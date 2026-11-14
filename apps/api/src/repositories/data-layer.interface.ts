/**
 * Persistence contract for the whole API. Every repository the services use is
 * declared here, so the backing store (in-memory for tests, SQLite for a real
 * local database, Postgres in the cloud) can be swapped without touching
 * domain logic.
 *
 * Every method returns `Awaitable<T>`: the local backends answer
 * synchronously (SQLite is a blocking file read), while PostgreSQL is
 * inherently asynchronous. Callers always `await`, which accepts both a value
 * and a Promise, so one service implementation works against all three.
 */
import type {
  ActivityInput,
  ActivityLog,
  ActivityPage,
  ActivityQuery,
  Archive,
  ArchiveStatus,
  CleanupRun,
  ExtensionRequest,
  FileRecord,
  Folder,
  JoinRequest,
  JobType,
  LifecycleJob,
  LifecycleTransition,
  MemberRole,
  Notification,
  Profile,
  ProfileRole,
  Space,
  SpaceInvitation,
  SpaceInviteLink,
  SpaceMember,
} from '@flashspace/shared';

/** A value that a backend may return directly or behind a Promise. */
export type Awaitable<T> = T | Promise<T>;

export interface LocalAccount {
  profile: Profile;
  passwordHash: string;
}

/**
 * Server-side user directory query (Module 11). Filtering, sorting and paging
 * are pushed into the backend so the admin console never loads every profile.
 */
export interface UserQuery {
  /** Case-insensitive match on display name, email or id. */
  q?: string;
  role?: ProfileRole;
  status?: 'ACTIVE' | 'SUSPENDED';
  limit: number;
  offset: number;
  sort?: 'created-asc' | 'created-desc' | 'name-asc' | 'name-desc' | 'activity-desc';
}

export interface UserPage {
  users: Profile[];
  total: number;
}

export interface AuthRepo {
  create(profile: Profile, passwordHash: string): Awaitable<Profile>;
  /**
   * Insert a profile that has no local credentials (Supabase-managed identity).
   * Returns the existing row untouched when the id is already present, so the
   * identity mirror is idempotent and can never duplicate a profile.
   */
  ensureProfile(profile: Profile): Awaitable<Profile>;
  findById(id: string): Awaitable<Profile | undefined>;
  findByEmail(email: string): Awaitable<Profile | undefined>;
  getCredentials(id: string): Awaitable<LocalAccount | undefined>;
  update(
    id: string,
    patch: Partial<Pick<Profile, 'displayName' | 'avatarUrl'>>,
  ): Awaitable<Profile | undefined>;
  promoteToAdmin(id: string): Awaitable<void>;
  count(): Awaitable<number>;
  all(): Awaitable<Profile[]>;
  setPasswordHash(id: string, passwordHash: string): Awaitable<void>;
  /** Local auth: record that the email address was confirmed. */
  markEmailVerified(id: string, at: string): Awaitable<void>;
  /** Local auth: change the sign-in address after uniqueness is checked. */
  updateEmail(id: string, email: string): Awaitable<Profile | undefined>;
  /** Local auth: permanently remove the profile and its credentials. */
  delete(id: string): Awaitable<void>;
  /** Module 11: admin directory with server-side search, filter, sort, paging. */
  list(query: UserQuery): Awaitable<UserPage>;
  /** Module 11: global role change (USER ↔ ADMIN). */
  setRole(id: string, role: ProfileRole): Awaitable<Profile | undefined>;
  /** Module 11: suspend / reactivate an account without deleting data. */
  setStatus(
    id: string,
    patch: {
      status: Profile['status'];
      suspendedAt: string | null;
      suspendedBy: string | null;
      suspensionReason: string | null;
    },
  ): Awaitable<Profile | undefined>;
  /** Module 11: number of profiles holding the ADMIN role. */
  countAdmins(): Awaitable<number>;
  /** Module 11: last successful authentication, used for \"active users\" and sorting. */
  touchLastActive(id: string, at: string): Awaitable<void>;
}

export interface SpacesRepo {
  insert(space: Space): Awaitable<Space>;
  findById(id: string): Awaitable<Space | undefined>;
  update(id: string, patch: Partial<Space>): Awaitable<Space | undefined>;
  list(): Awaitable<Space[]>;
  listForUser(userId: string): Awaitable<Space[]>;
}

