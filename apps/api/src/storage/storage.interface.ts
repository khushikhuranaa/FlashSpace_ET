import type { Readable } from 'node:stream';

/**
 * Storage adapter interface (PRD §11.1). Every object operation goes through
 * this interface so the backing store (local filesystem in dev/demo, Supabase
 * Storage on the free tier) can be swapped without touching domain logic.
 */

export interface StoredObjectInfo {
  key: string;
  size: number;
  etag: string | null;
}

export interface SignedUrl {
  url: string;
  expiresAt: string;
}

export interface StorageAdapter {
  /** Returns a short-lived URL the browser can PUT the object to directly. */
  createSignedUploadUrl(key: string, expiresInSeconds: number): Promise<SignedUrl>;

  /** Returns a short-lived GET URL; `downloadName` sets Content-Disposition. */
  createSignedDownloadUrl(
    key: string,
    expiresInSeconds: number,
    downloadName?: string,
  ): Promise<SignedUrl>;

  /** Uploads from the server (used by the archive engine, never the browser). */
  putObject(key: string, body: Readable | Buffer): Promise<StoredObjectInfo>;

  getObject(key: string): Promise<Readable>;

  /** HEAD-equivalent. Throws AppError NOT_FOUND when the object is missing. */
  headObject(key: string): Promise<StoredObjectInfo>;

  deleteObject(key: string): Promise<void>;

  /** Lists object keys under a prefix (used by cleanup + manifest checks). */
  listObjects(prefix: string): Promise<StoredObjectInfo[]>;
}
