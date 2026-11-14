import type {
  ActivityCategory,
  SpaceSort,
  SpaceTemplate,
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
  FILE_RESTORED: 'FILE_RESTORED',
  FILE_UPLOAD_CANCELLED: 'FILE_UPLOAD_CANCELLED',
  FILES_BULK_DELETED: 'FILES_BULK_DELETED',
  FILES_BULK_MOVED: 'FILES_BULK_MOVED',
  FILES_BULK_DOWNLOADED: 'FILES_BULK_DOWNLOADED',
  FOLDER_CREATED: 'FOLDER_CREATED',
  FOLDER_RENAMED: 'FOLDER_RENAMED',
  FOLDER_MOVED: 'FOLDER_MOVED',
  FOLDER_DELETED: 'FOLDER_DELETED',
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
  SPACE_DUPLICATED: 'SPACE_DUPLICATED',
  SPACE_SETTINGS_UPDATED: 'SPACE_SETTINGS_UPDATED',
  SPACE_FAVORITED: 'SPACE_FAVORITED',
  SPACE_UNFAVORITED: 'SPACE_UNFAVORITED',
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

  // ---- Module 12: complete activity coverage ----
  FILE_UPLOAD_FAILED: 'FILE_UPLOAD_FAILED',
  MEMBER_LEFT: 'MEMBER_LEFT',
  INVITATION_CREATED: 'INVITATION_CREATED',
  INVITATION_SENT: 'INVITATION_SENT',
  INVITATION_ACCEPTED: 'INVITATION_ACCEPTED',
  INVITATION_DECLINED: 'INVITATION_DECLINED',
  INVITATION_REVOKED: 'INVITATION_REVOKED',
  INVITATION_EXPIRED: 'INVITATION_EXPIRED',
  EXTENSION_CANCELLED: 'EXTENSION_CANCELLED',
  EXTENSION_AUTO_DECIDED: 'EXTENSION_AUTO_DECIDED',
  ARCHIVE_STARTED: 'ARCHIVE_STARTED',
  ARCHIVE_VERIFIED: 'ARCHIVE_VERIFIED',
  ARCHIVE_VERIFICATION_FAILED: 'ARCHIVE_VERIFICATION_FAILED',
  ARCHIVE_DOWNLOADED: 'ARCHIVE_DOWNLOADED',
  ARCHIVE_RETRIED: 'ARCHIVE_RETRIED',
  ARCHIVE_UNAVAILABLE: 'ARCHIVE_UNAVAILABLE',
  CLEANUP_STARTED: 'CLEANUP_STARTED',
  CLEANUP_COMPLETED: 'CLEANUP_COMPLETED',
  CLEANUP_PARTIAL_FAILED: 'CLEANUP_PARTIAL_FAILED',
  CLEANUP_FAILED: 'CLEANUP_FAILED',
  ADMIN_USER_ROLE_CHANGED: 'ADMIN_USER_ROLE_CHANGED',
  ADMIN_ACCOUNT_SUSPENDED: 'ADMIN_ACCOUNT_SUSPENDED',
  ADMIN_ACCOUNT_REACTIVATED: 'ADMIN_ACCOUNT_REACTIVATED',
  ADMIN_JOB_RETRIED: 'ADMIN_JOB_RETRIED',
  ADMIN_EXTENSION_DECIDED: 'ADMIN_EXTENSION_DECIDED',
  ACTIVITY_EXPORTED: 'ACTIVITY_EXPORTED',
  SECURITY_AUTH_FAILED: 'SECURITY_AUTH_FAILED',
  SECURITY_ACCESS_DENIED: 'SECURITY_ACCESS_DENIED',
} as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[keyof typeof ACTIVITY_ACTIONS];

/** All activity categories, for UI filters and validation. */
export const ACTIVITY_CATEGORIES: ActivityCategory[] = [
  'SPACE',
  'FILE',
  'FOLDER',
  'MEMBERSHIP',
  'INVITATION',
  'EXTENSION',
  'ARCHIVE',
  'CLEANUP',
  'STORAGE',
  'ADMIN',
  'SECURITY',
  'OTHER',
];

/**
 * Category for an action string, derived from its stable prefix. Stored on the
 * row so filters are indexed instead of pattern-matched at query time.
 */
export function activityCategoryFor(action: string): ActivityCategory {
  if (action.startsWith('SECURITY_')) return 'SECURITY';
  if (action.startsWith('ADMIN_')) return 'ADMIN';
  if (action.startsWith('SPACE_')) return 'SPACE';
  if (action.startsWith('FILE_') || action.startsWith('FILES_')) return 'FILE';
  if (action.startsWith('FOLDER_')) return 'FOLDER';
  if (action.startsWith('MEMBER_')) return 'MEMBERSHIP';
  if (action.startsWith('INVIT')) return 'INVITATION';
  if (action.startsWith('JOIN_')) return 'MEMBERSHIP';
  if (action.startsWith('EXTENSION_')) return 'EXTENSION';
  if (action.startsWith('ARCHIVE_')) return 'ARCHIVE';
  if (action.startsWith('CLEANUP_')) return 'CLEANUP';
  if (action.startsWith('DUPLICATE_') || action.startsWith('SCAN_') || action.startsWith('PLAN_')) {
    return 'STORAGE';
  }
  if (action.startsWith('ACTIVITY_EXPORTED')) return 'SECURITY';
  return 'OTHER';
}

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


