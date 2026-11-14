/**
 * FlashSpace domain types — shared contract between API, web and jobs.
 * Keep these in sync with the database migrations.
 */

// ---------------------------------------------------------------------------
// Enums (string unions; runtime arrays live in ./constants)
// ---------------------------------------------------------------------------

export type SpaceStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'WARNING'
  | 'ARCHIVING'
  | 'ARCHIVED'
  | 'ARCHIVE_FAILED'
  | 'DELETED';

export type MemberRole = 'OWNER' | 'EDITOR' | 'VIEWER';
export type MemberStatus = 'ACTIVE' | 'INVITED' | 'REVOKED';
export type ProfileRole = 'USER' | 'ADMIN';
/** Module 11: administrative account state. Suspension never deletes data. */
export type AccountStatus = 'ACTIVE' | 'SUSPENDED';

export type FileStatus = 'PENDING' | 'ACTIVE' | 'DELETED';
export type ArchiveStatus = 'PENDING' | 'CREATING' | 'VERIFIED' | 'FAILED';
export type JobType = 'LIFECYCLE' | 'ARCHIVE' | 'CLEANUP';
export type JobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type CleanupStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL_FAILED' | 'FAILED';
export type ExtensionStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type NotificationType =
  | 'SPACE_CREATED'
  | 'SPACE_WARNING'
  | 'SPACE_ARCHIVED'
  | 'SPACE_DELETED'
  | 'MEMBER_INVITED'
  | 'MEMBER_ROLE_CHANGED'
  | 'EXTENSION_DECIDED'
  | 'ARCHIVE_FAILED'
  | 'JOIN_REQUEST'
  | 'JOIN_ACCEPTED'
  | 'JOIN_DECLINED'
  | 'SCAN_READY'
  | 'SCAN_FAILED'
  | 'PLAN_CREATED'
  | 'PLAN_CANCELLED'
  | 'ARCHIVE_PLAN_CONFIRMED'
  | 'ARCHIVE_PLAN_FAILED'
  | 'DUPLICATE_FILES_REMOVED'
  | 'REMINDER_SENT';
export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
export type JoinRequestStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN';
export type JoinRequestSource = 'LINK' | 'EMAIL';

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Profile {
  id: string;
  email: string;
  displayName: string;
  role: ProfileRole;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
  /** Module 11: administrative account state; absent means ACTIVE. */
  status?: AccountStatus;
  suspendedAt?: string | null;
  suspendedBy?: string | null;
  suspensionReason?: string | null;
  /** Module 11: last successful authentication (ISO), absent when never seen. */
  lastActiveAt?: string | null;
  /** Local auth: when the address was confirmed. Null when unverified. */
  emailVerifiedAt?: string | null;
}

