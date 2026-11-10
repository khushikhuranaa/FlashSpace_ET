import { randomBytes } from 'node:crypto';
import type {
  AuthUser,
  JoinRequest,
  JoinRequestView,
  MemberRole,
  MembersPayload,
  PendingInviteView,
  SpaceInvitation,
  SpaceInviteLink,
  SpaceJoinPreview,
} from '@flashspace/shared';
import { AppError, ACTIVITY_ACTIONS } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import { newId } from '../utils/ids.js';
import type { SpacesService } from './spaces.service.js';

/**
 * Membership engine: invite links, email invitations and join requests.
 *
 * Two symmetric flows share one JoinRequest record so the owner and the
 * invitee always see the same pending state:
 *   - LINK  → a logged-in user opens a shareable link and asks to join; the
 *             OWNER decides (accept/decline).
 *   - EMAIL → the owner invites an email address; the invited user decides
 *             from their Notifications. Accepting adds them as a member.
 */
export class MembershipService {
  constructor(
    private readonly env: Env,
    private readonly db: DataLayer,
    private readonly spaces: SpacesService,
  ) {}

  // -- reads ---------------------------------------------------------------

  /** Roster + owner-facing queues for the Members tab. */
  membersPayload(actor: AuthUser, spaceId: string): MembersPayload {
    const role = this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    const canManage = role === 'OWNER' || role === 'EDITOR';
    const members = this.spaces.memberViews(spaceId);
    return {
      members,
      pending: canManage ? this.pendingInvites(spaceId) : [],
      joinRequests: canManage ? this.joinRequestViews(spaceId) : [],
      inviteLink: canManage ? this.linkView(spaceId) : null,
    };
  }

  listJoinRequests(actor: AuthUser, spaceId: string): JoinRequestView[] {
    this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    return this.joinRequestViews(spaceId);
  }

  /** What a visitor sees before asking to join through an invite link. */
  previewInviteLink(actor: AuthUser, token: string): SpaceJoinPreview {
    const link = this.requireLink(token);
    const space = this.db.spaces.findById(link.spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    const owner = this.db.auth.findById(space.ownerId);
    return {
      spaceId: space.id,
      name: space.name,
      purpose: space.purpose,
      description: space.description,
      ownerDisplayName: owner?.displayName ?? 'Space owner',
      memberCount: this.db.members.listForSpace(space.id).filter((m) => m.status === 'ACTIVE').length,
      role: link.role,
      alreadyMember: this.spaces.roleOf(space.id, actor.id) !== null,
      hasPendingRequest: Boolean(this.db.joinRequests.findPendingForUser(space.id, actor.id)),
    };
  }

  activeLinkUrl(spaceId: string): string | null {
    return this.linkView(spaceId)?.url ?? null;
  }

  // -- invite link ---------------------------------------------------------

  /** Create (or return) the shareable link for a Space. OWNER only. */
  createInviteLink(actor: AuthUser, spaceId: string, role: MemberRole = 'VIEWER'): { url: string; role: MemberRole; createdAt: string } {
    this.spaces.requireRole(spaceId, actor.id, ['OWNER']);
    const space = this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    if (role === 'OWNER') throw new AppError('FORBIDDEN_ROLE', 'A link cannot grant OWNER');

    const existing = this.db.inviteLinks.findActiveForSpace(spaceId);
    if (existing && existing.role === role) return this.toLinkView(existing);

    const link: SpaceInviteLink = {
      id: newId(),
      spaceId,
      createdBy: actor.id,
      token: randomBytes(24).toString('base64url'),
      role,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    if (existing) this.db.inviteLinks.update(existing.id, { revokedAt: new Date().toISOString() });
    this.db.inviteLinks.insert(link);
    this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.INVITE_LINK_ROTATED,
      metadata: { role },
    });
    return this.toLinkView(link);
  }

  /** Revoke the current link so it can no longer be used. OWNER only. */
  revokeInviteLink(actor: AuthUser, spaceId: string): void {
    this.spaces.requireRole(spaceId, actor.id, ['OWNER']);
    const link = this.db.inviteLinks.findActiveForSpace(spaceId);
    if (!link) return;
    this.db.inviteLinks.update(link.id, { revokedAt: new Date().toISOString() });
  }

