import type {
  ExtensionRequest,
  Folder,
  MemberRole,
  Space,
  SpaceInvitation,
  SpaceMember,
  SpaceStatus,
} from '@flashspace/shared';
import type {
  ExtensionRequestsRepo,
  FoldersRepo,
  InvitationsRepo,
  MembersRepo,
  SpacesRepo,
} from '../data-layer.interface.js';

/** In-memory repositories mirroring the Postgres schema shape. */

export class MemorySpacesRepo implements SpacesRepo {
  private readonly spaces = new Map<string, Space>();

  insert(space: Space): Space {
    this.spaces.set(space.id, space);
    return space;
  }

  findById(id: string): Space | undefined {
    return this.spaces.get(id);
  }

  update(id: string, patch: Partial<Space>): Space | undefined {
    const space = this.spaces.get(id);
    if (!space) return undefined;
    const next = { ...space, ...patch, updatedAt: new Date().toISOString() };
    this.spaces.set(id, next);
    return next;
  }

  list(): Space[] {
    return [...this.spaces.values()];
  }

  listForUser(userId: string): Space[] {
    return this.list();
  }
}

export class MemoryMembersRepo implements MembersRepo {
  private readonly members = new Map<string, SpaceMember>(); // key `${spaceId}:${userId}`

  private static key(spaceId: string, userId: string): string {
    return `${spaceId}:${userId}`;
  }

  insert(member: SpaceMember): SpaceMember {
    this.members.set(MemoryMembersRepo.key(member.spaceId, member.userId), member);
    return member;
  }

  find(spaceId: string, userId: string): SpaceMember | undefined {
    return this.members.get(MemoryMembersRepo.key(spaceId, userId));
  }

  listForSpace(spaceId: string): SpaceMember[] {
    return [...this.members.values()].filter((m) => m.spaceId === spaceId);
  }

  listForUser(userId: string): SpaceMember[] {
    return [...this.members.values()].filter((m) => m.userId === userId && m.status !== 'REVOKED');
  }

  update(spaceId: string, userId: string, patch: Partial<SpaceMember>): SpaceMember | undefined {
    const key = MemoryMembersRepo.key(spaceId, userId);
    const member = this.members.get(key);
    if (!member) return undefined;
    const next = { ...member, ...patch };
    this.members.set(key, next);
    return next;
  }

  /** Used by cleanup: revoke every membership of a Space in one sweep. */
  revokeAllForSpace(spaceId: string): number {
    let count = 0;
    for (const [key, m] of this.members) {
      if (m.spaceId === spaceId && m.status !== 'REVOKED') {
        this.members.set(key, { ...m, status: 'REVOKED', revokedAt: new Date().toISOString() });
        count++;
      }
    }
    return count;
  }

  countByRole(spaceId: string, role: MemberRole): number {
    return this.listForSpace(spaceId).filter((m) => m.role === role && m.status === 'ACTIVE').length;
  }
}

export class MemoryFoldersRepo implements FoldersRepo {
  private readonly folders = new Map<string, Folder>();

  insert(folder: Folder): Folder {
    this.folders.set(folder.id, folder);
    return folder;
  }

  findById(id: string): Folder | undefined {
    return this.folders.get(id);
  }

  listForSpace(spaceId: string): Folder[] {
    return [...this.folders.values()].filter((f) => f.spaceId === spaceId);
  }

  update(id: string, patch: Partial<Folder>): Folder | undefined {
    const folder = this.folders.get(id);
    if (!folder) return undefined;
    const next = { ...folder, ...patch, updatedAt: new Date().toISOString() };
    this.folders.set(id, next);
    return next;
  }
}

export class MemoryInvitationsRepo implements InvitationsRepo {
  private readonly invitations = new Map<string, SpaceInvitation>();

  insert(inv: SpaceInvitation): SpaceInvitation {
    this.invitations.set(inv.id, inv);
    return inv;
  }

  findById(id: string): SpaceInvitation | undefined {
    return this.invitations.get(id);
  }

  listForSpace(spaceId: string): SpaceInvitation[] {
    return [...this.invitations.values()].filter((i) => i.spaceId === spaceId);
  }

  findBySpaceAndEmail(spaceId: string, email: string): SpaceInvitation | undefined {
    return [...this.invitations.values()].find(
      (i) => i.spaceId === spaceId && i.email === email.toLowerCase() && i.status === 'PENDING',
    );
  }

  update(id: string, patch: Partial<SpaceInvitation>): SpaceInvitation | undefined {
    const inv = this.invitations.get(id);
    if (!inv) return undefined;
    const next = { ...inv, ...patch };
    this.invitations.set(id, next);
    return next;
  }
}

export class MemoryExtensionRequestsRepo implements ExtensionRequestsRepo {
  private readonly requests = new Map<string, ExtensionRequest>();

  insert(req: ExtensionRequest): ExtensionRequest {
    this.requests.set(req.id, req);
    return req;
  }

  findById(id: string): ExtensionRequest | undefined {
    return this.requests.get(id);
  }

  listForSpace(spaceId: string): ExtensionRequest[] {
    return [...this.requests.values()]
      .filter((r) => r.spaceId === spaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listAll(): ExtensionRequest[] {
    return [...this.requests.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  findPendingForSpace(spaceId: string): ExtensionRequest | undefined {
    return [...this.requests.values()].find((r) => r.spaceId === spaceId && r.status === 'PENDING');
  }

  update(id: string, patch: Partial<ExtensionRequest>): ExtensionRequest | undefined {
    const req = this.requests.get(id);
    if (!req) return undefined;
    const next = { ...req, ...patch };
    this.requests.set(id, next);
    return next;
  }
}

export type { SpaceStatus };
