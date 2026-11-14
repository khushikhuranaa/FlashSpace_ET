/**
 * Composite data layer for memory mode: bundles every repository instance
 * behind the shared DataLayer contract so services and routes stay
 * mode-agnostic (memory for tests, SQLite or Postgres for real persistence).
 */
import type { DataLayer } from '../data-layer.interface.js';
import { MemoryAuthRepo } from './auth.repo.js';
import { MemorySessionsRepo } from './sessions.repo.js';
import {
  MemorySpacesRepo,
  MemoryMembersRepo,
  MemoryFoldersRepo,
  MemoryInvitationsRepo,
  MemoryExtensionRequestsRepo,
} from './spaces.repo.js';
import { MemoryInviteLinksRepo, MemoryJoinRequestsRepo } from './membership.repo.js';
import { MemorySpaceAccessRepo } from './access.repo.js';
import { MemoryFavoriteSpacesRepo } from './favorites.repo.js';
import { MemoryFilesRepo, MemoryArchivesRepo, MemoryNotificationsRepo } from './files.repo.js';
import {
  MemoryJobsRepo,
  MemoryCleanupRunsRepo,
  MemoryActivityRepo,
  NotificationBus,
} from './jobs.repo.js';
import { MemoryLifecycleTransitionsRepo } from './lifecycle-transitions.repo.js';
import { MemoryAdminAuditRepo } from './admin-audit.repo.js';
import { MemoryEmailJobsRepo, MemoryVerificationTokensRepo } from './email.repo.js';
import {
  MemoryScanJobsRepo,
  MemoryDuplicateGroupsRepo,
  MemoryDuplicateFilesRepo,
  MemoryArchivePlansRepo,
  MemoryArchiveJobsRepo,
} from './insights.repo.js';

export class MemoryDataLayer implements DataLayer {
  readonly auth = new MemoryAuthRepo();
  readonly sessions = new MemorySessionsRepo();
  readonly spaces = new MemorySpacesRepo();
  readonly members = new MemoryMembersRepo();
  readonly folders = new MemoryFoldersRepo();
  readonly invitations = new MemoryInvitationsRepo();
  readonly inviteLinks = new MemoryInviteLinksRepo();
  readonly joinRequests = new MemoryJoinRequestsRepo();
  readonly extensionRequests = new MemoryExtensionRequestsRepo();
  readonly files = new MemoryFilesRepo();
  readonly archives = new MemoryArchivesRepo();
  readonly notifications = new MemoryNotificationsRepo();
  readonly jobs = new MemoryJobsRepo();
  readonly cleanupRuns = new MemoryCleanupRunsRepo();
  readonly lifecycleTransitions = new MemoryLifecycleTransitionsRepo();
  readonly activity = new MemoryActivityRepo();
  readonly access = new MemorySpaceAccessRepo();
  readonly favoriteSpaces = new MemoryFavoriteSpacesRepo();
  readonly scanJobs = new MemoryScanJobsRepo();
  readonly duplicateGroups = new MemoryDuplicateGroupsRepo();
  readonly duplicateFiles = new MemoryDuplicateFilesRepo();
  readonly archivePlans = new MemoryArchivePlansRepo();
  readonly archiveJobs = new MemoryArchiveJobsRepo();
  readonly adminAudit = new MemoryAdminAuditRepo();
  readonly emailJobs = new MemoryEmailJobsRepo();
  readonly verificationTokens = new MemoryVerificationTokensRepo();
  readonly notificationBus = new NotificationBus();

  /**
   * Local backends resolve immediately; the contract allows a Promise for the
   * PostgreSQL layer, which needs a real round-trip here.
   */
  healthCheck(): void {
    // Nothing to probe: the in-memory stores cannot be unreachable.
  }
}