  /** A logged-in user asks to join through a link. */
  requestJoinByLink(actor: AuthUser, token: string): JoinRequestView {
    const link = this.requireLink(token);
    const space = this.db.spaces.findById(link.spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    if (space.ownerId === actor.id || this.spaces.roleOf(space.id, actor.id)) {
      throw new AppError('ALREADY_MEMBER', 'You are already a member of this Space');
    }
    const pending = this.db.joinRequests.findPendingForUser(space.id, actor.id);
    if (pending) return this.toJoinRequestView(pending);

    const request: JoinRequest = {
      id: newId(),
      spaceId: space.id,
      requesterId: actor.id,
      role: link.role,
      source: 'LINK',
      invitationId: null,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      decidedBy: null,
      decidedAt: null,
    };
    this.db.joinRequests.insert(request);
    this.notifyOwners(
      space.id,
      space.ownerId,
      `Join request for "${space.name}"`,
      `${actor.displayName} (${actor.email}) asked to join as ${link.role}.`,
      request.id,
    );
    this.db.activity.append({
      userId: actor.id,
      spaceId: space.id,
      fileId: null,
      action: ACTIVITY_ACTIONS.JOIN_REQUESTED,
      metadata: { source: 'LINK', role: link.role },
    });
    return this.toJoinRequestView(request);
  }

  // -- email invitations ---------------------------------------------------

  /**
   * Invite an email address. Registered users join instantly and receive a
   * notification; unknown addresses get a pending invitation record that can
   * be claimed after they sign up.
   */
  invite(actor: AuthUser, spaceId: string, email: string, role: MemberRole): { delivered: boolean } {
    this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    const space = this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    this.spaces.assertWritable(space);
    if (role === 'OWNER') throw new AppError('FORBIDDEN_ROLE', 'Cannot invite another OWNER');

    const normalized = email.trim().toLowerCase();
    const target = this.db.auth.findByEmail(normalized);

    if (target) {
      const existingMember = this.db.members.find(spaceId, target.id);
      if (existingMember && existingMember.status === 'ACTIVE') {
        throw new AppError('ALREADY_MEMBER', 'That user is already a member of this Space');
      }
      if (this.db.joinRequests.findPendingForUser(spaceId, target.id)) {
        throw new AppError('INVITATION_PENDING', 'That user already has a pending invitation to this Space');
      }
    } else if (this.db.invitations.findBySpaceAndEmail(spaceId, normalized)) {
      throw new AppError('INVITATION_PENDING', 'An invitation is already pending for that email');
    }

    const invitation: SpaceInvitation = {
      id: newId(),
      spaceId,
      inviterId: actor.id,
      email: normalized,
      intendedRole: role,
      tokenHash: null,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    this.db.invitations.insert(invitation);

    if (target) {
      // Existing account: docs/api.md — existing users join instantly.
      this.activateMembership(spaceId, target.id, role);
      this.db.invitations.update(invitation.id, { status: 'ACCEPTED' });
      this.spaces.notify(
        target.id,
        spaceId,
        'MEMBER_INVITED',
        `You were added to "${space.name}"`,
        `${actor.displayName} added you as ${role}. Open the Space to get started.`,
      );
    }

    this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.MEMBER_INVITED,
      metadata: { email: normalized, role, registered: Boolean(target) },
    });
    return { delivered: Boolean(target) };
  }

  // -- decisions -----------------------------------------------------------

