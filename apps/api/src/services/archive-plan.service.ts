import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { AuthUser, Archive } from '@flashspace/shared';
import { AppError, ACTIVITY_ACTIONS, STORAGE_PATHS } from '@flashspace/shared';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { ArchivePlanRow, ArchiveJobRow, ScanJobRow } from '../repositories/data-layer.interface.js';
import { newId } from '../utils/ids.js';
import { zipStream, type ZipEntry } from '../utils/zip.js';
import { folderPathFor, uniqueEntryName } from '../utils/folder-path.js';
import type { SpacesService } from './spaces.service.js';
import type { StorageAdapter } from '../storage/index.js';
import type { ArchiveService } from './archive.service.js';
import type { ArchivePlanView, ArchiveJobView, PlanReview } from './scan.types.js';

/** Selective archive plan engine (PRD §4, §5, §6).
 *
 *  The default behaviour is a FULL archive: if the owner has made no exclusions,
 *  every active file (including duplicates) is packaged into the ZIP. Exclusions
 *  are an explicit owner choice — reviewing duplicates never auto-excludes them.
 *
 *  Lifecycle:
 *    1. createPlan(spaceId, scanId, excludedFileIds) → PLAN status, computes
 *       willArchive/willExclude counts + bytes + potential savings.
 *    2. confirmPlan(planId) → CONFIRMED → spawn an ArchiveJob → status
 *       ARCHIVING → stream selected files through zipStream → putObject into the
 *       owner's Vault → verify checksum + size → mark archive VERIFIED → mark
 *       plan+job SUCCEEDED → notify.
 *    3. On failure: plan + job marked FAILED, space left intact, error recorded.
 *
 *  ArchiveJob is idempotent by (planId): a second confirm attempt returns the
 *  existing job/plan state.
 */
export class ArchivePlanService {
  constructor(
    private readonly db: DataLayer,
    private readonly storage: StorageAdapter,
    private readonly spaces: SpacesService,
    private readonly archive: ArchiveService,
  ) {}

  async createPlan(actor: AuthUser, spaceId: string, input: { scanId?: string; excludedFileIds?: string[]; explained: boolean }): Promise<ArchivePlanView> {
    this.spaces.requireRole(spaceId, actor.id, ['OWNER']);
    const space = this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    this.spaces.assertWritable(space);

    // If there is already a non-terminal plan for this space, return it (idempotent creator).
    const existing = this.db.archivePlans.listForSpace(spaceId).find(
      (p) => p.status === 'PENDING' || p.status === 'CONFIRMED' || p.status === 'ARCHIVING',
    );
    if (existing) return this.toPlanView(existing);

    const activeFiles = this.db.files.listActiveForSpace(spaceId);
    const excludedSet = new Set(input.excludedFileIds ?? []);
    // Validate excluded ids belong to this space's active files.
    for (const id of excludedSet) {
      if (!activeFiles.some((f) => f.id === id)) {
        throw new AppError('VALIDATION_ERROR', `Excluded file not found: ${id}`);
      }
    }

    const willExclude = activeFiles.filter((f) => excludedSet.has(f.id));
    const willArchive = activeFiles.filter((f) => !excludedSet.has(f.id));
    const willExcludeBytes = willExclude.reduce((s, f) => s + f.sizeBytes, 0);
    const willArchiveBytes = willArchive.reduce((s, f) => s + f.sizeBytes, 0);
    const potentialSavingsBytes = willExcludeBytes;

    const now = new Date().toISOString();
    const plan: ArchivePlanRow = {
      id: newId(),
      spaceId,
      ownerId: space.ownerId,
      scanId: input.scanId ?? null,
      status: 'PENDING',
      excludedFileIds: excludedSet.size ? Array.from(excludedSet) : [],
      willArchiveFileCount: willArchive.length,
      willArchiveBytes,
      willExcludeFileCount: willExclude.length,
      willExcludeBytes,
      potentialSavingsBytes,
      explained: input.explained,
      confirmedAt: null,
      archiveJobId: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.archivePlans.insert(plan);

    this.spaces.notify(space.ownerId, spaceId, 'PLAN_CREATED', `Archive plan created for "${space.name}"`, `Will archive ${willArchive.length} file(s); ${willExclude.length} excluded (${this.fmt(willExcludeBytes)}).`);
    this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.PLAN_CREATED,
      metadata: { planId: plan.id, willArchiveFileCount: willArchive.length, willExcludeFileCount: willExclude.length },
    });

