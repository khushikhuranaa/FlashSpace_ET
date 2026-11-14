import type {
  AuthUser,
  DuplicateSpaceResult,
  FileRecord,
  Folder,
  MemberRole,
  Space,
  SpaceDetail,
  SpaceListQuery,
  SpaceStorageBreakdown,
} from '@flashspace/shared';
import { ACTIVITY_ACTIONS, AppError, STORAGE_PATHS } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { StorageAdapter } from '../storage/index.js';
import type { SpacesService } from './spaces.service.js';
import { newId } from '../utils/ids.js';
import { safeSegment } from '../utils/folder-path.js';

export interface SpaceSettingsPatch {
  name?: string;
  purpose?: string;
  description?: string;
  expiryAt?: string;
  invitationsEnabled?: boolean;
  defaultInviteRole?: MemberRole;
}

export interface DuplicateInput {
  name?: string;
  expiryAt?: string;
  copyFiles?: boolean;
}

/**
 * Space management (Module 3): listing, settings, storage, favourites,
 * duplication and recently accessed Spaces.
 *
 * Everything here delegates to the existing services where behaviour already
 * exists — creation goes through `SpacesService.create`, archiving through
 * `ArchiveService`, membership through `MembershipService`. This service only
 * adds the management surface, and every method starts with an authorization
 * check derived from the authenticated user.
 */
export class SpaceManagementService {
  constructor(
    private readonly env: Env,
    private readonly db: DataLayer,
    private readonly storage: StorageAdapter,
    private readonly spaces: SpacesService,
  ) {}

  // -- listing ---------------------------------------------------------------

  async list(actor: AuthUser, query: SpaceListQuery): Promise<{ spaces: SpaceDetail[]; total: number }> {
    const all = await this.spaces.listForUser(actor.id);
    const warningMs = this.env.warningWindowHours * 3_600_000;
    const now = Date.now();
    const isExpiring = (space: Space): boolean =>
      space.status === 'WARNING' ||
      ((space.status === 'ACTIVE' || space.status === 'DRAFT') &&
        new Date(space.expiryAt).getTime() - now <= warningMs);

    let items = all;

    if (query.status && query.status !== 'ALL') {
      if (query.status === 'EXPIRING') items = items.filter((s) => s.status !== 'ARCHIVED' && isExpiring(s));
      else if (query.status === 'ACTIVE') {
        // "Active" means live, not-yet-archived work: DRAFT, ACTIVE or WARNING.
        items = items.filter((s) => s.status === 'DRAFT' || s.status === 'ACTIVE' || s.status === 'WARNING');
      } else items = items.filter((s) => s.status === query.status);
    }
    if (query.purpose) items = items.filter((s) => s.purpose === query.purpose);
    if (query.ownership === 'owned') items = items.filter((s) => s.ownerId === actor.id);
    if (query.ownership === 'shared') items = items.filter((s) => s.ownerId !== actor.id);

    const q = (query.q ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (q) {
      items = items.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.purpose.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      );
    }
    if (query.favorite) items = items.filter((s) => s.favorite);

    items = [...items].sort((a, b) => {
      switch (query.sort) {
        case 'oldest':
          return a.createdAt.localeCompare(b.createdAt);
        case 'name-asc':
          return a.name.localeCompare(b.name);
        case 'name-desc':
          return b.name.localeCompare(a.name);
        case 'expiry':
          return a.expiryAt.localeCompare(b.expiryAt);
        case 'storage':
          return b.storageUsedBytes - a.storageUsedBytes;
        case 'accessed':
          return (b.lastAccessedAt ?? '').localeCompare(a.lastAccessedAt ?? '');
        case 'recent':
        default:
          return b.createdAt.localeCompare(a.createdAt);
      }
    });

    const total = items.length;
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const offset = Math.max(0, query.offset ?? 0);
    return { spaces: items.slice(offset, offset + limit), total };
  }

  // -- settings --------------------------------------------------------------

  async settings(actor: AuthUser, spaceId: string, patch: SpaceSettingsPatch): Promise<SpaceDetail> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER']);
    const space = await this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    this.spaces.assertWritable(space);

