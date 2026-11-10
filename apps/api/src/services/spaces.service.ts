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
 */
export class SpacesService {
  constructor(
    private readonly env: Env,
    private readonly db: DataLayer,
  ) {}

  // -- queries -------------------------------------------------------------

  /** Every Space the user owns or is an active member of (archived included). */
  listForUser(userId: string): SpaceDetail[] {
    const memberships = this.db.members.listForUser(userId);
    const seen = new Set<string>();
    const spaces: Space[] = [];
    for (const m of memberships) {
      const space = this.db.spaces.findById(m.spaceId);
      if (space && space.status !== 'DELETED') {
        spaces.push(space);
        seen.add(space.id);
      }
    }
    for (const space of this.db.spaces.list()) {
      if (space.ownerId === userId && space.status !== 'DELETED' && !seen.has(space.id)) {
        spaces.push(space);
        seen.add(space.id);
      }
    }
    return spaces
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => this.toDetail(s, userId));
  }

  getForUser(spaceId: string, userId: string): SpaceDetail {
    const space = this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    const role = this.roleOf(spaceId, userId);
    if (!role && this.db.auth.findById(userId)?.role !== 'ADMIN') {
      throw new AppError('SPACE_ACCESS_DENIED', 'You do not have access to this Space');
    }
    return this.toDetail(space, userId);
  }

  roleOf(spaceId: string, userId: string): MemberRole | null {
    const m = this.db.members.find(spaceId, userId);
    return m && m.status === 'ACTIVE' ? m.role : null;
  }

  requireRole(spaceId: string, userId: string, roles: MemberRole[]): MemberRole {
    const role = this.roleOf(spaceId, userId);
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
  memberViews(spaceId: string): MemberView[] {
    return this.db.members
      .listForSpace(spaceId)
      .filter((m) => m.status !== 'REVOKED')
      .map((m) => this.toMemberView(m));
  }

  toMemberView(member: SpaceMember): MemberView {
    const profile = this.db.auth.findById(member.userId);
    return {
      ...member,
      displayName: profile?.displayName ?? 'Unknown user',
      email: profile?.email ?? '',
    };
  }

  // -- mutations -----------------------------------------------------------

  create(user: AuthUser, input: { name: string; purpose: string; description?: string; startAt: string; expiryAt: string }): Space {
    const activeCount = this.listForUser(user.id).filter(
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
      name: input.name,
      purpose: input.purpose,
      description: input.description ?? '',
      startAt: start.toISOString(),
      expiryAt: expiry.toISOString(),
      status: start.getTime() <= Date.now() ? 'ACTIVE' : 'DRAFT',
      warningSentAt: null,
      archivedManually: false,
      createdAt: now,
      updatedAt: now,
    };
    this.db.spaces.insert(space);
    this.db.members.insert({
      spaceId: space.id,
      userId: user.id,
      role: 'OWNER',
      status: 'ACTIVE',
      joinedAt: now,
      revokedAt: null,
    });
    this.db.activity.append({
      userId: user.id,
      spaceId: space.id,
      fileId: null,
      action: ACTIVITY_ACTIONS.SPACE_CREATED,
      metadata: { name: space.name },
    });
    this.notify(
      user.id,
      space.id,
      'SPACE_CREATED',
      `Space "${space.name}" created`,
      `Runs from ${new Date(space.startAt).toLocaleString()} to ${new Date(space.expiryAt).toLocaleString()}.`,
    );
    return space;
  }

  update(actor: AuthUser, spaceId: string, patch: { name?: string; purpose?: string; description?: string; expiryAt?: string }): Space {
    this.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    const space = this.db.spaces.findById(spaceId);
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
    const updated = this.db.spaces.update(spaceId, next);
    this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.SPACE_UPDATED,
      metadata: { fields: Object.keys(next) },
    });
    return updated!;
  }

  delete(actor: AuthUser, spaceId: string): void {
    this.requireRole(spaceId, actor.id, ['OWNER']);
    const space = this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    this.db.spaces.update(spaceId, { status: 'DELETED' });
    this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.SPACE_FINALIZED,
      metadata: { reason: 'deleted-by-owner' },
    });
  }

  // -- membership ----------------------------------------------------------

  changeRole(actor: AuthUser, spaceId: string, targetUserId: string, role: MemberRole): SpaceMember {
    this.requireRole(spaceId, actor.id, ['OWNER']);
    const target = this.db.members.find(spaceId, targetUserId);
    if (!target || target.status === 'REVOKED') throw new AppError('MEMBER_NOT_FOUND', 'Member not found');
    if (role === 'OWNER') throw new AppError('FORBIDDEN_ROLE', 'There can be only one OWNER');
    const next = this.db.members.update(spaceId, targetUserId, { role });
    this.notify(targetUserId, spaceId, 'MEMBER_ROLE_CHANGED', `Role updated in ${this.db.spaces.findById(spaceId)?.name ?? 'Space'}`, `Your role is now ${role}.`);
    this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.MEMBER_ROLE_CHANGED,
      metadata: { targetUserId, role },
    });
    return next!;
  }

  revoke(actor: AuthUser, spaceId: string, targetUserId: string): void {
    this.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    if (actor.id === targetUserId) throw new AppError('FORBIDDEN_ROLE', 'Owners must delete the Space instead of leaving it');
    const target = this.db.members.find(spaceId, targetUserId);
    if (!target || target.status === 'REVOKED') throw new AppError('MEMBER_NOT_FOUND', 'Member not found');
    this.db.members.update(spaceId, targetUserId, { status: 'REVOKED', revokedAt: new Date().toISOString() });
    this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.MEMBER_REVOKED,
      metadata: { targetUserId },
    });
  }

  // -- folders -------------------------------------------------------------

  listFolders(spaceId: string, userId: string): Folder[] {
    this.requireRole(spaceId, userId, ['OWNER', 'EDITOR', 'VIEWER']);
    return this.db.folders.listForSpace(spaceId).sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Create a folder (PRD §5.6). Folder paths are what keep the original
   * directory hierarchy intact when the Space is archived.
   */
  createFolder(
    actor: AuthUser,
    spaceId: string,
    input: { name: string; parentId?: string | null },
  ): Folder {
    this.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    const space = this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    this.assertWritable(space);

    const name = safeSegment(input.name);
    if (!name || name === 'file') {
      throw new AppError('VALIDATION_ERROR', 'A folder name is required');
    }
    const parentId = input.parentId ?? null;
    let parentPath = '';
    if (parentId) {
      const parent = this.db.folders.findById(parentId);
      if (!parent || parent.spaceId !== spaceId) {
        throw new AppError('VALIDATION_ERROR', 'Parent folder not found in this Space');
      }
      parentPath = folderPathFor(this.db.folders, spaceId, parentId);
    }
    const sibling = this.db.folders
      .listForSpace(spaceId)
      .find((f) => f.parentId === parentId && f.name.toLowerCase() === name.toLowerCase());
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
    this.db.folders.insert(folder);
    this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.FOLDER_CREATED,
      metadata: { folderId: folder.id, path: folder.path },
    });
    return folder;
  }

  listActivity(spaceId: string, userId: string, limit = 100): ActivityLog[] {
    this.requireRole(spaceId, userId, ['OWNER', 'EDITOR', 'VIEWER']);
    return this.db.activity.listForSpace(spaceId, limit);
  }

  // -- internals -----------------------------------------------------------

  notify(
    userId: string,
    spaceId: string | null,
    type: Notification['type'],
    title: string,
    body: string,
    options: NotifyOptions = {},
  ): void {
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
    this.db.notifications.insert(notification);
    this.db.notificationBus.publish(userId, notification);
  }

  private toDetail(space: Space, viewerId: string): SpaceDetail {
    return {
      ...space,
      role: this.roleOf(space.id, viewerId),
      members: this.memberViews(space.id),
      storageUsedBytes: this.db.files.usedBytesForSpace(space.id),
    };
  }

  /** Convenience for services that already know the space exists. */
  requireWritableSpace(spaceId: string): Space {
    const space = this.db.spaces.findById(spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    this.assertWritable(space);
    return space;
  }

  /** Confirm the caller is the owner of the Space that owns the given plan. */
  requireRoleForPlan(planId: string, userId: string, db: DataLayer): void {
    const plan = db.archivePlans.findById(planId);
    if (!plan) throw new AppError('NOT_FOUND', 'Plan not found');
    const space = db.spaces.findById(plan.spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    // Owner of the Space owns the plan; admins can too.
    const profile = db.auth.findById(userId);
    if (profile?.role === 'ADMIN') return;
    if (space.ownerId !== userId) throw new AppError('SPACE_ACCESS_DENIED', 'You do not own this Space');
  }
}
