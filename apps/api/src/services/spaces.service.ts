import type {
  ActivityLog,
  AuthUser,
  Folder,
  MemberRole,
  MemberView,
  Notification,
  Space,
  SpaceDetail,
  SpaceMember,
} from '@flashspace/shared';
import { AppError, ACTIVITY_ACTIONS } from '@flashspace/shared';
import { folderPathFor, safeSegment } from '../utils/folder-path.js';
import type { Env } from '../config/env.js';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import { newId } from '../utils/ids.js';

export interface NotifyOptions {
  inviteLinkId?: string | null;
  joinRequestId?: string | null;
}

/**
 * Space lifecycle-aware CRUD + membership (PRD §4, §9). Quota and status
 * rules are enforced here so every caller (REST, jobs, admin) shares them.
 *
 * Every repository call is awaited: the DataLayer contract returns
 * `Awaitable<T>` so one implementation serves the synchronous local backends
 * and the asynchronous PostgreSQL backend alike.
 */
export class SpacesService {
  constructor(
    private readonly env: Env,
    private readonly db: DataLayer,
  ) {}

  // -- queries -------------------------------------------------------------

  /** Every Space the user owns or is an active member of (archived included). */
  async listForUser(userId: string): Promise<SpaceDetail[]> {
    const memberships = await this.db.members.listForUser(userId);
    const seen = new Set<string>();
    const spaces: Space[] = [];
    for (const m of memberships) {
      const space = await this.db.spaces.findById(m.spaceId);
      if (space && space.status !== 'DELETED') {
        spaces.push(space);
        seen.add(space.id);
      }
    }
    for (const space of await this.db.spaces.list()) {
      if (space.ownerId === userId && space.status !== 'DELETED' && !seen.has(space.id)) {
        spaces.push(space);
        seen.add(space.id);
      }
    }
    const sorted = spaces.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return this.enrich(sorted, userId);
  }

  /**
   * Adds the per-viewer fields (star, owner name, last access) in three batched
   * lookups instead of one query per Space.
   */
  private async enrich(spaces: Space[], viewerId: string): Promise<SpaceDetail[]> {
    const favorites = new Set((await this.db.favoriteSpaces.listForUser(viewerId)).map((f) => f.spaceId));
    const access = new Map(
      (await this.db.access.listForUser(viewerId, 500)).map((a) => [a.spaceId, a.lastAccessedAt]),
    );
    const owners = new Map<string, string>();
    for (const space of spaces) {
      if (owners.has(space.ownerId)) continue;
      const profile = await this.db.auth.findById(space.ownerId);
      owners.set(space.ownerId, profile?.displayName ?? 'Unknown owner');
    }
    const details: SpaceDetail[] = [];
    for (const space of spaces) {
      details.push(
        await this.toDetail(space, viewerId, {
          favorite: favorites.has(space.id),
          ownerName: owners.get(space.ownerId) ?? null,
          lastAccessedAt: access.get(space.id) ?? null,
        }),
      );
    }
    return details;
  }

  async getForUser(spaceId: string, userId: string): Promise<SpaceDetail> {
    const space = await this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    const role = await this.roleOf(spaceId, userId);
    if (!role && (await this.db.auth.findById(userId))?.role !== 'ADMIN') {
      throw new AppError('SPACE_ACCESS_DENIED', 'You do not have access to this Space');
    }
    // Meaningful access event: the user actually opened this Space. Dashboard
    // "recently accessed" is built from these rows, never from renders.
    const accessedAt = new Date().toISOString();
    await this.db.access.touch(spaceId, userId, accessedAt);
    const favorite = (await this.db.favoriteSpaces.listForUser(userId)).some((f) => f.spaceId === spaceId);
    const owner = await this.db.auth.findById(space.ownerId);
    return this.toDetail(space, userId, {
      favorite,
      ownerName: owner?.displayName ?? null,
      lastAccessedAt: accessedAt,
    });
  }

