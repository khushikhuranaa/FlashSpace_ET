/** Smart Storage Insights + Duplicate Detection domain types.
 *  Extended by the storage-insights feature; kept separate from the core domain
 *  types so the shared package stays organized.
 */

export type ScanStatus = 'PENDING' | 'RUNNING' | 'VERIFIED' | 'FAILED';
export type PlanStatus = 'PENDING' | 'CONFIRMED' | 'ARCHIVING' | 'VERIFIED' | 'FAILED' | 'CANCELLED';
export type ArchiveJobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

/** A scan of a Space's active files. */
export interface ScanJob {
  id: string;
  spaceId: string;
  ownerId: string;
  status: ScanStatus;
  totalFiles: number;
  totalBytes: number;
  duplicateGroups: number;
  duplicateFileCount: number;
  extraCopyCount: number;
  potentialSavingsBytes: number;
  largeFileCount: number;
  nearDuplicateGroupCount: number;
  scannedAt: string | null;
  failedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One exact-duplicate group produced by a scan. */
export interface DuplicateGroup {
  id: string;
  scanId: string;
  /** SHA-256 of the shared content. */
  contentHash: string;
  fileCount: number;
  extraCopyCount: number;
  totalBytes: number;
  potentialSavingsBytes: number;
  representativeName: string;
  files: DuplicateFile[];
}

/** One file that belongs to a duplicate group. */
export interface DuplicateFile {
  fileId: string;
  name: string;
  /** Path inside the Space, e.g. `docs/reports/q3.pdf`. */
  path: string;
  objectKey: string;
  sizeBytes: number;
  mimeType: string;
  uploadedAt: string;
  uploaderId: string;
  /** Files the owner has marked for exclusion from the archive plan. */
  excluded: boolean;
}

/** Possible near-duplicate (filename similarity), NOT content duplicates. */
export interface NearDuplicateGroup {
  id: string;
  scanId: string;
  /** Example name shared by the group. */
  baseName: string;
  fileCount: number;
  totalBytes: number;
  files: NearDuplicateFile[];
}

export interface NearDuplicateFile {
  fileId: string;
  name: string;
  path: string;
  sizeBytes: number;
  sha256: string | null;
}

/** Owner's chosen archive content for a Space. The default (no exclusions) is a
 *  full archive of every active file, including duplicates. */
export interface ArchivePlan {
  id: string;
  spaceId: string;
  ownerId: string;
  scanId: string | null;
  status: PlanStatus;
  /** File IDs explicitly excluded from the archive. Empty ⇒ full archive. */
  excludedFileIds: string[];
  willArchiveFileCount: number;
  willArchiveBytes: number;
  willExcludeFileCount: number;
  willExcludeBytes: number;
  potentialSavingsBytes: number;
  explained: boolean;
  confirmedAt: string | null;
  archiveJobId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Background job that actually builds + verifies a selective ZIP. */
export interface ArchiveJob {
  id: string;
  planId: string;
  spaceId: string;
  ownerId: string;
  idempotencyKey: string;
  status: ArchiveJobStatus;
  attempts: number;
  archiveId: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

/** A file that could not be hashed/scanned, with error context. */
export interface UnscannedFile {
  fileId: string;
  name: string;
  path: string;
  objectKey: string;
  sizeBytes: number;
  error: string;
}

/** The full insights report returned to the owner. */
export interface StorageInsights {
  scan: ScanJob;
  totalFiles: number;
  totalBytes: number;
  exactDuplicates: DuplicateGroup[];
  nearDuplicates: NearDuplicateGroup[];
  largeFiles: LargeFile[];
  unscannedFiles: UnscannedFile[];
  duplicateGroupCount: number;
  duplicateFileCount: number;
  extraCopyCount: number;
  potentialSavingsBytes: number;
  largeFileThresholdBytes: number;
}

export interface LargeFile {
  fileId: string;
  name: string;
  path: string;
  objectKey: string;
  sizeBytes: number;
  mimeType: string;
  uploadedAt: string;
}

/** Payload the owner sends to create an archive plan from a scan. */
export interface CreatePlanInput {
  scanId: string;
  /** File IDs to exclude from the archive. Defaults to none (full archive). */
  excludedFileIds?: string[];
  /** Must be true to confirm the owner understands the exclusion consequences. */
  explained: boolean;
}

/** Payload to update an existing plan's exclude list. */
export interface UpdatePlanInput {
  excludedFileIds?: string[];
  explained?: boolean;
}

/** Summary used by the frontend plan-review panel. */
export interface PlanReview {
  plan: ArchivePlan;
  spaceName: string;
  scan: ScanJob | null;
  archive: ArchiveJob | null;
}
