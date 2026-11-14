import { ACTIVITY_ACTIONS, AppError, type CleanupStatus } from '@flashspace/shared';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { StorageAdapter } from '../storage/index.js';
import { newId } from '../utils/ids.js';

/**
 * Cleanup engine (PRD §10): 7 days after archiving, revoke memberships,
 * hard-delete Space objects, then soft-delete DB rows so history stays
 * auditable. Partial failures are recorded and retried by the worker.
 *
 * Every execution is persisted in `cleanup_runs` (RUNNING → final status) so
 * deletions are auditable long after the Space rows are soft-deleted.
 */
export class CleanupService {
  constructor(
    private readonly db: DataLayer,
    private readonly storage: StorageAdapter,
  ) {}

  async runCleanup(
    spaceId: string,
    archiveId: string,
  ): Promise<{ membershipsRevoked: number; objectsDeleted: number; status: string }> {
    const space = await this.db.spaces.findById(spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    const archive = await this.db.archives.findById(archiveId);
    if (!archive || archive.status !== 'VERIFIED') {
      throw new AppError('ARCHIVE_NOT_VERIFIED', 'Refusing cleanup without a verified archive');
    }

    // Open the run record before touching anything so a crash mid-way is visible.
    const runId = newId();
    await this.db.cleanupRuns.insert({
      id: runId,
      spaceId,
      archiveId,
      status: 'RUNNING',
      membershipsRevoked: 0,
      objectsDeleted: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    });

    // Worker-generated events name SYSTEM as the actor, never the Space owner
    // or the user who happened to trigger the job.
    await this.db.activity.append({
      spaceId,
      action: ACTIVITY_ACTIONS.CLEANUP_STARTED,
      actorType: 'SYSTEM',
      category: 'CLEANUP',
      resourceType: 'space',
      resourceId: spaceId,
      metadata: { runId, archiveId },
    });

    let membershipsRevoked = 0;
    let objectsDeleted = 0;
    let hadFailure = false;
    let failureMessage: string | null = null;

    const recordFailure = (err: unknown): void => {
      hadFailure = true;
      failureMessage = err instanceof Error ? err.message : String(err);
    };

    try {
      // 1. Revoke every membership.
      try {
        membershipsRevoked = await this.db.members.revokeAllForSpace(spaceId);
      } catch (err) {
        recordFailure(err);
      }

      // 2. Hard-delete Space object storage.
      try {
        const prefix = `spaces/${spaceId}/`;
        const objects = await this.storage.listObjects(prefix);
        for (const obj of objects) {
          await this.storage.deleteObject(obj.key);
          objectsDeleted++;
        }
      } catch (err) {
        recordFailure(err);
      }

      // 3. Soft-delete file rows, mark Space DELETED. Vault archive is retained.
      try {
        for (const f of await this.db.files.listForSpace(spaceId)) {
          if (f.status !== 'DELETED') {
            await this.db.files.update(f.id, { status: 'DELETED', deletedAt: new Date().toISOString() });
          }
        }
        await this.db.spaces.update(spaceId, { status: 'DELETED' });
      } catch (err) {
        recordFailure(err);
      }

      const status: CleanupStatus = hadFailure ? 'PARTIAL_FAILED' : 'SUCCEEDED';
      await this.db.cleanupRuns.update(runId, {
        status,
        membershipsRevoked,
        objectsDeleted,
        finishedAt: new Date().toISOString(),
        error: failureMessage,
      });
      await this.db.activity.append({
        spaceId,
        action: hadFailure ? ACTIVITY_ACTIONS.CLEANUP_PARTIAL_FAILED : ACTIVITY_ACTIONS.CLEANUP_COMPLETED,
        actorType: 'SYSTEM',
        category: 'CLEANUP',
        outcome: hadFailure ? 'FAILURE' : 'SUCCESS',
        resourceType: 'space',
        resourceId: spaceId,
        reason: failureMessage,
        metadata: { runId, archiveId, membershipsRevoked, objectsDeleted, status },
      });
      return { membershipsRevoked, objectsDeleted, status };
    } catch (err) {
      await this.db.cleanupRuns.update(runId, {
        status: 'FAILED',
        membershipsRevoked,
        objectsDeleted,
        finishedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      });
      await this.db.activity.append({
        spaceId,
        action: ACTIVITY_ACTIONS.CLEANUP_FAILED,
        actorType: 'SYSTEM',
        category: 'CLEANUP',
        outcome: 'FAILURE',
        resourceType: 'space',
        resourceId: spaceId,
        reason: err instanceof Error ? err.message : String(err),
        metadata: { runId, archiveId, membershipsRevoked, objectsDeleted },
      });
      throw err;
    }
  }
}
