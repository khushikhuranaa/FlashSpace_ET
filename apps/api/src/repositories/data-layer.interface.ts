/**
 * Persistence contract for the whole API. Every repository the services use is
 * declared here, so the backing store (in-memory for tests, SQLite for a real
 * local database, Postgres in the cloud) can be swapped without touching
 * domain logic.
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

export interface LocalAccount {
  profile: Profile;
  passwordHash: string;
}

export interface AuthRepo {
  create(profile: Profile, passwordHash: string): Profile;
  findById(id: string): Profile | undefined;
  findByEmail(email: string): Profile | undefined;
  getCredentials(id: string): LocalAccount | undefined;
  update(id: string, patch: Partial<Pick<Profile, 'displayName' | 'avatarUrl'>>): Profile | undefined;
  promoteToAdmin(id: string): void;
  count(): number;
  all(): Profile[];
}

export interface SpacesRepo {
  insert(space: Space): Space;
  findById(id: string): Space | undefined;
  update(id: string, patch: Partial<Space>): Space | undefined;
  list(): Space[];
  listForUser(userId: string): Space[];
}

export interface MembersRepo {
  insert(member: SpaceMember): SpaceMember;
  find(spaceId: string, userId: string): SpaceMember | undefined;
  listForSpace(spaceId: string): SpaceMember[];
  listForUser(userId: string): SpaceMember[];
  update(spaceId: string, userId: string, patch: Partial<SpaceMember>): SpaceMember | undefined;
  revokeAllForSpace(spaceId: string): number;
  countByRole(spaceId: string, role: MemberRole): number;
}

export interface FoldersRepo {
  insert(folder: Folder): Folder;
  findById(id: string): Folder | undefined;
  listForSpace(spaceId: string): Folder[];
  update(id: string, patch: Partial<Folder>): Folder | undefined;
}

export interface InvitationsRepo {
  insert(inv: SpaceInvitation): SpaceInvitation;
  findById(id: string): SpaceInvitation | undefined;
  listForSpace(spaceId: string): SpaceInvitation[];
  findBySpaceAndEmail(spaceId: string, email: string): SpaceInvitation | undefined;
  update(id: string, patch: Partial<SpaceInvitation>): SpaceInvitation | undefined;
}

export interface InviteLinksRepo {
  insert(link: SpaceInviteLink): SpaceInviteLink;
  findById(id: string): SpaceInviteLink | undefined;
  findByToken(token: string): SpaceInviteLink | undefined;
  findActiveForSpace(spaceId: string): SpaceInviteLink | undefined;
  listForSpace(spaceId: string): SpaceInviteLink[];
  update(id: string, patch: Partial<SpaceInviteLink>): SpaceInviteLink | undefined;
}

export interface JoinRequestsRepo {
  insert(request: JoinRequest): JoinRequest;
  findById(id: string): JoinRequest | undefined;
  listForSpace(spaceId: string, status?: JoinRequest['status']): JoinRequest[];
  listForRequester(requesterId: string): JoinRequest[];
  findPendingForUser(spaceId: string, requesterId: string): JoinRequest | undefined;
  findOpenForInvitation(invitationId: string): JoinRequest | undefined;
  listAll(): JoinRequest[];
  update(id: string, patch: Partial<JoinRequest>): JoinRequest | undefined;
}

export interface ExtensionRequestsRepo {
  insert(req: ExtensionRequest): ExtensionRequest;
  findById(id: string): ExtensionRequest | undefined;
  listForSpace(spaceId: string): ExtensionRequest[];
  listAll(): ExtensionRequest[];
  findPendingForSpace(spaceId: string): ExtensionRequest | undefined;
  update(id: string, patch: Partial<ExtensionRequest>): ExtensionRequest | undefined;
}

export interface FilesRepo {
  insert(file: FileRecord): FileRecord;
  findById(id: string): FileRecord | undefined;
  listForSpace(spaceId: string): FileRecord[];
  listAll(): FileRecord[];
  listActiveForSpace(spaceId: string): FileRecord[];
  findByObjectKey(objectKey: string): FileRecord | undefined;
  update(id: string, patch: Partial<FileRecord>): FileRecord | undefined;
  usedBytesForSpace(spaceId: string): number;
}

export interface ArchivesRepo {
  insert(archive: Archive): Archive;
  findById(id: string): Archive | undefined;
  listForOwner(ownerId: string): Archive[];
  listByStatus(status: ArchiveStatus): Archive[];
  listForSpace(spaceId: string): Archive[];
  listAll(): Archive[];
  update(id: string, patch: Partial<Archive>): Archive | undefined;
}

export interface NotificationsRepo {
  insert(n: Notification): Notification;
  listForUser(userId: string): Notification[];
  findById(id: string): Notification | undefined;
  markRead(id: string): Notification | undefined;
  markAllRead(userId: string): number;
}

export interface JobsRepo {
  insert(job: LifecycleJob): LifecycleJob;
  findById(id: string): LifecycleJob | undefined;
  findByIdempotencyKey(key: string): LifecycleJob | undefined;
  claimNext(jobType: JobType): LifecycleJob | undefined;
  update(id: string, patch: Partial<LifecycleJob>): LifecycleJob | undefined;
  finish(id: string, patch: Partial<LifecycleJob>): LifecycleJob | undefined;
  list(limit?: number): LifecycleJob[];
}

export interface CleanupRunsRepo {
  insert(run: CleanupRun): CleanupRun;
  findById(id: string): CleanupRun | undefined;
  listForSpace(spaceId: string): CleanupRun[];
}

export interface ActivityRepo {
  append(log: Omit<ActivityLog, 'id' | 'createdAt'>): ActivityLog;
  listForSpace(spaceId: string, limit?: number): ActivityLog[];
  listAll(limit?: number): ActivityLog[];
}

/** In-process fan-out used to push notifications to connected clients. */
export interface NotificationBusLike {
  subscribe(userId: string, fn: (n: Notification) => void): () => void;
  publish(userId: string, notification: Notification): void;
}

