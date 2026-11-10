/** Internal types used by the scan + duplicate services. These stay inside the
 *  API package; the shared types are re-exported to the web app via api.ts.
 */

import type { ScanJobRow, DuplicateGroupRow, DuplicateFileRow, ArchivePlanRow, ArchiveJobRow } from '../repositories/data-layer.interface.js';

export type { ScanJobRow, DuplicateGroupRow, DuplicateFileRow, ArchivePlanRow, ArchiveJobRow };

export interface DuplicateGroupView {
  id: string;
  scanId: string;
  contentHash: string;
  fileCount: number;
  extraCopyCount: number;
  totalBytes: number;
  potentialSavingsBytes: number;
  representativeName: string;
  files: DuplicateFileView[];
}

export interface DuplicateFileView {
  fileId: string;
  name: string;
  /** Path inside the Space, e.g. `docs/reports/q3.pdf`. */
  path: string;
  objectKey: string;
  sizeBytes: number;
  mimeType: string;
  uploadedAt: string;
  uploaderId: string;
  excluded: boolean;
}

export interface NearDuplicateGroupView {
  id: string;
  baseName: string;
  fileCount: number;
  totalBytes: number;
  files: { fileId: string; name: string; path: string; sizeBytes: number; sha256: string | null }[];
}

export interface ArchivePlanView {
  id: string;
  spaceId: string;
  ownerId: string;
  scanId: string | null;
  status: string;
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

export interface ArchiveJobView {
  id: string;
  planId: string;
  spaceId: string;
  ownerId: string;
  idempotencyKey: string;
  status: string;
  attempts: number;
  archiveId: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

/** Persisted scan summary as returned to clients. */
export interface ScanView {
  id: string;
  spaceId: string;
  ownerId: string;
  status: string;
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

export interface LargeFileView {
  fileId: string;
  name: string;
  path: string;
  objectKey: string;
  sizeBytes: number;
  mimeType: string;
  uploadedAt: string;
}

export interface UnscannedFileView {
  fileId: string;
  name: string;
  path: string;
  objectKey: string;
  sizeBytes: number;
  error: string;
}

/** Full insights report returned by ScanService. */
export interface StorageInsights {
  scan: ScanView;
  totalFiles: number;
  totalBytes: number;
  exactDuplicates: DuplicateGroupView[];
  nearDuplicates: NearDuplicateGroupView[];
  largeFiles: LargeFileView[];
  unscannedFiles: UnscannedFileView[];
  duplicateGroupCount: number;
  duplicateFileCount: number;
  extraCopyCount: number;
  potentialSavingsBytes: number;
  largeFileThresholdBytes: number;
}

export interface PlanReview {
  plan: ArchivePlanView;
  spaceName: string;
  scan: ScanView | null;
  archiveJob: ArchiveJobView | null;
}