  /**
   * Decide a join request. One endpoint serves both sides:
   *   - the requester accepts/declines an email invitation, and
   *   - the OWNER accepts/declines a link request.
   */
  decide(actor: AuthUser, requestId: string, decision: 'ACCEPT' | 'DECLINE'): JoinRequestView {
    const request = this.db.joinRequests.findById(requestId);
    if (!request) throw new AppError('JOIN_REQUEST_NOT_FOUND', 'Join request not found');
    if (request.status !== 'PENDING') {
      throw new AppError('REQUEST_ALREADY_DECIDED', 'This request has already been decided');
    }
    const space = this.db.spaces.findById(request.spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');

    const isRequester = request.requesterId === actor.id;
    const actorRole = this.spaces.roleOf(space.id, actor.id);
    const isOwner = actorRole === 'OWNER' || space.ownerId === actor.id;
    // Self-decision is only for email invitations; link requests are the owner's call.
    const decidedByInvitee = isRequester && request.source === 'EMAIL';
    if (!decidedByInvitee && !isOwner) {
      throw new AppError('FORBIDDEN_ROLE', 'Only the Space owner or the invited user can decide this request');
    }

    const accepted = decision === 'ACCEPT';
    const updated = this.db.joinRequests.update(request.id, {
      status: accepted ? 'ACCEPTED' : 'DECLINED',
      decidedBy: actor.id,
      decidedAt: new Date().toISOString(),
    })!;

    if (accepted) {
      this.activateMembership(space.id, request.requesterId, request.role);
    }
    if (request.invitationId) {
      this.db.invitations.update(request.invitationId, {
        status: accepted ? 'ACCEPTED' : 'REVOKED',
      });
    }

    const requester = this.db.auth.findById(request.requesterId);
    const requesterName = requester?.displayName ?? 'A user';
    if (decidedByInvitee) {
      // The invitee decided → tell the owner(s).
      this.notifyOwners(
        space.id,
        space.ownerId,
        accepted
          ? `${requesterName} joined "${space.name}"`
          : `${requesterName} declined your invitation`,
        accepted
          ? `${requester?.email ?? ''} accepted and now has ${request.role} access.`
          : `${requester?.email ?? ''} declined to join "${space.name}".`,
        request.id,
      );
    } else {
      // The owner decided → tell the requester.
      this.spaces.notify(
        request.requesterId,
        space.id,
        accepted ? 'JOIN_ACCEPTED' : 'JOIN_DECLINED',
        accepted
          ? `You joined "${space.name}"`
          : `Your request to join "${space.name}" was declined`,
        accepted
          ? `You now have ${request.role} access. Open the Space to get started.`
          : `The owner declined your request. You can ask again later.`,
        { joinRequestId: request.id },
      );
    }

    this.db.activity.append({
      userId: actor.id,
      spaceId: space.id,
      fileId: null,
      action: accepted ? ACTIVITY_ACTIONS.JOIN_ACCEPTED : ACTIVITY_ACTIONS.JOIN_DECLINED,
      metadata: { requestId: request.id, source: request.source, role: request.role },
    });
    return this.toJoinRequestView(updated);
  }

  // -- internals -----------------------------------------------------------

  private activateMembership(spaceId: string, userId: string, role: MemberRole): void {
    const existing = this.db.members.find(spaceId, userId);
    const now = new Date().toISOString();
    if (existing) {
      this.db.members.update(spaceId, userId, { role, status: 'ACTIVE', joinedAt: now, revokedAt: null });
    } else {
      this.db.members.insert({
        spaceId,
        userId,
        role,
        status: 'ACTIVE',
        joinedAt: now,
        revokedAt: null,
      });
    }
  }

  private notifyOwners(
    spaceId: string,
    ownerId: string,
    title: string,
    body: string,
    joinRequestId: string,
  ): void {
    const ownerIds = new Set<string>([ownerId]);
    for (const m of this.db.members.listForSpace(spaceId)) {
      if (m.role === 'OWNER' && m.status === 'ACTIVE') ownerIds.add(m.userId);
    }
    for (const id of ownerIds) {
      this.spaces.notify(id, spaceId, 'JOIN_REQUEST', title, body, { joinRequestId });
    }
  }

  private requireLink(token: string): SpaceInviteLink {
    const link = this.db.inviteLinks.findByToken(token);
    if (!link || link.revokedAt) {
      throw new AppError('INVITE_LINK_INVALID', 'This invite link is no longer active');
    }
    return link;
  }

  private linkView(spaceId: string): { url: string; role: MemberRole; createdAt: string } | null {
    const link = this.db.inviteLinks.findActiveForSpace(spaceId);
    return link ? this.toLinkView(link) : null;
  }

  private toLinkView(link: SpaceInviteLink): { url: string; role: MemberRole; createdAt: string } {
    return { url: this.joinUrl(link.token), role: link.role, createdAt: link.createdAt };
  }

  private joinUrl(token: string): string {
    return `${this.env.webAppUrl.replace(/\/$/, '')}/#/join/${token}`;
  }

  private pendingInvites(spaceId: string): PendingInviteView[] {
    const pendingRequests = this.db.joinRequests
      .listForSpace(spaceId, 'PENDING')
      .filter((r) => r.source === 'EMAIL')
      .map(
        (r): PendingInviteView => ({
          kind: 'EMAIL',
          id: r.id,
          email: this.db.auth.findById(r.requesterId)?.email ?? null,
          role: r.role,
          status: 'PENDING',
          createdAt: r.createdAt,
        }),
      );
    const unclaimed = this.db.invitations
      .listForSpace(spaceId)
      .filter((i) => i.status === 'PENDING' && !this.db.joinRequests.findOpenForInvitation(i.id))
      .map(
        (i): PendingInviteView => ({
          kind: 'EMAIL',
          id: i.id,
          email: i.email,
          role: i.intendedRole,
          status: 'PENDING',
          createdAt: i.createdAt,
        }),
      );
    return [...pendingRequests, ...unclaimed].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private joinRequestViews(spaceId: string): JoinRequestView[] {
    return this.db.joinRequests.listForSpace(spaceId).map((r) => this.toJoinRequestView(r));
  }

  private toJoinRequestView(request: JoinRequest): JoinRequestView {
    const requester = this.db.auth.findById(request.requesterId);
    const space = this.db.spaces.findById(request.spaceId);
    return {
      ...request,
      spaceName: space?.name ?? 'Space',
      requesterDisplayName: requester?.displayName ?? 'Unknown user',
      requesterEmail: requester?.email ?? '',
    };
  }
}
