import { createHash } from 'node:crypto';
import type { AuthUser, FileRecord } from '@flashspace/shared';
import { AppError, ACTIVITY_ACTIONS, STORAGE_INSIGHTS_DEFAULTS } from '@flashspace/shared';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { ScanJobRow, DuplicateGroupRow } from '../repositories/data-layer.interface.js';
import type {
  StorageInsights,
  ScanView,
  DuplicateGroupView,
  NearDuplicateGroupView,
  LargeFileView,
  UnscannedFileView,
} from './scan.types.js';
import { newId } from '../utils/ids.js';
import { folderPathFor } from '../utils/folder-path.js';
import type { SpacesService } from './spaces.service.js';
import type { StorageAdapter } from '../storage/index.js';

/**
 * Smart Storage scan engine (PRD §3, §4).
 *
 * For a Space's active files it:
 *   1. streams each stored object through SHA-256 and persists `files.sha256`
 *      (reused on later scans);
 *   2. groups files by content hash → exact duplicate groups;
 *   3. computes extra copies + potential savings from real byte sizes;
 *   4. flags large files;
 *   5. flags possible near-duplicates by filename similarity ONLY when the
 *      content hashes differ (never reported as exact duplicates);
 *   6. records files that could not be read, with the error, instead of
 *      silently treating them as unique;
 *   7. persists scan_jobs / duplicate_groups / duplicate_files.
 *
 * Content is the sole basis for exact duplication: identical content under
 * different names is a duplicate; identical names with different content are not.
 */
export class ScanService {
  private readonly largeFileBytes: number;

  constructor(
    private readonly db: DataLayer,
    private readonly storage: StorageAdapter,
    private readonly spaces: SpacesService,
    largeFileBytes: number = STORAGE_INSIGHTS_DEFAULTS.largeFileBytes,
  ) {
    this.largeFileBytes = largeFileBytes;
  }

  /** Run a fresh scan. Only the Space owner may scan (PRD §7). */
  async scan(actor: AuthUser, spaceId: string): Promise<StorageInsights> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER']);
    const space = await this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');

