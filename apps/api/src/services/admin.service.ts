import fs from 'node:fs';
import type {
  AdminAnalytics,
  AdminAnalyticsBucket,
  AdminAuditEntry,
  AdminCleanupRow,
  AdminHealth,
  AdminHealthCheck,
  AdminJobDetail,
  AdminJobRow,
  AdminOverview,
  AdminStats,
  AdminUserDetail,
  AdminUserPage,
  AdminUserRow,
  Archive,
  ExtensionRequest,
  LifecycleJob,
  Profile,
  ProfileRole,
} from '@flashspace/shared';
import { AppError } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { AdminAuditRow, DataLayer, UserQuery } from '../repositories/data-layer.interface.js';

/**
 * Retry policy for failed background jobs. Documented in one place so the UI,
 * the API and the retry guard cannot drift apart.
 */
export const ADMIN_MAX_JOB_ATTEMPTS = 3;
/** Days a verified archive is retained before automatic cleanup. */
const RETENTION_DAYS = 7;

export interface AdminServiceDeps {
  /** Existing archive runner — the only path that may (re)build an archive. */
  archive: { runArchive(archiveId: string): Promise<Archive> };
  /** Email transport summary; used for the health probe only. */
  email: { readonly isMockMode: boolean };
}

/**
 * Admin control panel backend (PRD §12).
 *
 * Every number here is computed from persisted rows on the request that asks
 * for it — there is no cached or invented metric. User directory queries are
 * pushed into the data layer so the console never loads every profile.
 */
export class AdminService {
  constructor(
    private readonly env: Env,
    private readonly db: DataLayer,
    private readonly deps: AdminServiceDeps,
  ) {}

  // -- guard ---------------------------------------------------------------

  private async requireAdmin(userId: string): Promise<Profile> {
    const profile = await this.db.auth.findById(userId);
    if (!profile || profile.role !== 'ADMIN') {
      throw new AppError('ADMIN_REQUIRED', 'Admin access required');
    }
    if ((profile.status ?? 'ACTIVE') === 'SUSPENDED') {
      throw new AppError('ADMIN_REQUIRED', 'Admin access required');
    }
    return profile;
  }

  /** Append-only audit write. Never stores credentials or tokens. */
  private async audit(
    adminId: string,
    action: string,
    targetType: string,
    targetId: string,
    outcome: 'SUCCESS' | 'FAILURE',
    reason: string | null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db.adminAudit.append({
      adminId,
      action,
      targetType,
      targetId,
      outcome,
      reason,
      metadata,
    });
    // The protected audit store is the source of truth; mirror into the
    // platform activity feed so the general activity view includes privileged
    // actions with the administrator as the actor.
    await this.db.activity.append({
      userId: adminId,
      spaceId: typeof metadata.spaceId === 'string' ? metadata.spaceId : null,
      action,
      actorType: 'ADMIN',
      outcome,
      category: action.startsWith('SECURITY_') ? 'SECURITY' : 'ADMIN',
      resourceType: targetType,
      resourceId: targetId,
      reason,
      metadata: { ...metadata, targetType, targetId },
    });
  }

  /** Resolve a display name for audit rows without leaking anything else. */
  private async auditNames(entries: AdminAuditRow[]): Promise<AdminAuditEntry[]> {
    const names = new Map<string, string>();
    for (const entry of entries) {
      if (names.has(entry.adminId)) continue;
      const profile = await this.db.auth.findById(entry.adminId);
      names.set(entry.adminId, profile?.displayName ?? 'Unknown admin');
    }
    return entries.map((e) => ({ ...e, adminName: names.get(e.adminId) ?? null }));
  }

  // -- dashboard -----------------------------------------------------------