export interface MembersRepo {
  insert(member: SpaceMember): Awaitable<SpaceMember>;
  find(spaceId: string, userId: string): Awaitable<SpaceMember | undefined>;
  listForSpace(spaceId: string): Awaitable<SpaceMember[]>;
  listForUser(userId: string): Awaitable<SpaceMember[]>;
  update(
    spaceId: string,
    userId: string,
    patch: Partial<SpaceMember>,
  ): Awaitable<SpaceMember | undefined>;
  revokeAllForSpace(spaceId: string): Awaitable<number>;
  countByRole(spaceId: string, role: MemberRole): Awaitable<number>;
}

export interface FoldersRepo {
  insert(folder: Folder): Awaitable<Folder>;
  findById(id: string): Awaitable<Folder | undefined>;
  listForSpace(spaceId: string): Awaitable<Folder[]>;
  update(id: string, patch: Partial<Folder>): Awaitable<Folder | undefined>;
  delete(id: string): Awaitable<boolean>;
}

export interface InvitationsRepo {
  insert(inv: SpaceInvitation): Awaitable<SpaceInvitation>;
  findById(id: string): Awaitable<SpaceInvitation | undefined>;
  listForSpace(spaceId: string): Awaitable<SpaceInvitation[]>;
  listAll(): Awaitable<SpaceInvitation[]>;
  findBySpaceAndEmail(
    spaceId: string,
    email: string,
  ): Awaitable<SpaceInvitation | undefined>;
  update(id: string, patch: Partial<SpaceInvitation>): Awaitable<SpaceInvitation | undefined>;
}

export interface InviteLinksRepo {
  insert(link: SpaceInviteLink): Awaitable<SpaceInviteLink>;
  findById(id: string): Awaitable<SpaceInviteLink | undefined>;
  findByToken(token: string): Awaitable<SpaceInviteLink | undefined>;
  findActiveForSpace(spaceId: string): Awaitable<SpaceInviteLink | undefined>;
  listForSpace(spaceId: string): Awaitable<SpaceInviteLink[]>;
  update(id: string, patch: Partial<SpaceInviteLink>): Awaitable<SpaceInviteLink | undefined>;
}

export interface JoinRequestsRepo {
  insert(request: JoinRequest): Awaitable<JoinRequest>;
  findById(id: string): Awaitable<JoinRequest | undefined>;
  listForSpace(spaceId: string, status?: JoinRequest['status']): Awaitable<JoinRequest[]>;
  listForRequester(requesterId: string): Awaitable<JoinRequest[]>;
  findPendingForUser(
    spaceId: string,
    requesterId: string,
  ): Awaitable<JoinRequest | undefined>;
  findOpenForInvitation(invitationId: string): Awaitable<JoinRequest | undefined>;
  listAll(): Awaitable<JoinRequest[]>;
  update(id: string, patch: Partial<JoinRequest>): Awaitable<JoinRequest | undefined>;
}

export interface ExtensionRequestsRepo {
  insert(req: ExtensionRequest): Awaitable<ExtensionRequest>;
  findById(id: string): Awaitable<ExtensionRequest | undefined>;
  listForSpace(spaceId: string): Awaitable<ExtensionRequest[]>;
  listAll(): Awaitable<ExtensionRequest[]>;
  findPendingForSpace(spaceId: string): Awaitable<ExtensionRequest | undefined>;
  update(id: string, patch: Partial<ExtensionRequest>): Awaitable<ExtensionRequest | undefined>;
}

export interface FilesRepo {
  insert(file: FileRecord): Awaitable<FileRecord>;
  findById(id: string): Awaitable<FileRecord | undefined>;
  listForSpace(spaceId: string): Awaitable<FileRecord[]>;
  listAll(): Awaitable<FileRecord[]>;
  listActiveForSpace(spaceId: string): Awaitable<FileRecord[]>;
  findByObjectKey(objectKey: string): Awaitable<FileRecord | undefined>;
  update(id: string, patch: Partial<FileRecord>): Awaitable<FileRecord | undefined>;
  usedBytesForSpace(spaceId: string): Awaitable<number>;
}

