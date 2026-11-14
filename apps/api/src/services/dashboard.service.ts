import type {
  ActivityLog,
  AuthUser,
  DashboardActivityItem,
  DashboardExpiryItem,
  DashboardFileItem,
  DashboardInvitationItem,
  DashboardSpaceItem,
  DashboardSummary,
  FileRecord,
  Profile,
  Space,
  SpaceDetail,
} from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { SpacesService } from './spaces.service.js';
import type { StorageService } from './storage.service.js';

/**
 * Dashboard aggregation (Module 2.1).
 *
 * Every number here is derived from the same rows the rest of the app uses:
 * the lifecycle status stored on the Space, the warning window from the env
 * config, the real file bytes and verified archive sizes from StorageService.
 * Nothing is hardcoded and nothing is invented.
 *
 * Sections are computed defensively: one failing source is reported in
 * `errors` instead of taking the whole dashboard down.
 */
export class DashboardService {
  constructor(
    private readonly env: Env,
    private readonly db: DataLayer,
    private readonly spaces: SpacesService,
    private readonly storage: StorageService,
  ) {}

  async summary(actor: AuthUser): Promise<DashboardSummary> {
    const errors: string[] = [];
    const spaces = await this.spaces.listForUser(actor.id);
    const accessible = new Map(spaces.map((s) => [s.id, s]));
    const nowMs = Date.now();
    const warningMs = this.env.warningWindowHours * 3_600_000;

    /** Same rule the lifecycle runner uses to warn: state or window. */
    const isExpiring = (space: Space): boolean => {
      if (space.status === 'WARNING') return true;
      if (space.status !== 'ACTIVE' && space.status !== 'DRAFT') return false;
      return new Date(space.expiryAt).getTime() - nowMs <= warningMs;
    };

    const counts = {
      total: spaces.length,
      active: spaces.filter((s) => s.status === 'ACTIVE').length,
      expiring: spaces.filter((s) => s.status !== 'ARCHIVED' && isExpiring(s)).length,
      archived: spaces.filter((s) => s.status === 'ARCHIVED').length,
    };

    const expiring: DashboardExpiryItem[] = spaces
      .filter((s) => s.status !== 'ARCHIVED' && isExpiring(s))
      .sort((a, b) => a.expiryAt.localeCompare(b.expiryAt))
      .slice(0, 6)
      .map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        expiryAt: s.expiryAt,
        remainingMs: new Date(s.expiryAt).getTime() - nowMs,
      }));

    const storage = await this.guard(errors, 'storage', () => this.storage.summary(actor), null);
    const activity = await this.guard(errors, 'activity', () => this.activity(actor, accessible), []);
    const recentUploads = await this.guard(
      errors,
      'recentUploads',
      () => this.recentUploads(accessible),
      [],
    );
    const recentSpaces = await this.guard(errors, 'recentSpaces', () => this.recentSpaces(actor, accessible), []);
    const invitations = await this.guard(errors, 'invitations', () => this.invitations(actor, accessible), []);

    return {
      generatedAt: new Date().toISOString(),
      counts,
      storage,
      expiring,
      activity,
      recentUploads,
      recentSpaces,
      invitations,
      errors,
    };
  }

  // -- sections --------------------------------------------------------------

  private async activity(
    actor: AuthUser,
    accessible: Map<string, SpaceDetail>,
  ): Promise<DashboardActivityItem[]> {
    // `listAll` is newest-first; read a window and keep only events the caller is
    // allowed to see: their own, or anything inside a Space they belong to.
    const rows = await this.db.activity.listAll(200);
    const visible = rows
      .filter((row) => row.userId === actor.id || (row.spaceId && accessible.has(row.spaceId)))
      .slice(0, 10);
    const names = await this.profileNameCache(visible.map((row) => row.userId));
    return visible.map((row: ActivityLog) => ({
      id: row.id,
      action: row.action,
      createdAt: row.createdAt,
      spaceId: row.spaceId,
      spaceName: row.spaceId ? (accessible.get(row.spaceId)?.name ?? null) : null,
      actorName: row.userId ? (names.get(row.userId) ?? null) : null,
      fileId: row.fileId,
    }));
  }

  private async recentUploads(accessible: Map<string, SpaceDetail>): Promise<DashboardFileItem[]> {
    const rows: { file: FileRecord; space: SpaceDetail }[] = [];
    for (const space of accessible.values()) {
      for (const file of await this.db.files.listActiveForSpace(space.id)) {
        rows.push({ file, space });
      }
    }
    const top = rows
      .sort((a, b) => b.file.createdAt.localeCompare(a.file.createdAt))
      .slice(0, 6);
    const names = await this.profileNameCache(top.map(({ file }) => file.uploaderId));
    return top.map(({ file, space }) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      uploadedAt: file.createdAt,
      spaceId: space.id,
      spaceName: space.name,
      uploaderName: names.get(file.uploaderId) ?? null,
    }));
  }

  private async recentSpaces(
    actor: AuthUser,
    accessible: Map<string, SpaceDetail>,
  ): Promise<DashboardSpaceItem[]> {
    const rows = await this.db.access.listForUser(actor.id, 12);
    const names = await this.profileNameCache(
      [...accessible.values()].map((space) => space.ownerId),
    );
    return rows
      .map((row) => ({ row, space: accessible.get(row.spaceId) }))
      .filter((entry): entry is { row: typeof rows[number]; space: SpaceDetail } => Boolean(entry.space))
      .slice(0, 6)
      .map(({ row, space }) => ({
        id: space.id,
        name: space.name,
        purpose: space.purpose,
        status: space.status,
        role: space.role,
        ownerName: names.get(space.ownerId) ?? null,
        memberCount: space.members.length,
        expiryAt: space.expiryAt,
        lastAccessedAt: row.lastAccessedAt,
      }));
  }

  private async invitations(
    actor: AuthUser,
    accessible: Map<string, SpaceDetail>,
  ): Promise<DashboardInvitationItem[]> {
    const email = actor.email.toLowerCase();
    const nowIso = new Date().toISOString();
    // Collected first, then enriched: the inviter display names are resolved in
    // one pass after every candidate is known.
    const pending: { item: Omit<DashboardInvitationItem, 'inviterName'>; inviterId: string }[] = [];

    // Email invitations addressed to this account for Spaces it has not joined.
    for (const space of await this.db.spaces.list()) {
      if (space.status === 'DELETED' || accessible.has(space.id)) continue;
      const invitations = await this.db.invitations.listForSpace(space.id);
      for (const invitation of invitations) {
        if (
          invitation.status !== 'PENDING' ||
          invitation.email.toLowerCase() !== email ||
          invitation.expiresAt <= nowIso
        ) {
          continue;
        }
        pending.push({
          item: {
            id: invitation.id,
            kind: 'EMAIL',
            spaceId: space.id,
            spaceName: space.name,
            role: invitation.intendedRole,
            createdAt: invitation.createdAt,
            expiresAt: invitation.expiresAt,
          },
          inviterId: invitation.inviterId,
        });
      }
    }

    // Requests this user raised from an invite link, still awaiting a decision.
    const requests = await this.db.joinRequests.listForRequester(actor.id);
    for (const request of requests) {
      if (request.status !== 'PENDING') continue;
      const space = accessible.get(request.spaceId) ?? (await this.db.spaces.findById(request.spaceId));
      if (!space || space.status === 'DELETED') continue;
      pending.push({
        item: {
          id: request.id,
          kind: 'LINK',
          spaceId: space.id,
          spaceName: space.name,
          role: request.role,
          createdAt: request.createdAt,
          expiresAt: null,
        },
        inviterId: space.ownerId,
      });
    }

    const names = await this.profileNameCache(pending.map((entry) => entry.inviterId));
    return pending
      .map(({ item, inviterId }) => ({ ...item, inviterName: names.get(inviterId) ?? null }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 6);
  }

  // -- internals -------------------------------------------------------------

  /** Runs a section, recording its name instead of failing the whole request. */
  private async guard<T>(errors: string[], section: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      console.error(`[dashboard] section ${section} failed`, err);
      errors.push(section);
      return fallback;
    }
  }

  private async profileNameCache(userIds: (string | null)[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const userId of new Set(userIds.filter((id): id is string => Boolean(id)))) {
      const profile: Profile | undefined = await this.db.auth.findById(userId);
      if (profile) names.set(userId, profile.displayName);
    }
    return names;
  }
}