// ---- Storage-insights repos (PRD §4) ----

export interface ScanJobsRepo {
  insert(job: ScanJobRow): ScanJobRow;
  findById(id: string): ScanJobRow | undefined;
  listForSpace(spaceId: string): ScanJobRow[];
  update(id: string, patch: Partial<ScanJobRow>): ScanJobRow | undefined;
}

export interface DuplicateGroupsRepo {
  insert(group: DuplicateGroupRow): DuplicateGroupRow;
  findById(id: string): DuplicateGroupRow | undefined;
  listForScan(scanId: string): DuplicateGroupRow[];
  deleteForScan(scanId: string): void;
}

export interface DuplicateFilesRepo {
  insert(row: DuplicateFileRow): DuplicateFileRow;
  findById(id: string): DuplicateFileRow | undefined;
  listForGroup(groupId: string): DuplicateFileRow[];
  listAll(): DuplicateFileRow[];
  deleteForGroup(groupId: string): void;
  deleteForScan(scanId: string): void;
}

export interface ArchivePlansRepo {
  insert(plan: ArchivePlanRow): ArchivePlanRow;
  findById(id: string): ArchivePlanRow | undefined;
  listForSpace(spaceId: string): ArchivePlanRow[];
  update(id: string, patch: Partial<ArchivePlanRow>): ArchivePlanRow | undefined;
  deleteForSpace(spaceId: string): void;
}

export interface ArchiveJobsRepo {
  insert(job: ArchiveJobRow): ArchiveJobRow;
  findById(id: string): ArchiveJobRow | undefined;
  findByPlanId(planId: string): ArchiveJobRow | undefined;
  findByIdempotencyKey(key: string): ArchiveJobRow | undefined;
  update(id: string, patch: Partial<ArchiveJobRow>): ArchiveJobRow | undefined;
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