  async roleOf(spaceId: string, userId: string): Promise<MemberRole | null> {
    const m = await this.db.members.find(spaceId, userId);
    return m && m.status === 'ACTIVE' ? m.role : null;
  }

  async requireRole(spaceId: string, userId: string, roles: MemberRole[]): Promise<MemberRole> {
    const role = await this.roleOf(spaceId, userId);
    if (!role) throw new AppError('SPACE_ACCESS_DENIED', 'You are not an active member of this Space');
    if (!roles.includes(role)) {
      throw new AppError('FORBIDDEN_ROLE', `Requires one of: ${roles.join(', ')}`);
    }
    return role;
  }

  /** Is the Space still writable (not archived/finalizing/deleted)? */
  assertWritable(space: Space): void {
    if (space.status !== 'DRAFT' && space.status !== 'ACTIVE' && space.status !== 'WARNING') {
      throw new AppError('SPACE_NOT_WRITABLE', 'This Space is no longer writable');
    }
  }

  /** Members of a Space enriched with the profile users see in the UI. */
  async memberViews(spaceId: string): Promise<MemberView[]> {
    const members = (await this.db.members.listForSpace(spaceId)).filter((m) => m.status !== 'REVOKED');
    const views: MemberView[] = [];
    for (const m of members) views.push(await this.toMemberView(m));
    return views;
  }

  async toMemberView(member: SpaceMember): Promise<MemberView> {
    const profile = await this.db.auth.findById(member.userId);
    return {
      ...member,
      displayName: profile?.displayName ?? 'Unknown user',
      email: profile?.email ?? '',
    };
  }

  // -- mutations -----------------------------------------------------------

  async create(
    user: AuthUser,
    input: {
      name: string;
      purpose: string;
      description?: string;
      startAt: string;
      expiryAt: string;
      /** Root folders to create straight away (Space templates). */
      folders?: string[];
    },
  ): Promise<Space> {
    const name = input.name.trim();
    const purpose = input.purpose.trim();
    const description = (input.description ?? '').trim();

    if (name.length < 3 || name.length > 120) {
      throw new AppError('VALIDATION_ERROR', 'Space name must be between 3 and 120 characters');
    }
    if (!purpose || purpose.length > 120) {
      throw new AppError('VALIDATION_ERROR', 'Purpose must be between 1 and 120 characters');
    }
    if (description.length > 2000) {
      throw new AppError('VALIDATION_ERROR', 'Description cannot exceed 2000 characters');
    }

    const activeCount = (await this.listForUser(user.id)).filter(
      (s) => s.status === 'DRAFT' || s.status === 'ACTIVE' || s.status === 'WARNING',
    ).length;
    if (activeCount >= this.env.maxActiveSpacesPerUser) {
      throw new AppError('QUOTA_EXCEEDED', `Active Space limit reached (${this.env.maxActiveSpacesPerUser})`);
    }
    const start = new Date(input.startAt);
    const expiry = new Date(input.expiryAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(expiry.getTime()) || expiry <= start) {
      throw new AppError('INVALID_DATE_RANGE', 'expiryAt must be after startAt');
    }
    const now = new Date().toISOString();
    const space: Space = {
      id: newId(),
      ownerId: user.id,
      name,
      purpose,
      description,
      startAt: start.toISOString(),
      expiryAt: expiry.toISOString(),
      status: start.getTime() <= Date.now() ? 'ACTIVE' : 'DRAFT',
      warningSentAt: null,
      archivedManually: false,
      invitationsEnabled: true,
      defaultInviteRole: 'VIEWER',
      createdAt: now,
      updatedAt: now,
    };
    await this.db.spaces.insert(space);

    // The Space row and its OWNER membership must never diverge. If the
    // membership write fails the Space is retired on the spot instead of being
    // left behind ownerless (a Space nobody can administer).
    try {
      await this.db.members.insert({
        spaceId: space.id,
        userId: user.id,
        role: 'OWNER',
        status: 'ACTIVE',
        joinedAt: now,
        revokedAt: null,
      });
    } catch (err) {
      await this.db.spaces.update(space.id, { status: 'DELETED' });
      throw err;
    }

    await this.db.activity.append({
      userId: user.id,
      spaceId: space.id,
      fileId: null,
      action: ACTIVITY_ACTIONS.SPACE_CREATED,
      metadata: { name: space.name, purpose: space.purpose },
    });
    await this.notify(
      user.id,
      space.id,
      'SPACE_CREATED',
      `Space "${space.name}" created`,
      `Runs from ${new Date(space.startAt).toLocaleString()} to ${new Date(space.expiryAt).toLocaleString()}.`,
    );

    // Template folders go through the normal folder path so validation, naming
    // and audit entries are identical to a hand-created folder.
    for (const folderName of input.folders ?? []) {
      await this.createFolder(user, space.id, { name: folderName });
    }
    return space;
  }