  /**
   * Platform overview: users, Spaces by lifecycle state, storage split between
   * temporary Space storage and permanent Vault archives, job health and the
   * pending moderation queues.
   */
  async overview(userId: string): Promise<AdminOverview> {
    await this.requireAdmin(userId);

    const profiles = await this.db.auth.all();
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const suspended = profiles.filter((p) => (p.status ?? 'ACTIVE') === 'SUSPENDED').length;

    const spaces = await this.db.spaces.list();
    const byStatus = spaces.reduce<Record<string, number>>((acc, s) => {
      acc[s.status] = (acc[s.status] ?? 0) + 1;
      return acc;
    }, {});
    const liveSpaces = spaces.filter((s) => s.status !== 'DELETED');

    const files = await this.db.files.listAll();
    const liveFiles = files.filter((f) => f.status !== 'DELETED');
    const temporaryBytes = liveFiles.reduce((sum, f) => sum + f.sizeBytes, 0);

    const archives = await this.db.archives.listAll();
    const verifiedArchives = archives.filter((a) => a.status === 'VERIFIED');
    const vaultBytes = verifiedArchives.reduce((sum, a) => sum + a.sizeBytes, 0);

    const jobs = await this.db.jobs.list(500);
    const failedJobs = jobs.filter((j) => j.status === 'FAILED');
    const succeeded = jobs.filter((j) => j.status === 'SUCCEEDED');
    const lastSuccessAt = succeeded
      .map((j) => j.finishedAt ?? j.startedAt)
      .sort()
      .at(-1) ?? null;
    const lastFailureAt = failedJobs
      .map((j) => j.finishedAt ?? j.startedAt)
      .sort()
      .at(-1) ?? null;

    const extensions = await this.db.extensionRequests.listAll();
    const joinRequests = await this.db.joinRequests.listAll();
    const invitations = await this.db.invitations.listAll();

    const emailJobs = await this.db.emailJobs.listAll(1000);

    return {
      generatedAt: new Date().toISOString(),
      users: {
        total: profiles.length,
        active: profiles.length - suspended,
        suspended,
        admins: profiles.filter((p) => p.role === 'ADMIN').length,
        registeredLast7Days: profiles.filter((p) => Date.parse(p.createdAt) >= weekAgo).length,
      },
      spaces: {
        total: liveSpaces.length,
        draft: byStatus.DRAFT ?? 0,
        active: byStatus.ACTIVE ?? 0,
        warning: byStatus.WARNING ?? 0,
        archiving: byStatus.ARCHIVING ?? 0,
        archived: byStatus.ARCHIVED ?? 0,
        archiveFailed: byStatus.ARCHIVE_FAILED ?? 0,
        deleted: byStatus.DELETED ?? 0,
      },
      storage: {
        temporaryBytes,
        vaultBytes,
        fileCount: liveFiles.length,
        verifiedArchives: verifiedArchives.length,
        failedArchives: archives.filter((a) => a.status === 'FAILED').length,
      },
      jobs: {
        total: jobs.length,
        pending: jobs.filter((j) => j.status === 'PENDING').length,
        running: jobs.filter((j) => j.status === 'RUNNING').length,
        succeeded: succeeded.length,
        failed: failedJobs.length,
        awaitingIntervention: failedJobs.filter((j) => j.attempts < ADMIN_MAX_JOB_ATTEMPTS).length,
        lastSuccessAt,
        lastFailureAt,
      },
      queues: {
        pendingExtensions: extensions.filter((r) => r.status === 'PENDING').length,
        pendingJoinRequests: joinRequests.filter((r) => r.status === 'PENDING').length,
        pendingInvitations: invitations.filter((i) => i.status === 'PENDING').length,
        pendingEmailRetries: emailJobs.filter((j) => j.status === 'RETRY_SCHEDULED').length,
      },
      email: {
        mode: this.deps.email.isMockMode ? 'mock' : 'smtp',
        configured: !this.deps.email.isMockMode,
        total: emailJobs.length,
        sent: emailJobs.filter((j) => j.status === 'SENT').length,
        failed: emailJobs.filter((j) => j.status === 'FAILED').length,
        pending: emailJobs.filter((j) => j.status === 'PENDING' || j.status === 'RETRY_SCHEDULED')
          .length,
      },
    };
  }

  /**
   * Backwards-compatible summary (existing clients and tests). Keeps the exact
   * `AdminStats` shape while sourcing values from live rows.
   */
  async stats(userId: string): Promise<AdminStats> {
    await this.requireAdmin(userId);
    const now = Date.now();
    const warningCutoff = now + this.env.warningWindowHours * 3600 * 1000;

    const spaces = await this.db.spaces.list();
    const live = spaces.filter((s) => s.status !== 'DELETED');
    const spacesByStatus = live.reduce<Record<string, number>>((acc, s) => {
      acc[s.status] = (acc[s.status] ?? 0) + 1;
      return acc;
    }, {});

    const warningWindow = live.filter(
      (s) =>
        s.status === 'WARNING' ||
        ((s.status === 'ACTIVE' || s.status === 'DRAFT') &&
          new Date(s.expiryAt).getTime() <= warningCutoff),
    ).length;

    const extensions = await this.db.extensionRequests.listAll();
    const pendingExtensions = extensions.filter((r) => r.status === 'PENDING').length;
    const pendingJoinRequests = (await this.db.joinRequests.listAll()).filter(
      (r) => r.status === 'PENDING',
    ).length;

    const archives = await this.db.archives.listAll();
    const verifiedArchives = archives.filter((a) => a.status === 'VERIFIED').length;
    const failedArchives = archives.filter((a) => a.status === 'FAILED').length;
    const archivedBytes = archives
      .filter((a) => a.status === 'VERIFIED')
      .reduce((sum, a) => sum + a.sizeBytes, 0);
    const archivalPipeline = archives.length
      ? Math.round((verifiedArchives / archives.length) * 1000) / 10
      : 100;

    const files = await this.db.files.listAll();
    const totalStorageBytes = files
      .filter((f) => f.status !== 'DELETED')
      .reduce((sum, f) => sum + f.sizeBytes, 0);

    const jobs = await this.db.jobs.list(200);
    const jobsByStatus = jobs.reduce<Record<string, number>>((acc, j) => {
      acc[j.status] = (acc[j.status] ?? 0) + 1;
      return acc;
    }, {});

    return {
      users: await this.db.auth.count(),
      spaces: live.length,
      activeSpaces: live.filter((s) => s.status === 'ACTIVE').length,
      warningWindow,
      archivedSpaces: live.filter((s) => s.status === 'ARCHIVED').length,
      pendingTickets: pendingExtensions + pendingJoinRequests,
      pendingExtensions,
      pendingJoinRequests,
      archivalPipeline,
      verifiedArchives,
      failedArchives,
      totalFiles: files.filter((f) => f.status !== 'DELETED').length,
      totalStorageBytes,
      archivedBytes,
      spacesByStatus,
      jobsByStatus,
      recentJobs: await this.db.jobs.list(10),
    };
  }

