import type { AuthUser, FileRecord, SignedDownload, SignedUpload } from '@flashspace/shared';
import { AppError, ACTIVITY_ACTIONS, STORAGE_PATHS } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { StorageAdapter } from '../storage/index.js';
import { newId } from '../utils/ids.js';
import type { SpacesService } from './spaces.service.js';
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

    if (input.sizeBytes > this.env.fileMaxBytes) {
      throw new AppError('QUOTA_EXCEEDED', `File exceeds the ${Math.round(this.env.fileMaxBytes / 1024 / 1024)} MB per-file limit`);
    }
    const used = await this.db.files.usedBytesForSpace(spaceId);
    if (used + input.sizeBytes > this.env.spaceMaxBytes) {
      throw new AppError('QUOTA_EXCEEDED', `Space storage limit reached (${Math.round(this.env.spaceMaxBytes / 1024 / 1024)} MB)`);
    }

    const fileId = newId();
    const safeName = sanitizeName(input.name);
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
      mimeType: input.mimeType || 'application/octet-stream',
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
      await this.discardRejectedUpload(file);
      throw new AppError(
        'QUOTA_EXCEEDED',
        `File exceeds the ${Math.round(this.env.fileMaxBytes / 1024 / 1024)} MB per-file limit`,
      );
    }
    const usedByOtherFiles = (await this.db.files.listActiveForSpace(spaceId))
      .filter((f) => f.id !== fileId)
      .reduce((sum, f) => sum + f.sizeBytes, 0);
    if (usedByOtherFiles + info.size > this.env.spaceMaxBytes) {
      await this.discardRejectedUpload(file);
      throw new AppError(
        'QUOTA_EXCEEDED',
        `Space storage limit reached (${Math.round(this.env.spaceMaxBytes / 1024 / 1024)} MB)`,
      );
    }

    const updated = await this.db.files.update(fileId, { status: 'ACTIVE', etag: info.etag, sizeBytes: info.size });
    return updated!;
  }

  /** Remove an object whose real size exceeded a quota, and retire its row. */
  private async discardRejectedUpload(file: FileRecord): Promise<void> {
    await this.storage.deleteObject(file.objectKey).catch(() => undefined);
    await this.db.files.update(file.id, {
      status: 'DELETED',
      deletedAt: new Date().toISOString(),
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

export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[\\/\0]/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 180) || 'file';
}
