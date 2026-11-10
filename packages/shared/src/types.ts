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

export type FileStatus = 'PENDING' | 'ACTIVE' | 'DELETED';
export type ArchiveStatus = 'PENDING' | 'CREATING' | 'VERIFIED' | 'FAILED';
export type JobType = 'LIFECYCLE' | 'ARCHIVE' | 'CLEANUP';
export type JobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type CleanupStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL_FAILED' | 'FAILED';
export type ExtensionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
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

export interface ActivityLog {
  id: number;
  userId: string | null;
  spaceId: string | null;
  fileId: string | null;
  action: string;
  metadata: Record<string, unknown>;
  createdAt: string;
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

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: ProfileRole;
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
