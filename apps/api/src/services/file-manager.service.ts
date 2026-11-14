import { Readable } from 'node:stream';
import type {
  AuthUser,
  BulkFileResult,
  FileDetails,
  FileListItem,
  FileListResult,
  FilePreview,
  FileRecord,
  FileSort,
  FileTypeFilter,
  Folder,
  FolderStats,
} from '@flashspace/shared';
import {
  ACTIVITY_ACTIONS,
  AppError,
  PREVIEW_TEXT_MAX_BYTES,
  fileTypeBucket,
  previewKindFor,
} from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { StorageAdapter } from '../storage/index.js';
import { uniqueEntryName } from '../utils/folder-path.js';
import { zipStream, type ZipEntry } from '../utils/zip.js';
import { sanitizeName, type FilesService } from './files.service.js';
import type { SpacesService } from './spaces.service.js';
import { newId } from '../utils/ids.js';

export interface FileQuery {
  folderId?: string | null;
  type?: FileTypeFilter;
  q?: string;
  sort?: FileSort;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export const MAX_BULK_FILES = 500;
export const DEFAULT_FILE_LIMIT = 50;
export const MAX_FILE_LIMIT = 500;

/**
 * File & folder management (Module 4).
 *
 * The upload/download wire protocol already lives in `FilesService`; this
 * service adds browsing, previews, metadata, move/restore/cancel, bulk actions
 * and the folder operations that were previously creation-only.
 *
 * Every method starts from `requireRole`, so authorization never depends on
 * what the browser chose to render. Storage keys are never derived from client
 * input: moves and renames are metadata-only and keep the existing object key.
 */
export class FileManagerService {
  constructor(
    private readonly env: Env,
    private readonly db: DataLayer,
    private readonly storage: StorageAdapter,
    private readonly spaces: SpacesService,
    private readonly files: FilesService,
  ) {}

  // -- browsing --------------------------------------------------------------

  async list(actor: AuthUser, spaceId: string, query: FileQuery): Promise<FileListResult> {
    const role = await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    const canSeeDeleted = role === 'OWNER' || role === 'EDITOR';

    const [allFiles, folders] = await Promise.all([
      this.db.files.listForSpace(spaceId),
      this.db.folders.listForSpace(spaceId),
    ]);
    const paths = buildPathMap(folders);
    const names = await this.uploaderNames(allFiles.map((f) => f.uploaderId));

    const active = allFiles.filter((f) => f.status === 'ACTIVE');
    const counts = { all: active.length, image: 0, pdf: 0, document: 0, text: 0, other: 0 };
    for (const file of active) counts[fileTypeBucket(file.mimeType, file.name)] += 1;

    let rows = query.includeDeleted && canSeeDeleted
      ? allFiles.filter((f) => f.status === 'ACTIVE' || f.status === 'DELETED')
      : active;

    if (query.folderId !== undefined) {
      const folderId = query.folderId;
      if (folderId !== null) {
        const folder = await this.db.folders.findById(folderId);
        if (!folder || folder.spaceId !== spaceId) {
          throw new AppError('VALIDATION_ERROR', 'Folder not found in this Space');
        }
      }
      rows = rows.filter((f) => (f.folderId ?? null) === folderId);
    }
    if (query.type && query.type !== 'all') {
      rows = rows.filter((f) => fileTypeBucket(f.mimeType, f.name) === query.type);
    }
    const q = (query.q ?? '').trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (f) => f.name.toLowerCase().includes(q) || (paths.get(f.folderId ?? '') ?? '').toLowerCase().includes(q),
      );
    }

    const sort: FileSort = query.sort ?? 'newest';
    rows = [...rows].sort((a, b) => {
      switch (sort) {
        case 'name-asc':
          return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
        case 'name-desc':
          return b.name.localeCompare(a.name) || b.id.localeCompare(a.id);
        case 'size-asc':
          return a.sizeBytes - b.sizeBytes || a.id.localeCompare(b.id);
        case 'size-desc':
          return b.sizeBytes - a.sizeBytes || b.id.localeCompare(a.id);
        case 'oldest':
          return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
        case 'newest':
        default:
          return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
      }
    });

