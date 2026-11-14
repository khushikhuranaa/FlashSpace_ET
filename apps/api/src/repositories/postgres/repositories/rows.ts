/**
 * Row mappers for the core PostgreSQL repositories.
 *
 * PostgreSQL returns `timestamptz` columns as `Date` objects and booleans as
 * real booleans, while the DataLayer contract (shared with SQLite) exposes
 * ISO-8601 strings. Every mapper normalises those two differences.
 */
import {
  activityCategoryFor,
  type ActivityLog,
  type Archive,
  type CleanupRun,
  type LifecycleJob,
  type LifecycleTransition,
  type ExtensionRequest,
  type FileRecord,
  type Folder,
  type JoinRequest,
  type Notification,
  type Profile,
  type Space,
  type SpaceInvitation,
  type SpaceInviteLink,
  type SpaceMember,
} from '@flashspace/shared';
import type {
  AdminAuditRow,
  ArchiveJobRow,
  ArchivePlanRow,
  AuthSession as SessionRow,
  DuplicateFileRow,
  DuplicateGroupRow,
  EmailJobRow,
  FavoriteSpace,
  HashedTokenRow,
  ScanJobRow,
  SpaceAccess,
} from '../../data-layer.interface.js';

export type DbRow = Record<string, unknown>;

export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function iso(value: unknown): string {
  return toIso(value) ?? '';
}

export function mapProfileRow(row: DbRow): Profile {
  return {
    id: row.id as string,
    email: row.email as string,
    displayName: row.display_name as string,
    role: row.role as Profile['role'],
    avatarUrl: (row.avatar_url as string | null) ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    // Postgres calls this column account_status; SQLite calls it status.
    status: ((row.account_status ?? row.status) as Profile['status']) ?? 'ACTIVE',
    suspendedAt: toIso(row.suspended_at),
    suspendedBy: (row.suspended_by as string | null) ?? null,
    suspensionReason: (row.suspension_reason as string | null) ?? null,
    lastActiveAt: toIso(row.last_active_at),
    emailVerifiedAt: toIso(row.email_verified_at),
  };
}

export function mapSessionRow(row: DbRow): SessionRow {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    refreshTokenHash: row.refresh_hash as string,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    revokedAt: toIso(row.revoked_at),
    lastUsedAt: iso(row.last_used_at),
    userAgent: (row.user_agent as string | null) ?? null,
    ip: (row.ip as string | null) ?? null,
  };
}

export function mapSpaceRow(row: DbRow): Space {
  return {
    id: row.id as string,
    ownerId: row.owner_id as string,
    name: row.name as string,
    purpose: row.purpose as string,
    description: (row.description as string | null) ?? '',
    startAt: iso(row.start_at),
    expiryAt: iso(row.expiry_at),
    status: row.status as Space['status'],
    warningSentAt: toIso(row.warning_sent_at),
    archivedManually: Boolean(row.archived_manually),
    invitationsEnabled: row.invitations_enabled === null || row.invitations_enabled === undefined
      ? true
      : Boolean(row.invitations_enabled),
    defaultInviteRole: (row.default_invite_role as Space['defaultInviteRole']) ?? 'VIEWER',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapMemberRow(row: DbRow): SpaceMember {
  return {
    spaceId: row.space_id as string,
    userId: row.user_id as string,
    role: row.role as SpaceMember['role'],
    status: row.status as SpaceMember['status'],
    joinedAt: toIso(row.joined_at),
    revokedAt: toIso(row.revoked_at),
  };
}

export function mapAccessRow(row: DbRow): SpaceAccess {
  return {
    spaceId: row.space_id as string,
    userId: row.user_id as string,
    lastAccessedAt: iso(row.last_accessed_at),
  };
}

export function mapFolderRow(row: DbRow): Folder {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    parentId: (row.parent_id as string | null) ?? null,
    name: row.name as string,
    path: row.path as string,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapFileRow(row: DbRow): FileRecord {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    folderId: (row.folder_id as string | null) ?? null,
    uploaderId: row.uploader_id as string,
    name: row.name as string,
    objectKey: row.object_key as string,
    mimeType: row.mime_type as string,
    sizeBytes: Number(row.size_bytes),
    etag: (row.etag as string | null) ?? null,
    sha256: (row.sha256 as string | null) ?? null,
    status: row.status as FileRecord['status'],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: toIso(row.deleted_at),
  };
}

export function mapInvitationRow(row: DbRow): SpaceInvitation {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    inviterId: row.inviter_id as string,
    email: row.email as string,
    intendedRole: row.intended_role as SpaceInvitation['intendedRole'],
    tokenHash: (row.token_hash as string | null) ?? null,
    status: row.status as SpaceInvitation['status'],
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
  };
}

export function mapInviteLinkRow(row: DbRow): SpaceInviteLink {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    createdBy: row.created_by as string,
    token: row.token as string,
    role: row.role as SpaceInviteLink['role'],
    createdAt: iso(row.created_at),
    revokedAt: toIso(row.revoked_at),
  };
}