  // -- users ---------------------------------------------------------------

  async listUsers(
    adminId: string,
    query: Partial<UserQuery> = {},
  ): Promise<AdminUserPage> {
    await this.requireAdmin(adminId);
    const page = await this.db.auth.list({
      q: query.q,
      role: query.role,
      status: query.status,
      sort: query.sort,
      limit: Math.min(Math.max(query.limit ?? 25, 1), 100),
      offset: Math.max(query.offset ?? 0, 0),
    });

    const rows: AdminUserRow[] = [];
    for (const profile of page.users) {
      const owned = (await this.db.spaces.list()).filter(
        (s) => s.ownerId === profile.id && s.status !== 'DELETED',
      ).length;
      const memberships = (await this.db.members.listForUser(profile.id)).length;
      rows.push({ ...profile, spaceCount: owned, membershipCount: memberships });
    }

    return {
      users: rows,
      total: page.total,
      limit: Math.min(Math.max(query.limit ?? 25, 1), 100),
      offset: Math.max(query.offset ?? 0, 0),
    };
  }

  async userDetail(adminId: string, targetUserId: string): Promise<AdminUserDetail> {
    await this.requireAdmin(adminId);
    const profile = await this.db.auth.findById(targetUserId);
    if (!profile) throw new AppError('NOT_FOUND', 'User not found');

    const allSpaces = await this.db.spaces.list();
    const spacesOwned = allSpaces
      .filter((s) => s.ownerId === targetUserId)
      .map((s) => ({ id: s.id, name: s.name, status: s.status }));
    const memberships = [];
    for (const m of await this.db.members.listForUser(targetUserId)) {
      const space = allSpaces.find((s) => s.id === m.spaceId);
      memberships.push({
        spaceId: m.spaceId,
        spaceName: space?.name ?? 'Removed Space',
        role: m.role,
        status: m.status,
      });
    }

    const files = (await this.db.files.listAll()).filter((f) => f.uploaderId === targetUserId);
    const activity = (await this.db.activity.listAll(500))
      .filter((a) => a.userId === targetUserId)
      .slice(0, 25);
    const audit = await this.db.adminAudit.list({ outlet: 'ALL', limit: 500, offset: 0 });
    const securityEvents = (await this.auditNames(
      audit.entries.filter((e) => e.targetId === targetUserId),
    )).slice(0, 25);

    await this.audit(adminId, 'USER_VIEWED', 'user', targetUserId, 'SUCCESS', null, {});

    return {
      user: profile,
      spacesOwned,
      memberships,
      counts: {
        spacesOwned: spacesOwned.length,
        memberships: memberships.length,
        files: files.length,
      },
      recentActivity: activity,
      securityEvents,
    };
  }

