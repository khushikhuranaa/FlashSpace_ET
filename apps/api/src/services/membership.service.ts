import { createHash, randomBytes } from 'node:crypto';
import type {
  AuthUser,
  JoinRequest,
  JoinRequestView,
  MemberRole,
  MembersPayload,
  PendingInviteView,
  Space,
  SpaceInvitation,
  SpaceInviteLink,
  SpaceJoinPreview,
  SpaceMember,
} from '@flashspace/shared';
import { AppError, ACTIVITY_ACTIONS } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import { newId } from '../utils/ids.js';
import type { SpacesService } from './spaces.service.js';
import type { EmailService } from './email.service.js';

/**
 * Membership engine: invite links, email invitations and join requests.
 *
 * Two symmetric flows share one JoinRequest record so the owner and the
 * invitee always see the same pending state:
 *   - LINK  → a logged-in user opens a shareable link and asks to join; the
 *             OWNER decides (accept/decline).
 *   - EMAIL → the owner invites an email address; the invited user decides
 *             from their Notifications. Accepting adds them as a member.
 *
 * Email invitations now carry a secure token so the invitee can accept after
 * signing up, even if they did not have an account when invited.
 */
export class MembershipService {
  /** Wired after construction because the mail service is built later. */
  private email: EmailService | null = null;

  constructor(
    private readonly env: Env,
    private readonly db: DataLayer,
    private readonly spaces: SpacesService,
  ) {}

  attachEmail(email: EmailService): void {
    this.email = email;
  }

  // -- reads ---------------------------------------------------------------

  /** Roster + owner-facing queues for the Members tab. */
  async membersPayload(actor: AuthUser, spaceId: string): Promise<MembersPayload> {
    const role = await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    const canManage = role === 'OWNER' || role === 'EDITOR';
    const members = await this.spaces.memberViews(spaceId);
    return {
      members,
      pending: canManage ? await this.pendingInvites(spaceId) : [],
      joinRequests: canManage ? await this.joinRequestViews(spaceId) : [],
      inviteLink: canManage ? await this.linkView(spaceId) : null,
    };
  }

