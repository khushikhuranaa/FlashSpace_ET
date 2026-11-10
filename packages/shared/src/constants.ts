import type {
  ArchiveStatus,
  CleanupStatus,
  ExtensionStatus,
  FileStatus,
  InvitationStatus,
  JoinRequestStatus,
  JobStatus,
  JobType,
  MemberRole,
  MemberStatus,
  NotificationType,
  ProfileRole,
  SpaceStatus,
} from './types.js';
import {
  SCAN_STATUSES,
  PLAN_STATUSES,
  ARCHIVE_JOB_STATUSES,
  STORAGE_INSIGHTS_DEFAULTS,
  STORAGE_NOTIFICATION_TYPES,
  STORAGE_ACTIVITY_ACTIONS,
} from './constants/storage.js';

export { SCAN_STATUSES, PLAN_STATUSES, ARCHIVE_JOB_STATUSES, STORAGE_INSIGHTS_DEFAULTS } from './constants/storage.js';

export const SPACE_STATUSES: SpaceStatus[] = [
  'DRAFT',
  'ACTIVE',
  'WARNING',
  'ARCHIVING',
  'ARCHIVED',
  'ARCHIVE_FAILED',
  'DELETED',
];
export const MEMBER_ROLES: MemberRole[] = ['OWNER', 'EDITOR', 'VIEWER'];
export const MEMBER_STATUSES: MemberStatus[] = ['ACTIVE', 'INVITED', 'REVOKED'];
export const PROFILE_ROLES: ProfileRole[] = ['USER', 'ADMIN'];
export const FILE_STATUSES: FileStatus[] = ['PENDING', 'ACTIVE', 'DELETED'];
export const ARCHIVE_STATUSES: ArchiveStatus[] = ['PENDING', 'CREATING', 'VERIFIED', 'FAILED'];
export const JOB_TYPES: JobType[] = ['LIFECYCLE', 'ARCHIVE', 'CLEANUP'];
export const JOB_STATUSES: JobStatus[] = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'];
export const CLEANUP_STATUSES: CleanupStatus[] = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'PARTIAL_FAILED',
  'FAILED',
];
export const EXTENSION_STATUSES: ExtensionStatus[] = ['PENDING', 'APPROVED', 'REJECTED'];

/** All notification types across the core app + storage-insights feature. */
export const NOTIFICATION_TYPES: NotificationType[] = [
  'SPACE_CREATED',
  'SPACE_WARNING',
  'SPACE_ARCHIVED',
  'SPACE_DELETED',
  'MEMBER_INVITED',
  'MEMBER_ROLE_CHANGED',
  'EXTENSION_DECIDED',
  'ARCHIVE_FAILED',
  'JOIN_REQUEST',
  'JOIN_ACCEPTED',
  'JOIN_DECLINED',
  ...STORAGE_NOTIFICATION_TYPES,
];
export const INVITATION_STATUSES: InvitationStatus[] = ['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED'];
export const JOIN_REQUEST_STATUSES: JoinRequestStatus[] = [
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'WITHDRAWN',
];

/** Roles allowed to mutate file content / membership. */
export const WRITE_ROLES: MemberRole[] = ['OWNER', 'EDITOR'];
/** Roles allowed to read files. */
export const READ_ROLES: MemberRole[] = ['OWNER', 'EDITOR', 'VIEWER'];

/** Action strings recorded in activity_logs across the core app +
 *  storage-insights feature. */
export const ACTIVITY_ACTIONS = {
  SPACE_CREATED: 'SPACE_CREATED',
  SPACE_UPDATED: 'SPACE_UPDATED',
  MEMBER_INVITED: 'MEMBER_INVITED',
  MEMBER_JOINED: 'MEMBER_JOINED',
  MEMBER_ROLE_CHANGED: 'MEMBER_ROLE_CHANGED',
  MEMBER_REVOKED: 'MEMBER_REVOKED',
  FILE_UPLOAD_STARTED: 'FILE_UPLOAD_STARTED',
  FILE_UPLOADED: 'FILE_UPLOADED',
  FILE_DOWNLOADED: 'FILE_DOWNLOADED',
  FILE_RENAMED: 'FILE_RENAMED',
  FILE_MOVED: 'FILE_MOVED',
  FILE_DELETED: 'FILE_DELETED',
  FOLDER_CREATED: 'FOLDER_CREATED',
  EXTENSION_REQUESTED: 'EXTENSION_REQUESTED',
  EXTENSION_APPROVED: 'EXTENSION_APPROVED',
  EXTENSION_REJECTED: 'EXTENSION_REJECTED',
  SPACE_WARNING: 'SPACE_WARNING',
  SPACE_ARCHIVED: 'SPACE_ARCHIVED',
  ARCHIVE_FAILED: 'ARCHIVE_FAILED',
  SPACE_ARCHIVED_MANUALLY: 'SPACE_ARCHIVED_MANUALLY',
  JOIN_REQUESTED: 'JOIN_REQUESTED',
  JOIN_ACCEPTED: 'JOIN_ACCEPTED',
  JOIN_DECLINED: 'JOIN_DECLINED',
  INVITE_LINK_ROTATED: 'INVITE_LINK_ROTATED',
  SPACE_FINALIZED: 'SPACE_FINALIZED',
  ADMIN_RETRY: 'ADMIN_RETRY',
  SCAN_STARTED: 'SCAN_STARTED',
  SCAN_COMPLETED: 'SCAN_COMPLETED',
  SCAN_FAILED: 'SCAN_FAILED',
  PLAN_CREATED: 'PLAN_CREATED',
  PLAN_UPDATED: 'PLAN_UPDATED',
  PLAN_CONFIRMED: 'PLAN_CONFIRMED',
  PLAN_CANCELLED: 'PLAN_CANCELLED',
  ARCHIVE_JOB_STARTED: 'ARCHIVE_JOB_STARTED',
  ARCHIVE_JOB_SUCCEEDED: 'ARCHIVE_JOB_SUCCEEDED',
  ARCHIVE_JOB_FAILED: 'ARCHIVE_JOB_FAILED',
  DUPLICATE_FILES_REMOVED: 'DUPLICATE_FILES_REMOVED',
  REMINDER_SENT: 'REMINDER_SENT',
} as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[keyof typeof ACTIVITY_ACTIONS];

/** Default hard quotas (cost guardrails — PRD §19). */
export const DEFAULT_QUOTAS = {
  FILE_MAX_BYTES: 50 * 1024 * 1024, // 50 MB per file
  SPACE_MAX_BYTES: 250 * 1024 * 1024, // 250 MB per Space
  MAX_ACTIVE_SPACES_PER_USER: 20,
  MAX_EXTENSION_DAYS: 14,
} as const;

/** Storage path builders (PRD §7.1). Temporary and vault prefixes never overlap. */
export const STORAGE_PATHS = {
  spaceObject: (spaceId: string, folderPath: string, fileId: string, safeName: string) =>
    `spaces/${spaceId}/${folderPath}${fileId}-${safeName}`,
  spacePrefix: (spaceId: string) => `spaces/${spaceId}/`,
  archiveZip: (ownerId: string, spaceId: string, archiveId: string) =>
    `users/${ownerId}/vault/archives/${spaceId}/${archiveId}.zip`,
  archiveManifest: (ownerId: string, spaceId: string, archiveId: string) =>
    `users/${ownerId}/vault/archives/${spaceId}/${archiveId}.manifest.json`,
} as const;

