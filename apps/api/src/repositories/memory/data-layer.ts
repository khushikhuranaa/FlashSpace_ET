/**
 * Composite data layer for memory mode: bundles every repository instance
 * behind the shared DataLayer contract so services and routes stay
 * mode-agnostic (memory for tests, SQLite or Postgres for real persistence).
 */
import type { DataLayer } from '../data-layer.interface.js';
import { MemoryAuthRepo } from './auth.repo.js';
import {
  MemorySpacesRepo,
  MemoryMembersRepo,
  MemoryFoldersRepo,
  MemoryInvitationsRepo,
  MemoryExtensionRequestsRepo,
} from './spaces.repo.js';
import { MemoryInviteLinksRepo, MemoryJoinRequestsRepo } from './membership.repo.js';
import { MemoryFilesRepo, MemoryArchivesRepo, MemoryNotificationsRepo } from './files.repo.js';
import {
  MemoryJobsRepo,
  MemoryCleanupRunsRepo,
  MemoryActivityRepo,
  NotificationBus,
} from './jobs.repo.js';
import {
  MemoryScanJobsRepo,
  MemoryDuplicateGroupsRepo,
  MemoryDuplicateFilesRepo,
  MemoryArchivePlansRepo,
  MemoryArchiveJobsRepo,
} from './insights.repo.js';

export class MemoryDataLayer implements DataLayer {
  readonly auth = new MemoryAuthRepo();
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
  readonly activity = new MemoryActivityRepo();
  readonly scanJobs = new MemoryScanJobsRepo();
  readonly duplicateGroups = new MemoryDuplicateGroupsRepo();
  readonly duplicateFiles = new MemoryDuplicateFilesRepo();
  readonly archivePlans = new MemoryArchivePlansRepo();
  readonly archiveJobs = new MemoryArchiveJobsRepo();
  readonly notificationBus = new NotificationBus();
}
