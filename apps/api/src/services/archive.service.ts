import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Archive, AuthUser, SignedDownload } from '@flashspace/shared';
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
    this.spaces.requireRole(spaceId, actor.id, ['OWNER']);
    const space = this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');

    if (space.status === 'ARCHIVED') {
      const existing = this.db.archives.listForSpace(spaceId).find((a) => a.status === 'VERIFIED');
      if (existing) return existing;
    }
    this.spaces.assertWritable(space);

    // Flag first so a failure mid-flight cannot let the cleanup job sweep it.
    this.db.spaces.update(spaceId, { archivedManually: true });
    const archive = await this.createPendingArchive(spaceId);
    const verified = await this.runArchive(archive.id);
    this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.SPACE_ARCHIVED_MANUALLY,
      metadata: { archiveId: verified.id, fileCount: verified.fileCount },
    });
    return verified;
  }

  async createPendingArchive(spaceId: string): Promise<Archive> {
    const space = this.db.spaces.findById(spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    const existing = this.db.archives.listForSpace(spaceId).find((a) => a.status !== 'FAILED');
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
    this.db.archives.insert(archive);
    return archive;
  }

  async runArchive(archiveId: string): Promise<Archive> {
    const archive = this.db.archives.findById(archiveId);
    if (!archive) throw new AppError('ARCHIVE_NOT_FOUND', 'Archive not found');
    if (archive.status === 'CREATING') return archive; // another worker owns it
    const space = this.db.spaces.findById(archive.spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');

    this.db.archives.update(archiveId, { status: 'CREATING' });
    this.db.spaces.update(archive.spaceId, { status: 'ARCHIVING' });
    try {
      const files = this.db.files.listActiveForSpace(archive.spaceId);
      // Preserve the original directory hierarchy (PRD §5.6) and never let two
      // different files collide on the same ZIP entry name.
      const usedNames = new Set<string>();
      const entries = files.map((f) => {
        const path = folderPathFor(this.db.folders, archive.spaceId, f.folderId);
        const entryName = uniqueEntryName(path, f.name, usedNames);
        return { file: f, path, entryName };
      });
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
      const updated = this.db.archives.update(archiveId, {
        objectKey,
        sizeBytes: stored.size,
        checksum: checksumHex,
        fileCount,
        status: 'VERIFIED',
        verifiedAt: new Date().toISOString(),
      });
      this.db.spaces.update(archive.spaceId, { status: 'ARCHIVED' });
      this.spaces.notify(
        archive.ownerId,
        archive.spaceId,
        'SPACE_ARCHIVED',
        `Space "${space.name}" archived`,
        `A verified archive (${fileCount} file${fileCount === 1 ? '' : 's'}) is now in your Vault.`,
      );
      this.db.activity.append({
        userId: archive.ownerId,
        spaceId: archive.spaceId,
        fileId: null,
        action: ACTIVITY_ACTIONS.SPACE_ARCHIVED,
        metadata: { archiveId, fileCount, sizeBytes: stored.size },
      });
      return updated!;
    } catch (err) {
      this.db.archives.update(archiveId, { status: 'FAILED' });
      this.db.spaces.update(archive.spaceId, { status: 'ARCHIVE_FAILED' });
      this.spaces.notify(
        archive.ownerId,
        archive.spaceId,
        'ARCHIVE_FAILED',
        `Archiving failed for "${space.name}"`,
        'You can retry from the admin console. The Space is preserved until archiving succeeds.',
      );
      this.db.activity.append({
        userId: archive.ownerId,
        spaceId: archive.spaceId,
        fileId: null,
        action: ACTIVITY_ACTIONS.ARCHIVE_FAILED,
        metadata: { archiveId, error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }

  async listVault(actor: AuthUser): Promise<Archive[]> {
    return this.db.archives.listForOwner(actor.id);
  }

  async download(actor: AuthUser, archiveId: string): Promise<SignedDownload> {
    const archive = this.db.archives.findById(archiveId);
    if (!archive) throw new AppError('ARCHIVE_NOT_FOUND', 'Archive not found');
    if (archive.ownerId !== actor.id && this.db.auth.findById(actor.id)?.role !== 'ADMIN') {
      throw new AppError('SPACE_ACCESS_DENIED', 'Only the Space owner can download this archive');
    }
    if (archive.status !== 'VERIFIED') {
      throw new AppError('ARCHIVE_NOT_VERIFIED', 'Archive is not verified for download yet');
    }
    await this.storage.headObject(archive.objectKey);
    const name = `${this.db.spaces.findById(archive.spaceId)?.name ?? 'space'}-archive.zip`;
    return this.storage.createSignedDownloadUrl(archive.objectKey, 300, sanitizeArchiveName(name));
  }
}

function sanitizeArchiveName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120);
}