export interface ArchivesRepo {
  insert(archive: Archive): Awaitable<Archive>;
  findById(id: string): Awaitable<Archive | undefined>;
  listForOwner(ownerId: string): Awaitable<Archive[]>;
  listByStatus(status: ArchiveStatus): Awaitable<Archive[]>;
  listForSpace(spaceId: string): Awaitable<Archive[]>;
  listAll(): Awaitable<Archive[]>;
  update(id: string, patch: Partial<Archive>): Awaitable<Archive | undefined>;
}

export interface NotificationsRepo {
  insert(n: Notification): Awaitable<Notification>;
  listForUser(userId: string): Awaitable<Notification[]>;
  findById(id: string): Awaitable<Notification | undefined>;
  markRead(id: string): Awaitable<Notification | undefined>;
  markAllRead(userId: string): Awaitable<number>;
}

/**
 * Last meaningful open of a Space by a user. Written only when a signed-in user
 * actually views a Space, never on render or list, so "recently accessed"
 * reflects real navigation instead of page loads.
 */
export interface SpaceAccess {
  spaceId: string;
  userId: string;
  lastAccessedAt: string;
}

export interface FavoriteSpace {
  userId: string;
  spaceId: string;
  createdAt: string;
}

/**
 * Per-user star on a Space. Kept in its own table (composite key) so starring
 * never touches ownership, membership or the Space row itself.
 */
export interface FavoriteSpacesRepo {
  add(userId: string, spaceId: string, at: string): Awaitable<void>;
  remove(userId: string, spaceId: string): Awaitable<boolean>;
  listForUser(userId: string): Awaitable<FavoriteSpace[]>;
}

export interface SpaceAccessRepo {
  /** Upserts the access timestamp for one user/Space pair. */
  touch(spaceId: string, userId: string, at: string): Awaitable<void>;
  /** Most recently accessed Spaces for a user, newest first. */
  listForUser(userId: string, limit?: number): Awaitable<SpaceAccess[]>;
}

export interface JobsRepo {
  insert(job: LifecycleJob): Awaitable<LifecycleJob>;
  findById(id: string): Awaitable<LifecycleJob | undefined>;
  findByIdempotencyKey(key: string): Awaitable<LifecycleJob | undefined>;
  claimNext(jobType: JobType): Awaitable<LifecycleJob | undefined>;
  update(id: string, patch: Partial<LifecycleJob>): Awaitable<LifecycleJob | undefined>;
  finish(id: string, patch: Partial<LifecycleJob>): Awaitable<LifecycleJob | undefined>;
  list(limit?: number): Awaitable<LifecycleJob[]>;
}

export interface CleanupRunsRepo {
  insert(run: CleanupRun): Awaitable<CleanupRun>;
  findById(id: string): Awaitable<CleanupRun | undefined>;
  listForSpace(spaceId: string): Awaitable<CleanupRun[]>;
  /** All runs, newest first, for the admin cleanup monitor. */
  listAll(limit?: number): Awaitable<CleanupRun[]>;
  /** Closes a run opened at the start of cleanup with its final counts/status. */
  update(id: string, patch: Partial<CleanupRun>): Awaitable<CleanupRun | undefined>;
}

export interface ActivityRepo {
  /**
   * Append an event. `eventKey` makes the write idempotent: an existing row with
   * the same key is returned instead of a duplicate being created.
   */
  append(log: ActivityInput): Awaitable<ActivityLog>;
  findById(id: number): Awaitable<ActivityLog | undefined>;
  listForSpace(spaceId: string, limit?: number): Awaitable<ActivityLog[]>;
  listForUser(userId: string, limit?: number): Awaitable<ActivityLog[]>;
  listAll(limit?: number): Awaitable<ActivityLog[]>;
  /** Filtered, paginated read. Authorisation scope is resolved by the caller. */
  query(query: ActivityQuery): Awaitable<ActivityPage>;
}

/** In-process fan-out used to push notifications to connected clients. */
export interface NotificationBusLike {
  subscribe(userId: string, fn: (n: Notification) => void): () => void;
  publish(userId: string, notification: Notification): void;
}

// ---- Email delivery tracking (Module 9) ----

