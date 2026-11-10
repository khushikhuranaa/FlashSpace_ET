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
    const role = this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    const space = this.db.spaces.findById(spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    this.spaces.assertWritable(space);

    if (input.sizeBytes > this.env.fileMaxBytes) {
      throw new AppError('QUOTA_EXCEEDED', `File exceeds the ${Math.round(this.env.fileMaxBytes / 1024 / 1024)} MB per-file limit`);
    }
    const used = this.db.files.usedBytesForSpace(spaceId);
    if (used + input.sizeBytes > this.env.spaceMaxBytes) {
      throw new AppError('QUOTA_EXCEEDED', `Space storage limit reached (${Math.round(this.env.spaceMaxBytes / 1024 / 1024)} MB)`);
    }

    const fileId = newId();
    const safeName = sanitizeName(input.name);
    let directory = '';
    if (input.folderId) {
      const folder = this.db.folders.findById(input.folderId);
      if (!folder || folder.spaceId !== spaceId) {
        throw new AppError('VALIDATION_ERROR', 'Folder not found in this Space');
      }
      directory = folderPathFor(this.db.folders, spaceId, input.folderId);
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
    this.db.files.insert(file);
    this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId,
      action: ACTIVITY_ACTIONS.FILE_UPLOAD_STARTED,
      metadata: { name: safeName, sizeBytes: input.sizeBytes, role },
    });
    return { fileId, objectKey, url: signed.url, expiresAt: signed.expiresAt };
  }

  async confirmUpload(actor: AuthUser, spaceId: string, fileId: string): Promise<FileRecord> {
    this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    const file = this.db.files.findById(fileId);
    if (!file || file.spaceId !== spaceId) throw new AppError('FILE_NOT_FOUND', 'File not found');
    if (file.status === 'ACTIVE') return file;
    if (file.status === 'DELETED') throw new AppError('UPLOAD_INCOMPLETE', 'File was deleted');
    const info = await this.storage.headObject(file.objectKey); // throws NOT_FOUND if browser never uploaded
    const updated = this.db.files.update(fileId, { status: 'ACTIVE', etag: info.etag, sizeBytes: info.size });
    return updated!;
  }

  async download(actor: AuthUser, spaceId: string, fileId: string): Promise<SignedDownload> {
    const role = this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    const file = this.db.files.findById(fileId);
    if (!file || file.spaceId !== spaceId || file.status === 'DELETED') {
      throw new AppError('FILE_NOT_FOUND', 'File not found');
    }
    const space = this.db.spaces.findById(spaceId);
    if (space && space.status === 'ARCHIVED') {
      // Archived Spaces are read-only vaults: files are inside the archive ZIP.
      throw new AppError('SPACE_NOT_WRITABLE', 'Space is archived; download from the Vault archive instead');
    }
    const signed = await this.storage.createSignedDownloadUrl(file.objectKey, 300, file.name);
    this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId,
      action: ACTIVITY_ACTIONS.FILE_DOWNLOADED,
      metadata: { name: file.name, role },
    });
    return signed;
  }

  async rename(actor: AuthUser, spaceId: string, fileId: string, name: string): Promise<FileRecord> {
    this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    const file = this.db.files.findById(fileId);
    if (!file || file.spaceId !== spaceId || file.status === 'DELETED') {
      throw new AppError('FILE_NOT_FOUND', 'File not found');
    }
    const safe = sanitizeName(name);
    const updated = this.db.files.update(fileId, { name: safe });
    this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId,
      action: ACTIVITY_ACTIONS.FILE_RENAMED,
      metadata: { from: file.name, to: safe },
    });
    return updated!;
  }

  async remove(actor: AuthUser, spaceId: string, fileId: string): Promise<void> {
    const role = this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    const file = this.db.files.findById(fileId);
    if (!file || file.spaceId !== spaceId || file.status === 'DELETED') {
      throw new AppError('FILE_NOT_FOUND', 'File not found');
    }
    const space = this.db.spaces.findById(spaceId);
    if (space) this.spaces.assertWritable(space);
    // soft delete; the cleanup job hard-deletes objects later (PRD §10)
    this.db.files.update(fileId, { status: 'DELETED', deletedAt: new Date().toISOString() });
    this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId,
      action: ACTIVITY_ACTIONS.FILE_DELETED,
      metadata: { name: file.name, role },
    });
  }

  list(actor: AuthUser, spaceId: string): FileRecord[] {
    this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    return this.db.files.listActiveForSpace(spaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[\\/\0]/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 180) || 'file';
}
