import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Archive, ArchiveStatus, AuthUser, SignedDownload } from '@flashspace/shared';
import { AppError, ACTIVITY_ACTIONS, STORAGE_PATHS } from '@flashspace/shared';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { StorageAdapter } from '../storage/index.js';
import { newId } from '../utils/ids.js';
import { zipStream, type ZipEntry } from '../utils/zip.js';
import { folderPathFor, uniqueEntryName } from '../utils/folder-path.js';
import type { SpacesService } from './spaces.service.js';

/**
 * Archive engine (PRD §8): when a Space expires the lifecycle worker flips it
 * to ARCHIVING, streams every active file through a deterministic ZIP writer,
 * stores the ZIP + manifest in the owner's Vault, verifies size + count, then
 * flips the Space to ARCHIVED.
 */
export class ArchiveService {
  constructor(
    private readonly db: DataLayer,
    private readonly storage: StorageAdapter,
    private readonly spaces: SpacesService,
  ) {}

  /**
   * Archive a Space on the owner's command (PRD §9.5). The Space stops being
   * writable and moves to the owner's Vault; `archivedManually` keeps it out of
   * the automatic retention cleanup so the owner stays in control of deletion.
   */
  async archiveNow(actor: AuthUser, spaceId: string): Promise<Archive> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER']);
    const space = await this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');

    if (space.status === 'ARCHIVED') {
      const existing = (await this.db.archives.listForSpace(spaceId)).find((a) => a.status === 'VERIFIED');
      if (existing) return existing;
    }
    this.spaces.assertWritable(space);