export interface EmailJobsRepo {
  insert(job: EmailJobRow): Awaitable<EmailJobRow>;
  findById(id: string): Awaitable<EmailJobRow | undefined>;
  findByEntity(entityType: string, entityId: string): Awaitable<EmailJobRow | undefined>;
  listFailed(limit?: number): Awaitable<EmailJobRow[]>;
  listPending(limit?: number): Awaitable<EmailJobRow[]>;
  listAll(limit?: number): Awaitable<EmailJobRow[]>;
  update(id: string, patch: Partial<EmailJobRow>): Awaitable<EmailJobRow | undefined>;
}

// ---- Lifecycle transitions (Module 6/8) ----

export interface LifecycleTransitionsRepo {
  insert(t: LifecycleTransition): Awaitable<LifecycleTransition>;
  listForSpace(spaceId: string, limit?: number): Awaitable<LifecycleTransition[]>;
}

// ---- Storage-insights repos ----

export interface ScanJobsRepo {
  insert(job: ScanJobRow): Awaitable<ScanJobRow>;
  findById(id: string): Awaitable<ScanJobRow | undefined>;
  listForSpace(spaceId: string): Awaitable<ScanJobRow[]>;
  update(id: string, patch: Partial<ScanJobRow>): Awaitable<ScanJobRow | undefined>;
}

export interface DuplicateGroupsRepo {
  insert(group: DuplicateGroupRow): Awaitable<DuplicateGroupRow>;
  findById(id: string): Awaitable<DuplicateGroupRow | undefined>;
  listForScan(scanId: string): Awaitable<DuplicateGroupRow[]>;
  deleteForScan(scanId: string): Awaitable<void>;
}

export interface DuplicateFilesRepo {
  insert(file: DuplicateFileRow): Awaitable<DuplicateFileRow>;
  findById(id: string): Awaitable<DuplicateFileRow | undefined>;
  listForGroup(groupId: string): Awaitable<DuplicateFileRow[]>;
  listAll(): Awaitable<DuplicateFileRow[]>;
  deleteForGroup(groupId: string): Awaitable<void>;
  deleteForScan(scanId: string): Awaitable<void>;
}

export interface ArchivePlansRepo {
  insert(plan: ArchivePlanRow): Awaitable<ArchivePlanRow>;
  findById(id: string): Awaitable<ArchivePlanRow | undefined>;
  listForSpace(spaceId: string): Awaitable<ArchivePlanRow[]>;
  update(id: string, patch: Partial<ArchivePlanRow>): Awaitable<ArchivePlanRow | undefined>;
  deleteForSpace(spaceId: string): Awaitable<void>;
}

export interface ArchiveJobsRepo {
  insert(job: ArchiveJobRow): Awaitable<ArchiveJobRow>;
  findById(id: string): Awaitable<ArchiveJobRow | undefined>;
  findByPlanId(planId: string): Awaitable<ArchiveJobRow | undefined>;
  findByIdempotencyKey(key: string): Awaitable<ArchiveJobRow | undefined>;
  findByEntity(entityType: string, entityId: string): Awaitable<ArchiveJobRow | undefined>;
  update(id: string, patch: Partial<ArchiveJobRow>): Awaitable<ArchiveJobRow | undefined>;
}

export interface VerificationTokensRepo {
  insert(row: HashedTokenRow): Awaitable<HashedTokenRow>;
  findByPurposeAndUserId(purpose: string, userId: string): Awaitable<HashedTokenRow | undefined>;
  findByTokenHash(tokenHash: string, purpose: string): Awaitable<HashedTokenRow | undefined>;
  markUsed(id: string): Awaitable<HashedTokenRow | undefined>;
  destroy(id: string): Awaitable<boolean>;
}

// ---- Admin audit trail (Module 11) ----