  async listJoinRequests(actor: AuthUser, spaceId: string): Promise<JoinRequestView[]> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    return this.joinRequestViews(spaceId);
  }

  /** What a visitor sees before asking to join through an invite link.
   *  Works for unauthenticated visitors too: actor may be null when the user
   *  has not signed in yet (spec §2.1). */
  async previewInviteLink(actor: AuthUser | null, token: string): Promise<SpaceJoinPreview> {
    const link = await this.requireLink(token);
    const space = await this.db.spaces.findById(link.spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    const owner = await this.db.auth.findById(space.ownerId);
    const userId = actor?.id ?? null;
    return {
      spaceId: space.id,
      name: space.name,
      purpose: space.purpose,
      description: space.description,
      ownerDisplayName: owner?.displayName ?? 'Space owner',
      memberCount: (await this.db.members.listForSpace(space.id)).filter((m) => m.status === 'ACTIVE').length,
      role: link.role,
      alreadyMember: userId ? (await this.spaces.roleOf(space.id, userId)) !== null : false,
      hasPendingRequest: userId ? Boolean(await this.db.joinRequests.findPendingForUser(space.id, userId)) : false,
    };
  }

  /** Invitations are owner-controlled; a closed Space cannot be joined. */
  private assertInvitesOpen(space: Space): void {
    if (space.invitationsEnabled === false) {
      throw new AppError('INVITATIONS_DISABLED', 'Invitations are disabled for this Space');
    }
  }

  async activeLinkUrl(spaceId: string): Promise<string | null> {
    return (await this.linkView(spaceId))?.url ?? null;
  }

  // -- invite link ---------------------------------------------------------

  /** Create (or return) the shareable link for a Space. OWNER only. */
  async createInviteLink(
    actor: AuthUser,
    spaceId: string,
    role?: MemberRole,
  ): Promise<{ url: string; role: MemberRole; createdAt: string }> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER']);
    const space = await this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    if (space.invitationsEnabled === false) {
      throw new AppError('INVITATIONS_DISABLED', 'Invitations are disabled for this Space');
    }
    const resolvedRole: MemberRole = role ?? space.defaultInviteRole ?? 'VIEWER';
    if (resolvedRole === 'OWNER') throw new AppError('FORBIDDEN_ROLE', 'A link cannot grant OWNER');

    const existing = await this.db.inviteLinks.findActiveForSpace(spaceId);
    if (existing && existing.role === resolvedRole) return this.toLinkView(existing);

    const link: SpaceInviteLink = {
      id: newId(),
      spaceId,
      createdBy: actor.id,
      token: randomBytes(24).toString('base64url'),
      role: resolvedRole,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    if (existing) await this.db.inviteLinks.update(existing.id, { revokedAt: new Date().toISOString() });
    await this.db.inviteLinks.insert(link);
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.INVITE_LINK_ROTATED,
      metadata: { role: resolvedRole },
    });
    return this.toLinkView(link);
  }

  /** Revoke the current link so it can no longer be used. OWNER only. */
  async revokeInviteLink(actor: AuthUser, spaceId: string): Promise<void> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER']);
    const link = await this.db.inviteLinks.findActiveForSpace(spaceId);
    if (!link) return;
    await this.db.inviteLinks.update(link.id, { revokedAt: new Date().toISOString() });
  }

  /** A logged-in user asks to join through a link. */
  async requestJoinByLink(actor: AuthUser, token: string): Promise<JoinRequestView> {
    const link = await this.requireLink(token);
    const space = await this.db.spaces.findById(link.spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    if (space.invitationsEnabled === false) {
      throw new AppError('INVITATIONS_DISABLED', 'Invitations are disabled for this Space');
    }
    if (space.ownerId === actor.id || (await this.spaces.roleOf(space.id, actor.id))) {
      throw new AppError('ALREADY_MEMBER', 'You are already a member of this Space');
    }
    const pending = await this.db.joinRequests.findPendingForUser(space.id, actor.id);
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
    await this.db.joinRequests.insert(request);
    await this.notifyOwners(
      space.id,
      space.ownerId,
      `Join request for "${space.name}"`,
      `${actor.displayName} (${actor.email}) asked to join as ${link.role}.`,
      request.id,
    );
    await this.db.activity.append({
      userId: actor.id,
      spaceId: space.id,
      fileId: null,
      action: ACTIVITY_ACTIONS.JOIN_REQUESTED,
      metadata: { source: 'LINK', role: link.role },
    });
    return this.toJoinRequestView(request);
  }

  // -- email invitations ----------------------------------------------------

  /**
   * Invite an email address. Registered users join instantly and receive a
   * notification; unknown addresses get a pending invitation record that can
   * be claimed after they sign up via the token-based acceptance flow.
   */
  async invite(actor: AuthUser, spaceId: string, email: string, role: MemberRole): Promise<{ delivered: boolean; invitationId?: string }> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR']);
    const space = await this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    this.assertInvitesOpen(space);
    this.spaces.assertWritable(space);
    if (role === 'OWNER') throw new AppError('FORBIDDEN_ROLE', 'Cannot invite another OWNER');

    const normalized = email.trim().toLowerCase();
    const target = await this.db.auth.findByEmail(normalized);

    if (target) {
      const existingMember = await this.db.members.find(spaceId, target.id);
      if (existingMember && existingMember.status === 'ACTIVE') {
        throw new AppError('ALREADY_MEMBER', 'That user is already a member of this Space');
      }
      if (await this.db.joinRequests.findPendingForUser(spaceId, target.id)) {
        throw new AppError('INVITATION_PENDING', 'That user already has a pending invitation to this Space');
      }
    } else if (await this.db.invitations.findBySpaceAndEmail(spaceId, normalized)) {
      throw new AppError('INVITATION_PENDING', 'An invitation is already pending for that email');
    }

    // Generate a secure token so the invitee can accept after signing up,
    // even if they did not have an account when the invitation was sent.
    const token = randomBytes(32).toString('base64url');
    const invitation: SpaceInvitation = {
      id: newId(),
      spaceId,
      inviterId: actor.id,
      email: normalized,
      intendedRole: role,
      tokenHash: this.hashToken(token),
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    await this.db.invitations.insert(invitation);

    if (target) {
      // Existing account: the invitation stays PENDING. The invitee decides
      // from their notification; auto-accepting would grant access before they
      // agreed.
      await this.spaces.notify(
        target.id,
        spaceId,
        'MEMBER_INVITED',
        `Invitation to "${space.name}"`,
        `${actor.displayName} invited you to join as ${role}. Open your notifications to accept or decline.`,
      );
    }

    // Deliver the tokenised link through the configured transport. In local
    // development the mock transport parks it in /dev/outbox.
    if (this.email) {
      await this.email
        .sendInvitationEmail(target?.email ?? normalized, actor.displayName, space.name, role, token)
        .catch(() => undefined);
    }

    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.MEMBER_INVITED,
      category: 'INVITATION',
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { role, registered: Boolean(target), delivered: false },
    });
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      action: ACTIVITY_ACTIONS.INVITATION_CREATED,
      category: 'INVITATION',
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { role, registered: Boolean(target), expiresAt: invitation.expiresAt },
    });
    return { delivered: false, invitationId: invitation.id };
  }

  /**
   * Accept a pending email invitation using its secure token.
   * The invitee must authenticate with the email address the invitation was sent to.
   *
   * Flow:
   *   1. Validate token hash.
   *   2. Check invitation is pending, not expired, not revoked.
   *   3. Verify the authenticated user's email matches the invitation.
   *   4. Activate membership with the invitation's intended role.
   *   5. Mark invitation accepted.
   */
  async acceptInvitationByToken(actor: AuthUser, token: string): Promise<{ invitation: SpaceInvitation; member: SpaceMember }> {
    const invitation = await this.findInvitationByToken(token);
    if (!invitation) {
      throw new AppError('INVITATION_INVALID', 'This invitation link is no longer valid');
    }
    await this.assertInvitationUsable(invitation, actor);
    return this.acceptInvitationRecord(actor, invitation);
  }

  /**
   * Notification-driven decision for an email invitation. The invitation is
   * resolved from the signed-in user's own address, so no token has to be
   * carried in a notification body and IDOR is impossible.
   */
  async decideInvitationForSpace(
    actor: AuthUser,
    spaceId: string,
    decision: 'ACCEPT' | 'DECLINE',
  ): Promise<{ invitation: SpaceInvitation; member?: SpaceMember }> {
    const invitations = await this.db.invitations.listForSpace(spaceId);
    const email = actor.email.toLowerCase();
    const invitation = invitations
      .filter((i) => i.email === email)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!invitation) {
      throw new AppError('INVITATION_NOT_FOUND', 'No invitation for this Space was sent to your address');
    }
    if (invitation.status === 'ACCEPTED') {
      throw new AppError('INVITATION_ALREADY_ACCEPTED', 'This invitation was already accepted');
    }
    if (invitation.status === 'REVOKED') {
      throw new AppError('INVITATION_REVOKED', 'This invitation was declined or revoked');
    }
    await this.assertInvitationUsable(invitation, actor);
    if (decision === 'ACCEPT') return this.acceptInvitationRecord(actor, invitation);
    await this.declineInvitationRecord(actor, invitation);
    return { invitation: { ...invitation, status: 'REVOKED' } };
  }

  /** Shared status/expiry/recipient checks for every invitation entry point. */
  private async assertInvitationUsable(invitation: SpaceInvitation, actor: AuthUser): Promise<void> {
    if (invitation.status !== 'PENDING') {
      if (invitation.status === 'EXPIRED') throw new AppError('INVITATION_EXPIRED', 'This invitation has expired');
      if (invitation.status === 'REVOKED') throw new AppError('INVITATION_REVOKED', 'This invitation was revoked');
      if (invitation.status === 'ACCEPTED') throw new AppError('INVITATION_ALREADY_ACCEPTED', 'This invitation was already accepted');
      throw new AppError('INVITATION_INVALID', 'This invitation is no longer valid');
    }
    if (new Date(invitation.expiresAt) <= new Date()) {
      await this.db.invitations.update(invitation.id, { status: 'EXPIRED' });
      await this.db.activity.append({
        spaceId: invitation.spaceId,
        action: ACTIVITY_ACTIONS.INVITATION_EXPIRED,
        actorType: 'SYSTEM',
        category: 'INVITATION',
        resourceType: 'invitation',
        resourceId: invitation.id,
        reason: 'expiry-date-reached',
        metadata: { role: invitation.intendedRole, expiresAt: invitation.expiresAt },
      });
      throw new AppError('INVITATION_EXPIRED', 'This invitation has expired');
    }
    if (invitation.email !== actor.email.toLowerCase()) {
      throw new AppError('INVITATION_EMAIL_MISMATCH', 'This invitation was sent to a different email address');
    }
  }

  private async acceptInvitationRecord(
    actor: AuthUser,
    invitation: SpaceInvitation,
  ): Promise<{ invitation: SpaceInvitation; member: SpaceMember }> {
    const space = await this.db.spaces.findById(invitation.spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    this.assertInvitesOpen(space);

    const existingRole = await this.spaces.roleOf(invitation.spaceId, actor.id);
    if (existingRole) {
      throw new AppError('ALREADY_MEMBER', 'You are already a member of this Space');
    }

    await this.activateMembership(invitation.spaceId, actor.id, invitation.intendedRole);
    await this.db.invitations.update(invitation.id, { status: 'ACCEPTED' });

    await this.spaces.notify(
      actor.id,
      invitation.spaceId,
      'JOIN_ACCEPTED',
      `You joined "${space.name}"`,
      `You now have ${invitation.intendedRole} access. Open the Space to get started.`,
    );
    await this.notifyOwners(
      invitation.spaceId,
      space.ownerId,
      `${actor.displayName} joined "${space.name}"`,
      `${actor.email} accepted your invitation and now has ${invitation.intendedRole} access.`,
      null,
    );
    await this.db.activity.append({
      userId: actor.id,
      spaceId: invitation.spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.JOIN_ACCEPTED,
      category: 'INVITATION',
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { source: 'EMAIL', role: invitation.intendedRole, invitationId: invitation.id },
    });
    await this.db.activity.append({
      userId: actor.id,
      spaceId: invitation.spaceId,
      action: ACTIVITY_ACTIONS.INVITATION_ACCEPTED,
      category: 'INVITATION',
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { role: invitation.intendedRole },
    });

    const member = await this.db.members.find(invitation.spaceId, actor.id);
    if (!member) throw new AppError('MEMBER_NOT_FOUND', 'Membership record was not created');
    return { invitation, member };
  }

  /** Decline a pending email invitation. */
  async declineInvitationByToken(actor: AuthUser, token: string): Promise<{ invitation: SpaceInvitation }> {
    const invitation = await this.findInvitationByToken(token);
    if (!invitation) throw new AppError('INVITATION_INVALID', 'This invitation link is no longer valid');
    await this.assertInvitationUsable(invitation, actor);
    await this.declineInvitationRecord(actor, invitation);
    return { invitation: { ...invitation, status: 'REVOKED' } };
  }

  private async declineInvitationRecord(actor: AuthUser, invitation: SpaceInvitation): Promise<void> {
    await this.db.invitations.update(invitation.id, { status: 'REVOKED' });
    const space = await this.db.spaces.findById(invitation.spaceId);
    await this.notifyOwners(
      invitation.spaceId,
      space?.ownerId ?? '',
      `Invitation declined for "${space?.name ?? 'Space'}"`,
      `${actor.email} declined the invitation to join as ${invitation.intendedRole}.`,
      null,
    );
    await this.db.activity.append({
      userId: actor.id,
      spaceId: invitation.spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.JOIN_DECLINED,
      category: 'INVITATION',
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { source: 'EMAIL', role: invitation.intendedRole, invitationId: invitation.id },
    });
    await this.db.activity.append({
      userId: actor.id,
      spaceId: invitation.spaceId,
      action: ACTIVITY_ACTIONS.INVITATION_DECLINED,
      category: 'INVITATION',
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { role: invitation.intendedRole },
    });
  }

  /** Resend the invitation notification/email to the invitee. Spec §1.7. */
  async resendInvitation(actor: AuthUser, invitationId: string): Promise<{ resent: boolean }> {
    const invitation = await this.db.invitations.findById(invitationId);
    if (!invitation) throw new AppError('INVITATION_NOT_FOUND', 'Invitation not found');
    if (invitation.status !== 'PENDING') {
      throw new AppError('INVITATION_NOT_PENDING', 'Only pending invitations can be resent');
    }
    const space = await this.db.spaces.findById(invitation.spaceId);
    await this.spaces.requireRole(invitation.spaceId, actor.id, ['OWNER', 'EDITOR']);
    if (new Date(invitation.expiresAt) <= new Date()) {
      throw new AppError('INVITATION_EXPIRED', 'This invitation has expired');
    }
    // Resend is recorded but actual email delivery depends on the configured
    // mail provider. The in-app notification is always created.
    await this.spaces.notify(
      invitation.inviterId,
      invitation.spaceId,
      'REMINDER_SENT',
      `Invitation resent for "${space?.name ?? 'Space'}"`,
      `The invitation to ${invitation.email} was resent.`,
    );
    await this.db.activity.append({
      userId: actor.id,
      spaceId: invitation.spaceId,
      action: ACTIVITY_ACTIONS.INVITATION_SENT,
      category: 'INVITATION',
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { role: invitation.intendedRole, attempt: 'resend' },
    });
    return { resent: true };
  }

  // -- decisions -----------------------------------------------------------

  /**
   * Decide a join request. One endpoint serves both sides:
   *   - the requester accepts/declines an email invitation, and
   *   - the OWNER accepts/declines a link request.
   */
  async decide(actor: AuthUser, requestId: string, decision: 'ACCEPT' | 'DECLINE'): Promise<JoinRequestView> {
    const request = await this.db.joinRequests.findById(requestId);
    if (!request) throw new AppError('JOIN_REQUEST_NOT_FOUND', 'Join request not found');
    if (request.status !== 'PENDING') {
      throw new AppError('REQUEST_ALREADY_DECIDED', 'This request has already been decided');
    }
    const space = await this.db.spaces.findById(request.spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');

    const isRequester = request.requesterId === actor.id;
    const actorRole = await this.spaces.roleOf(space.id, actor.id);
    const isOwner = actorRole === 'OWNER' || space.ownerId === actor.id;
    // Self-decision is only for email invitations; link requests are the owner's call.
    const decidedByInvitee = isRequester && request.source === 'EMAIL';
    if (!decidedByInvitee && !isOwner) {
      throw new AppError('FORBIDDEN_ROLE', 'Only the Space owner or the invited user can decide this request');
    }

    const accepted = decision === 'ACCEPT';
    const updated = (await this.db.joinRequests.update(request.id, {
      status: accepted ? 'ACCEPTED' : 'DECLINED',
      decidedBy: actor.id,
      decidedAt: new Date().toISOString(),
    }))!;

    if (accepted) {
      await this.activateMembership(space.id, request.requesterId, request.role);
    }
    if (request.invitationId) {
      await this.db.invitations.update(request.invitationId, {
        status: accepted ? 'ACCEPTED' : 'REVOKED',
      });
    }

    const requester = await this.db.auth.findById(request.requesterId);
    const requesterName = requester?.displayName ?? 'A user';
    if (decidedByInvitee) {
      await this.notifyOwners(
        space.id,
        space.ownerId,
        accepted ? `${requesterName} joined "${space.name}"` : `${requesterName} declined your invitation`,
        accepted
          ? `${requester?.email ?? ''} accepted and now has ${request.role} access.`
          : `${requester?.email ?? ''} declined to join "${space.name}".`,
        request.id,
      );
    } else {
      await this.spaces.notify(
        request.requesterId,
        space.id,
        accepted ? 'JOIN_ACCEPTED' : 'JOIN_DECLINED',
        accepted ? `You joined "${space.name}"` : `Your request to join "${space.name}" was declined`,
        accepted
          ? `You now have ${request.role} access. Open the Space to get started.`
          : `The owner declined your request. You can ask again later.`,
        { joinRequestId: request.id },
      );
    }

    await this.db.activity.append({
      userId: actor.id,
      spaceId: space.id,
      fileId: null,
      action: accepted ? ACTIVITY_ACTIONS.JOIN_ACCEPTED : ACTIVITY_ACTIONS.JOIN_DECLINED,
      metadata: { requestId: request.id, source: request.source, role: request.role },
    });
    return this.toJoinRequestView(updated);
  }

  // -- leave ---------------------------------------------------------------

  /**
   * A member voluntarily leaves the Space. OWNERs cannot leave (they must
   * delete the Space or transfer ownership first). EDITOR/VIEWER may leave
   * unless they are the last remaining member besides the OWNER.
   */
  async leaveSpace(actor: AuthUser, spaceId: string): Promise<void> {
    const role = await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    if (role === 'OWNER') {
      throw new AppError('FORBIDDEN_ROLE', 'Owners cannot leave — delete the Space or transfer ownership first');
    }
    const space = await this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');

    // Count ACTIVE non-owner members so we know if removing this person would
    // leave the Space effectively empty (only the OWNER remains).
    const activeMembers = (await this.db.members.listForSpace(spaceId)).filter(
      (m) => m.status === 'ACTIVE' && m.userId !== space.ownerId,
    );
    if (activeMembers.length <= 1 && activeMembers[0]?.userId === actor.id) {
      throw new AppError('FORBIDDEN_ROLE', 'The last member cannot leave — the Space would have no collaborators');
    }

    await this.db.members.update(spaceId, actor.id, {
      status: 'REVOKED',
      revokedAt: new Date().toISOString(),
    });
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: ACTIVITY_ACTIONS.MEMBER_LEFT,
      category: 'MEMBERSHIP',
      resourceType: 'user',
      resourceId: actor.id,
      reason: 'left voluntarily',
      metadata: { targetUserId: actor.id, source: 'SELF_LEAVE', role },
    });
  }

  // -- internals -----------------------------------------------------------

  private async activateMembership(spaceId: string, userId: string, role: MemberRole): Promise<void> {
    const existing = await this.db.members.find(spaceId, userId);
    const now = new Date().toISOString();
    if (existing) {
      await this.db.members.update(spaceId, userId, { role, status: 'ACTIVE', joinedAt: now, revokedAt: null });
    } else {
      await this.db.members.insert({
        spaceId,
        userId,
        role,
        status: 'ACTIVE',
        joinedAt: now,
        revokedAt: null,
      });
    }
  }

  private async notifyOwners(
    spaceId: string,
    ownerId: string,
    title: string,
    body: string,
    joinRequestId: string | null,
  ): Promise<void> {
    const ownerIds = new Set<string>([ownerId]);
    for (const m of await this.db.members.listForSpace(spaceId)) {
      if (m.role === 'OWNER' && m.status === 'ACTIVE') ownerIds.add(m.userId);
    }
    for (const id of ownerIds) {
      await this.spaces.notify(id, spaceId, 'JOIN_REQUEST', title, body, { joinRequestId });
    }
  }

  private async requireLink(token: string): Promise<SpaceInviteLink> {
    const link = await this.db.inviteLinks.findByToken(token);
    if (!link || link.revokedAt) {
      throw new AppError('INVITE_LINK_INVALID', 'This invite link is no longer active');
    }
    return link;
  }

  /** Find an email invitation by its secure token hash. */
  private async findInvitationByToken(token: string): Promise<SpaceInvitation | null> {
    const hash = this.hashToken(token);
    const all = await this.db.invitations.listForSpace(''); // get all
    // InvitationsRepo.listForSpace with empty string returns all in memory impl
    // but in SQLite it filters by space_id. Use listAll instead.
    const allInvitations = await this.db.invitations.listAll?.() ?? all;
    return allInvitations.find((i) => i.tokenHash === hash && i.status === 'PENDING') ?? null;
  }

  /** Find an email invitation by its token for validation (doesn't require PENDING status). */
  async findInvitationByTokenForValidation(token: string): Promise<SpaceInvitation | null> {
    const hash = this.hashToken(token);
    const allInvitations = await this.db.invitations.listAll?.() ?? [];
    return allInvitations.find((i) => i.tokenHash === hash) ?? null;
  }

  /** SHA-256 fingerprint; the raw invitation token is never stored. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async linkView(spaceId: string): Promise<{ url: string; role: MemberRole; createdAt: string } | null> {
    const link = await this.db.inviteLinks.findActiveForSpace(spaceId);
    return link ? this.toLinkView(link) : null;
  }

  private toLinkView(link: SpaceInviteLink): { url: string; role: MemberRole; createdAt: string } {
    return { url: this.joinUrl(link.token), role: link.role, createdAt: link.createdAt };
  }

  private joinUrl(token: string): string {
    return `${this.env.webAppUrl.replace(/\/$/, '')}/#/join/${token}`;
  }

  private async pendingInvites(spaceId: string): Promise<PendingInviteView[]> {
    const pendingRequests: PendingInviteView[] = [];
    for (const r of (await this.db.joinRequests.listForSpace(spaceId, 'PENDING')).filter(
      (r) => r.source === 'EMAIL',
    )) {
      pendingRequests.push({
        kind: 'EMAIL',
        id: r.id,
        email: (await this.db.auth.findById(r.requesterId))?.email ?? null,
        role: r.role,
        status: 'PENDING',
        createdAt: r.createdAt,
      });
    }
    const unclaimed: PendingInviteView[] = [];
    for (const i of (await this.db.invitations.listForSpace(spaceId)).filter(
      (i) => i.status === 'PENDING' && !this.db.joinRequests.findOpenForInvitation(i.id),
    )) {
      unclaimed.push({
        kind: 'EMAIL',
        id: i.id,
        email: i.email,
        role: i.intendedRole,
        status: 'PENDING',
        createdAt: i.createdAt,
      });
    }
    return [...pendingRequests, ...unclaimed].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async joinRequestViews(spaceId: string): Promise<JoinRequestView[]> {
    const rows = await this.db.joinRequests.listForSpace(spaceId);
    const views: JoinRequestView[] = [];
    for (const r of rows) views.push(await this.toJoinRequestView(r));
    return views;
  }

  private async toJoinRequestView(request: JoinRequest): Promise<JoinRequestView> {
    const requester = await this.db.auth.findById(request.requesterId);
    const space = await this.db.spaces.findById(request.spaceId);
    return {
      ...request,
      spaceName: space?.name ?? 'Space',
      requesterDisplayName: requester?.displayName ?? 'Unknown user',
      requesterEmail: requester?.email ?? '',
    };
  }
}
