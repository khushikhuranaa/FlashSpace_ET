import type { AuthUser } from '@flashspace/shared';
import { AppError } from '@flashspace/shared';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { ScanJobRow, DuplicateGroupRow, DuplicateFileRow } from '../repositories/data-layer.interface.js';
import type { SpacesService } from './spaces.service.js';
import type { DuplicateGroupView, DuplicateFileView, NearDuplicateGroupView } from './scan.types.js';
import { folderPathFor } from '../utils/folder-path.js';

/** Reads duplicate + near-duplicate information for a Space's latest scan and
 *  lets the owner toggle exclusions on individual duplicate files.
 *
 *  Exclusions are stored on the duplicate_files row (`excluded` flag) and are
 *  the basis for selective archive plans: a file excluded here is excluded from
 *  the archive ZIP unless the owner creates a plan that overrides it.
 */
export class DuplicateService {
  constructor(
    private readonly db: DataLayer,
    private readonly spaces: SpacesService,
  ) {}

  /** Returns the duplicate + near-duplicate view for a Space, based on its
   *  latest VERIFIED scan. When there is no verified scan yet, returns an empty
   *  structure (no fabricated duplicates). */
  async getDuplicates(actor: AuthUser, spaceId: string): Promise<{
    scan: ScanJobRow | null;
    exactGroups: DuplicateGroupView[];
    nearGroups: NearDuplicateGroupView[];
    totalFiles: number;
    totalBytes: number;
    duplicateFileCount: number;
    extraCopyCount: number;
    potentialSavingsBytes: number;
  }> {
    this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    const space = this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');

    const latestScan = this.db.scanJobs.listForSpace(spaceId).find((s) => s.status === 'VERIFIED') ?? null;
    const files = this.db.files.listActiveForSpace(spaceId);
    const totalBytes = files.reduce((s, f) => s + f.sizeBytes, 0);

    if (!latestScan) {
      return {
        scan: null,
        exactGroups: [],
        nearGroups: [],
        totalFiles: files.length,
        totalBytes,
        duplicateFileCount: 0,
        extraCopyCount: 0,
        potentialSavingsBytes: 0,
      };
    }

    const groups = this.db.duplicateGroups.listForScan(latestScan.id);
    const exactGroups = groups.map((g) => ({
      ...g,
      files: this.db.duplicateFiles.listForGroup(g.id).map(this.toFileView),
    }));

    const nearGroups = this.buildNearGroups(groups);

    const dupFileCount = groups.reduce((s, g) => s + g.fileCount, 0);
    const extraCopyCount = groups.reduce((s, g) => s + g.extraCopyCount, 0);
    const potentialSavingsBytes = groups.reduce((s, g) => s + g.potentialSavingsBytes, 0);

    return { scan: latestScan, exactGroups, nearGroups, totalFiles: files.length, totalBytes, duplicateFileCount: dupFileCount, extraCopyCount, potentialSavingsBytes };
  }

  /** Toggle whether a specific duplicate file is excluded from archive plans.
   *  Only the Space owner may change exclusions. */
  async toggleExclusion(actor: AuthUser, spaceId: string, fileId: string): Promise<DuplicateFileView> {
    this.spaces.requireRole(spaceId, actor.id, ['OWNER']);
    const space = this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');

    const allFiles = this.db.duplicateFiles.listAll();
    const row = allFiles.find((r) => r.fileId === fileId);
    if (!row) throw new AppError('FILE_NOT_FOUND', 'File not found in any duplicate group');

    const next = this.db.duplicateFiles.insert({ ...row, excluded: !row.excluded });
    return this.toFileView(next);
  }

  // ---- internals ---------------------------------------------------------

  private buildNearGroups(groups: DuplicateGroupRow[]): NearDuplicateGroupView[] {
    // Group representative names that appear across multiple groups with
    // different content hashes — these are possible versions/near-duplicates.
    const byBase = new Map<string, typeof groups>();
    for (const g of groups) {
      const base = this.normalizeBasename(g.representativeName);
      const existing = byBase.get(base);
      if (existing) existing.push(g);
      else byBase.set(base, [g]);
    }
    const result: NearDuplicateGroupView[] = [];
    for (const [base, gs] of byBase.entries()) {
      if (gs.length < 2) continue;
      const files: NearDuplicateGroupView['files'] = [];
      for (const g of gs) {
        for (const f of this.db.duplicateFiles.listForGroup(g.id)) {
          files.push({
            fileId: f.fileId,
            name: f.name,
            path: this.pathOf(f.fileId, f.name),
            sizeBytes: f.sizeBytes,
            sha256: null,
          });
        }
      }
      result.push({ id: newId(), baseName: base, fileCount: files.length, totalBytes: files.reduce((s, f) => s + f.sizeBytes, 0), files });
    }
    return result.sort((a, b) => b.totalBytes - a.totalBytes);
  }

  private normalizeBasename(name: string): string {
    let b = name.toLowerCase().replace(/\.[^.]+$/, '');
    b = b.replace(/[^a-z0-9]+/g, ' ');
    b = b.replace(/\b(v\d+|ver\d+|draft|final|old|new|copy|backup|archive)\b/g, '');
    return b.trim().slice(0, 60);
  }

  /** Space-relative path of a file (`<folder path><name>`). */
  private pathOf(fileId: string, fallbackName: string): string {
    const file = this.db.files.findById(fileId);
    if (!file) return fallbackName;
    return `${folderPathFor(this.db.folders, file.spaceId, file.folderId)}${file.name}`;
  }

  private toFileView(row: DuplicateFileRow): DuplicateFileView {
    return {
      fileId: row.fileId,
      name: row.name,
      path: this.pathOf(row.fileId, row.name),
      objectKey: row.objectKey,
      sizeBytes: row.sizeBytes,
      mimeType: row.mimeType,
      uploadedAt: row.uploadedAt,
      uploaderId: row.uploaderId,
      excluded: row.excluded,
    };
  }
}

let _dupSeq = 0;
function newId(): string {
  return `nd-${Date.now()}-${++_dupSeq}`;
}