/** One append-only administrative action record. */
export interface AdminAuditRow {
  id: string;
  adminId: string;
  /** e.g. USER_ROLE_CHANGED, ACCOUNT_SUSPENDED, ARCHIVE_RETRIED, LOGIN_FAILED. */
  action: string;
  targetType: string;
  targetId: string;
  outcome: 'SUCCESS' | 'FAILURE';
  reason: string | null;
  /** Safe before/after snapshot; never contains credentials or tokens. */
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AdminAuditQuery {
  action?: string;
  adminId?: string;
  outlet?: 'SECURITY' | 'ADMIN' | 'ALL';
  limit: number;
  offset: number;
}

export interface AdminAuditRepo {
  append(entry: Omit<AdminAuditRow, 'id' | 'createdAt'>): Awaitable<AdminAuditRow>;
  list(query: AdminAuditQuery): Awaitable<{ entries: AdminAuditRow[]; total: number }>;
}

export interface AuthSession {
  id: string;
  userId: string;
  refreshTokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string;
  userAgent: string | null;
  ip: string | null;
}

export interface SessionsRepo {
  insert(session: AuthSession): Awaitable<AuthSession>;
  findById(id: string): Awaitable<AuthSession | undefined>;
  findByRefreshHash(hash: string): Awaitable<AuthSession | undefined>;
  update(id: string, patch: Partial<AuthSession>): Awaitable<AuthSession | undefined>;
  listForUser(userId: string): Awaitable<AuthSession[]>;
  /** Revoke every live session, optionally keeping the caller's current one. */
  revokeAllForUser(userId: string, at: string, exceptId?: string): Awaitable<number>;
}

export interface DataLayer {
  auth: AuthRepo;
  sessions: SessionsRepo;
  spaces: SpacesRepo;
  members: MembersRepo;
  folders: FoldersRepo;
  invitations: InvitationsRepo;
  inviteLinks: InviteLinksRepo;
  joinRequests: JoinRequestsRepo;
  extensionRequests: ExtensionRequestsRepo;
  files: FilesRepo;
  archives: ArchivesRepo;
  notifications: NotificationsRepo;
  jobs: JobsRepo;
  cleanupRuns: CleanupRunsRepo;
  activity: ActivityRepo;
  access: SpaceAccessRepo;
  favoriteSpaces: FavoriteSpacesRepo;
  notificationBus: NotificationBusLike;
  lifecycleTransitions: LifecycleTransitionsRepo;
  // storage-insights
  scanJobs: ScanJobsRepo;
  duplicateGroups: DuplicateGroupsRepo;
  duplicateFiles: DuplicateFilesRepo;
  archivePlans: ArchivePlansRepo;
  archiveJobs: ArchiveJobsRepo;
  // Module 9: email delivery tracking
  emailJobs: EmailJobsRepo;
  verificationTokens: VerificationTokensRepo;
  // Module 11: administrative audit trail
  adminAudit: AdminAuditRepo;
  /**
   * Cheapest possible round-trip to the backing store, used by GET /ready.
   * Local backends resolve immediately.
   */
  healthCheck(): Awaitable<void>;
}

// ---- Row types for the storage-insights tables ----

export interface ScanJobRow {
  id: string;
  spaceId: string;
  ownerId: string;
  status: string;
  totalFiles: number;
  totalBytes: number;
  duplicateGroups: number;
  duplicateFileCount: number;
  extraCopyCount: number;
  potentialSavingsBytes: number;
  largeFileCount: number;
  nearDuplicateGroupCount: number;
  scannedAt: string | null;
  failedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DuplicateGroupRow {
  id: string;
  scanId: string;
  contentHash: string;
  fileCount: number;
  extraCopyCount: number;
  totalBytes: number;
  potentialSavingsBytes: number;
  representativeName: string;
}

export interface DuplicateFileRow {
  id: string;
  groupId: string;
  scanId: string;
  fileId: string;
  name: string;
  objectKey: string;
  sizeBytes: number;
  mimeType: string;
  uploadedAt: string;
  uploaderId: string;
  excluded: boolean;
}

export interface ArchivePlanRow {
  id: string;
  spaceId: string;
  ownerId: string;
  scanId: string | null;
  status: string;
  excludedFileIds: string[];
  willArchiveFileCount: number;
  willArchiveBytes: number;
  willExcludeFileCount: number;
  willExcludeBytes: number;
  potentialSavingsBytes: number;
  explained: boolean;
  confirmedAt: string | null;
  archiveJobId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArchiveJobRow {
  id: string;
  planId: string;
  spaceId: string;
  ownerId: string;
  idempotencyKey: string;
  status: string;
  attempts: number;
  archiveId: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

// ---- Email delivery tracking rows (Module 9) ----

export interface EmailJobRow {
  id: string;
  category: string;
  template: string;
  to: string;
  subject: string;
  entityId: string;
  entityType: string;
  status: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  error: string | null;
  idempotencyKey: string | null | undefined;
}

// ---- Verification token rows (Module 9) ----

export interface HashedTokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  purpose: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}
