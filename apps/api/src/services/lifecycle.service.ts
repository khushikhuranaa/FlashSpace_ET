import { AppError, ACTIVITY_ACTIONS } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { StorageAdapter } from '../storage/index.js';
import type { ArchiveService } from './archive.service.js';
import type { CleanupService } from './cleanup.service.js';
import type { SpacesService } from './spaces.service.js';

/**
 * Lifecycle worker (PRD §8.1): one pass of the state machine over every
 * non-deleted Space.
 *   ACTIVE → WARNING      when now > expiryAt − warningWindow
 *   WARNING → ARCHIVING   when now > expiryAt (queue archive job)
 *   ARCHIVING → ARCHIVED  archive verified
 *   ARCHIVED → DELETED    7 days after verifiedAt (queue cleanup job)
 *
 * The worker is idempotent: each pass is keyed by (date, space, phase) so
 * repeated cron invocations are no-ops (PRD §14.2).
 */
export class LifecycleService {
  constructor(
    private readonly env: Env,
    private readonly db: DataLayer,
    private readonly storage: StorageAdapter,
    private readonly spaces: SpacesService,
    private readonly archive: ArchiveService,
    private readonly cleanup: CleanupService,
  ) {}

  async runLifecyclePass(trigger: { source: 'cron' | 'manual' | 'test'; jobSecret?: string }): Promise<{
    scanned: number;
    warned: number;
    queuedArchives: number;
    archived: number;
    finalized: number;
    failures: string[];
  }> {
    if (trigger.source !== 'manual' && trigger.jobSecret !== this.env.jobSecret) {
      throw new AppError('INVALID_JOB_SECRET', 'Invalid job secret');
    }

    const now = Date.now();
    const warningsCutoff = now + this.env.warningWindowHours * 3600 * 1000;
    const cleanupCutoff = now - 7 * 24 * 3600 * 1000;

    const result = { scanned: 0, warned: 0, queuedArchives: 0, archived: 0, finalized: 0, failures: [] as string[] };

    for (const space of this.db.spaces.list()) {
      if (space.status === 'DELETED') continue;
      result.scanned++;

      const expiry = new Date(space.expiryAt).getTime();

      // Phase 1: warn upcoming expiries (only while there is still time left).
      // The reminder fires exactly once per Space: gated on `warningSentAt` so a
      // repeated cron pass, a page refresh or a manual scan never re-notifies.
      const inWarningWindow = expiry <= warningsCutoff && expiry > now;
      if (inWarningWindow && !space.warningSentAt) {
        const nowIso = new Date().toISOString();
        this.db.spaces.update(space.id, {
          status: space.status === 'DRAFT' || space.status === 'ACTIVE' ? 'WARNING' : space.status,
          warningSentAt: nowIso,
        });
        const daysLeft = Math.max(0, Math.ceil((expiry - now) / 86_400_000));
        this.spaces.notify(
          space.ownerId,
          space.id,
          'SPACE_WARNING',
          `Space "${space.name}" expires in ${daysLeft} day(s)`,
          `Expires at ${space.expiryAt}. Request an extension, review storage, or download your files.`,
        );
        for (const m of this.db.members.listForSpace(space.id)) {
          if (m.userId !== space.ownerId && m.status === 'ACTIVE') {
            this.spaces.notify(m.userId, space.id, 'SPACE_WARNING', `Space "${space.name}" expires in ${daysLeft} day(s)`, `Expires at ${space.expiryAt}.`);
          }
        }
        this.db.activity.append({
          userId: space.ownerId,
          spaceId: space.id,
          fileId: null,
          action: ACTIVITY_ACTIONS.REMINDER_SENT,
          metadata: { expiryAt: space.expiryAt, warningWindowHours: this.env.warningWindowHours },
        });
        result.warned++;
        continue;
      }

      // Phase 2: expired → queue archive.
      if ((space.status === 'ACTIVE' || space.status === 'WARNING') && expiry <= now) {
        const key = `archive:${space.id}:${new Date().toISOString().slice(0, 10)}`;
        if (!this.db.jobs.findByIdempotencyKey(key)) {
          const job = {
            id: crypto.randomUUID(),
            jobType: 'ARCHIVE' as const,
            spaceId: space.id,
            idempotencyKey: key,
            status: 'PENDING' as const,
            attempts: 0,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            error: null,
          };
          this.db.jobs.insert(job);
          result.queuedArchives++;
        }
        // Fall through: process the queued job in this same pass so a single
        // cron invocation converges (queue → archive → verify).
      }

      // Phase 3: process pending archive jobs for this space inline (single-process worker).
      const pendingArchiveJobs = [...this.db.jobs.list(500)].filter(
        (j) => j.spaceId === space.id && j.jobType === 'ARCHIVE' && j.status === 'PENDING',
      );
      for (const job of pendingArchiveJobs) {
        this.db.jobs.update(job.id, { status: 'RUNNING', attempts: job.attempts + 1 });
        try {
          const archive = await this.archive.createPendingArchive(space.id);
          await this.archive.runArchive(archive.id);
          this.db.jobs.finish(job.id, { status: 'SUCCEEDED', error: null });
          result.archived++;
        } catch (err) {
          this.db.jobs.finish(job.id, { status: 'FAILED', error: err instanceof Error ? err.message : String(err) });
          result.failures.push(`archive:${space.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Phase 4: cleanup 7 days after archiving. Spaces the owner archived by
      // hand stay in the Vault until the owner deletes them.
      if (space.status === 'ARCHIVED' && !space.archivedManually) {
        const verified = this.db.archives.listForSpace(space.id).find((a) => a.status === 'VERIFIED');
        if (verified && new Date(verified.verifiedAt ?? space.updatedAt).getTime() <= cleanupCutoff) {
          const key = `cleanup:${space.id}:${new Date().toISOString().slice(0, 10)}`;
          if (!this.db.jobs.findByIdempotencyKey(key)) {
            this.db.jobs.insert({
              id: crypto.randomUUID(),
              jobType: 'CLEANUP',
              spaceId: space.id,
              idempotencyKey: key,
              status: 'PENDING',
              attempts: 0,
              startedAt: new Date().toISOString(),
              finishedAt: null,
              error: null,
            });
          }
          const job = [...this.db.jobs.list(500)].find((j) => j.idempotencyKey === key);
          if (job && job.status === 'PENDING') {
            this.db.jobs.update(job.id, { status: 'RUNNING', attempts: job.attempts + 1 });
            try {
              const res = await this.cleanup.runCleanup(space.id, verified.id);
              this.db.jobs.finish(job.id, { status: res.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED', error: res.status === 'SUCCEEDED' ? null : 'partial cleanup failure' });
              this.spaces.notify(space.ownerId, space.id, 'SPACE_DELETED', `Space "${space.name}" finalized`, 'Memberships were revoked and temporary files deleted. Your Vault archive remains.');
              result.finalized++;
            } catch (err) {
              this.db.jobs.finish(job.id, { status: 'FAILED', error: err instanceof Error ? err.message : String(err) });
              result.failures.push(`cleanup:${space.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    }
    return result;
  }
}