  async update(
    actor: AuthUser,
    spaceId: string,
    patch: { name?: string; purpose?: string; description?: string; expiryAt?: string },
  ): Promise<Space> {
    await this.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    const space = await this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    this.assertWritable(space);
    const next: Partial<Space> = {};
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.purpose !== undefined) next.purpose = patch.purpose;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.expiryAt !== undefined) {
      const expiry = new Date(patch.expiryAt);
      if (Number.isNaN(expiry.getTime()) || expiry <= new Date(space.startAt)) {
        throw new AppError('INVALID_DATE_RANGE', 'expiryAt must be after startAt');
      }
      next.expiryAt = expiry.toISOString();
    }
    const updated = await this.db.spaces.update(spaceId, next);
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.SPACE_UPDATED,
      metadata: { fields: Object.keys(next) },
    });
    return updated!;
  }

  async delete(actor: AuthUser, spaceId: string): Promise<void> {
    await this.requireRole(spaceId, actor.id, ['OWNER']);
    const space = await this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    await this.db.spaces.update(spaceId, { status: 'DELETED' });
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.SPACE_FINALIZED,
      metadata: { reason: 'deleted-by-owner' },
    });
  }

  // -- membership ----------------------------------------------------------

  async changeRole(actor: AuthUser, spaceId: string, targetUserId: string, role: MemberRole): Promise<SpaceMember> {
    await this.requireRole(spaceId, actor.id, ['OWNER']);
    const target = await this.db.members.find(spaceId, targetUserId);
    if (!target || target.status === 'REVOKED') throw new AppError('MEMBER_NOT_FOUND', 'Member not found');
    if (role === 'OWNER') throw new AppError('FORBIDDEN_ROLE', 'There can be only one OWNER');
    const before = await this.db.members.find(spaceId, targetUserId);
    const next = await this.db.members.update(spaceId, targetUserId, { role });
    const space = await this.db.spaces.findById(spaceId);
    await this.notify(
      targetUserId,
      spaceId,
      'MEMBER_ROLE_CHANGED',
      `Role updated in ${space?.name ?? 'Space'}`,
      `Your role is now ${role}.`,
    );
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.MEMBER_ROLE_CHANGED,
      category: 'MEMBERSHIP',
      resourceType: 'user',
      resourceId: targetUserId,
      metadata: { targetUserId, role, previousRole: before?.role ?? null, newRole: role },
    });
    return next!;
  }

  async revoke(actor: AuthUser, spaceId: string, targetUserId: string): Promise<void> {
    await this.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    if (actor.id === targetUserId) throw new AppError('FORBIDDEN_ROLE', 'Owners must delete the Space instead of leaving it');
    const target = await this.db.members.find(spaceId, targetUserId);
    if (!target || target.status === 'REVOKED') throw new AppError('MEMBER_NOT_FOUND', 'Member not found');
    await this.db.members.update(spaceId, targetUserId, { status: 'REVOKED', revokedAt: new Date().toISOString() });
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.MEMBER_REVOKED,
      metadata: { targetUserId },
    });
  }

  // -- folders -------------------------------------------------------------

  async listFolders(spaceId: string, userId: string): Promise<Folder[]> {
    await this.requireRole(spaceId, userId, ['OWNER', 'EDITOR', 'VIEWER']);
    return (await this.db.folders.listForSpace(spaceId)).sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Create a folder (PRD §5.6). Folder paths are what keep the original
   * directory hierarchy intact when the Space is archived.
   */
  async createFolder(
    actor: AuthUser,
    spaceId: string,
    input: { name: string; parentId?: string | null },
  ): Promise<Folder> {
    await this.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    const space = await this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    this.assertWritable(space);

    const name = safeSegment(input.name);
    if (!name || name === 'file') {
      throw new AppError('VALIDATION_ERROR', 'A folder name is required');
    }
    const parentId = input.parentId ?? null;
    let parentPath = '';
    if (parentId) {
      const parent = await this.db.folders.findById(parentId);
      if (!parent || parent.spaceId !== spaceId) {
        throw new AppError('VALIDATION_ERROR', 'Parent folder not found in this Space');
      }
      parentPath = await folderPathFor(this.db.folders, spaceId, parentId);
    }
    const sibling = (await this.db.folders.listForSpace(spaceId)).find(
      (f) => f.parentId === parentId && f.name.toLowerCase() === name.toLowerCase(),
    );
    if (sibling) throw new AppError('CONFLICT', 'A folder with that name already exists here');

    const now = new Date().toISOString();
    const folder: Folder = {
      id: newId(),
      spaceId,
      parentId,
      name,
      path: `${parentPath}${name}/`,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.folders.insert(folder);
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.FOLDER_CREATED,
      metadata: { folderId: folder.id, path: folder.path },
    });
    return folder;
  }

  async listActivity(spaceId: string, userId: string, limit = 100): Promise<ActivityLog[]> {
    await this.requireRole(spaceId, userId, ['OWNER', 'EDITOR', 'VIEWER']);
    return this.db.activity.listForSpace(spaceId, limit);
  }

  // -- internals -----------------------------------------------------------

  async notify(
    userId: string,
    spaceId: string | null,
    type: Notification['type'],
    title: string,
    body: string,
    options: NotifyOptions = {},
  ): Promise<void> {
    const notification: Notification = {
      id: newId(),
      userId,
      spaceId,
      type,
      title,
      body,
      inviteLinkId: options.inviteLinkId ?? null,
      joinRequestId: options.joinRequestId ?? null,
      readAt: null,
      createdAt: new Date().toISOString(),
    };
    await this.db.notifications.insert(notification);
    this.db.notificationBus.publish(userId, notification);
  }

  private async toDetail(
    space: Space,
    viewerId: string,
    meta: { favorite: boolean; ownerName: string | null; lastAccessedAt: string | null },
  ): Promise<SpaceDetail> {
    return {
      ...space,
      role: await this.roleOf(space.id, viewerId),
      members: await this.memberViews(space.id),
      storageUsedBytes: await this.db.files.usedBytesForSpace(space.id),
      favorite: meta.favorite,
      ownerName: meta.ownerName,
      lastAccessedAt: meta.lastAccessedAt,
    };
  }

  /** Convenience for services that already know the space exists. */
  async requireWritableSpace(spaceId: string): Promise<Space> {
    const space = await this.db.spaces.findById(spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    this.assertWritable(space);
    return space;
  }

  /** Confirm the caller is the owner of the Space that owns the given plan. */
  async requireRoleForPlan(planId: string, userId: string, db: DataLayer): Promise<void> {
    const plan = await db.archivePlans.findById(planId);
    if (!plan) throw new AppError('NOT_FOUND', 'Plan not found');
    const space = await db.spaces.findById(plan.spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    // Owner of the Space owns the plan; admins can too.
    const profile = await db.auth.findById(userId);
    if (profile?.role === 'ADMIN') return;
    if (space.ownerId !== userId) throw new AppError('SPACE_ACCESS_DENIED', 'You do not own this Space');
  }
}