export function mapJoinRequestRow(row: DbRow): JoinRequest {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    requesterId: row.requester_id as string,
    role: row.role as JoinRequest['role'],
    source: row.source as JoinRequest['source'],
    invitationId: (row.invitation_id as string | null) ?? null,
    status: row.status as JoinRequest['status'],
    createdAt: iso(row.created_at),
    decidedBy: (row.decided_by as string | null) ?? null,
    decidedAt: toIso(row.decided_at),
  };
}

export function mapExtensionRow(row: DbRow): ExtensionRequest {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    requesterId: row.requester_id as string,
    requestedDays: Number(row.requested_days),
    reason: row.reason as string,
    status: row.status as ExtensionRequest['status'],
    decidedBy: (row.decided_by as string | null) ?? null,
    decidedAt: toIso(row.decided_at),
    rejectionReason: (row.rejection_reason as string | null) ?? null,
    adminNote: (row.admin_note as string | null) ?? null,
    previousExpiryAt: toIso(row.previous_expiry_at),
    newExpiryAt: toIso(row.new_expiry_at),
    approvalMethod: (row.approval_method as ExtensionRequest['approvalMethod']) ?? null,
    createdAt: iso(row.created_at),
  };
}

export function mapNotificationRow(row: DbRow): Notification {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    spaceId: (row.space_id as string | null) ?? null,
    type: row.type as Notification['type'],
    title: row.title as string,
    body: row.body as string,
    inviteLinkId: (row.invite_link_id as string | null) ?? null,
    joinRequestId: (row.join_request_id as string | null) ?? null,
    readAt: toIso(row.read_at),
    createdAt: iso(row.created_at),
  };
}

export function mapArchiveRow(row: DbRow): Archive {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    ownerId: row.owner_id as string,
    objectKey: row.object_key as string,
    sizeBytes: Number(row.size_bytes),
    checksum: (row.checksum as string | null) ?? null,
    fileCount: Number(row.file_count),
    status: row.status as Archive['status'],
    createdAt: iso(row.created_at),
    verifiedAt: toIso(row.verified_at),
  };
}

export function mapJobRow(row: DbRow): LifecycleJob {
  return {
    id: row.id as string,
    jobType: row.job_type as LifecycleJob['jobType'],
    spaceId: (row.space_id as string | null) ?? null,
    idempotencyKey: row.idempotency_key as string,
    status: row.status as LifecycleJob['status'],
    attempts: Number(row.attempts),
    startedAt: iso(row.started_at),
    finishedAt: toIso(row.finished_at),
    error: (row.error as string | null) ?? null,
  };
}

export function mapCleanupRunRow(row: DbRow): CleanupRun {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    archiveId: row.archive_id as string,
    status: row.status as CleanupRun['status'],
    membershipsRevoked: Number(row.memberships_revoked),
    objectsDeleted: Number(row.objects_deleted),
    startedAt: iso(row.started_at),
    finishedAt: toIso(row.finished_at),
    error: (row.error as string | null) ?? null,
  };
}

export function mapFavoriteSpaceRow(row: DbRow): FavoriteSpace {
  return {
    userId: row.user_id as string,
    spaceId: row.space_id as string,
    createdAt: iso(row.created_at),
  };
}

export function mapLifecycleTransitionRow(row: DbRow): LifecycleTransition {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    actorId: (row.actor_id as string | null) ?? null,
    previousStatus: row.previous_status as LifecycleTransition['previousStatus'],
    newStatus: row.new_status as LifecycleTransition['newStatus'],
    reason: row.reason as string,
    timestamp: iso(row.timestamp),
  };
}