    const total = rows.length;
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_FILE_LIMIT, 1), MAX_FILE_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);
    const page = rows.slice(offset, offset + limit);

    return {
      files: page.map((file) => this.toListItem(file, paths, names)),
      total,
      counts,
      limit,
      offset,
    };
  }

  async details(actor: AuthUser, spaceId: string, fileId: string): Promise<FileDetails> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    const file = await this.requireFile(spaceId, fileId);
    const folders = await this.db.folders.listForSpace(spaceId);
    const paths = buildPathMap(folders);
    const names = await this.uploaderNames([file.uploaderId]);
    const folderPath = paths.get(file.folderId ?? '') ?? null;

    let storageStatus: 'PRESENT' | 'MISSING' = 'MISSING';
    try {
      await this.storage.headObject(file.objectKey);
      storageStatus = 'PRESENT';
    } catch {
      storageStatus = 'MISSING';
    }

    return {
      ...this.toListItem(file, paths, names),
      folderId: file.folderId,
      folderName: file.folderId ? (folders.find((f) => f.id === file.folderId)?.name ?? null) : null,
      storageStatus,
      fullPath: `${folderPath ?? ''}${file.name}`,
    };
  }

  /**
   * Issues a short-lived inline URL for renderable files. Only image, PDF and
   * text types get a capability; everything else returns kind "none" with no
   * URL, so unsupported documents cannot be fetched through a preview token.
   */
  async preview(actor: AuthUser, spaceId: string, fileId: string): Promise<FilePreview> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    const file = await this.requireFile(spaceId, fileId);
    if (file.status !== 'ACTIVE') throw new AppError('FILE_NOT_FOUND', 'File not found');
    const space = await this.db.spaces.findById(spaceId);
    if (space?.status === 'ARCHIVED') {
      throw new AppError('SPACE_NOT_WRITABLE', 'Archived Spaces are read-only; download the Vault archive instead');
    }

    const kind = previewKindFor(file.mimeType, file.name);
    if (kind === 'none') {
      return {
        url: '',
        expiresAt: new Date().toISOString(),
        kind,
        mimeType: file.mimeType,
        name: file.name,
        sizeBytes: file.sizeBytes,
        maxTextBytes: PREVIEW_TEXT_MAX_BYTES,
      };
    }
    const signed = await this.storage.createSignedDownloadUrl(
      file.objectKey,
      300,
      undefined,
      kind === 'text' ? 'text/plain; charset=utf-8' : file.mimeType,
    );
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId,
      action: ACTIVITY_ACTIONS.FILE_DOWNLOADED,
      metadata: { name: file.name, preview: kind },
    });
    return {
      url: signed.url,
      expiresAt: signed.expiresAt,
      kind,
      mimeType: file.mimeType,
      name: file.name,
      sizeBytes: file.sizeBytes,
      maxTextBytes: PREVIEW_TEXT_MAX_BYTES,
    };
  }

  // -- single-file operations ------------------------------------------------

  async move(actor: AuthUser, spaceId: string, fileId: string, folderId: string | null): Promise<FileRecord> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    await this.assertWritable(spaceId);
    const file = await this.requireFile(spaceId, fileId);
    if (file.status === 'DELETED') throw new AppError('FILE_NOT_FOUND', 'File not found');
    await this.assertFolder(spaceId, folderId);

    const updated = await this.db.files.update(fileId, { folderId });
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId,
      action: ACTIVITY_ACTIONS.FILE_MOVED,
      metadata: { name: file.name, from: file.folderId, to: folderId },
    });
    return updated!;
  }

  /**
   * Restores a soft-deleted file. The object is only undeleted if it still
   * exists in storage; a missing object is reported instead of resurrecting a
   * record that would fail to download or archive.
   */
  async restore(actor: AuthUser, spaceId: string, fileId: string): Promise<FileRecord> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    await this.assertWritable(spaceId);
    const file = await this.requireFile(spaceId, fileId);
    if (file.status !== 'DELETED') throw new AppError('VALIDATION_ERROR', 'File is not deleted');

    try {
      await this.storage.headObject(file.objectKey);
    } catch {
      throw new AppError('FILE_OBJECT_MISSING', 'The stored object no longer exists, so this file cannot be restored');
    }

    const used = await this.db.files.usedBytesForSpace(spaceId);
    if (used + file.sizeBytes > this.env.spaceMaxBytes) {
      throw new AppError('QUOTA_EXCEEDED', 'Restoring this file would exceed the Space storage limit');
    }

    // A folder removed while the file was deleted is not recreated implicitly.
    let folderId = file.folderId;
    if (folderId) {
      const folder = await this.db.folders.findById(folderId);
      if (!folder || folder.spaceId !== spaceId) folderId = null;
    }

    const siblings = (await this.db.files.listActiveForSpace(spaceId)).filter(
      (f) => (f.folderId ?? null) === (folderId ?? null),
    );
    const name = uniqueName(file.name, siblings.map((f) => f.name));

    const updated = await this.db.files.update(fileId, {
      status: 'ACTIVE',
      deletedAt: null,
      folderId,
      name,
    });
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId,
      action: ACTIVITY_ACTIONS.FILE_RESTORED,
      metadata: { name },
    });
    return updated!;
  }

  /**
   * Cancels an upload that is still reserved. An object that already reached
   * storage is removed; a confirmed file cannot be cancelled (use delete).
   */
  async cancelUpload(actor: AuthUser, spaceId: string, fileId: string): Promise<void> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    const file = await this.requireFile(spaceId, fileId);
    if (file.status === 'ACTIVE') {
      throw new AppError('VALIDATION_ERROR', 'This upload is already confirmed; delete the file instead');
    }
    if (file.status === 'DELETED') return;
    await this.storage.deleteObject(file.objectKey).catch(() => undefined);
    await this.db.files.update(fileId, { status: 'DELETED', deletedAt: new Date().toISOString() });
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId,
      action: ACTIVITY_ACTIONS.FILE_UPLOAD_CANCELLED,
      metadata: { name: file.name },
    });
  }

  // -- bulk operations -------------------------------------------------------

  async bulkDelete(actor: AuthUser, spaceId: string, fileIds: string[]): Promise<BulkFileResult> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    const ids = this.uniqueIds(fileIds);
    const result: BulkFileResult = { succeeded: [], failed: [] };
    for (const id of ids) {
      try {
        // Reuses the single-file path, so each item is authorized and audited.
        await this.files.remove(actor, spaceId, id);
        result.succeeded.push(id);
      } catch (err) {
        result.failed.push({ id, error: err instanceof AppError ? err.message : 'Could not delete this file' });
      }
    }
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.FILES_BULK_DELETED,
      metadata: { requested: ids.length, deleted: result.succeeded.length, failed: result.failed.length },
    });
    return result;
  }

  async bulkMove(
    actor: AuthUser,
    spaceId: string,
    fileIds: string[],
    folderId: string | null,
  ): Promise<BulkFileResult> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    await this.assertWritable(spaceId);
    await this.assertFolder(spaceId, folderId);
    const ids = this.uniqueIds(fileIds);
    const result: BulkFileResult = { succeeded: [], failed: [] };
    for (const id of ids) {
      try {
        await this.move(actor, spaceId, id, folderId);
        result.succeeded.push(id);
      } catch (err) {
        result.failed.push({ id, error: err instanceof AppError ? err.message : 'Could not move this file' });
      }
    }
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.FILES_BULK_MOVED,
      metadata: { requested: ids.length, moved: result.succeeded.length, folderId },
    });
    return result;
  }

  /** Streams a ZIP of the selected files, preserving each folder path. */
  async bulkDownload(
    actor: AuthUser,
    spaceId: string,
    fileIds: string[],
  ): Promise<{ stream: Readable; filename: string; fileCount: number }> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    const ids = this.uniqueIds(fileIds);
    const files: FileRecord[] = [];
    for (const id of ids) {
      const file = await this.db.files.findById(id);
      if (!file || file.spaceId !== spaceId || file.status !== 'ACTIVE') {
        throw new AppError('FILE_NOT_FOUND', 'One or more selected files are not available');
      }
      files.push(file);
    }
    if (files.length === 0) throw new AppError('VALIDATION_ERROR', 'Select at least one file');

    const folders = await this.db.folders.listForSpace(spaceId);
    const paths = buildPathMap(folders);
    const used = new Set<string>();
    const entries: ZipEntry[] = [];
    let totalBytes = 0;
    for (const file of files) {
      totalBytes += file.sizeBytes;
      if (totalBytes > this.env.spaceMaxBytes) {
        throw new AppError('QUOTA_EXCEEDED', 'Selection is too large to download as one ZIP');
      }
      const dir = paths.get(file.folderId ?? '') ?? '';
      entries.push({
        name: uniqueEntryName(dir, file.name, used),
        getData: () => this.storage.getObject(file.objectKey),
      });
    }
    const space = await this.db.spaces.findById(spaceId);
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.FILES_BULK_DOWNLOADED,
      metadata: { fileCount: files.length, totalBytes },
    });
    return {
      stream: zipStream(entries),
      filename: `${sanitizeName(space?.name ?? 'space')}-files.zip`,
      fileCount: files.length,
    };
  }

  // -- folders ---------------------------------------------------------------

  async renameFolder(actor: AuthUser, spaceId: string, folderId: string, name: string): Promise<Folder> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    await this.assertWritable(spaceId);
    const folder = await this.requireFolder(spaceId, folderId);
    const safe = sanitizeName(name);
    if (!safe || safe === 'file') throw new AppError('VALIDATION_ERROR', 'A folder name is required');

    const siblings = (await this.db.folders.listForSpace(spaceId)).filter(
      (f) => (f.parentId ?? null) === (folder.parentId ?? null) && f.id !== folderId,
    );
    if (siblings.some((f) => f.name.toLowerCase() === safe.toLowerCase())) {
      throw new AppError('FOLDER_EXISTS', 'A folder with that name already exists here');
    }

    const oldPath = folder.path;
    const parentPath = oldPath.slice(0, oldPath.lastIndexOf(folder.name, oldPath.length - 2));
    const newPath = `${parentPath}${safe}/`;
    await this.db.folders.update(folder.id, { name: safe, path: newPath });
    // Descendants keep their identity and parent links; only their stored path
    // prefix changes so new uploads and archives stay consistent.
    if (newPath !== oldPath) {
      for (const child of await this.db.folders.listForSpace(spaceId)) {
        if (child.id !== folder.id && child.path.startsWith(oldPath)) {
          await this.db.folders.update(child.id, { path: `${newPath}${child.path.slice(oldPath.length)}` });
        }
      }
    }
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.FOLDER_RENAMED,
      metadata: { from: folder.name, to: safe },
    });
    return (await this.db.folders.findById(folder.id))!;
  }

  async moveFolder(
    actor: AuthUser,
    spaceId: string,
    folderId: string,
    parentId: string | null,
  ): Promise<Folder> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    await this.assertWritable(spaceId);
    const folder = await this.requireFolder(spaceId, folderId);
    await this.assertFolder(spaceId, parentId);

    if (parentId === folderId) throw new AppError('VALIDATION_ERROR', 'A folder cannot contain itself');
    if (parentId) {
      // Walking up from the destination catches every descendant, so a folder
      // can never be moved inside its own subtree (no cycles).
      let cursor: Folder | undefined = await this.db.folders.findById(parentId);
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor.id)) {
        if (cursor.id === folderId) {
          throw new AppError('VALIDATION_ERROR', 'A folder cannot be moved inside itself');
        }
        seen.add(cursor.id);
        cursor = cursor.parentId ? await this.db.folders.findById(cursor.parentId) : undefined;
      }
    }

    const parentPath = parentId
      ? ((await this.db.folders.findById(parentId))?.path ?? '')
      : '';
    const siblings = (await this.db.folders.listForSpace(spaceId)).filter(
      (f) => (f.parentId ?? null) === parentId && f.id !== folderId,
    );
    if (siblings.some((f) => f.name.toLowerCase() === folder.name.toLowerCase())) {
      throw new AppError('FOLDER_EXISTS', 'A folder with that name already exists there');
    }

    const oldPath = folder.path;
    const newPath = `${parentPath}${folder.name}/`;
    await this.db.folders.update(folder.id, { parentId, path: newPath });
    if (newPath !== oldPath) {
      for (const child of await this.db.folders.listForSpace(spaceId)) {
        if (child.id !== folder.id && child.path.startsWith(oldPath)) {
          await this.db.folders.update(child.id, { path: `${newPath}${child.path.slice(oldPath.length)}` });
        }
      }
    }
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.FOLDER_MOVED,
      metadata: { name: folder.name, from: folder.parentId, to: parentId },
    });
    return (await this.db.folders.findById(folder.id))!;
  }

  /**
   * Deletes a folder. Non-empty folders require `recursive`, which soft-deletes
   * every file underneath (so the cleanup job can reclaim the objects) and
   * removes the descendant folder rows. Empty folders delete directly.
   */
  async deleteFolder(
    actor: AuthUser,
    spaceId: string,
    folderId: string,
    recursive: boolean,
  ): Promise<{ filesDeleted: number; foldersDeleted: number }> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    await this.assertWritable(spaceId);
    const folder = await this.requireFolder(spaceId, folderId);

    const allFolders = await this.db.folders.listForSpace(spaceId);
    const descendants = allFolders.filter((f) => f.id !== folderId && f.path.startsWith(folder.path));
    const subtreeIds = new Set([folderId, ...descendants.map((f) => f.id)]);
    const filesInside = (await this.db.files.listActiveForSpace(spaceId)).filter(
      (f) => f.folderId && subtreeIds.has(f.folderId),
    );

    if (!recursive && (descendants.length > 0 || filesInside.length > 0)) {
      throw new AppError(
        'FOLDER_NOT_EMPTY',
        'This folder is not empty. Move its contents or delete it recursively.',
      );
    }

    for (const file of filesInside) {
      await this.db.files.update(file.id, { status: 'DELETED', deletedAt: new Date().toISOString() });
    }
    // Deepest first, then the folder itself.
    for (const child of descendants.sort((a, b) => b.path.length - a.path.length)) {
      await this.db.folders.delete(child.id);
    }
    await this.db.folders.delete(folder.id);
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.FOLDER_DELETED,
      metadata: {
        name: folder.name,
        recursive,
        filesDeleted: filesInside.length,
        foldersDeleted: descendants.length + 1,
      },
    });
    return { filesDeleted: filesInside.length, foldersDeleted: descendants.length + 1 };
  }

  async folderStats(actor: AuthUser, spaceId: string, folderId: string | null): Promise<FolderStats> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    const [files, folders] = await Promise.all([
      this.db.files.listActiveForSpace(spaceId),
      this.db.folders.listForSpace(spaceId),
    ]);
    let prefix = '';
    if (folderId) {
      const folder = await this.requireFolder(spaceId, folderId);
      prefix = folder.path;
    }
    const subtree = new Set(
      folders.filter((f) => (prefix ? f.path.startsWith(prefix) : true)).map((f) => f.id),
    );
    const inScope = files.filter(
      (f) => (folderId === null ? true : f.folderId !== null && subtree.has(f.folderId)),
    );
    return {
      folderId,
      fileCount: inScope.length,
      folderCount: folderId === null ? folders.length : Math.max(0, subtree.size - 1),
      usedBytes: inScope.reduce((sum, f) => sum + f.sizeBytes, 0),
    };
  }

  // -- helpers ---------------------------------------------------------------

  private async requireFile(spaceId: string, fileId: string): Promise<FileRecord> {
    const file = await this.db.files.findById(fileId);
    if (!file || file.spaceId !== spaceId) throw new AppError('FILE_NOT_FOUND', 'File not found');
    return file;
  }

  private async requireFolder(spaceId: string, folderId: string): Promise<Folder> {
    const folder = await this.db.folders.findById(folderId);
    if (!folder || folder.spaceId !== spaceId) throw new AppError('VALIDATION_ERROR', 'Folder not found');
    return folder;
  }

  private async assertFolder(spaceId: string, folderId: string | null): Promise<void> {
    if (folderId === null) return;
    await this.requireFolder(spaceId, folderId);
  }

  private async assertWritable(spaceId: string): Promise<void> {
    const space = await this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    this.spaces.assertWritable(space);
  }

  private uniqueIds(ids: string[]): string[] {
    const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
    if (unique.length === 0) throw new AppError('VALIDATION_ERROR', 'Select at least one file');
    if (unique.length > MAX_BULK_FILES) {
      throw new AppError('VALIDATION_ERROR', `Select at most ${MAX_BULK_FILES} files at once`);
    }
    return unique;
  }

  private async uploaderNames(ids: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const id of new Set(ids)) {
      if (!id || names.has(id)) continue;
      const profile = await this.db.auth.findById(id);
      if (profile) names.set(id, profile.displayName);
    }
    return names;
  }

  private toListItem(file: FileRecord, paths: Map<string, string>, names: Map<string, string>): FileListItem {
    return {
      ...file,
      uploaderName: names.get(file.uploaderId) ?? null,
      folderPath: file.folderId ? (paths.get(file.folderId) ?? null) : null,
      previewKind: previewKindFor(file.mimeType, file.name),
    };
  }
}

/** folderId ('' for root) → path ending in `/`; cycle-safe. */
function buildPathMap(folders: Folder[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();
  const resolve = (folder: Folder, seen: Set<string>): string => {
    const cached = paths.get(folder.id);
    if (cached !== undefined) return cached;
    if (seen.has(folder.id)) return '';
    seen.add(folder.id);
    const parent = folder.parentId ? byId.get(folder.parentId) : undefined;
    const path = `${parent ? resolve(parent, seen) : ''}${folder.name}/`;
    paths.set(folder.id, path);
    return path;
  };
  for (const folder of folders) resolve(folder, new Set());
  return paths;
}

/** Appends ` (2)`, ` (3)`… until the name is free in its folder. */
function uniqueName(name: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} (${newId().slice(0, 8)})${ext}`;
}