export interface Space {
  id: string;
  ownerId: string;
  name: string;
  purpose: string;
  description: string;
  startAt: string;
  expiryAt: string;
  status: SpaceStatus;
  warningSentAt: string | null;
  /** True when the owner archived the Space early: it stays in the Vault and
   *  is excluded from the automatic retention cleanup. */
  archivedManually: boolean;
  /** Owner-controlled: when false, email invitations and invite links are closed. */
  invitationsEnabled: boolean;
  /** Role handed to people joining through an invite (never OWNER). */
  defaultInviteRole: MemberRole;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceMember {
  spaceId: string;
  userId: string;
  role: MemberRole;
  status: MemberStatus;
  joinedAt: string | null;
  revokedAt: string | null;
}

export interface SpaceInvitation {
  id: string;
  spaceId: string;
  inviterId: string;
  email: string;
  intendedRole: MemberRole;
  tokenHash: string | null;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
}

/** A shareable "anyone with this link can request to join" token per Space. */
export interface SpaceInviteLink {
  id: string;
  spaceId: string;
  createdBy: string;
  token: string;
  role: MemberRole;
  createdAt: string;
  revokedAt: string | null;
}

/**
 * A pending request to join a Space. Raised either by a logged-in user opening
 * an invite link (the owner decides) or by an email invitation (the invitee
 * decides). */
export interface JoinRequest {
  id: string;
  spaceId: string;
  requesterId: string;
  role: MemberRole;
  source: JoinRequestSource;
  invitationId: string | null;
  status: JoinRequestStatus;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface Folder {
  id: string;
  spaceId: string;
  parentId: string | null;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileRecord {
  id: string;
  spaceId: string;
  folderId: string | null;
  uploaderId: string;
  name: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  etag: string | null;
  /** Content hash of the stored object. Null until a storage scan hashes it. */
  sha256: string | null;
  status: FileStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Archive {
  id: string;
  spaceId: string;
  ownerId: string;
  objectKey: string;
  sizeBytes: number;
  /** SHA-256 of the stored ZIP; set once the archive is verified. */
  checksum: string | null;
  fileCount: number;
  status: ArchiveStatus;
  createdAt: string;
  verifiedAt: string | null;
}

export interface ExtensionRequest {
  id: string;
  spaceId: string;
  requesterId: string;
  requestedDays: number;
  reason: string;
  status: ExtensionStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  /** When the admin or automatic policy recorded why a request was rejected. */
  rejectionReason: string | null;
  /** Optional admin note attached at decision time. */
  adminNote: string | null;
  /** Expiry before this extension was applied (null until approved). */
  previousExpiryAt: string | null;
  /** Expiry after this extension was applied (null until approved). */
  newExpiryAt: string | null;
  /** How the decision was made: manual admin review or automatic policy. */
  approvalMethod: 'MANUAL' | 'AUTOMATIC' | null;
  createdAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  spaceId: string | null;
  type: NotificationType;
  title: string;
  body: string;
  /** Set when the notification carries an Accept/Decline action. */
  inviteLinkId: string | null;
  joinRequestId: string | null;
  readAt: string | null;
  createdAt: string;
}

/** Who caused an activity event (Module 12). Background workers are SYSTEM. */
export type ActivityActorType = 'USER' | 'ADMIN' | 'SYSTEM';

export type ActivityOutcome = 'SUCCESS' | 'FAILURE';

export type ActivityCategory =
  | 'SPACE'
  | 'FILE'
  | 'FOLDER'
  | 'MEMBERSHIP'
  | 'INVITATION'
  | 'EXTENSION'
  | 'ARCHIVE'
  | 'CLEANUP'
  | 'STORAGE'
  | 'ADMIN'
  | 'SECURITY'
  | 'OTHER';

export interface ActivityLog {
  id: number;
  userId: string | null;
  spaceId: string | null;
  fileId: string | null;
  action: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  actorType: ActivityActorType;
  outcome: ActivityOutcome;
  category: ActivityCategory;
  /** Safe reference to the affected resource (`space`, `file`, `user`, ...). */
  resourceType: string | null;
  resourceId: string | null;
  reason: string | null;
  /** Request/operation correlation id, when one exists. */
  correlationId: string | null;
  /** Idempotency key: an identical key is never recorded twice. */
  eventKey: string | null;
  /** Resolved at read time from the actor profile; never stored. */
  actorName?: string | null;
  actorEmail?: string | null;
}

/**
 * What a caller supplies when appending an activity record. Actor type,
 * outcome and category are inferred when omitted, so existing call sites did
 * not have to change; new call sites should pass them explicitly.
 */
export interface ActivityInput {
  userId?: string | null;
  spaceId?: string | null;
  fileId?: string | null;
  action: string;
  metadata?: Record<string, unknown>;
  actorType?: ActivityActorType;
  outcome?: ActivityOutcome;
  category?: ActivityCategory;
  resourceType?: string | null;
  resourceId?: string | null;
  reason?: string | null;
  correlationId?: string | null;
  eventKey?: string | null;
}

/** Server-side filters for activity reads (Module 12). */
export interface ActivityQuery {
  spaceId?: string;
  /** Authorisation scope: only these Spaces may be read (empty = none). */
  spaceIds?: string[];
  /** Actor filter (exact). */
  userId?: string;
  /** Actor filter resolved from a name/email search. */
  userIds?: string[];
  actorType?: ActivityActorType;
  category?: ActivityCategory;
  action?: string;
  outcome?: ActivityOutcome;
  resourceType?: string;
  resourceId?: string;
  /** ISO timestamps, inclusive. */
  from?: string;
  to?: string;
  sort?: 'newest' | 'oldest';
  limit?: number;
  offset?: number;
}

export interface ActivityPage {
  entries: ActivityLog[];
  total: number;
  limit: number;
  offset: number;
}

export interface LifecycleJob {
  id: string;
  jobType: JobType;
  spaceId: string | null;
  idempotencyKey: string;
  status: JobStatus;
  attempts: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface CleanupRun {
  id: string;
  spaceId: string;
  archiveId: string;
  status: CleanupStatus;
  membershipsRevoked: number;
  objectsDeleted: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface LifecycleTransition {
  id: string;
  spaceId: string;
  actorId: string | null;
  previousStatus: SpaceStatus;
  newStatus: SpaceStatus;
  reason: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: ProfileRole;
  emailVerifiedAt?: string | null;
}

export interface SignedUpload {
  fileId: string;
  objectKey: string;
  url: string;
  expiresAt: string;
}

export interface SignedDownload {
  url: string;
  expiresAt: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

export interface MemberView extends SpaceMember {
  displayName: string;
  email: string;
}

/** Owner-facing row for an invitation that has not been accepted yet. */
export interface PendingInviteView {
  kind: 'LINK' | 'EMAIL';
  id: string;
  email: string | null;
  role: MemberRole;
  status: string;
  createdAt: string;
}

/** A join request enriched with requester + Space identity for the UI. */
export interface JoinRequestView extends JoinRequest {
  spaceName: string;
  requesterDisplayName: string;
  requesterEmail: string;
}

/** The Space a visitor sees after opening an invite link. */
export interface SpaceJoinPreview {
  spaceId: string;
  name: string;
  purpose: string;
  description: string;
  ownerDisplayName: string;
  memberCount: number;
  role: MemberRole;
  alreadyMember: boolean;
  hasPendingRequest: boolean;
}

/** Members payload: roster + owner-only moderation queues + the invite link. */
export interface MembersPayload {
  members: MemberView[];
  pending: PendingInviteView[];
  joinRequests: JoinRequestView[];
  inviteLink: { url: string; role: MemberRole; createdAt: string } | null;
}

/** Real storage accounting for the current user (drives the usage graph). */
export interface StorageSummary {
  quotaBytes: number;
  usedBytes: number;
  archivedBytes: number;
  freeBytes: number;
  spaceCount: number;
  archivedSpaceCount: number;
  spaces: {
    spaceId: string;
    name: string;
    status: SpaceStatus;
    usedBytes: number;
    archivedBytes: number;
    archivedManually: boolean;
    owned: boolean;
  }[];
}

/** Admin console aggregates, all computed from live application data. */
export interface AdminStats {
  users: number;
  spaces: number;
  activeSpaces: number;
  warningWindow: number;
  archivedSpaces: number;
  pendingTickets: number;
  pendingExtensions: number;
  pendingJoinRequests: number;
  /** Share of archives that verified successfully, 0-100. */
  archivalPipeline: number;
  verifiedArchives: number;
  failedArchives: number;
  totalFiles: number;
  totalStorageBytes: number;
  archivedBytes: number;
  spacesByStatus: Record<string, number>;
  jobsByStatus: Record<string, number>;
  recentJobs: LifecycleJob[];
}

export interface SpaceDetail extends Space {
  role: MemberRole | null;
  members: MemberView[];
  storageUsedBytes: number;
  /** Per-user star, resolved from space_favorites (never stored on the Space). */
  favorite: boolean;
  ownerName: string | null;
  /** Last time this viewer opened the Space, from space_access. */
  lastAccessedAt: string | null;
}

export interface LifecycleJobResult {
  jobId: string;
  scanned: number;
  warned: number;
  queuedArchives: number;
  archived: number;
  finalized: number;
  failures: string[];
}

// ---------------------------------------------------------------------------
// Module 2 — dashboard + global search payloads
// ---------------------------------------------------------------------------

/** Headline counters shown on the dashboard. */
export interface DashboardCounts {
  /** Every Space the user owns or is an active member of (archived included). */
  total: number;
  /** Spaces in the ACTIVE lifecycle state. */
  active: number;
  /** Spaces inside the configured warning window (same rule the lifecycle uses). */
  expiring: number;
  archived: number;
}

export interface DashboardActivityItem {
  id: number;
  action: string;
  createdAt: string;
  spaceId: string | null;
  spaceName: string | null;
  actorName: string | null;
  fileId: string | null;
}

export interface DashboardFileItem {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  spaceId: string;
  spaceName: string;
  uploaderName: string | null;
}

export interface DashboardSpaceItem {
  id: string;
  name: string;
  purpose: string;
  status: SpaceStatus;
  role: MemberRole | null;
  ownerName: string | null;
  memberCount: number;
  expiryAt: string;
  lastAccessedAt: string | null;
}

export interface DashboardInvitationItem {
  id: string;
  /** EMAIL = addressed to this account, LINK = request raised from an invite link. */
  kind: 'EMAIL' | 'LINK';
  spaceId: string;
  spaceName: string;
  inviterName: string | null;
  role: MemberRole;
  createdAt: string;
  expiresAt: string | null;
}

export interface DashboardExpiryItem {
  id: string;
  name: string;
  status: SpaceStatus;
  expiryAt: string;
  /** Milliseconds left; negative means the deadline already passed. */
  remainingMs: number;
}

/**
 * One authenticated dashboard payload. Each section is computed independently:
 * when one data source fails its section is empty and named in `errors`, so the
 * rest of the dashboard still renders.
 */
export interface DashboardSummary {
  generatedAt: string;
  counts: DashboardCounts;
  storage: StorageSummary | null;
  expiring: DashboardExpiryItem[];
  activity: DashboardActivityItem[];
  recentUploads: DashboardFileItem[];
  recentSpaces: DashboardSpaceItem[];
  invitations: DashboardInvitationItem[];
  /** Section names that could not be loaded on this request. */
  errors: string[];
}

export type SearchCategory = 'all' | 'spaces' | 'files' | 'folders';

export interface SearchResultItem {
  id: string;
  type: 'space' | 'file' | 'folder';
  name: string;
  spaceId: string;
  spaceName: string;
  /** Purpose for Spaces, MIME type for files, folder path for folders. */
  detail: string | null;
  sizeBytes: number | null;
  status: string | null;
  updatedAt: string;
  folderId: string | null;
}

export interface SearchResults {
  query: string;
  category: SearchCategory;
  spaces: SearchResultItem[];
  files: SearchResultItem[];
  folders: SearchResultItem[];
  /** Total matches found before the per-category limit was applied. */
  totals: { spaces: number; files: number; folders: number };
  truncated: boolean;
  minQueryLength: number;
}


// ---------------------------------------------------------------------------
// Module 3 — Space management payloads
// ---------------------------------------------------------------------------

/** Server-computed storage picture for one Space. */
export interface SpaceStorageBreakdown {
  spaceId: string;
  usedBytes: number;
  quotaBytes: number;
  freeBytes: number;
  percentUsed: number;
  fileCount: number;
  folderCount: number;
  /** Verified archive bytes for this Space (kept in the owner's Vault). */
  archivedBytes: number;
}

export type SpaceSort =
  | 'recent'
  | 'oldest'
  | 'name-asc'
  | 'name-desc'
  | 'expiry'
  | 'accessed'
  | 'storage';

export interface SpaceListQuery {
  status?: SpaceStatus | 'ALL' | 'EXPIRING';
  ownership?: 'all' | 'owned' | 'shared';
  /** Filter by the Space purpose string. */
  purpose?: string;
  q?: string;
  sort?: SpaceSort;
  favorite?: boolean;
  limit?: number;
  offset?: number;
}

/** A starter configuration for a new Space; folders are created on creation. */
export interface SpaceTemplate {
  id: string;
  name: string;
  purpose: string;
  description: string;
  folders: string[];
}

export interface DuplicateSpaceResult {
  space: SpaceDetail;
  foldersCopied: number;
  filesCopied: number;
  filesSkipped: number;
}

// ---------------------------------------------------------------------------
// Module 4 — file & folder management
// ---------------------------------------------------------------------------

export type FileSort = 'name-asc' | 'name-desc' | 'size-asc' | 'size-desc' | 'newest' | 'oldest';
export type FileTypeFilter = 'all' | 'image' | 'pdf' | 'document' | 'text' | 'other';
export type PreviewKind = 'image' | 'pdf' | 'text' | 'none';

/** A file row enriched for the file manager (all values come from the API). */
export interface FileListItem extends FileRecord {
  uploaderName: string | null;
  /** Folder path relative to the Space root, e.g. `docs/specs/` (null at root). */
  folderPath: string | null;
  previewKind: PreviewKind;
}

export interface FileListCounts {
  all: number;
  image: number;
  pdf: number;
  document: number;
  text: number;
  other: number;
}

export interface FileListResult {
  files: FileListItem[];
  total: number;
  counts: FileListCounts;
  limit: number;
  offset: number;
}

export interface FileDetails extends FileListItem {
  folderName: string | null;
  storageStatus: 'PRESENT' | 'MISSING';
  /** Current folder path plus the file name, for display. */
  fullPath: string;
}

export interface FilePreview {
  url: string;
  expiresAt: string;
  kind: PreviewKind;
  mimeType: string;
  name: string;
  sizeBytes: number;
  /** Text previews are truncated client-side at this many bytes. */
  maxTextBytes: number;
}

export interface FolderStats {
  folderId: string | null;
  fileCount: number;
  folderCount: number;
  usedBytes: number;
}

export interface BulkFileResult {
  succeeded: string[];
  failed: { id: string; error: string }[];
}

/** One item in the browser upload queue (client-side state only). */
export interface UploadTask {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  folderId: string | null;
  progress: number;
  status: 'queued' | 'uploading' | 'confirming' | 'done' | 'failed' | 'cancelled';
  error: string | null;
  fileId: string | null;
}

// ---------------------------------------------------------------------------
// Module 11 — Admin control panel payloads
// ---------------------------------------------------------------------------

/** Everything the admin overview renders, computed from live rows at call time. */
export interface AdminOverview {
  generatedAt: string;
  users: {
    total: number;
    active: number;
    suspended: number;
    admins: number;
    registeredLast7Days: number;
  };
  spaces: {
    total: number;
    draft: number;
    active: number;
    warning: number;
    archiving: number;
    archived: number;
    archiveFailed: number;
    deleted: number;
  };
  storage: {
    /** Bytes of live (non-deleted) files in temporary Space storage. */
    temporaryBytes: number;
    /** Bytes of verified Vault archives (kept after cleanup). */
    vaultBytes: number;
    fileCount: number;
    verifiedArchives: number;
    failedArchives: number;
  };
  jobs: {
    total: number;
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
    /** FAILED jobs that may still be retried under the retry policy. */
    awaitingIntervention: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
  };
  queues: {
    pendingExtensions: number;
    pendingJoinRequests: number;
    pendingInvitations: number;
    pendingEmailRetries: number;
  };
  email: {
    mode: string;
    configured: boolean;
    total: number;
    sent: number;
    failed: number;
    pending: number;
  };
}

/** One health probe. `unconfigured` is never reported as healthy. */
export interface AdminHealthCheck {
  name: 'api' | 'database' | 'storage' | 'worker' | 'email' | 'scheduler';
  status: 'ok' | 'degraded' | 'unconfigured' | 'error';
  detail: string;
  checkedAt: string;
  latencyMs: number | null;
}

export interface AdminHealth {
  generatedAt: string;
  version: string;
  uptimeSeconds: number;
  checks: AdminHealthCheck[];
}

/** A lifecycle job enriched with its Space name and retry eligibility. */
export interface AdminJobRow extends LifecycleJob {
  spaceName: string | null;
  maxAttempts: number;
  retryable: boolean;
}

export interface AdminJobDetail {
  job: AdminJobRow;
  transitions: LifecycleTransition[];
  archives: Archive[];
  cleanupRuns: CleanupRun[];
}

export interface AdminCleanupRow extends CleanupRun {
  spaceName: string | null;
  /** Set when the Space's verified archive has passed the retention window. */
  retentionEligibleAt: string | null;
  /** Live bytes still stored for the Space. */
  remainingBytes: number;
}

/** One append-only administrative (or security) audit record. */
export interface AdminAuditEntry {
  id: string;
  adminId: string;
  adminName: string | null;
  action: string;
  targetType: string;
  targetId: string;
  outcome: 'SUCCESS' | 'FAILURE';
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AdminAuditPage {
  entries: AdminAuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

/** A per-day count bucket used by the analytics charts. */
export interface AdminAnalyticsBucket {
  /** UTC day, `YYYY-MM-DD`. */
  date: string;
  count: number;
}

export interface AdminAnalytics {
  generatedAt: string;
  days: number;
  registrations: AdminAnalyticsBucket[];
  spacesCreated: AdminAnalyticsBucket[];
  archivesCompleted: AdminAnalyticsBucket[];
  archivesFailed: AdminAnalyticsBucket[];
  jobsSucceeded: AdminAnalyticsBucket[];
  jobsFailed: AdminAnalyticsBucket[];
  extensionsApproved: AdminAnalyticsBucket[];
  extensionsRejected: AdminAnalyticsBucket[];
  emailsSent: AdminAnalyticsBucket[];
  emailsFailed: AdminAnalyticsBucket[];
  totals: {
    registrations: number;
    spacesCreated: number;
    archivesCompleted: number;
    archivesFailed: number;
    jobsSucceeded: number;
    jobsFailed: number;
    extensionsApproved: number;
    extensionsRejected: number;
    emailsSent: number;
    emailsFailed: number;
  };
  /** Metric names this deployment cannot compute from persisted data. */
  unavailable: string[];
}

/** Admin user directory row: profile plus ownership/membership counts. */
export interface AdminUserRow extends Profile {
  spaceCount: number;
  membershipCount: number;
}

export interface AdminUserPage {
  users: AdminUserRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminUserDetail {
  user: Profile;
  spacesOwned: { id: string; name: string; status: SpaceStatus }[];
  memberships: { spaceId: string; spaceName: string; role: MemberRole; status: MemberStatus }[];
  counts: { spacesOwned: number; memberships: number; files: number };
  recentActivity: ActivityLog[];
  securityEvents: AdminAuditEntry[];
}