export function mapScanJobRow(row: DbRow): ScanJobRow {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    ownerId: row.owner_id as string,
    status: row.status as string,
    totalFiles: Number(row.total_files),
    totalBytes: Number(row.total_bytes),
    duplicateGroups: Number(row.duplicate_groups),
    duplicateFileCount: Number(row.duplicate_file_count),
    extraCopyCount: Number(row.extra_copy_count),
    potentialSavingsBytes: Number(row.potential_savings_bytes),
    largeFileCount: Number(row.large_file_count),
    nearDuplicateGroupCount: Number(row.near_duplicate_group_count),
    scannedAt: toIso(row.scanned_at),
    failedAt: toIso(row.failed_at),
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapDuplicateGroupRow(row: DbRow): DuplicateGroupRow {
  return {
    id: row.id as string,
    scanId: row.scan_id as string,
    contentHash: row.content_hash as string,
    fileCount: Number(row.file_count),
    extraCopyCount: Number(row.extra_copy_count),
    totalBytes: Number(row.total_bytes),
    potentialSavingsBytes: Number(row.potential_savings_bytes),
    representativeName: row.representative_name as string,
  };
}

export function mapDuplicateFileRow(row: DbRow): DuplicateFileRow {
  return {
    id: row.id as string,
    groupId: row.group_id as string,
    scanId: row.scan_id as string,
    fileId: row.file_id as string,
    name: row.name as string,
    objectKey: row.object_key as string,
    sizeBytes: Number(row.size_bytes),
    mimeType: row.mime_type as string,
    uploadedAt: iso(row.uploaded_at),
    uploaderId: row.uploader_id as string,
    excluded: Boolean(row.excluded),
  };
}

export function mapArchivePlanRow(row: DbRow): ArchivePlanRow {
  const raw = row.excluded_file_ids as string | null;
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    ownerId: row.owner_id as string,
    scanId: (row.scan_id as string | null) ?? null,
    status: row.status as string,
    excludedFileIds: raw ? raw.split(',').filter(Boolean) : [],
    willArchiveFileCount: Number(row.will_archive_file_count),
    willArchiveBytes: Number(row.will_archive_bytes),
    willExcludeFileCount: Number(row.will_exclude_file_count),
    willExcludeBytes: Number(row.will_exclude_bytes),
    potentialSavingsBytes: Number(row.potential_savings_bytes),
    explained: Boolean(row.explained),
    confirmedAt: toIso(row.confirmed_at),
    archiveJobId: (row.archive_job_id as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapArchiveJobRow(row: DbRow): ArchiveJobRow {
  return {
    id: row.id as string,
    planId: row.plan_id as string,
    spaceId: row.space_id as string,
    ownerId: row.owner_id as string,
    idempotencyKey: row.idempotency_key as string,
    status: row.status as string,
    attempts: Number(row.attempts),
    archiveId: (row.archive_id as string | null) ?? null,
    startedAt: iso(row.started_at),
    finishedAt: toIso(row.finished_at),
    error: (row.error as string | null) ?? null,
  };
}

export function mapEmailJobRow(row: DbRow): EmailJobRow {
  return {
    id: row.id as string,
    category: row.category as string,
    template: row.template as string,
    to: row.to_address as string,
    subject: row.subject as string,
    entityId: row.entity_id as string,
    entityType: row.entity_type as string,
    status: row.status as string,
    attempts: Number(row.attempts),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastAttemptAt: toIso(row.last_attempt_at),
    deliveredAt: toIso(row.delivered_at),
    error: (row.error as string | null) ?? null,
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
  };
}

export function mapHashedTokenRow(row: DbRow): HashedTokenRow {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    tokenHash: row.token_hash as string,
    purpose: row.purpose as string,
    expiresAt: iso(row.expires_at),
    usedAt: toIso(row.used_at),
    createdAt: iso(row.created_at),
  };
}

export function mapAdminAuditRow(row: DbRow): AdminAuditRow {
  const rawMetadata = row.metadata;
  let metadata: Record<string, unknown> = {};
  if (rawMetadata && typeof rawMetadata === 'object') {
    metadata = rawMetadata as Record<string, unknown>;
  } else if (typeof rawMetadata === 'string' && rawMetadata) {
    metadata = JSON.parse(rawMetadata) as Record<string, unknown>;
  }
  return {
    id: row.id as string,
    adminId: row.admin_id as string,
    action: row.action as string,
    targetType: row.target_type as string,
    targetId: row.target_id as string,
    outcome: row.outcome as AdminAuditRow['outcome'],
    reason: (row.reason as string | null) ?? null,
    metadata,
    createdAt: iso(row.created_at),
  };
}

export function mapActivityRow(row: DbRow): ActivityLog {
  const rawMetadata = row.metadata;
  let metadata: Record<string, unknown> = {};
  if (rawMetadata && typeof rawMetadata === 'object') {
    metadata = rawMetadata as Record<string, unknown>;
  } else if (typeof rawMetadata === 'string' && rawMetadata) {
    metadata = JSON.parse(rawMetadata) as Record<string, unknown>;
  }
  const action = row.action as string;
  return {
    id: Number(row.id),
    userId: (row.user_id as string | null) ?? null,
    spaceId: (row.space_id as string | null) ?? null,
    fileId: (row.file_id as string | null) ?? null,
    action,
    metadata,
    createdAt: iso(row.created_at),
    actorType: (row.actor_type as ActivityLog['actorType']) ?? 'USER',
    outcome: (row.outcome as ActivityLog['outcome']) ?? 'SUCCESS',
    category: (row.category as ActivityLog['category']) ?? activityCategoryFor(action),
    resourceType: (row.resource_type as string | null) ?? null,
    resourceId: (row.resource_id as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    correlationId: (row.correlation_id as string | null) ?? null,
    eventKey: (row.event_key as string | null) ?? null,
  };
}
