import type { JoinRequest, JoinRequestStatus, SpaceInviteLink } from '@flashspace/shared';
import type { InviteLinksRepo, JoinRequestsRepo } from '../data-layer.interface.js';

/** In-memory invite-link store (one active link per Space). */
export class MemoryInviteLinksRepo implements InviteLinksRepo {
  private readonly links = new Map<string, SpaceInviteLink>();

  insert(link: SpaceInviteLink): SpaceInviteLink {
    this.links.set(link.id, link);
    return link;
  }

  findById(id: string): SpaceInviteLink | undefined {
    return this.links.get(id);
  }

  findByToken(token: string): SpaceInviteLink | undefined {
    return [...this.links.values()].find((l) => l.token === token);
  }

  /** The link that is currently shareable for a Space, if any. */
  findActiveForSpace(spaceId: string): SpaceInviteLink | undefined {
    return [...this.links.values()]
      .filter((l) => l.spaceId === spaceId && !l.revokedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  listForSpace(spaceId: string): SpaceInviteLink[] {
    return [...this.links.values()].filter((l) => l.spaceId === spaceId);
  }

  update(id: string, patch: Partial<SpaceInviteLink>): SpaceInviteLink | undefined {
    const link = this.links.get(id);
    if (!link) return undefined;
    const next = { ...link, ...patch };
    this.links.set(id, next);
    return next;
  }
}

/** In-memory join-request store. */
export class MemoryJoinRequestsRepo implements JoinRequestsRepo {
  private readonly requests = new Map<string, JoinRequest>();

  insert(request: JoinRequest): JoinRequest {
    this.requests.set(request.id, request);
    return request;
  }

  findById(id: string): JoinRequest | undefined {
    return this.requests.get(id);
  }

  listForSpace(spaceId: string, status?: JoinRequestStatus): JoinRequest[] {
    return [...this.requests.values()]
      .filter((r) => r.spaceId === spaceId && (!status || r.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listForRequester(requesterId: string): JoinRequest[] {
    return [...this.requests.values()]
      .filter((r) => r.requesterId === requesterId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  findPendingForUser(spaceId: string, requesterId: string): JoinRequest | undefined {
    return [...this.requests.values()].find(
      (r) => r.spaceId === spaceId && r.requesterId === requesterId && r.status === 'PENDING',
    );
  }

  findOpenForInvitation(invitationId: string): JoinRequest | undefined {
    return [...this.requests.values()].find(
      (r) => r.invitationId === invitationId && r.status === 'PENDING',
    );
  }

  listAll(): JoinRequest[] {
    return [...this.requests.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  update(id: string, patch: Partial<JoinRequest>): JoinRequest | undefined {
    const request = this.requests.get(id);
    if (!request) return undefined;
    const next = { ...request, ...patch };
    this.requests.set(id, next);
    return next;
  }
}
