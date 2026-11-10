import type { AdminStats, Archive, ExtensionRequest, LifecycleJob, Profile } from '@flashspace/shared';
import { AppError } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { DataLayer } from '../repositories/data-layer.interface.js';

/** Admin console backend (PRD §12): live stats + operational retries. */
export class AdminService {
  constructor(
    private readonly env: Env,
    private readonly db: DataLayer,
    private readonly archive: { runArchive(archiveId: string): Promise<Archive> },
  ) {}

  private requireAdmin(userId: string): Profile {
    const profile = this.db.auth.findById(userId);
    if (!profile || profile.role !== 'ADMIN') {
      throw new AppError('ADMIN_REQUIRED', 'Admin access required');
    }
    return profile;
  }

  /**
   * Everything the admin dashboard shows, computed from the database at call
   * time: user/space counts, the warning window, pending tickets, the archival
   * pipeline success rate and live storage totals.
   */
  stats(userId: string): AdminStats {
    this.requireAdmin(userId);
    const now = Date.now();
    const warningCutoff = now + this.env.warningWindowHours * 3600 * 1000;

    const spaces = this.db.spaces.list();
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

    const pendingExtensions = this.db.extensionRequests
      .listAll()
      .filter((r) => r.status === 'PENDING').length;
    const pendingJoinRequests = this.db.joinRequests.listAll().filter((r) => r.status === 'PENDING').length;

    const archives = this.db.archives.listAll();
    const verifiedArchives = archives.filter((a) => a.status === 'VERIFIED').length;
    const failedArchives = archives.filter((a) => a.status === 'FAILED').length;
    const archivedBytes = archives
      .filter((a) => a.status === 'VERIFIED')
      .reduce((sum, a) => sum + a.sizeBytes, 0);
    const archivalPipeline = archives.length
      ? Math.round((verifiedArchives / archives.length) * 1000) / 10
      : 100;

    const files = this.db.files.listAll();
    const totalStorageBytes = files
      .filter((f) => f.status !== 'DELETED')
      .reduce((sum, f) => sum + f.sizeBytes, 0);

    const jobs = this.db.jobs.list(200);
    const jobsByStatus = jobs.reduce<Record<string, number>>((acc, j) => {
      acc[j.status] = (acc[j.status] ?? 0) + 1;
      return acc;
    }, {});

    return {
      users: this.db.auth.count(),
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
      recentJobs: this.db.jobs.list(10),
    };
  }

  listUsers(userId: string): Profile[] {
    this.requireAdmin(userId);
    return this.db.auth.all();
  }

  promoteToAdmin(actorId: string, targetUserId: string): Profile {
    this.requireAdmin(actorId);
    const profile = this.db.auth.findById(targetUserId);
    if (!profile) throw new AppError('NOT_FOUND', 'User not found');
    this.db.auth.promoteToAdmin(targetUserId);
    return this.db.auth.findById(targetUserId)!;
  }

  retryArchive(actorId: string, archiveId: string): Promise<Archive> {
    this.requireAdmin(actorId);
    const archive = this.db.archives.findById(archiveId);
    if (!archive) throw new AppError('ARCHIVE_NOT_FOUND', 'Archive not found');
    if (archive.status !== 'FAILED') {
      throw new AppError('IDEMPOTENT_NOOP', 'Only failed archives can be retried');
    }
    this.db.archives.update(archiveId, { status: 'PENDING' });
    this.db.spaces.update(archive.spaceId, { status: 'ARCHIVING' });
    return this.archive.runArchive(archiveId);
  }

  listJobs(userId: string): LifecycleJob[] {
    this.requireAdmin(userId);
    return this.db.jobs.list(100);
  }

  listExtensions(userId: string): ExtensionRequest[] {
    this.requireAdmin(userId);
    return this.db.extensionRequests.listAll();
  }
}