/**
 * Purpose presets offered by the Space creation form. Free-text purposes are
 * still accepted (length-limited), so this list guides rather than restricts.
 */
export const SPACE_PURPOSES = [
  'Hackathon',
  'Group Assignment',
  'Project Collaboration',
  'Temporary Team Workspace',
  'Event Planning',
  'Research',
  'Other',
] as const;

/**
 * Built-in Space templates. They only prefill a normal creation request — the
 * API creates a real Space through the regular workflow, so there is exactly
 * one creation code path. No user data is involved, so nothing private can
 * leak through a template.
 */
export const SPACE_TEMPLATES: SpaceTemplate[] = [
  {
    id: 'blank',
    name: 'Blank Space',
    purpose: 'Temporary Team Workspace',
    description: '',
    folders: [],
  },
  {
    id: 'hackathon',
    name: 'Hackathon Workspace',
    purpose: 'Hackathon',
    description: 'Weekend build: idea, prototype, demo and submission.',
    folders: ['Ideas', 'Prototype', 'Design', 'Demo', 'Submission'],
  },
  {
    id: 'assignment',
    name: 'Group Assignment',
    purpose: 'Group Assignment',
    description: 'Coursework split across the group with a hard hand-in date.',
    folders: ['Brief', 'Research', 'Drafts', 'Final'],
  },
  {
    id: 'project',
    name: 'Project Collaboration',
    purpose: 'Project Collaboration',
    description: 'Shared project workspace with specs, assets and reports.',
    folders: ['Docs', 'Design', 'Assets', 'Reports'],
  },
  {
    id: 'event',
    name: 'Event Planning',
    purpose: 'Event Planning',
    description: 'Run sheet, budget, vendors and promotion for one event.',
    folders: ['Planning', 'Budget', 'Vendors', 'Promotion'],
  },
  {
    id: 'research',
    name: 'Research Workspace',
    purpose: 'Research',
    description: 'Sources, notes and analysis for a bounded research sprint.',
    folders: ['Sources', 'Notes', 'Data', 'Analysis'],
  },
];

export const SPACE_SORTS: SpaceSort[] = [
  'recent',
  'oldest',
  'name-asc',
  'name-desc',
  'expiry',
  'accessed',
  'storage',
];

// ---------------------------------------------------------------------------
// Module 4 — file classification + upload policy
// ---------------------------------------------------------------------------

/**
 * Extensions that are never accepted. These are executables, installers and
 * shell scripts: accepting them would let a Space hold runnable payloads that a
 * later download could execute. Documents, archives, images, code and data
 * files are all allowed.
 */
export const UPLOAD_BLOCKED_EXTENSIONS = [
  'exe', 'dll', 'com', 'scr', 'msi', 'msix', 'bat', 'cmd', 'ps1', 'psm1',
  'vbs', 'vbe', 'wsf', 'wsh', 'jar', 'apk', 'app', 'dmg', 'iso', 'pkg',
  'deb', 'rpm', 'sh', 'bash', 'zsh', 'csh',
] as const;

export const IMAGE_MIME_TYPES = [
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif',
] as const;

export const TEXT_MIME_TYPES = [
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values',
  'application/json', 'application/xml', 'application/x-yaml', 'text/yaml',
  'application/javascript', 'text/javascript', 'application/x-ndjson',
] as const;

export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/rtf',
] as const;

/** Extension → bucket fallback for cases where the browser sends octet-stream. */
export function fileTypeBucket(mimeType: string, name: string): 'image' | 'pdf' | 'document' | 'text' | 'other' {
  const mime = (mimeType || '').toLowerCase();
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if ((IMAGE_MIME_TYPES as readonly string[]).includes(mime) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(ext)) {
    return 'image';
  }
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if ((DOCUMENT_MIME_TYPES as readonly string[]).includes(mime) || ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'odt', 'ods', 'odp'].includes(ext)) {
    return 'document';
  }
  if (mime.startsWith('text/') || (TEXT_MIME_TYPES as readonly string[]).includes(mime) || ['txt', 'md', 'csv', 'json', 'log', 'tsv', 'yaml', 'yml', 'xml', 'js', 'ts', 'py', 'css', 'html'].includes(ext)) {
    return 'text';
  }
  return 'other';
}

/** Which preview the browser can render safely for a file. */
export function previewKindFor(mimeType: string, name: string): 'image' | 'pdf' | 'text' | 'none' {
  const bucket = fileTypeBucket(mimeType, name);
  if (bucket === 'image') return 'image';
  if (bucket === 'pdf') return 'pdf';
  // Markdown/CSV/JSON and plain source are safe as escaped text; HTML is not
  // previewed as a document because it would be an injection surface.
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (bucket === 'text' && !['html', 'htm', 'xhtml'].includes(ext)) return 'text';
  if (bucket === 'text' && (mimeType || '').toLowerCase().startsWith('text/plain')) return 'text';
  return 'none';
}

/** Text previews are capped so a huge log cannot freeze the browser. */
export const PREVIEW_TEXT_MAX_BYTES = 1024 * 1024;
