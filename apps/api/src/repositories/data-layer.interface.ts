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
  ActivityLog,
  Archive,
  ArchiveStatus,
  CleanupRun,
  ExtensionRequest,
  FileRecord,
  Folder,
  JoinRequest,
  JobType,
  LifecycleJob,
  MemberRole,
  Notification,
  Profile,
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

export interface AuthRepo {
  create(profile: Profile, passwordHash: string): Awaitable<Profile>;
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
}

export interface InvitationsRepo {
  insert(inv: SpaceInvitation): Awaitable<SpaceInvitation>;
  findById(id: string): Awaitable<SpaceInvitation | undefined>;
  listForSpace(spaceId: string): Awaitable<SpaceInvitation[]>;
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
  /** Closes a run opened at the start of cleanup with its final counts/status. */
  update(id: string, patch: Partial<CleanupRun>): Awaitable<CleanupRun | undefined>;
}

export interface ActivityRepo {
  append(log: Omit<ActivityLog, 'id' | 'createdAt'>): Awaitable<ActivityLog>;
  listForSpace(spaceId: string, limit?: number): Awaitable<ActivityLog[]>;
  listAll(limit?: number): Awaitable<ActivityLog[]>;
}

/** In-process fan-out used to push notifications to connected clients. */
export interface NotificationBusLike {
  subscribe(userId: string, fn: (n: Notification) => void): () => void;
  publish(userId: string, notification: Notification): void;
}

// ---- Storage-insights repos (PRD §4) ----

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
  insert(row: DuplicateFileRow): Awaitable<DuplicateFileRow>;
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
  update(id: string, patch: Partial<ArchiveJobRow>): Awaitable<ArchiveJobRow | undefined>;
}

export interface DataLayer {
  auth: AuthRepo;
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
  notificationBus: NotificationBusLike;
  // storage-insights
  scanJobs: ScanJobsRepo;
  duplicateGroups: DuplicateGroupsRepo;
  duplicateFiles: DuplicateFilesRepo;
  archivePlans: ArchivePlansRepo;
  archiveJobs: ArchiveJobsRepo;
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
