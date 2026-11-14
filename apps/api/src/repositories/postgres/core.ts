/**
 * Core PostgreSQL repositories (Phase 3B).
 *
 * This is a deliberately partial composition: `DataLayer` declares 26 repos,
 * and every one of the twenty-six repository domains is now implemented (profile
 * methods live in `AuthRepo`, which is how SQLite/memory model profiles too).
 * The full `DataLayer` still needs a notification bus and health check, and the
 * factory below is intentionally not switched to PostgreSQL yet. Exposing
 * a partial object through `createDataLayer` would either lie to callers or
 * crash on the first folder/file/membership call, so the factory remains
 * untouched until every repository exists.
 */
import type { Pool } from 'pg';
import type { Env } from '../../config/env.js';
import type {
  ActivityRepo,
  AdminAuditRepo,
  ArchiveJobsRepo,
  ArchivePlansRepo,
  ArchivesRepo,
  AuthRepo,
  CleanupRunsRepo,
  DuplicateFilesRepo,
  DuplicateGroupsRepo,
  EmailJobsRepo,
  ExtensionRequestsRepo,
  FavoriteSpacesRepo,
  FilesRepo,
  FoldersRepo,
  InvitationsRepo,
  InviteLinksRepo,
  JobsRepo,
  JoinRequestsRepo,
  LifecycleTransitionsRepo,
  MembersRepo,
  NotificationsRepo,
  ScanJobsRepo,
  SessionsRepo,
  SpaceAccessRepo,
  SpacesRepo,
  VerificationTokensRepo,
} from '../data-layer.interface.js';
import { getSharedPostgresPool, postgresSettingsFromEnv } from './pool.js';
import { PostgresAuthRepo } from './repositories/auth.repo.js';
import { PostgresSessionsRepo } from './repositories/sessions.repo.js';
import { PostgresSpacesRepo } from './repositories/spaces.repo.js';
import { PostgresMembersRepo } from './repositories/members.repo.js';
import { PostgresSpaceAccessRepo } from './repositories/access.repo.js';
import { PostgresFoldersRepo } from './repositories/folders.repo.js';
import { PostgresFilesRepo } from './repositories/files.repo.js';
import { PostgresInvitationsRepo } from './repositories/invitations.repo.js';
import { PostgresInviteLinksRepo } from './repositories/invite-links.repo.js';
import { PostgresJoinRequestsRepo } from './repositories/join-requests.repo.js';
import { PostgresExtensionRequestsRepo } from './repositories/extension-requests.repo.js';
import { PostgresNotificationsRepo } from './repositories/notifications.repo.js';
import { PostgresActivityRepo } from './repositories/activity.repo.js';
import { PostgresArchivesRepo } from './repositories/archives.repo.js';
import { PostgresJobsRepo } from './repositories/jobs.repo.js';
import { PostgresCleanupRunsRepo } from './repositories/cleanup-runs.repo.js';
import { PostgresFavoriteSpacesRepo } from './repositories/favorite-spaces.repo.js';
import { PostgresLifecycleTransitionsRepo } from './repositories/lifecycle-transitions.repo.js';
import { PostgresScanJobsRepo } from './repositories/scan-jobs.repo.js';
import { PostgresDuplicateGroupsRepo } from './repositories/duplicate-groups.repo.js';
import { PostgresDuplicateFilesRepo } from './repositories/duplicate-files.repo.js';
import { PostgresArchivePlansRepo } from './repositories/archive-plans.repo.js';
import { PostgresArchiveJobsRepo } from './repositories/archive-jobs.repo.js';
import { PostgresEmailJobsRepo } from './repositories/email-jobs.repo.js';
import { PostgresVerificationTokensRepo } from './repositories/verification-tokens.repo.js';
import { PostgresAdminAuditRepo } from './repositories/admin-audit.repo.js';

export interface PostgresCoreRepositories {
  auth: AuthRepo;
  sessions: SessionsRepo;
  spaces: SpacesRepo;
  members: MembersRepo;
  access: SpaceAccessRepo;
  folders: FoldersRepo;
  files: FilesRepo;
  invitations: InvitationsRepo;
  inviteLinks: InviteLinksRepo;
  joinRequests: JoinRequestsRepo;
  extensionRequests: ExtensionRequestsRepo;
  notifications: NotificationsRepo;
  activity: ActivityRepo;
  archives: ArchivesRepo;
  jobs: JobsRepo;
  cleanupRuns: CleanupRunsRepo;
  favoriteSpaces: FavoriteSpacesRepo;
  lifecycleTransitions: LifecycleTransitionsRepo;
  scanJobs: ScanJobsRepo;
  duplicateGroups: DuplicateGroupsRepo;
  duplicateFiles: DuplicateFilesRepo;
  archivePlans: ArchivePlansRepo;
  archiveJobs: ArchiveJobsRepo;
  emailJobs: EmailJobsRepo;
  verificationTokens: VerificationTokensRepo;
  adminAudit: AdminAuditRepo;
}

/**
 * Build the core repositories. Pass an explicit pool in tests; application code
 * uses the process-wide shared pool so health checks and repositories cannot
 * open separate pools to the same database.
 */
export function createPostgresCoreRepositories(
  env: Env,
  pool: Pool | null = getSharedPostgresPool(env),
): PostgresCoreRepositories {
  if (!pool) {
    if (!postgresSettingsFromEnv(env)) {
      throw new Error('DATABASE_URL is required to create PostgreSQL repositories');
    }
    throw new Error('Could not create a PostgreSQL connection pool');
  }
  return {
    auth: new PostgresAuthRepo(pool),
    sessions: new PostgresSessionsRepo(pool),
    spaces: new PostgresSpacesRepo(pool),
    members: new PostgresMembersRepo(pool),
    access: new PostgresSpaceAccessRepo(pool),
    folders: new PostgresFoldersRepo(pool),
    files: new PostgresFilesRepo(pool),
    invitations: new PostgresInvitationsRepo(pool),
    inviteLinks: new PostgresInviteLinksRepo(pool),
    joinRequests: new PostgresJoinRequestsRepo(pool),
    extensionRequests: new PostgresExtensionRequestsRepo(pool),
    notifications: new PostgresNotificationsRepo(pool),
    activity: new PostgresActivityRepo(pool),
    archives: new PostgresArchivesRepo(pool),
    jobs: new PostgresJobsRepo(pool),
    cleanupRuns: new PostgresCleanupRunsRepo(pool),
    favoriteSpaces: new PostgresFavoriteSpacesRepo(pool),
    lifecycleTransitions: new PostgresLifecycleTransitionsRepo(pool),
    scanJobs: new PostgresScanJobsRepo(pool),
    duplicateGroups: new PostgresDuplicateGroupsRepo(pool),
    duplicateFiles: new PostgresDuplicateFilesRepo(pool),
    archivePlans: new PostgresArchivePlansRepo(pool),
    archiveJobs: new PostgresArchiveJobsRepo(pool),
    emailJobs: new PostgresEmailJobsRepo(pool),
    verificationTokens: new PostgresVerificationTokensRepo(pool),
    adminAudit: new PostgresAdminAuditRepo(pool),
  };
}
