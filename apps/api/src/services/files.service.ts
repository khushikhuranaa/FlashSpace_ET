import { createHash } from 'node:crypto';
import type { AuthUser, FileRecord, SignedDownload, SignedUpload } from '@flashspace/shared';
import { AppError, ACTIVITY_ACTIONS, STORAGE_PATHS } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { StorageAdapter } from '../storage/index.js';
import { newId } from '../utils/ids.js';
import type { SpacesService } from './spaces.service.js';
import type { MalwareScanService, ScanResult } from './malware-scan.service.js';
import { folderPathFor } from '../utils/folder-path.js';

/**
 * File upload/download flow (PRD §7): API issues short-lived signed URLs,
 * the browser streams directly to storage, then confirms; the API never
 * proxies bytes. Everything validates quota + role + Space writability.
 */
export class FilesService {
  constructor(
    private readonly env: Env,
    private readonly db: DataLayer,
    private readonly storage: StorageAdapter,
    private readonly spaces: SpacesService,
    private readonly scanner?: MalwareScanService,
  ) {}

  async initUpload(
    actor: AuthUser,
    spaceId: string,
    input: { name: string; mimeType: string; sizeBytes: number; folderId?: string | null },
  ): Promise<SignedUpload> {
    const role = await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    const space = await this.db.spaces.findById(spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    this.spaces.assertWritable(space);

    if (!Number.isFinite(input.sizeBytes) || input.sizeBytes < 0) {
      throw new AppError('VALIDATION_ERROR', 'sizeBytes must be a non-negative number');
    }
    if (input.sizeBytes > this.env.fileMaxBytes) {
      throw new AppError('QUOTA_EXCEEDED', `File exceeds the ${Math.round(this.env.fileMaxBytes / 1024 / 1024)} MB per-file limit`);
    }
    const safeName = sanitizeName(input.name);
    const mimeType = sanitizeMime(input.mimeType);
    assertTypeAllowed(this.env.uploadBlockedExtensions, safeName);

    // Capacity includes uploads that are reserved but not yet confirmed, so two
    // concurrent initialisations cannot both consume the same free bytes.
    const used = (await this.db.files.usedBytesForSpace(spaceId)) + (await this.reservedBytes(spaceId));
    if (used + input.sizeBytes > this.env.spaceMaxBytes) {
      throw new AppError('QUOTA_EXCEEDED', `Space storage limit reached (${Math.round(this.env.spaceMaxBytes / 1024 / 1024)} MB)`);
    }

    const fileId = newId();
    let directory = '';
    if (input.folderId) {
      const folder = await this.db.folders.findById(input.folderId);
      if (!folder || folder.spaceId !== spaceId) {
        throw new AppError('VALIDATION_ERROR', 'Folder not found in this Space');
      }
      directory = await folderPathFor(this.db.folders, spaceId, input.folderId);
    }
    const objectKey = STORAGE_PATHS.spaceObject(spaceId, directory, fileId, safeName);
    const signed = await this.storage.createSignedUploadUrl(objectKey, 900);
    const file: FileRecord = {
      id: fileId,
      spaceId,
      folderId: input.folderId ?? null,
      uploaderId: actor.id,
      name: safeName,
      objectKey,
      mimeType,
      sizeBytes: input.sizeBytes,
      etag: null,
      sha256: null,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };
    await this.db.files.insert(file);
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId,
      action: ACTIVITY_ACTIONS.FILE_UPLOAD_STARTED,
      metadata: { name: safeName, sizeBytes: input.sizeBytes, role },
    });
    return { fileId, objectKey, url: signed.url, expiresAt: signed.expiresAt };
  }

  async confirmUpload(actor: AuthUser, spaceId: string, fileId: string): Promise<FileRecord> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    const file = await this.db.files.findById(fileId);
    if (!file || file.spaceId !== spaceId) throw new AppError('FILE_NOT_FOUND', 'File not found');
    if (file.status === 'ACTIVE') return file;
    if (file.status === 'DELETED') throw new AppError('UPLOAD_INCOMPLETE', 'File was deleted');
    const info = await this.storage.headObject(file.objectKey); // throws NOT_FOUND if browser never uploaded

    // Quotas were checked at init-upload against the size the CLIENT claimed,
    // which a caller can understate to slip past both limits. Re-check against
    // the bytes that actually landed in storage, and discard the object when it
    // does not fit so no orphan is left behind.
    if (info.size > this.env.fileMaxBytes) {
      await this.discardRejectedUpload(file, 'per-file-size-limit-exceeded');
      throw new AppError(
        'QUOTA_EXCEEDED',
        `File exceeds the ${Math.round(this.env.fileMaxBytes / 1024 / 1024)} MB per-file limit`,
      );
    }
    // Re-check against the bytes that actually landed, counting other reserved
    // uploads but not this one (it is no longer a reservation).
    const usedByOtherFiles = (await this.db.files.listActiveForSpace(spaceId))
      .filter((f) => f.id !== fileId)
      .reduce((sum, f) => sum + f.sizeBytes, 0);
    const reservedByOthers = (await this.db.files.listForSpace(spaceId))
      .filter((f) => f.id !== fileId && f.status === 'PENDING' && isFreshReservation(f))
      .reduce((sum, f) => sum + f.sizeBytes, 0);
    if (usedByOtherFiles + reservedByOthers + info.size > this.env.spaceMaxBytes) {
      await this.discardRejectedUpload(file, 'space-storage-limit-exceeded');
      throw new AppError(
        'QUOTA_EXCEEDED',
        `Space storage limit reached (${Math.round(this.env.spaceMaxBytes / 1024 / 1024)} MB)`,
      );
    }

    // MIME spoofing check: for formats with a strong magic number, the bytes in
    // storage must match the type we are about to record.
    await this.assertSignatureMatches(file).catch(async (err) => {
      await this.discardRejectedUpload(file, 'content-does-not-match-declared-type');
      throw err;
    });

    // Content checksum of the stored object, computed once at confirmation.
    const sha256 = await this.hashObject(file.objectKey);

    // Module 14: malware scanning. A missing scanner is reported as
    // NOT_CONFIGURED and never described as "clean". Under `enforce`, a
    // positive detection deletes the object and retires the row so the file can
    // never be downloaded; under `advisory` the result is recorded and the
    // upload proceeds.
    const scan = await this.scanStoredObject(file, info.size);
    if (scan?.status === 'INFECTED' && this.env.malwareScanPolicy === 'enforce') {
      await this.discardRejectedUpload(file, 'malware-detected');
      throw new AppError(
        'MALWARE_DETECTED',
        'This file was flagged by malware scanning and was not saved',
      );
    }

    const updated = await this.db.files.update(fileId, {
      status: 'ACTIVE',
      etag: info.etag,
      sizeBytes: info.size,
      sha256,
    });
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId,
      action: ACTIVITY_ACTIONS.FILE_UPLOADED,
      category: 'FILE',
      resourceType: 'file',
      resourceId: fileId,
      metadata: {
        name: file.name,
        sizeBytes: info.size,
        mimeType: file.mimeType,
        folderId: file.folderId,
        ...(scan ? { scanStatus: scan.status, scanScanner: scan.scanner } : {}),
      },
    });
    return updated!;
  }

  /** Remove an object whose real size exceeded a quota, and retire its row. */
  private async discardRejectedUpload(file: FileRecord, reason: string): Promise<void> {
    await this.storage.deleteObject(file.objectKey).catch(() => undefined);
    await this.db.files.update(file.id, {
      status: 'DELETED',
      deletedAt: new Date().toISOString(),
    });
    // A rejected upload is a real user-visible failure, so it is recorded with
    // the reason and the size that actually landed (never the file contents).
    await this.db.activity.append({
      userId: file.uploaderId,
      spaceId: file.spaceId,
      fileId: file.id,
      action: ACTIVITY_ACTIONS.FILE_UPLOAD_FAILED,
      category: 'FILE',
      outcome: 'FAILURE',
      resourceType: 'file',
      resourceId: file.id,
      reason,
      metadata: { name: file.name, sizeBytes: file.sizeBytes, mimeType: file.mimeType },
    });
  }

  /** Bytes held by unconfirmed upload reservations (stale ones expire). */
  private async reservedBytes(spaceId: string): Promise<number> {
    return (await this.db.files.listForSpace(spaceId))
      .filter((f) => f.status === 'PENDING' && isFreshReservation(f))
      .reduce((sum, f) => sum + f.sizeBytes, 0);
  }

  /**
   * Read the stored object (bounded) and hand it to the configured scanner.
   * Returns null when scanning is not wired in at all.
   */
  private async scanStoredObject(file: FileRecord, size: number): Promise<ScanResult | null> {
    if (!this.scanner) return null;
    if (this.env.malwareScanPolicy === 'off') {
      return { status: 'SKIPPED', scanner: 'none', detail: 'policy=off', durationMs: 0 };
    }
    if (size > this.env.malwareScanMaxBytes) {
      return {
        status: 'SKIPPED',
        scanner: 'none',
        detail: `file larger than scan limit (${this.env.malwareScanMaxBytes} bytes)`,
        durationMs: 0,
      };
    }
    const buffer = await this.collectObject(file.objectKey, this.env.malwareScanMaxBytes);
    if (!buffer) {
      return { status: 'SKIPPED', scanner: 'none', detail: 'object exceeded scan limit', durationMs: 0 };
    }
    return this.scanner.scanBuffer(buffer);
  }

  /** Read an object into memory, refusing to exceed `maxBytes`. */
  private async collectObject(objectKey: string, maxBytes: number): Promise<Buffer | null> {
    const stream = await this.storage.getObject(objectKey);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buf.length;
      if (size > maxBytes) {
        stream.destroy();
        return null;
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  private async hashObject(objectKey: string): Promise<string> {
    const stream = await this.storage.getObject(objectKey);
    const hash = createHash('sha256');
    for await (const chunk of stream) {
      hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return hash.digest('hex');
  }

  /**
   * Verifies the stored bytes against the declared type for formats whose header
   * is unambiguous (PNG/JPEG/GIF/WebP/PDF/ZIP-based Office files). Types without
   * a reliable signature are accepted as declared.
   *
   * Signature checks are driven by the declared MIME type. A generic MIME like
   * `application/octet-stream` does not trigger a signature check on its own —
   * the extension is still checked against the blocked list in
   * `assertTypeAllowed`, but we do not guess a format from the filename when the
   * caller gave us no useful type signal. This avoids rejecting legitimately
   * generic uploads (e.g. a `.pdf` file uploaded before its real MIME is known)
   * while still catching MIME spoofing when a specific type was declared.
   */
  private async assertSignatureMatches(file: FileRecord): Promise<void> {
    const expected = expectedSignature(file.mimeType);
    if (!expected) return;
    const head = await this.readHead(file.objectKey, 16);
    if (!head || !matchesSignature(expected, head)) {
      throw new AppError('MIME_MISMATCH', 'The uploaded file content does not match its declared type');
    }
  }

  private async readHead(objectKey: string, bytes: number): Promise<Buffer | null> {
    const stream = await this.storage.getObject(objectKey);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (value: Buffer | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      stream.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        chunks.push(buf);
        size += buf.length;
        if (size >= bytes) {
          finish(Buffer.concat(chunks).subarray(0, bytes));
          stream.destroy();
        }
      });
      stream.on('end', () => finish(Buffer.concat(chunks).subarray(0, bytes)));
      stream.on('close', () => finish(Buffer.concat(chunks).subarray(0, bytes) || null));
      stream.on('error', (err) => (settled ? undefined : reject(err)));
    });
  }

  async download(actor: AuthUser, spaceId: string, fileId: string): Promise<SignedDownload> {
    const role = await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    const file = await this.db.files.findById(fileId);
    if (!file || file.spaceId !== spaceId || file.status === 'DELETED') {
      throw new AppError('FILE_NOT_FOUND', 'File not found');
    }
    const space = await this.db.spaces.findById(spaceId);
    if (space && space.status === 'ARCHIVED') {
      // Archived Spaces are read-only vaults: files are inside the archive ZIP.
      throw new AppError('SPACE_NOT_WRITABLE', 'Space is archived; download from the Vault archive instead');
    }
    const signed = await this.storage.createSignedDownloadUrl(file.objectKey, 300, file.name);
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId,
      action: ACTIVITY_ACTIONS.FILE_DOWNLOADED,
      metadata: { name: file.name, role },
    });
    return signed;
  }

  async rename(actor: AuthUser, spaceId: string, fileId: string, name: string): Promise<FileRecord> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    const file = await this.db.files.findById(fileId);
    if (!file || file.spaceId !== spaceId || file.status === 'DELETED') {
      throw new AppError('FILE_NOT_FOUND', 'File not found');
    }
    const safe = sanitizeName(name);
    const updated = await this.db.files.update(fileId, { name: safe });
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId,
      action: ACTIVITY_ACTIONS.FILE_RENAMED,
      metadata: { from: file.name, to: safe },
    });
    return updated!;
  }

  async remove(actor: AuthUser, spaceId: string, fileId: string): Promise<void> {
    const role = await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    const file = await this.db.files.findById(fileId);
    if (!file || file.spaceId !== spaceId || file.status === 'DELETED') {
      throw new AppError('FILE_NOT_FOUND', 'File not found');
    }
    const space = await this.db.spaces.findById(spaceId);
    if (space) this.spaces.assertWritable(space);
    // soft delete; the cleanup job hard-deletes objects later (PRD §10)
    await this.db.files.update(fileId, { status: 'DELETED', deletedAt: new Date().toISOString() });
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId,
      action: ACTIVITY_ACTIONS.FILE_DELETED,
      metadata: { name: file.name, role },
    });
  }

  async list(actor: AuthUser, spaceId: string): Promise<FileRecord[]> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    return (await this.db.files.listActiveForSpace(spaceId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

/** Normalises a browser-supplied MIME type; anything malformed becomes binary. */
export function sanitizeMime(mimeType: string): string {
  const mime = (mimeType || '').split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mime) ? mime : 'application/octet-stream';
}

/** Rejects configured dangerous extensions (executables, installers, scripts). */
export function assertTypeAllowed(blocked: string[], name: string): void {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (blocked.includes(ext)) {
    throw new AppError('FILE_TYPE_NOT_ALLOWED', `Files of type .${ext} are not allowed in this Space`);
  }
}

/** A PENDING row older than a day is treated as an abandoned upload. */
function isFreshReservation(file: FileRecord): boolean {
  return Date.now() - new Date(file.createdAt).getTime() < 24 * 3_600_000;
}

type Signature = 'png' | 'jpg' | 'gif' | 'webp' | 'pdf' | 'zip';

/**
 * Returns the expected file signature for a declared MIME type, or null when
 * the type is generic (e.g. `application/octet-stream`) and should not be
 * signature-checked. Extension-only signals are intentionally ignored here: the
 * blocked-extension check in `assertTypeAllowed` already handles dangerous
 * extensions, and guessing a format from a filename would create false positives
 * for legitimately generic uploads.
 *
 * ZIP signature is checked for Office/document formats that are ZIP-based
 * (`.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`) when the MIME declares
 * one of those types, and for `.zip` when the MIME is `application/zip`.
 */
function expectedSignature(mimeType: string): Signature | null {
  const mime = (mimeType || '').toLowerCase();
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/zip') return 'zip';
  if (mime === 'application/msword') return 'zip';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'zip';
  if (mime === 'application/vnd.ms-excel') return 'zip';
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'zip';
  if (mime === 'application/vnd.ms-powerpoint') return 'zip';
  if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'zip';
  if (mime === 'application/vnd.oasis.opendocument.text') return 'zip';
  if (mime === 'application/vnd.oasis.opendocument.spreadsheet') return 'zip';
  if (mime === 'application/vnd.oasis.opendocument.presentation') return 'zip';
  return null;
}

function matchesSignature(kind: Signature, head: Buffer): boolean {
  switch (kind) {
    case 'png':
      return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'gif':
      return head.subarray(0, 4).toString('latin1') === 'GIF8';
    case 'webp':
      return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'pdf':
      return head.subarray(0, 4).toString('latin1') === '%PDF';
    case 'zip':
      return head[0] === 0x50 && head[1] === 0x4b;
  }
}

export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[\\/\0]/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 180) || 'file';
}