  /**
   * Change a global role. Space OWNER/EDITOR/VIEWER roles are never touched:
   * global administration and Space permissions are separate systems.
   */
  async changeRole(
    adminId: string,
    targetUserId: string,
    role: ProfileRole,
    reason?: string,
  ): Promise<Profile> {
    const actor = await this.requireAdmin(adminId);
    if (targetUserId === adminId) {
      // Self-demotion is allowed only when another admin remains; self-promotion
      // is meaningless (the caller is already an admin).
      if (role === 'ADMIN') {
        throw new AppError('INVALID_ROLE_CHANGE', 'You already hold the ADMIN role');
      }
    }
    const target = await this.db.auth.findById(targetUserId);
    if (!target) throw new AppError('NOT_FOUND', 'User not found');
    if (target.role === role) {
      throw new AppError('NO_CHANGE', `User already has the ${role} role`);
    }

    if (target.role === 'ADMIN' && role === 'USER') {
      const admins = await this.db.auth.countAdmins();
      if (admins <= 1) {
        throw new AppError(
          'LAST_ADMIN',
          'The last active administrator cannot be demoted. Promote another admin first.',
        );
      }
    }

    const updated = await this.db.auth.setRole(targetUserId, role);
    if (!updated) throw new AppError('UPDATE_FAILED', 'Could not update the role');

    await this.audit(
      actor.id,
      role === 'ADMIN' ? 'SECURITY_ROLE_GRANTED' : 'SECURITY_ROLE_REVOKED',
      'user',
      targetUserId,
      'SUCCESS',
      reason ?? null,
      { previousRole: target.role, newRole: role, targetEmail: target.email },
    );

    // Notify the affected user; in-app delivery only (no email dependency).
    try {
      await this.db.notifications.insert({
        id: crypto.randomUUID(),
        userId: targetUserId,
        spaceId: null,
        type: 'MEMBER_ROLE_CHANGED',
        title:
          role === 'ADMIN'
            ? 'You are now an administrator'
            : 'Your administrator role was removed',
        body:
          role === 'ADMIN'
            ? 'A platform administrator granted you the ADMIN role.'
            : 'A platform administrator changed your global role to USER.',
        inviteLinkId: null,
        joinRequestId: null,
        readAt: null,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Notification failure must not roll back an audited role change.
    }

    return updated;
  }

  /** Backwards-compatible alias used by the existing admin route. */
  async promoteToAdmin(adminId: string, targetUserId: string): Promise<Profile> {
    return this.changeRole(adminId, targetUserId, 'ADMIN', 'promoted-from-admin-console');
  }

  /**
   * Suspend an account. Tokens stop working immediately because every
   * authenticated request re-reads the profile status. Data, Spaces and Vault
   * archives are preserved; ownership is never transferred.
   */
  async suspendAccount(
    adminId: string,
    targetUserId: string,
    reason: string,
  ): Promise<Profile> {
    const actor = await this.requireAdmin(adminId);
    if (targetUserId === adminId) {
      throw new AppError('INVALID_SUSPENSION', 'You cannot suspend your own account');
    }
    const target = await this.db.auth.findById(targetUserId);
    if (!target) throw new AppError('NOT_FOUND', 'User not found');
    if ((target.status ?? 'ACTIVE') === 'SUSPENDED') {
      throw new AppError('ALREADY_SUSPENDED', 'This account is already suspended');
    }
    if (target.role === 'ADMIN' && (await this.db.auth.countAdmins()) <= 1) {
      throw new AppError('LAST_ADMIN', 'The last active administrator cannot be suspended');
    }

    const updated = await this.db.auth.setStatus(targetUserId, {
      status: 'SUSPENDED',
      suspendedAt: new Date().toISOString(),
      suspendedBy: actor.id,
      suspensionReason: reason,
    });
    if (!updated) throw new AppError('UPDATE_FAILED', 'Could not suspend the account');

    const ownedSpaces = (await this.db.spaces.list()).filter(
      (s) => s.ownerId === targetUserId && s.status !== 'DELETED',
    );
    await this.audit(adminId, 'SECURITY_ACCOUNT_SUSPENDED', 'user', targetUserId, 'SUCCESS', reason, {
      suspendedEmail: target.email,
      ownedSpaceCount: ownedSpaces.length,
      ownershipRetained: true,
    });

    try {
      await this.db.notifications.insert({
        id: crypto.randomUUID(),
        userId: targetUserId,
        spaceId: null,
        type: 'SPACE_WARNING',
        title: 'Your account was suspended',
        body: `An administrator suspended this account. Reason: ${reason}`,
        inviteLinkId: null,
        joinRequestId: null,
        readAt: null,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Best effort; the suspension itself is already persisted and audited.
    }

    return updated;
  }

  async reactivateAccount(adminId: string, targetUserId: string): Promise<Profile> {
    await this.requireAdmin(adminId);
    const target = await this.db.auth.findById(targetUserId);
    if (!target) throw new AppError('NOT_FOUND', 'User not found');
    if ((target.status ?? 'ACTIVE') !== 'SUSPENDED') {
      throw new AppError('NOT_SUSPENDED', 'This account is not suspended');
    }

    const updated = await this.db.auth.setStatus(targetUserId, {
      status: 'ACTIVE',
      suspendedAt: null,
      suspendedBy: null,
      suspensionReason: null,
    });
    if (!updated) throw new AppError('UPDATE_FAILED', 'Could not reactivate the account');

    await this.audit(
      adminId,
      'SECURITY_ACCOUNT_REACTIVATED',
      'user',
      targetUserId,
      'SUCCESS',
      null,
      { reactivatedEmail: target.email },
    );

    try {
      await this.db.notifications.insert({
        id: crypto.randomUUID(),
        userId: targetUserId,
        spaceId: null,
        type: 'SPACE_CREATED',
        title: 'Your account was reactivated',
        body: 'You can sign in again. Your Spaces and archives were preserved.',
        inviteLinkId: null,
        joinRequestId: null,
        readAt: null,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Best effort.
    }

    return updated;
  }

  // -- lifecycle jobs ------------------------------------------------------

  private async jobRows(jobs: LifecycleJob[]): Promise<AdminJobRow[]> {
    const spaces = await this.db.spaces.list();
    const names = new Map(spaces.map((s) => [s.id, s.name]));
    return jobs.map((job) => ({
      ...job,
      spaceName: job.spaceId ? names.get(job.spaceId) ?? null : null,
      maxAttempts: ADMIN_MAX_JOB_ATTEMPTS,
      retryable:
        job.jobType === 'ARCHIVE' &&
        job.status === 'FAILED' &&
        job.attempts < ADMIN_MAX_JOB_ATTEMPTS,
    }));
  }

  async listJobs(
    adminId: string,
    query: {
      status?: LifecycleJob['status'];
      jobType?: LifecycleJob['jobType'];
      q?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ jobs: AdminJobRow[]; total: number; limit: number; offset: number }> {
    await this.requireAdmin(adminId);
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const offset = Math.max(query.offset ?? 0, 0);
    const needle = query.q?.trim().toLowerCase();

    const all = await this.jobRows(await this.db.jobs.list(500));
    const filtered = all.filter((job) => {
      if (query.status && job.status !== query.status) return false;
      if (query.jobType && job.jobType !== query.jobType) return false;
      if (needle) {
        const haystack = `${job.id} ${job.idempotencyKey} ${job.spaceName ?? ''} ${job.spaceId ?? ''}`;
        if (!haystack.toLowerCase().includes(needle)) return false;
      }
      return true;
    });

    return {
      jobs: filtered.slice(offset, offset + limit),
      total: filtered.length,
      limit,
      offset,
    };
  }

  async jobDetail(adminId: string, jobId: string): Promise<AdminJobDetail> {
    await this.requireAdmin(adminId);
    const job = await this.db.jobs.findById(jobId);
    if (!job) throw new AppError('JOB_NOT_FOUND', 'Job not found');
    const [row] = await this.jobRows([job]);
    const transitions = job.spaceId
      ? await this.db.lifecycleTransitions.listForSpace(job.spaceId, 50)
      : [];
    const archives = job.spaceId ? await this.db.archives.listForSpace(job.spaceId) : [];
    const cleanupRuns = job.spaceId ? await this.db.cleanupRuns.listForSpace(job.spaceId) : [];
    return { job: row!, transitions, archives, cleanupRuns };
  }

  async listFailedJobs(adminId: string): Promise<{ jobs: AdminJobRow[]; total: number }> {
    await this.requireAdmin(adminId);
    const rows = await this.jobRows(await this.db.jobs.list(500));
    const failed = rows.filter((j) => j.status === 'FAILED');
    return { jobs: failed, total: failed.length };
  }

  // -- archives ------------------------------------------------------------

  /**
   * Retry a failed archive through the existing archive runner.
   *
   * Guards: a verified archive for the Space is never overwritten, an already
   * queued/running archive job blocks the retry, and the Space must still exist.
   */
  async retryArchive(adminId: string, archiveId: string, ignoreJobId?: string): Promise<Archive> {
    await this.requireAdmin(adminId);
    const archive = await this.db.archives.findById(archiveId);
    if (!archive) throw new AppError('ARCHIVE_NOT_FOUND', 'Archive not found');
    if (archive.status !== 'FAILED') {
      throw new AppError('IDEMPOTENT_NOOP', 'Only failed archives can be retried');
    }

    const space = await this.db.spaces.findById(archive.spaceId);
    if (!space || space.status === 'DELETED') {
      throw new AppError('SPACE_NOT_FOUND', 'The Space for this archive no longer exists');
    }

    const spaceArchives = await this.db.archives.listForSpace(archive.spaceId);
    if (spaceArchives.some((a) => a.status === 'VERIFIED')) {
      throw new AppError(
        'ARCHIVE_ALREADY_VERIFIED',
        'A verified archive already exists for this Space; refusing to overwrite it',
      );
    }

    const activeJob = (await this.db.jobs.list(500)).find(
      (j) =>
        j.id !== ignoreJobId &&
        j.spaceId === archive.spaceId &&
        j.jobType === 'ARCHIVE' &&
        (j.status === 'PENDING' || j.status === 'RUNNING'),
    );
    if (activeJob) {
      throw new AppError(
        'ARCHIVE_JOB_ACTIVE',
        'An archive job is already queued or running for this Space',
      );
    }

    await this.db.archives.update(archiveId, { status: 'PENDING' });
    await this.db.spaces.update(archive.spaceId, { status: 'ARCHIVING' });
    try {
      const result = await this.deps.archive.runArchive(archiveId);
      await this.audit(adminId, 'ARCHIVE_RETRIED', 'archive', archiveId, 'SUCCESS', null, {
        spaceId: archive.spaceId,
        resultStatus: result.status,
      });
      return result;
    } catch (err) {
      await this.audit(
        adminId,
        'ARCHIVE_RETRIED',
        'archive',
        archiveId,
        'FAILURE',
        err instanceof Error ? err.message : String(err),
        { spaceId: archive.spaceId },
      );
      throw err;
    }
  }

  /**
   * Retry a failed ARCHIVE job by delegating to `retryArchive` (single retry
   * implementation). Attempts are bounded by ADMIN_MAX_JOB_ATTEMPTS.
   */
  async retryJob(adminId: string, jobId: string): Promise<AdminJobDetail> {
    await this.requireAdmin(adminId);
    const job = await this.db.jobs.findById(jobId);
    if (!job) throw new AppError('JOB_NOT_FOUND', 'Job not found');
    if (job.jobType !== 'ARCHIVE') {
      throw new AppError('JOB_NOT_RETRYABLE', 'Only archive jobs can be retried');
    }
    if (job.status !== 'FAILED') {
      throw new AppError('JOB_NOT_RETRYABLE', 'Only failed jobs can be retried');
    }
    if (job.attempts >= ADMIN_MAX_JOB_ATTEMPTS) {
      throw new AppError(
        'MAX_RETRIES_EXCEEDED',
        `This job reached the retry ceiling (${ADMIN_MAX_JOB_ATTEMPTS} attempts)`,
      );
    }
    if (!job.spaceId) throw new AppError('JOB_NOT_RETRYABLE', 'Job is not attached to a Space');

    const failedArchive = (await this.db.archives.listForSpace(job.spaceId)).find(
      (a) => a.status === 'FAILED',
    );
    if (!failedArchive) {
      throw new AppError('ARCHIVE_NOT_FOUND', 'No failed archive exists for this Space');
    }

    await this.db.jobs.update(jobId, { status: 'RUNNING', attempts: job.attempts + 1 });
    try {
      // The job we are retrying is transiently RUNNING; it must not count as a
      // concurrent archive job for the same Space.
      await this.retryArchive(adminId, failedArchive.id, jobId);
      await this.db.jobs.finish(jobId, { status: 'SUCCEEDED', error: null });
    } catch (err) {
      await this.db.jobs.finish(jobId, {
        status: 'FAILED',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    return this.jobDetail(adminId, jobId);
  }

  // -- cleanup monitoring --------------------------------------------------

  async cleanupStatus(adminId: string): Promise<{
    runs: AdminCleanupRow[];
    awaiting: { spaceId: string; spaceName: string; status: string; retentionEligibleAt: string }[];
    failed: number;
    partial: number;
  }> {
    await this.requireAdmin(adminId);

    const spaces = await this.db.spaces.list();
    const names = new Map(spaces.map((s) => [s.id, s.name]));
    const runs: AdminCleanupRow[] = [];

    for (const run of await this.db.cleanupRuns.listAll(100)) {
      const space = spaces.find((s) => s.id === run.spaceId);
      const verified = (await this.db.archives.listForSpace(run.spaceId)).find(
        (a) => a.status === 'VERIFIED',
      );
      const eligibleAt = verified?.verifiedAt
        ? new Date(Date.parse(verified.verifiedAt) + RETENTION_DAYS * 86400_000).toISOString()
        : null;
      runs.push({
        ...run,
        spaceName: names.get(run.spaceId) ?? null,
        retentionEligibleAt: eligibleAt,
        remainingBytes: await this.db.files.usedBytesForSpace(run.spaceId),
      });
    }

    const awaiting: {
      spaceId: string;
      spaceName: string;
      status: string;
      retentionEligibleAt: string;
    }[] = [];
    for (const space of spaces) {
      if (space.status !== 'ARCHIVED' || space.archivedManually) continue;
      const verified = (await this.db.archives.listForSpace(space.id)).find(
        (a) => a.status === 'VERIFIED',
      );
      if (!verified?.verifiedAt) continue;
      const eligibleAt = Date.parse(verified.verifiedAt) + RETENTION_DAYS * 86400_000;
      awaiting.push({
        spaceId: space.id,
        spaceName: space.name,
        status: space.status,
        retentionEligibleAt: new Date(eligibleAt).toISOString(),
      });
    }

    return {
      runs,
      awaiting,
      failed: runs.filter((r) => r.status === 'FAILED').length,
      partial: runs.filter((r) => r.status === 'PARTIAL_FAILED').length,
    };
  }

  /** Archive monitoring: lost of archives with their Space name. */
  async listArchives(
    adminId: string,
    status?: Archive['status'],
  ): Promise<{ archives: (Archive & { spaceName: string | null })[]; total: number }> {
    await this.requireAdmin(adminId);
    const spaces = await this.db.spaces.list();
    const names = new Map(spaces.map((s) => [s.id, s.name]));
    const rows = (await this.db.archives.listAll())
      .filter((a) => (status ? a.status === status : true))
      .map((a) => ({ ...a, spaceName: names.get(a.spaceId) ?? null }));
    return { archives: rows, total: rows.length };
  }

  // -- extensions ----------------------------------------------------------

  async listExtensions(adminId: string): Promise<ExtensionRequest[]> {
    await this.requireAdmin(adminId);
    return this.db.extensionRequests.listAll();
  }

  // -- health --------------------------------------------------------------

  /**
   * Health probes. A probe reports `unconfigured` (never `ok`) when the
   * dependency is absent, and `error` when a real check fails.
   */
  async health(adminId: string): Promise<AdminHealth> {
    await this.requireAdmin(adminId);
    const checks: AdminHealthCheck[] = [];
    const checkedAt = new Date().toISOString();

    // API: answering at all is the check.
    checks.push({
      name: 'api',
      status: 'ok',
      detail: `Responding in ${this.env.nodeEnv} mode`,
      checkedAt,
      latencyMs: 0,
    });

    // Database: real query round-trip.
    const dbStarted = Date.now();
    try {
      await this.db.healthCheck();
      checks.push({
        name: 'database',
        status: 'ok',
        detail: `${this.env.repoMode} backend responded to a query`,
        checkedAt,
        latencyMs: Date.now() - dbStarted,
      });
    } catch (err) {
      checks.push({
        name: 'database',
        status: 'error',
        detail: err instanceof Error ? err.message : 'Database check failed',
        checkedAt,
        latencyMs: Date.now() - dbStarted,
      });
    }

    // Storage: local mode checks the directory is writable; cloud mode is only
    // reported as configured (we never claim a remote probe we did not run).
    if (this.env.storageMode === 'local') {
      const started = Date.now();
      try {
        fs.accessSync(this.env.localStorageDir, fs.constants.W_OK);
        checks.push({
          name: 'storage',
          status: 'ok',
          detail: 'Local storage directory is writable',
          checkedAt,
          latencyMs: Date.now() - started,
        });
      } catch {
        checks.push({
          name: 'storage',
          status: 'error',
          detail: 'Local storage directory is missing or not writable',
          checkedAt,
          latencyMs: Date.now() - started,
        });
      }
    } else {
      checks.push({
        name: 'storage',
        status: 'degraded',
        detail: `${this.env.storageMode} storage is configured; connectivity is not probed from here`,
        checkedAt,
        latencyMs: null,
      });
    }

    // Worker: inferred from the persisted job history.
    const jobs = await this.db.jobs.list(50);
    const latest = jobs[0];
    if (!latest) {
      checks.push({
        name: 'worker',
        status: 'unconfigured',
        detail: 'No lifecycle job has been recorded yet',
        checkedAt,
        latencyMs: null,
      });
    } else if (jobs.slice(0, 5).every((j) => j.status === 'FAILED')) {
      checks.push({
        name: 'worker',
        status: 'degraded',
        detail: `The last ${Math.min(jobs.length, 5)} job(s) failed`,
        checkedAt,
        latencyMs: null,
      });
    } else {
      checks.push({
        name: 'worker',
        status: 'ok',
        detail: `Last job ${latest.status} at ${latest.finishedAt ?? latest.startedAt}`,
        checkedAt,
        latencyMs: null,
      });
    }

    // Scheduler: the lifecycle endpoint exists; flag the dev secret.
    checks.push({
      name: 'scheduler',
      status: this.env.jobSecret.startsWith('dev-only') ? 'degraded' : 'ok',
      detail: this.env.jobSecret.startsWith('dev-only')
        ? 'Lifecycle endpoint uses the development job secret'
        : 'Lifecycle endpoint is secured with a configured secret',
      checkedAt,
      latencyMs: null,
    });

    // Email: mock mode is never reported as a working delivery channel.
    checks.push({
      name: 'email',
      status: this.deps.email.isMockMode ? 'unconfigured' : 'ok',
      detail: this.deps.email.isMockMode
        ? 'Mock transport active: emails are simulated, not delivered'
        : 'SMTP transport configured',
      checkedAt,
      latencyMs: null,
    });

    return {
      generatedAt: checkedAt,
      version: `api@${process.env.npm_package_version ?? '1.0.0'} node ${process.version}`,
      uptimeSeconds: Math.round(process.uptime()),
      checks,
    };
  }

  // -- audit ---------------------------------------------------------------

  async auditLog(
    adminId: string,
    query: { outlet?: 'SECURITY' | 'ADMIN' | 'ALL'; action?: string; adminId?: string; limit?: number; offset?: number } = {},
  ): Promise<{ entries: AdminAuditEntry[]; total: number; limit: number; offset: number }> {
    await this.requireAdmin(adminId);
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    const page = await this.db.adminAudit.list({
      outlet: query.outlet ?? 'ALL',
      action: query.action,
      adminId: query.adminId,
      limit,
      offset,
    });
    return {
      entries: await this.auditNames(page.entries),
      total: page.total,
      limit,
      offset,
    };
  }

  // -- analytics -----------------------------------------------------------

  private bucketize(dates: string[], days: number): AdminAnalyticsBucket[] {
    const buckets = new Map<string, number>();
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400_000);
      buckets.set(d.toISOString().slice(0, 10), 0);
    }
    for (const iso of dates) {
      const key = iso.slice(0, 10);
      if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return [...buckets.entries()].map(([date, count]) => ({ date, count }));
  }

  /**
   * Time-series analytics over persisted records. Only metrics this deployment
   * can actually derive are returned; anything else is named in `unavailable`
   * instead of being invented.
   */
  async analytics(adminId: string, days = 14): Promise<AdminAnalytics> {
    await this.requireAdmin(adminId);
    const window = Math.min(Math.max(days, 1), 90);
    const since = Date.now() - window * 86400_000;
    const inWindow = (iso: string | null | undefined): iso is string =>
      !!iso && Date.parse(iso) >= since;

    const profiles = await this.db.auth.all();
    const spaces = await this.db.spaces.list();
    const archives = await this.db.archives.listAll();
    const jobs = await this.db.jobs.list(500);
    const extensions = await this.db.extensionRequests.listAll();
    const emails = await this.db.emailJobs.listAll(1000);

    const registrations = this.bucketize(
      profiles.map((p) => p.createdAt).filter(inWindow),
      window,
    );
    const spacesCreated = this.bucketize(
      spaces.map((s) => s.createdAt).filter(inWindow),
      window,
    );
    const archivesCompleted = this.bucketize(
      archives
        .filter((a) => a.status === 'VERIFIED')
        .map((a) => a.verifiedAt ?? a.createdAt)
        .filter(inWindow),
      window,
    );
    const archivesFailed = this.bucketize(
      archives.filter((a) => a.status === 'FAILED').map((a) => a.createdAt).filter(inWindow),
      window,
    );
    const jobsSucceeded = this.bucketize(
      jobs
        .filter((j) => j.status === 'SUCCEEDED')
        .map((j) => j.finishedAt ?? j.startedAt)
        .filter(inWindow),
      window,
    );
    const jobsFailed = this.bucketize(
      jobs
        .filter((j) => j.status === 'FAILED')
        .map((j) => j.finishedAt ?? j.startedAt)
        .filter(inWindow),
      window,
    );
    const extensionsApproved = this.bucketize(
      extensions
        .filter((r) => r.status === 'APPROVED')
        .map((r) => r.decidedAt ?? r.createdAt)
        .filter(inWindow),
      window,
    );
    const extensionsRejected = this.bucketize(
      extensions
        .filter((r) => r.status === 'REJECTED')
        .map((r) => r.decidedAt ?? r.createdAt)
        .filter(inWindow),
      window,
    );
    const emailsSent = this.bucketize(
      emails
        .filter((e) => e.status === 'SENT')
        .map((e) => e.deliveredAt ?? e.createdAt)
        .filter(inWindow),
      window,
    );
    const emailsFailed = this.bucketize(
      emails.filter((e) => e.status === 'FAILED').map((e) => e.createdAt).filter(inWindow),
      window,
    );

    const sum = (b: AdminAnalyticsBucket[]): number => b.reduce((s, x) => s + x.count, 0);

    return {
      generatedAt: new Date().toISOString(),
      days: window,
      registrations,
      spacesCreated,
      archivesCompleted,
      archivesFailed,
      jobsSucceeded,
      jobsFailed,
      extensionsApproved,
      extensionsRejected,
      emailsSent,
      emailsFailed,
      totals: {
        registrations: sum(registrations),
        spacesCreated: sum(spacesCreated),
        archivesCompleted: sum(archivesCompleted),
        archivesFailed: sum(archivesFailed),
        jobsSucceeded: sum(jobsSucceeded),
        jobsFailed: sum(jobsFailed),
        extensionsApproved: sum(extensionsApproved),
        extensionsRejected: sum(extensionsRejected),
        emailsSent: sum(emailsSent),
        emailsFailed: sum(emailsFailed),
      },
      // We do not persist historical storage snapshots, so a storage-growth
      // trend cannot be computed from real data.
      unavailable: ['storageGrowth'],
    };
  }
}