    const now = new Date().toISOString();
    const scanId = newId();
    const scan: ScanJobRow = {
      id: scanId,
      spaceId,
      ownerId: space.ownerId,
      status: 'RUNNING',
      totalFiles: 0,
      totalBytes: 0,
      duplicateGroups: 0,
      duplicateFileCount: 0,
      extraCopyCount: 0,
      potentialSavingsBytes: 0,
      largeFileCount: 0,
      nearDuplicateGroupCount: 0,
      scannedAt: null,
      failedAt: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.scanJobs.insert(scan);
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.SCAN_STARTED,
      metadata: { scanId },
    });

    const files = await this.db.files.listActiveForSpace(spaceId);
    scan.totalFiles = files.length;

    // Hash every file; collect failures separately.
    const unscanned: UnscannedFileView[] = [];
    const hashed: { file: FileRecord; sha256: string }[] = [];
    for (const file of files) {
      const result = await this.hashFile(file);
      if (result.sha256) hashed.push({ file, sha256: result.sha256 });
      else
        unscanned.push({
          fileId: file.id,
          name: file.name,
          path: await this.pathOf(file),
          objectKey: file.objectKey,
          sizeBytes: file.sizeBytes,
          error: result.error ?? 'Unknown error',
        });
    }

    // If nothing could be read but files exist, the scan genuinely failed:
    // record it and return no fabricated duplicates.
    if (files.length > 0 && hashed.length === 0) {
      const message = unscanned[0]?.error ?? 'No files could be read';
      await this.db.scanJobs.update(scanId, {
        status: 'FAILED',
        failedAt: new Date().toISOString(),
        errorMessage: message,
        totalFiles: files.length,
      });
      await this.spaces.notify(space.ownerId, spaceId, 'SCAN_FAILED', `Storage scan failed for "${space.name}"`, message);
      await this.db.activity.append({
        userId: actor.id,
        spaceId,
        fileId: null,
        action: ACTIVITY_ACTIONS.SCAN_FAILED,
        metadata: { scanId, error: message },
      });
      return this.emptyReport(spaceId, space.ownerId, files, unscanned, 'FAILED', message);
    }

    // Exact duplicate grouping by content hash.
    const byHash = new Map<string, { file: FileRecord; sha256: string }[]>();
    for (const entry of hashed) {
      const bucket = byHash.get(entry.sha256);
      if (bucket) bucket.push(entry);
      else byHash.set(entry.sha256, [entry]);
    }

    let totalBytes = 0;
    let largeFileCount = 0;
    const largeFiles: LargeFileView[] = [];
    for (const { file } of hashed) {
      totalBytes += file.sizeBytes;
      if (file.sizeBytes >= this.largeFileBytes) {
        largeFileCount++;
        largeFiles.push({
          fileId: file.id,
          name: file.name,
          path: await this.pathOf(file),
          objectKey: file.objectKey,
          sizeBytes: file.sizeBytes,
          mimeType: file.mimeType,
          uploadedAt: file.createdAt,
        });
      }
    }

    let duplicateGroupCount = 0;
    let duplicateFileCount = 0;
    let extraCopyCount = 0;
    let potentialSavingsBytes = 0;

    for (const [hash, bucket] of byHash.entries()) {
      if (bucket.length < 2) continue;
      duplicateGroupCount += 1;
      const extra = bucket.length - 1;
      const groupBytes = bucket.reduce((sum, e) => sum + e.file.sizeBytes, 0);
      // One copy is retained; savings = everything beyond the first copy.
      const savings = groupBytes - bucket[0]!.file.sizeBytes;
      extraCopyCount += extra;
      duplicateFileCount += bucket.length;
      potentialSavingsBytes += savings;

      const groupId = newId();
      const representativeName = bucket
        .map((e) => e.file.name)
        .sort((a, b) => a.localeCompare(b))[0]!;
      await this.db.duplicateGroups.insert({
        id: groupId,
        scanId,
        contentHash: hash,
        fileCount: bucket.length,
        extraCopyCount: extra,
        totalBytes: groupBytes,
        potentialSavingsBytes: savings,
        representativeName,
      });
      for (const { file } of bucket) {
        await this.db.duplicateFiles.insert({
          id: newId(),
          groupId,
          scanId,
          fileId: file.id,
          name: file.name,
          objectKey: file.objectKey,
          sizeBytes: file.sizeBytes,
          mimeType: file.mimeType,
          uploadedAt: file.createdAt,
          uploaderId: file.uploaderId,
          excluded: false,
        });
      }
    }

    const nearDuplicates = await this.buildNearDuplicates(scanId, hashed);

    await this.db.scanJobs.update(scanId, {
      status: 'VERIFIED',
      totalFiles: files.length,
      totalBytes,
      duplicateGroups: duplicateGroupCount,
      duplicateFileCount,
      extraCopyCount,
      potentialSavingsBytes,
      largeFileCount,
      nearDuplicateGroupCount: nearDuplicates.length,
      scannedAt: new Date().toISOString(),
      errorMessage: unscanned.length ? `${unscanned.length} file(s) could not be scanned` : null,
    });

    await this.spaces.notify(
      space.ownerId,
      spaceId,
      'SCAN_READY',
      `Storage scan ready for "${space.name}"`,
      `${duplicateGroupCount} exact duplicate group(s), ${nearDuplicates.length} possible near-duplicate group(s), ${this.fmt(potentialSavingsBytes)} potential savings.`,
    );
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.SCAN_COMPLETED,
      metadata: {
        scanId,
        totalFiles: files.length,
        duplicateGroups: duplicateGroupCount,
        nearDuplicateGroups: nearDuplicates.length,
        potentialSavingsBytes,
        unscanned: unscanned.length,
      },
    });

    return this.buildReport(scanId);
  }

  /** Latest scan report for a Space. Never fabricates duplicates: when no scan
   *  has run, or the latest scan failed, the duplicate sections stay empty. */
  async getInsights(actor: AuthUser, spaceId: string): Promise<StorageInsights> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    const space = await this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');

    const latest = (await this.db.scanJobs.listForSpace(spaceId))[0];
    if (!latest) {
      const files = await this.db.files.listActiveForSpace(spaceId);
      return this.emptyReport(spaceId, space.ownerId, files, [], 'PENDING', null);
    }
    return this.buildReport(latest.id);
  }

  // ---- internals ---------------------------------------------------------

  private async hashFile(file: FileRecord): Promise<{ sha256: string | null; error: string | null }> {
    // If we already have a content hash, verify the object still exists before
    // reusing it. A missing object means the stored file is gone, so the scan
    // must report a failure rather than fabricate a result from a stale hash.
    if (file.sha256) {
      try {
        await this.storage.headObject(file.objectKey);
        return { sha256: file.sha256, error: null };
      } catch {
        return { sha256: null, error: 'Stored object no longer exists' };
      }
    }
    try {
      const stream = await this.storage.getObject(file.objectKey);
      const hash = createHash('sha256');
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        hash.update(buf);
      }
      const hex = hash.digest('hex');
      await this.db.files.update(file.id, { sha256: hex });
      return { sha256: hex, error: null };
    } catch (err) {
      return { sha256: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Possible versions: similar basenames whose content hashes DIFFER. */
  private async buildNearDuplicates(
    scanId: string,
    hashed: { file: FileRecord; sha256: string }[],
  ): Promise<NearDuplicateGroupView[]> {
    const byBase = new Map<string, { file: FileRecord; sha256: string }[]>();
    for (const entry of hashed) {
      const base = this.normalizeBasename(entry.file.name);
      if (!base) continue;
      const bucket = byBase.get(base);
      if (bucket) bucket.push(entry);
      else byBase.set(base, [entry]);
    }
    const result: NearDuplicateGroupView[] = [];
    for (const [base, bucket] of byBase.entries()) {
      if (bucket.length < 2) continue;
      const distinctHashes = new Set(bucket.map((e) => e.sha256));
      if (distinctHashes.size < 2) continue; // all identical → exact duplicates
      const nearFiles: NearDuplicateGroupView['files'] = [];
      for (const e of bucket) {
        nearFiles.push({
          fileId: e.file.id,
          name: e.file.name,
          path: await this.pathOf(e.file),
          sizeBytes: e.file.sizeBytes,
          sha256: e.sha256,
        });
      }
      result.push({
        id: `near-${scanId}-${result.length}`,
        baseName: base || bucket[0]!.file.name,
        fileCount: nearFiles.length,
        totalBytes: nearFiles.reduce((sum, f) => sum + f.sizeBytes, 0),
        files: nearFiles,
      });
    }
    return result.sort((a, b) => b.totalBytes - a.totalBytes);
  }

  private normalizeBasename(name: string): string {
    return name
      .toLowerCase()
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(v\d+|ver\d+|draft|final|old|new|copy|backup|archive|tmp)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  /** Builds the report from persisted rows so every number has a DB source. */
  private async buildReport(scanId: string): Promise<StorageInsights> {
    const scan = await this.db.scanJobs.findById(scanId);
    if (!scan) throw new AppError('NOT_FOUND', 'Scan not found');

    const groups = await this.db.duplicateGroups.listForScan(scanId);
    const exactDuplicates: DuplicateGroupView[] = [];
    for (const g of groups) {
      const groupFiles: DuplicateGroupView['files'] = [];
      for (const f of await this.db.duplicateFiles.listForGroup(g.id)) {
        groupFiles.push({
          fileId: f.fileId,
          name: f.name,
          path: await this.pathOfFileId(f.fileId, f.name),
          objectKey: f.objectKey,
          sizeBytes: f.sizeBytes,
          mimeType: f.mimeType,
          uploadedAt: f.uploadedAt,
          uploaderId: f.uploaderId,
          excluded: f.excluded,
        });
      }
      exactDuplicates.push({
        id: g.id,
        scanId: g.scanId,
        contentHash: g.contentHash,
        fileCount: g.fileCount,
        extraCopyCount: g.extraCopyCount,
        totalBytes: g.totalBytes,
        potentialSavingsBytes: g.potentialSavingsBytes,
        representativeName: g.representativeName,
        files: groupFiles,
      });
    }

    const activeFiles = await this.db.files.listActiveForSpace(scan.spaceId);
    const largeFiles: LargeFileView[] = [];
    for (const f of activeFiles) {
      if (f.sizeBytes >= this.largeFileBytes) {
        largeFiles.push({
          fileId: f.id,
          name: f.name,
          path: await this.pathOf(f),
          objectKey: f.objectKey,
          sizeBytes: f.sizeBytes,
          mimeType: f.mimeType,
          uploadedAt: f.createdAt,
        });
      }
    }

    const nearDuplicates = await this.deriveNearDuplicatesFromFiles(scanId, activeFiles);

    return {
      scan: this.toScanView(scan),
      totalFiles: scan.totalFiles || activeFiles.length,
      totalBytes: scan.totalBytes,
      exactDuplicates,
      nearDuplicates,
      largeFiles,
      unscannedFiles:
        scan.status === 'FAILED' && scan.errorMessage
          ? [{ fileId: '', name: '*', path: '*', objectKey: '', sizeBytes: 0, error: scan.errorMessage }]
          : [],
      duplicateGroupCount: scan.duplicateGroups,
      duplicateFileCount: scan.duplicateFileCount,
      extraCopyCount: scan.extraCopyCount,
      potentialSavingsBytes: scan.potentialSavingsBytes,
      largeFileThresholdBytes: this.largeFileBytes,
    };
  }

  /**
   * Possible versions, derived from the files' persisted content hashes:
   * similar basenames whose hashes DIFFER. Files with identical hashes are exact
   * duplicates (reported separately) and are never repeated here.
   */
  private async deriveNearDuplicatesFromFiles(scanId: string, files: FileRecord[]): Promise<NearDuplicateGroupView[]> {
    const byBase = new Map<string, FileRecord[]>();
    for (const file of files) {
      if (!file.sha256) continue;
      const base = this.normalizeBasename(file.name);
      if (!base) continue;
      const bucket = byBase.get(base);
      if (bucket) bucket.push(file);
      else byBase.set(base, [file]);
    }
    const result: NearDuplicateGroupView[] = [];
    for (const [base, bucket] of byBase.entries()) {
      if (bucket.length < 2) continue;
      if (new Set(bucket.map((f) => f.sha256)).size < 2) continue;
      const groupFiles: NearDuplicateGroupView['files'] = [];
      for (const f of bucket) {
        groupFiles.push({
          fileId: f.id,
          name: f.name,
          path: await this.pathOf(f),
          sizeBytes: f.sizeBytes,
          sha256: f.sha256,
        });
      }
      result.push({
        id: `near-${scanId}-${base.slice(0, 12)}`,
        baseName: base,
        fileCount: groupFiles.length,
        totalBytes: groupFiles.reduce((sum, f) => sum + f.sizeBytes, 0),
        files: groupFiles,
      });
    }
    return result.sort((a, b) => b.totalBytes - a.totalBytes);
  }

  private async emptyReport(
    spaceId: string,
    ownerId: string,
    files: FileRecord[],
    unscanned: UnscannedFileView[],
    status: string,
    errorMessage: string | null,
  ): Promise<StorageInsights> {
    const now = new Date().toISOString();
    const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
    const largeFiles: LargeFileView[] = [];
    for (const f of files) {
      if (f.sizeBytes >= this.largeFileBytes) {
        largeFiles.push({
          fileId: f.id,
          name: f.name,
          path: await this.pathOf(f),
          objectKey: f.objectKey,
          sizeBytes: f.sizeBytes,
          mimeType: f.mimeType,
          uploadedAt: f.createdAt,
        });
      }
    }
    return {
      scan: {
        id: '',
        spaceId,
        ownerId,
        status,
        totalFiles: files.length,
        totalBytes,
        duplicateGroups: 0,
        duplicateFileCount: 0,
        extraCopyCount: 0,
        potentialSavingsBytes: 0,
        largeFileCount: largeFiles.length,
        nearDuplicateGroupCount: 0,
        scannedAt: null,
        failedAt: status === 'FAILED' ? now : null,
        errorMessage,
        createdAt: now,
        updatedAt: now,
      },
      totalFiles: files.length,
      totalBytes,
      exactDuplicates: [],
      nearDuplicates: [],
      largeFiles,
      unscannedFiles: unscanned,
      duplicateGroupCount: 0,
      duplicateFileCount: 0,
      extraCopyCount: 0,
      potentialSavingsBytes: 0,
      largeFileThresholdBytes: this.largeFileBytes,
    };
  }

  /** Path of a file inside its Space (`<folder path><name>`). */
  private async pathOf(file: FileRecord): Promise<string> {
    const prefix = await folderPathFor(this.db.folders, file.spaceId, file.folderId);
    return `${prefix}${file.name}`;
  }

  private async pathOfFileId(fileId: string, fallbackName: string): Promise<string> {
    const file = await this.db.files.findById(fileId);
    if (!file) return fallbackName;
    return this.pathOf(file);
  }

  private toScanView(scan: ScanJobRow): ScanView {
    return {
      id: scan.id,
      spaceId: scan.spaceId,
      ownerId: scan.ownerId,
      status: scan.status,
      totalFiles: scan.totalFiles,
      totalBytes: scan.totalBytes,
      duplicateGroups: scan.duplicateGroups,
      duplicateFileCount: scan.duplicateFileCount,
      extraCopyCount: scan.extraCopyCount,
      potentialSavingsBytes: scan.potentialSavingsBytes,
      largeFileCount: scan.largeFileCount,
      nearDuplicateGroupCount: scan.nearDuplicateGroupCount,
      scannedAt: scan.scannedAt,
      failedAt: scan.failedAt,
      errorMessage: scan.errorMessage,
      createdAt: scan.createdAt,
      updatedAt: scan.updatedAt,
    };
  }

  private fmt(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
}