    // Flag first so a failure mid-flight cannot let the cleanup job sweep it.
    await this.db.spaces.update(spaceId, { archivedManually: true });
    const archive = await this.createPendingArchive(spaceId);
    const verified = await this.runArchive(archive.id);
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.SPACE_ARCHIVED_MANUALLY,
      metadata: { archiveId: verified.id, fileCount: verified.fileCount },
    });
    return verified;
  }

  async createPendingArchive(spaceId: string): Promise<Archive> {
    const space = await this.db.spaces.findById(spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    const existing = (await this.db.archives.listForSpace(spaceId)).find((a) => a.status !== 'FAILED');
    if (existing) return existing;
    const archive: Archive = {
      id: newId(),
      spaceId,
      ownerId: space.ownerId,
      objectKey: STORAGE_PATHS.archiveZip(space.ownerId, spaceId, newId()),
      sizeBytes: 0,
      checksum: null,
      fileCount: 0,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      verifiedAt: null,
    };
    await this.db.archives.insert(archive);
    return archive;
  }

  async runArchive(archiveId: string): Promise<Archive> {
    const archive = await this.db.archives.findById(archiveId);
    if (!archive) throw new AppError('ARCHIVE_NOT_FOUND', 'Archive not found');
    if (archive.status === 'CREATING') return archive; // another worker owns it
    const space = await this.db.spaces.findById(archive.spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');

    await this.db.archives.update(archiveId, { status: 'CREATING' });
    await this.db.spaces.update(archive.spaceId, { status: 'ARCHIVING' });
    await this.db.activity.append({
      spaceId: archive.spaceId,
      action: ACTIVITY_ACTIONS.ARCHIVE_STARTED,
      actorType: 'SYSTEM',
      category: 'ARCHIVE',
      resourceType: 'archive',
      resourceId: archiveId,
      metadata: { archiveId, ownerId: archive.ownerId },
    });
    try {
      const files = await this.db.files.listActiveForSpace(archive.spaceId);
      // Preserve the original directory hierarchy (PRD §5.6) and never let two
      // different files collide on the same ZIP entry name.
      const usedNames = new Set<string>();
      const entries: { file: (typeof files)[number]; path: string; entryName: string }[] = [];
      for (const f of files) {
        const path = await folderPathFor(this.db.folders, archive.spaceId, f.folderId);
        entries.push({ file: f, path, entryName: uniqueEntryName(path, f.name, usedNames) });
      }
      const manifest = {
        archiveId,
        spaceId: archive.spaceId,
        spaceName: space.name,
        createdAt: new Date().toISOString(),
        entries: entries.map(({ file: f, path, entryName }) => ({
          fileId: f.id,
          name: f.name,
          path: entryName,
          folderPath: path || null,
          sizeBytes: f.sizeBytes,
          mimeType: f.mimeType,
          uploadedAt: f.createdAt,
        })),
      };

      const fileCount = files.length;
      let bytes = 0;
      async function* countBytes(source: Readable): AsyncGenerator<Buffer> {
        for await (const chunk of source) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          bytes += buf.length;
          yield buf;
        }
      }
      const zip = zipStream(
        entries.map(({ file: f, entryName }): ZipEntry => ({
          name: entryName,
          getData: () => this.storage.getObject(f.objectKey),
        })),
      );

      const objectKey = STORAGE_PATHS.archiveZip(archive.ownerId, archive.spaceId, archiveId);
      // Counting runs inside the generator chain so upstream errors (e.g. a
      // missing object) propagate and reject the putObject pipeline.
      const body = Readable.from(countBytes(zip));
      const stored = await this.storage.putObject(objectKey, body);
      await this.storage.putObject(
        STORAGE_PATHS.archiveManifest(archive.ownerId, archive.spaceId, archiveId),
        Buffer.from(JSON.stringify(manifest, null, 2)),
      );

      // Verify (PRD §8.3): object exists and byte count matches what we streamed.
      const head = await this.storage.headObject(objectKey);
      if (head.size !== bytes) {
        throw new AppError('ARCHIVE_ERROR', 'Archive verification failed: size mismatch');
      }
      // Persist a content checksum so clients/integrity checks can verify the
      // archive independently of the stored size (PRD §6).
      const storedStream = await this.storage.getObject(objectKey);
      const checksum = createHash('sha256');
      for await (const chunk of storedStream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        checksum.update(buf);
      }
      const checksumHex = checksum.digest('hex');
      const updated = await this.db.archives.update(archiveId, {
        objectKey,
        sizeBytes: stored.size,
        checksum: checksumHex,
        fileCount,
        status: 'VERIFIED',
        verifiedAt: new Date().toISOString(),
      });
      await this.db.spaces.update(archive.spaceId, { status: 'ARCHIVED' });
      await this.spaces.notify(
        archive.ownerId,
        archive.spaceId,
        'SPACE_ARCHIVED',
        `Space "${space.name}" archived`,
        `A verified archive (${fileCount} file${fileCount === 1 ? '' : 's'}) is now in your Vault.`,
      );
      // Worker-generated events are attributed to SYSTEM, with the owning
      // account kept as metadata rather than as a false actor.
      await this.db.activity.append({
        spaceId: archive.spaceId,
        action: ACTIVITY_ACTIONS.ARCHIVE_VERIFIED,
        actorType: 'SYSTEM',
        category: 'ARCHIVE',
        resourceType: 'archive',
        resourceId: archiveId,
        metadata: {
          archiveId,
          ownerId: archive.ownerId,
          fileCount,
          sizeBytes: stored.size,
          checksum: checksumHex,
        },
      });
      await this.db.activity.append({
        spaceId: archive.spaceId,
        fileId: null,
        action: ACTIVITY_ACTIONS.SPACE_ARCHIVED,
        actorType: 'SYSTEM',
        category: 'ARCHIVE',
        resourceType: 'space',
        resourceId: archive.spaceId,
        metadata: { archiveId, ownerId: archive.ownerId, fileCount, sizeBytes: stored.size },
      });
      return updated!;
    } catch (err) {
      await this.db.archives.update(archiveId, { status: 'FAILED' });
      await this.db.spaces.update(archive.spaceId, { status: 'ARCHIVE_FAILED' });
      await this.spaces.notify(
        archive.ownerId,
        archive.spaceId,
        'ARCHIVE_FAILED',
        `Archiving failed for "${space.name}"`,
        'You can retry from the admin console. The Space is preserved until archiving succeeds.',
      );
      await this.db.activity.append({
        spaceId: archive.spaceId,
        fileId: null,
        action: ACTIVITY_ACTIONS.ARCHIVE_VERIFICATION_FAILED,
        actorType: 'SYSTEM',
        category: 'ARCHIVE',
        outcome: 'FAILURE',
        resourceType: 'archive',
        resourceId: archiveId,
        reason: err instanceof Error ? err.message : String(err),
        metadata: { archiveId, ownerId: archive.ownerId },
      });
      await this.db.activity.append({
        spaceId: archive.spaceId,
        fileId: null,
        action: ACTIVITY_ACTIONS.ARCHIVE_FAILED,
        actorType: 'SYSTEM',
        category: 'ARCHIVE',
        outcome: 'FAILURE',
        resourceType: 'archive',
        resourceId: archiveId,
        reason: err instanceof Error ? err.message : String(err),
        metadata: { archiveId, ownerId: archive.ownerId },
      });
      throw err;
    }
  }

  async listVault(actor: AuthUser): Promise<Archive[]> {
    return this.db.archives.listForOwner(actor.id);
  }

  /** Filtered Vault listing with search, status filter, sort, and pagination.
   *  Only returns archives the actor owns (or all for ADMIN).
   */
  async listVaultFiltered(
    actor: AuthUser,
    opts: {
      q?: string;
      status?: string;
      sort?: 'newest' | 'oldest' | 'size-asc' | 'size-desc';
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ archives: Archive[]; total: number }> {
    const admin = await this.db.auth.findById(actor.id);
    const isAdmin = admin?.role === 'ADMIN';
    let rows = isAdmin ? await this.db.archives.listAll() : await this.db.archives.listForOwner(actor.id);

    const q = (opts.q ?? '').toLowerCase().slice(0, 120);
    if (q) {
      const spaceNames = new Map<string, string>();
      for (const a of rows) {
        if (!spaceNames.has(a.spaceId)) {
          const s = await this.db.spaces.findById(a.spaceId);
          spaceNames.set(a.spaceId, s?.name.toLowerCase() ?? '');
        }
      }
      rows = rows.filter((a) => spaceNames.get(a.spaceId)!.includes(q));
    }

    if (opts.status && opts.status !== 'ALL') {
      rows = rows.filter((a) => a.status === opts.status);
    }

    const total = rows.length;
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.min(100, opts.limit ?? 50);
    rows = rows.slice(offset, offset + limit);

    const sort = opts.sort ?? 'newest';
    rows = [...rows].sort((a, b) => {
      if (sort === 'newest') return b.createdAt.localeCompare(a.createdAt);
      if (sort === 'oldest') return a.createdAt.localeCompare(b.createdAt);
      if (sort === 'size-asc') return a.sizeBytes - b.sizeBytes;
      if (sort === 'size-desc') return b.sizeBytes - a.sizeBytes;
      return 0;
    });

    return { archives: rows, total };
  }

  /** Full archive detail with Space info attached. */
  async getArchive(actor: AuthUser, archiveId: string): Promise<{
    archive: Archive;
    spaceName: string | null;
    spaceStatus: string | null;
    ownerName: string | null;
  }> {
    const archive = await this.db.archives.findById(archiveId);
    if (!archive) throw new AppError('ARCHIVE_NOT_FOUND', 'Archive not found');
    if (archive.ownerId !== actor.id && (await this.db.auth.findById(actor.id))?.role !== 'ADMIN') {
      throw new AppError('SPACE_ACCESS_DENIED', 'You do not own this archive');
    }
    const space = await this.db.spaces.findById(archive.spaceId);
    const owner = await this.db.auth.findById(archive.ownerId);
    return {
      archive,
      spaceName: space?.name ?? null,
      spaceStatus: space?.status ?? null,
      ownerName: owner?.displayName ?? null,
    };
  }

  /** Returns the file listing from the stored manifest without downloading the ZIP.
   *  Falls back to an empty list when the manifest is missing.
   */
  async getArchiveFiles(actor: AuthUser, archiveId: string): Promise<{ files: ArchiveFileView[]; manifestVerified: boolean }> {
    const archive = await this.db.archives.findById(archiveId);
    if (!archive) throw new AppError('ARCHIVE_NOT_FOUND', 'Archive not found');
    if (archive.ownerId !== actor.id && (await this.db.auth.findById(actor.id))?.role !== 'ADMIN') {
      throw new AppError('SPACE_ACCESS_DENIED', 'You do not own this archive');
    }
    const manifestKey = STORAGE_PATHS.archiveManifest(archive.ownerId, archive.spaceId, archiveId);
    let manifest: { entries?: Array<{ fileId: string; name: string; path: string; folderPath: string | null; sizeBytes: number; mimeType: string; uploadedAt: string }> } | null = null;
    try {
      const stream = await this.storage.getObject(manifestKey);
      const buf = await consumeStream(stream);
      manifest = JSON.parse(buf.toString('utf8'));
    } catch {
      // missing or unreadable manifest
    }
    if (!manifest?.entries) {
      return { files: [], manifestVerified: false };
    }
    return { files: manifest.entries.map((e) => ({
      fileId: e.fileId,
      name: e.name,
      path: e.path,
      folderPath: e.folderPath,
      sizeBytes: e.sizeBytes,
      mimeType: e.mimeType,
      uploadedAt: e.uploadedAt,
    })), manifestVerified: true };
  }

  /** Re-verify archive integrity: object exists, size matches, SHA-256 matches,
   *  manifest present and consistent.
   */
  async verifyArchive(actor: AuthUser, archiveId: string): Promise<{
    archive: Archive;
    verified: boolean;
    checks: VerificationCheck[];
  }> {
    const archive = await this.db.archives.findById(archiveId);
    if (!archive) throw new AppError('ARCHIVE_NOT_FOUND', 'Archive not found');
    if (archive.ownerId !== actor.id && (await this.db.auth.findById(actor.id))?.role !== 'ADMIN') {
      throw new AppError('SPACE_ACCESS_DENIED', 'You do not own this archive');
    }

    const checks: VerificationCheck[] = [];
    let verified = true;

    // 1. Object exists + size match
    let head: { size: number } | null = null;
    try {
      head = await this.storage.headObject(archive.objectKey);
      checks.push({ name: 'object-exists', passed: true });
    } catch {
      checks.push({ name: 'object-exists', passed: false, message: 'Archive object not found in storage' });
      verified = false;
    }

    if (head) {
      if (head.size === archive.sizeBytes) {
        checks.push({ name: 'size-match', passed: true });
      } else {
        checks.push({ name: 'size-match', passed: false, message: `Expected ${archive.sizeBytes}, got ${head.size}` });
        verified = false;
      }
    }

    // 2. SHA-256 checksum
    if (head && archive.checksum) {
      try {
        const stream = await this.storage.getObject(archive.objectKey);
        const hash = createHash('sha256');
        for await (const chunk of stream) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          hash.update(buf);
        }
        const actual = hash.digest('hex');
        if (actual === archive.checksum) {
          checks.push({ name: 'checksum', passed: true });
        } else {
          checks.push({ name: 'checksum', passed: false, message: 'Checksum mismatch' });
          verified = false;
        }
      } catch (err) {
        checks.push({ name: 'checksum', passed: false, message: err instanceof Error ? err.message : String(err) });
        verified = false;
      }
    } else if (!archive.checksum) {
      checks.push({ name: 'checksum', passed: false, message: 'No checksum recorded' });
      verified = false;
    }

    // 3. Manifest exists and is parseable
    const manifestKey = STORAGE_PATHS.archiveManifest(archive.ownerId, archive.spaceId, archiveId);
    let manifestEntries = 0;
    try {
      const stream = await this.storage.getObject(manifestKey);
      const buf = await consumeStream(stream);
      const manifest = JSON.parse(buf.toString('utf8'));
      if (Array.isArray(manifest.entries)) {
        manifestEntries = manifest.entries.length;
        checks.push({ name: 'manifest', passed: true, details: ` ${manifest.entries.length} entries` });
      } else {
        checks.push({ name: 'manifest', passed: false, message: 'Manifest invalid structure' });
        verified = false;
      }
    } catch {
      checks.push({ name: 'manifest', passed: false, message: 'Manifest missing or unreadable' });
      verified = false;
    }

    // 4. File count consistency
    if (archive.fileCount > 0 && manifestEntries > 0) {
      if (archive.fileCount === manifestEntries) {
        checks.push({ name: 'file-count', passed: true });
      } else {
        checks.push({ name: 'file-count', passed: false, message: `Archive says ${archive.fileCount} files, manifest has ${manifestEntries}` });
        verified = false;
      }
    } else {
      checks.push({ name: 'file-count', passed: !!archive.fileCount, message: archive.fileCount ? 'Manifest missing' : 'No file count recorded' });
      if (!archive.fileCount) verified = false;
    }

    // Update status if verification result changed meaningfully
    const newStatus: ArchiveStatus = verified ? 'VERIFIED' : 'FAILED';
    if (archive.status !== newStatus) {
      await this.db.archives.update(archiveId, { status: newStatus, verifiedAt: verified ? new Date().toISOString() : archive.verifiedAt });
    }

    const refreshed = await this.db.archives.findById(archiveId);
    if (!refreshed) throw new AppError('ARCHIVE_NOT_FOUND', 'Archive not found after verification');
    return {
      archive: refreshed,
      verified,
      checks,
    };
  }

  /** Download the manifest JSON as a signed URL. */
  async downloadManifest(actor: AuthUser, archiveId: string): Promise<SignedDownload> {
    const archive = await this.db.archives.findById(archiveId);
    if (!archive) throw new AppError('ARCHIVE_NOT_FOUND', 'Archive not found');
    if (archive.ownerId !== actor.id && (await this.db.auth.findById(actor.id))?.role !== 'ADMIN') {
      throw new AppError('SPACE_ACCESS_DENIED', 'You do not own this archive');
    }
    const manifestKey = STORAGE_PATHS.archiveManifest(archive.ownerId, archive.spaceId, archiveId);
    await this.storage.headObject(manifestKey);
    const space = await this.db.spaces.findById(archive.spaceId);
    const name = `${space?.name ?? 'space'}-manifest.json`;
    return this.storage.createSignedDownloadUrl(manifestKey, 300, sanitizeArchiveName(name));
  }

  async download(actor: AuthUser, archiveId: string): Promise<SignedDownload> {
    const archive = await this.db.archives.findById(archiveId);
    if (!archive) throw new AppError('ARCHIVE_NOT_FOUND', 'Archive not found');
    if (archive.ownerId !== actor.id && (await this.db.auth.findById(actor.id))?.role !== 'ADMIN') {
      throw new AppError('SPACE_ACCESS_DENIED', 'Only the Space owner can download this archive');
    }
    if (archive.status !== 'VERIFIED') {
      throw new AppError('ARCHIVE_NOT_VERIFIED', 'Archive is not verified for download yet');
    }
    await this.storage.headObject(archive.objectKey);
    const space = await this.db.spaces.findById(archive.spaceId);
    const name = `${space?.name ?? 'space'}-archive.zip`;
    // No signed URL or object key is recorded — only that a download happened.
    await this.db.activity.append({
      userId: actor.id,
      spaceId: archive.spaceId,
      action: ACTIVITY_ACTIONS.ARCHIVE_DOWNLOADED,
      category: 'ARCHIVE',
      resourceType: 'archive',
      resourceId: archiveId,
      metadata: { archiveId, fileCount: archive.fileCount, sizeBytes: archive.sizeBytes },
    });
    return this.storage.createSignedDownloadUrl(archive.objectKey, 300, sanitizeArchiveName(name));
  }
}

/** One check performed during archive verification. */
export interface VerificationCheck {
  name: string;
  passed: boolean;
  message?: string;
  details?: string;
}

/** One file listed inside an archive manifest. */
export interface ArchiveFileView {
  fileId: string;
  name: string;
  path: string;
  folderPath: string | null;
  sizeBytes: number;
  mimeType: string;
  uploadedAt: string;
}

async function consumeStream(stream: AsyncIterable<Buffer | Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) {
    parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

function sanitizeArchiveName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120);
}