    return this.toPlanView(plan);
  }

  async confirmPlan(actor: AuthUser, planId: string): Promise<PlanReview> {
    this.spaces.requireRoleForPlan(planId, actor.id, this.db);
    const plan = this.db.archivePlans.findById(planId);
    if (!plan) throw new AppError('NOT_FOUND', 'Plan not found');
    if (plan.status !== 'PENDING') {
      throw new AppError('CONFLICT', `Plan is already ${plan.status}`);
    }
    if (!plan.explained) {
      throw new AppError('VALIDATION_ERROR', 'You must confirm you understand the exclusion consequences before archiving');
    }

    const space = this.db.spaces.findById(plan.spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');

    // Mark CONFIRMED, then spawn the archive job (idempotent by plan).
    const updated = this.db.archivePlans.update(plan.id, { status: 'CONFIRMED', confirmedAt: new Date().toISOString() });
    const review = await this.spawnArchiveJob(actor, updated!);
    return review;
  }

  async cancelPlan(actor: AuthUser, planId: string): Promise<ArchivePlanView> {
    this.spaces.requireRoleForPlan(planId, actor.id, this.db);
    const plan = this.db.archivePlans.findById(planId);
    if (!plan) throw new AppError('NOT_FOUND', 'Plan not found');
    if (plan.status !== 'PENDING' && plan.status !== 'CONFIRMED') {
      throw new AppError('CONFLICT', `Plan cannot be cancelled in status ${plan.status}`);
    }
    const updated = this.db.archivePlans.update(plan.id, { status: 'CANCELLED' });
    this.spaces.notify(plan.ownerId, plan.spaceId, 'PLAN_CANCELLED', `Archive plan cancelled for "${this.db.spaces.findById(plan.spaceId)?.name ?? 'Space'}"`, 'No archive was created.');
    return this.toPlanView(updated!);
  }

  async retryFailedPlan(admin: AuthUser, planId: string): Promise<PlanReview> {
    const adminProfile = this.db.auth.findById(admin.id);
    if (!adminProfile || adminProfile.role !== 'ADMIN') throw new AppError('ADMIN_REQUIRED', 'Admin access required');
    const plan = this.db.archivePlans.findById(planId);
    if (!plan) throw new AppError('NOT_FOUND', 'Plan not found');
    if (plan.status !== 'FAILED') throw new AppError('CONFLICT', `Plan is not in a retryable state (${plan.status})`);

    const space = this.db.spaces.findById(plan.spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    if (space.status === 'DELETED') throw new AppError('SPACE_NOT_WRITABLE', 'Space has been deleted');

    this.db.activity.append({
      userId: admin.id,
      spaceId: plan.spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.ADMIN_RETRY,
      metadata: { planId, retryTarget: 'archive_plan' },
    });
    const actor = { id: plan.ownerId, email: space.ownerId, displayName: '', role: 'USER' } as AuthUser;

    // A failed plan normally still owns its previous job row. Reusing that row
    // keeps retries idempotent: one job per plan, no duplicate archives.
    const previousJob = this.db.archiveJobs.findByPlanId(plan.id);
    if (previousJob) {
      const now = new Date().toISOString();
      this.db.archivePlans.update(plan.id, { status: 'ARCHIVING', errorMessage: null, updatedAt: now });
      this.db.archiveJobs.update(previousJob.id, {
        status: 'RUNNING',
        attempts: previousJob.attempts + 1,
        startedAt: now,
        finishedAt: null,
        error: null,
      });
      return this.runJob(actor, this.db.archivePlans.findById(plan.id)!, previousJob.id);
    }

    const revived = this.db.archivePlans.update(plan.id, { status: 'CONFIRMED', errorMessage: null, updatedAt: new Date().toISOString() });
    this.spaces.notify(plan.ownerId, plan.spaceId, 'PLAN_CREATED', `A failed archive plan for "${space.name}" is ready to retry`, 'Review and confirm to try again.');
    return this.spawnArchiveJob(actor, revived!);
  }

  async getPlanReview(actor: AuthUser, planId: string): Promise<PlanReview> {
    this.spaces.requireRoleForPlan(planId, actor.id, this.db);
    const plan = this.db.archivePlans.findById(planId);
    if (!plan) throw new AppError('NOT_FOUND', 'Plan not found');
    const space = this.db.spaces.findById(plan.spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    const scan = plan.scanId ? this.db.scanJobs.findById(plan.scanId) ?? null : null;
    const archiveJob = plan.archiveJobId ? this.db.archiveJobs.findById(plan.archiveJobId) ?? null : null;
    return { plan: this.toPlanView(plan), spaceName: space.name, scan: scan ? this.toScanView(scan) : null, archiveJob: archiveJob ? this.toArchiveJobView(archiveJob) : null };
  }

  async getPlansForSpace(actor: AuthUser, spaceId: string): Promise<ArchivePlanView[]> {
    this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    if (!this.db.spaces.findById(spaceId)) throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    return this.db.archivePlans.listForSpace(spaceId).map(this.toPlanView);
  }

  // ---- internals ---------------------------------------------------------

  private async spawnArchiveJob(actor: AuthUser, plan: ArchivePlanRow): Promise<PlanReview> {
    const space = this.db.spaces.findById(plan.spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');

    // Idempotent by plan: if a job already exists for this plan, return its review.
    const existingJob = this.db.archiveJobs.findByPlanId(plan.id);
    if (existingJob) {
      return { plan: this.toPlanView(plan), spaceName: space.name, scan: plan.scanId ? (this.db.scanJobs.findById(plan.scanId) ?? null) : null, archiveJob: this.toArchiveJobView(existingJob) };
    }

    const jobId = newId();
    const now = new Date().toISOString();
    const job: ArchiveJobRow = {
      id: jobId,
      planId: plan.id,
      spaceId: plan.spaceId,
      ownerId: plan.ownerId,
      idempotencyKey: `plan:${plan.id}`,
      status: 'RUNNING',
      attempts: 1,
      archiveId: null,
      startedAt: now,
      finishedAt: null,
      error: null,
    };
    this.db.archiveJobs.insert(job);
    this.db.archivePlans.update(plan.id, { status: 'ARCHIVING', archiveJobId: jobId, updatedAt: now });

    this.db.activity.append({
      userId: actor.id,
      spaceId: plan.spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.ARCHIVE_JOB_STARTED,
      metadata: { planId: plan.id, jobId },
    });

    return this.runJob(actor, plan, jobId);
  }

  /** Runs (or re-runs) the ZIP creation for a plan's job. */
  private async runJob(actor: AuthUser, plan: ArchivePlanRow, jobId: string): Promise<PlanReview> {
    const space = this.db.spaces.findById(plan.spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    try {
      // buildAndStoreArchive verifies the ZIP, stores it in the owner's Vault,
      // persists the archive row and only then flips the Space to ARCHIVED.
      const archive = await this.buildAndStoreArchive(actor, plan, space);
      this.db.archiveJobs.update(jobId, { status: 'SUCCEEDED', archiveId: archive.id, finishedAt: new Date().toISOString() });
      this.db.archivePlans.update(plan.id, { status: 'VERIFIED', updatedAt: new Date().toISOString() });
      this.spaces.notify(plan.ownerId, plan.spaceId, 'ARCHIVE_PLAN_CONFIRMED', `Archive verified for "${space.name}"`, `A ${this.fmt(archive.sizeBytes)} archive with ${archive.fileCount} file(s) is now in your Vault.`);
      this.db.activity.append({
        userId: actor.id,
        spaceId: plan.spaceId,
        fileId: null,
        action: ACTIVITY_ACTIONS.ARCHIVE_JOB_SUCCEEDED,
        metadata: { planId: plan.id, jobId, archiveId: archive.id, fileCount: archive.fileCount, sizeBytes: archive.sizeBytes },
      });
      return { plan: this.toPlanView(this.db.archivePlans.findById(plan.id)!), spaceName: space.name, scan: plan.scanId ? (this.db.scanJobs.findById(plan.scanId) ?? null) : null, archiveJob: this.toArchiveJobView(this.db.archiveJobs.findById(jobId)!) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.db.archiveJobs.update(jobId, { status: 'FAILED', error: message, finishedAt: new Date().toISOString() });
      this.db.archivePlans.update(plan.id, { status: 'FAILED', errorMessage: message, updatedAt: new Date().toISOString() });
      this.spaces.notify(plan.ownerId, plan.spaceId, 'ARCHIVE_PLAN_FAILED', `Archiving failed for "${space.name}"`, 'Your Space and files are preserved. You can retry from the Space details.');
      this.db.activity.append({
        userId: actor.id,
        spaceId: plan.spaceId,
        fileId: null,
        action: ACTIVITY_ACTIONS.ARCHIVE_JOB_FAILED,
        metadata: { planId: plan.id, jobId, error: message },
      });
      throw err;
    }
  }

  private async buildAndStoreArchive(actor: AuthUser, plan: ArchivePlanRow, space: { id: string; name: string; ownerId: string }): Promise<Archive> {
    const activeFiles = this.db.files.listActiveForSpace(space.id);
    const excludedSet = new Set(plan.excludedFileIds);
    const selected = activeFiles.filter((f) => !excludedSet.has(f.id));

    // Preserve the original directory hierarchy inside the ZIP (PRD §5.6) and
    // de-duplicate entry names so no selected file is silently overwritten.
    const usedNames = new Set<string>();
    const entries = selected.map((f) => {
      const folder = folderPathFor(this.db.folders, space.id, f.folderId);
      return { file: f, folder, entryName: uniqueEntryName(folder, f.name, usedNames) };
    });

    // Build manifest of selected files.
    const manifest = {
      planId: plan.id,
      spaceId: space.id,
      spaceName: space.name,
      createdAt: new Date().toISOString(),
      archiveType: plan.excludedFileIds.length ? 'selective' : 'full',
      excludedFileCount: plan.willExcludeFileCount,
      entries: entries.map(({ file: f, folder, entryName }) => ({
        fileId: f.id,
        name: f.name,
        path: entryName,
        folderPath: folder || null,
        sizeBytes: f.sizeBytes,
        mimeType: f.mimeType,
        uploadedAt: f.createdAt,
      })),
    };

    // Stream selected files through zipStream, counting bytes.
    let bytes = 0;
    const zip = zipStream(
      entries.map(({ file: f, entryName }): ZipEntry => ({
        name: entryName,
        getData: () => this.storage.getObject(f.objectKey),
      })),
    );
    const counting = Readable.from(async function* (source) {
      for await (const chunk of source) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        bytes += buf.length;
        yield buf;
      }
    }(zip));

    const archiveId = newId();
    const objectKey = STORAGE_PATHS.archiveZip(space.ownerId, space.id, archiveId);
    const stored = await this.storage.putObject(objectKey, counting);

    // Verify checksum + size.
    const head = await this.storage.headObject(objectKey);
    if (head.size !== bytes) {
      throw new AppError('ARCHIVE_ERROR', `Archive verification failed: size mismatch (expected ${bytes}, got ${head.size})`);
    }
    const storedStream = await this.storage.getObject(objectKey);
    const checksum = createHash('sha256');
    for await (const chunk of storedStream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      checksum.update(buf);
    }
    const checksumHex = checksum.digest('hex');

    // Store manifest.
    await this.storage.putObject(
      STORAGE_PATHS.archiveManifest(space.ownerId, space.id, archiveId),
      Buffer.from(JSON.stringify(manifest, null, 2)),
    );

    // Persist the archive record (verified).
    const archive: Archive = {
      id: archiveId,
      spaceId: space.id,
      ownerId: space.ownerId,
      objectKey,
      sizeBytes: stored.size,
      checksum: checksumHex,
      fileCount: selected.length,
      status: 'VERIFIED',
      createdAt: now(),
      verifiedAt: new Date().toISOString(),
    };
    // Populate checksum on the archive (existing column).
    this.db.archives.insert(archive);
    this.db.archives.update(archiveId, { checksum: checksumHex, sizeBytes: stored.size, fileCount: selected.length, status: 'VERIFIED', verifiedAt: new Date().toISOString() });

    // Transition the space to ARCHIVED (only after verified persistence).
    this.db.spaces.update(space.id, { status: 'ARCHIVED', updatedAt: new Date().toISOString() });

    return archive;
  }

  private fmt(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  private toPlanView(row: ArchivePlanRow): ArchivePlanView {
    return {
      id: row.id,
      spaceId: row.spaceId,
      ownerId: row.ownerId,
      scanId: row.scanId,
      status: row.status,
      excludedFileIds: row.excludedFileIds,
      willArchiveFileCount: row.willArchiveFileCount,
      willArchiveBytes: row.willArchiveBytes,
      willExcludeFileCount: row.willExcludeFileCount,
      willExcludeBytes: row.willExcludeBytes,
      potentialSavingsBytes: row.potentialSavingsBytes,
      explained: row.explained,
      confirmedAt: row.confirmedAt,
      archiveJobId: row.archiveJobId,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toScanView(row: ScanJobRow): NonNullable<PlanReview['scan']> {
    return {
      id: row.id,
      spaceId: row.spaceId,
      ownerId: row.ownerId,
      status: row.status,
      totalFiles: row.totalFiles,
      totalBytes: row.totalBytes,
      duplicateGroups: row.duplicateGroups,
      duplicateFileCount: row.duplicateFileCount,
      extraCopyCount: row.extraCopyCount,
      potentialSavingsBytes: row.potentialSavingsBytes,
      largeFileCount: row.largeFileCount,
      nearDuplicateGroupCount: row.nearDuplicateGroupCount,
      scannedAt: row.scannedAt,
      failedAt: row.failedAt,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toArchiveJobView(row: ArchiveJobRow): ArchiveJobView {
    return {
      id: row.id,
      planId: row.planId,
      spaceId: row.spaceId,
      ownerId: row.ownerId,
      idempotencyKey: row.idempotencyKey,
      status: row.status,
      attempts: row.attempts,
      archiveId: row.archiveId,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      error: row.error,
    };
  }
}

function now(): string {
  return new Date().toISOString();
}