    const content: { name?: string; purpose?: string; description?: string; expiryAt?: string } = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length < 3 || name.length > 120) {
        throw new AppError('VALIDATION_ERROR', 'Space name must be between 3 and 120 characters');
      }
      content.name = name;
    }
    if (patch.purpose !== undefined) {
      const purpose = patch.purpose.trim();
      if (!purpose || purpose.length > 120) {
        throw new AppError('VALIDATION_ERROR', 'Purpose must be between 1 and 120 characters');
      }
      content.purpose = purpose;
    }
    if (patch.description !== undefined) {
      if (patch.description.length > 2000) {
        throw new AppError('VALIDATION_ERROR', 'Description cannot exceed 2000 characters');
      }
      content.description = patch.description.trim();
    }
    if (patch.expiryAt !== undefined) {
      const expiry = new Date(patch.expiryAt);
      if (Number.isNaN(expiry.getTime())) {
        throw new AppError('VALIDATION_ERROR', 'expiryAt must be an ISO datetime');
      }
      if (expiry <= new Date(space.startAt)) {
        throw new AppError('INVALID_DATE_RANGE', 'The end time must be after the start time');
      }
      content.expiryAt = expiry.toISOString();
    }

    if (Object.keys(content).length > 0) {
      await this.spaces.update(actor, spaceId, content);
    }

    const invitationPatch: Partial<Space> = {};
    if (patch.invitationsEnabled !== undefined) invitationPatch.invitationsEnabled = patch.invitationsEnabled;
    if (patch.defaultInviteRole !== undefined) {
      if (patch.defaultInviteRole !== 'EDITOR' && patch.defaultInviteRole !== 'VIEWER') {
        throw new AppError('VALIDATION_ERROR', 'defaultInviteRole must be EDITOR or VIEWER');
      }
      invitationPatch.defaultInviteRole = patch.defaultInviteRole;
    }
    if (Object.keys(invitationPatch).length > 0) {
      await this.db.spaces.update(spaceId, invitationPatch);
    }

    // Moving the deadline out of the warning window re-arms the reminder: the
    // lifecycle runner only warns a Space once, so without this a Space extended
    // past the window would never warn again.
    if (content.expiryAt) {
      const warnAt = Date.now() + this.env.warningWindowHours * 3_600_000;
      const moved = new Date(content.expiryAt).getTime();
      const updated = await this.db.spaces.findById(spaceId);
      if (updated?.warningSentAt && moved > warnAt) {
        await this.db.spaces.update(spaceId, { warningSentAt: null });
      }
    }

    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.SPACE_SETTINGS_UPDATED,
      metadata: { fields: Object.keys({ ...content, ...invitationPatch }) },
    });

    return this.spaces.getForUser(spaceId, actor.id);
  }

  // -- storage ---------------------------------------------------------------

  async storageBreakdown(actor: AuthUser, spaceId: string): Promise<SpaceStorageBreakdown> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    const files = await this.db.files.listActiveForSpace(spaceId);
    const folders = await this.db.folders.listForSpace(spaceId);
    const usedBytes = await this.db.files.usedBytesForSpace(spaceId);
    const archivedBytes = (await this.db.archives.listForSpace(spaceId))
      .filter((a) => a.status === 'VERIFIED')
      .reduce((sum, a) => sum + a.sizeBytes, 0);
    const quotaBytes = this.env.spaceMaxBytes;
    const freeBytes = Math.max(0, quotaBytes - usedBytes);
    return {
      spaceId,
      usedBytes,
      quotaBytes,
      freeBytes,
      percentUsed: quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0,
      fileCount: files.length,
      folderCount: folders.length,
      archivedBytes,
    };
  }

  // -- favourites ------------------------------------------------------------

  async setFavorite(actor: AuthUser, spaceId: string, favorite: boolean): Promise<{ favorite: boolean }> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    if (favorite) {
      await this.db.favoriteSpaces.add(actor.id, spaceId, new Date().toISOString());
    } else {
      await this.db.favoriteSpaces.remove(actor.id, spaceId);
    }
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: favorite ? ACTIVITY_ACTIONS.SPACE_FAVORITED : ACTIVITY_ACTIONS.SPACE_UNFAVORITED,
      metadata: {},
    });
    return { favorite };
  }

  async favorites(actor: AuthUser): Promise<SpaceDetail[]> {
    return (await this.spaces.listForUser(actor.id)).filter((space) => space.favorite);
  }

  // -- recently accessed -----------------------------------------------------

  async recent(actor: AuthUser, limit = 6): Promise<SpaceDetail[]> {
    const accessible = new Map(
      (await this.spaces.listForUser(actor.id)).map((space) => [space.id, space]),
    );
    const rows = await this.db.access.listForUser(actor.id, Math.min(50, Math.max(1, limit * 3)));
    const out: SpaceDetail[] = [];
    for (const row of rows) {
      const space = accessible.get(row.spaceId);
      if (space) out.push(space);
      if (out.length >= limit) break;
    }
    return out;
  }

  // -- duplicate -------------------------------------------------------------

  /**
   * Forks a Space the caller owns into a brand-new Space.
   *
   * Copied: purpose, description, folder tree, and (opt-in) the files themselves
   * as independent storage objects. Not copied: members, invitations, archives,
   * lifecycle state or the old deadline — the copy starts fresh with the caller
   * as OWNER.
   */
  async duplicate(actor: AuthUser, sourceId: string, input: DuplicateInput): Promise<DuplicateSpaceResult> {
    await this.spaces.requireRole(sourceId, actor.id, ['OWNER']);
    const source = await this.db.spaces.findById(sourceId);
    if (!source || source.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');

    const now = Date.now();
    const sourceDuration = new Date(source.expiryAt).getTime() - new Date(source.startAt).getTime();
    const fallbackExpiry = new Date(now + Math.max(3_600_000, sourceDuration)).toISOString();
    let expiryAt = fallbackExpiry;
    if (input.expiryAt) {
      const parsed = new Date(input.expiryAt);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now) {
        throw new AppError('INVALID_DATE_RANGE', 'The new end time must be in the future');
      }
      expiryAt = parsed.toISOString();
    }

    const copy = await this.spaces.create(actor, {
      name: (input.name?.trim() || `${source.name} (copy)`).slice(0, 120),
      purpose: source.purpose,
      description: source.description,
      startAt: new Date(now).toISOString(),
      expiryAt,
    });
    // Copy the owner-controlled invitation preferences too.
    await this.db.spaces.update(copy.id, {
      invitationsEnabled: source.invitationsEnabled,
      defaultInviteRole: source.defaultInviteRole,
    });

    // Folders first, parents before children, so paths stay meaningful.
    const sourceFolders = (await this.db.folders.listForSpace(sourceId)).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    const folderMap = new Map<string, Folder>();
    for (const folder of sourceFolders) {
      const parent = folder.parentId ? folderMap.get(folder.parentId) : undefined;
      if (folder.parentId && !parent) continue; // orphaned subtree in the source
      const created = await this.db.folders.insert({
        id: newId(),
        spaceId: copy.id,
        parentId: parent?.id ?? null,
        name: folder.name,
        path: `${parent?.path ?? ''}${folder.name}/`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      folderMap.set(folder.id, created);
    }

    let filesCopied = 0;
    let filesSkipped = 0;
    let copiedBytes = 0;
    if (input.copyFiles) {
      for (const file of await this.db.files.listActiveForSpace(sourceId)) {
        if (copiedBytes + file.sizeBytes > this.env.spaceMaxBytes) {
          filesSkipped++;
          continue;
        }
        try {
          const newFileId = newId();
          const folder = file.folderId ? folderMap.get(file.folderId) : undefined;
          const objectKey = STORAGE_PATHS.spaceObject(
            copy.id,
            folder?.path ?? '',
            newFileId,
            purifyName(file.name),
          );
          const sourceStream = await this.storage.getObject(file.objectKey);
          const stored = await this.storage.putObject(objectKey, sourceStream);
          if (stored.size !== file.sizeBytes) {
            // Integrity check: never record a copy whose byte count differs.
            await this.storage.deleteObject(objectKey).catch(() => undefined);
            filesSkipped++;
            continue;
          }
          const record: FileRecord = {
            id: newFileId,
            spaceId: copy.id,
            folderId: folder?.id ?? null,
            uploaderId: actor.id,
            name: file.name,
            objectKey,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            etag: null,
            sha256: file.sha256,
            status: 'ACTIVE',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            deletedAt: null,
          };
          await this.db.files.insert(record);
          filesCopied++;
          copiedBytes += file.sizeBytes;
        } catch (err) {
          console.error(`[duplicate] could not copy file ${file.id}`, err);
          filesSkipped++;
        }
      }
    }

    await this.db.activity.append({
      userId: actor.id,
      spaceId: copy.id,
      fileId: null,
      action: ACTIVITY_ACTIONS.SPACE_DUPLICATED,
      metadata: {
        sourceSpaceId: sourceId,
        foldersCopied: folderMap.size,
        filesCopied,
        filesSkipped,
      },
    });

    return {
      space: await this.spaces.getForUser(copy.id, actor.id),
      foldersCopied: folderMap.size,
      filesCopied,
      filesSkipped,
    };
  }
}

/** Object-name sanitizer matching the upload path rules. */
function purifyName(name: string): string {
  const safe = safeSegment(name);
  return safe || 'file';
}
