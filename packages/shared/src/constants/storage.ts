import type {
  ArchiveJobStatus,
  PlanStatus,
  ScanStatus,
} from '../types/storage.js';
import type { NotificationType } from '../types.js';

export const SCAN_STATUSES: ScanStatus[] = ['PENDING', 'RUNNING', 'VERIFIED', 'FAILED'];
export const PLAN_STATUSES: PlanStatus[] = [
  'PENDING',
  'CONFIRMED',
  'ARCHIVING',
  'VERIFIED',
  'FAILED',
  'CANCELLED',
];
export const ARCHIVE_JOB_STATUSES: ArchiveJobStatus[] = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
];

/** Notification types introduced by the storage-insights feature. These are
 *  merged into the core NOTIFICATION_TYPES array in constants.ts. */
export const STORAGE_NOTIFICATION_TYPES: NotificationType[] = [
  'SCAN_READY',
  'SCAN_FAILED',
  'PLAN_CREATED',
  'PLAN_CANCELLED',
  'ARCHIVE_PLAN_CONFIRMED',
  'ARCHIVE_PLAN_FAILED',
  'DUPLICATE_FILES_REMOVED',
  'REMINDER_SENT',
];

/** Activity actions recorded by the storage-insights feature. These are merged
 *  into ACTIVITY_ACTIONS in constants.ts. */
export const STORAGE_ACTIVITY_ACTIONS = {
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

/** Default thresholds for the storage-insights feature. */
export const STORAGE_INSIGHTS_DEFAULTS = {
  /** Files at or above this size are flagged as large files. */
  largeFileBytes: 10 * 1024 * 1024,
  /** Filename similarity ratio (0-1) above which two files are flagged as
   *  possible near-duplicates. Purely a UI hint; never treated as exact dupes. */
  nearDuplicateSimilarity: 0.7,
  /** How long before expiry the reminder fires (ms). This mirrors the existing
   *  WARNING_WINDOW_HOURS env; the reminder is the SPACE_WARNING notification
   *  gated by warningSentAt so it fires once per warning-window entry. */
  reminderWindowMs: 24 * 60 * 60 * 1000,
} as const;

export type StorageInsightAction = (typeof STORAGE_ACTIVITY_ACTIONS)[keyof typeof STORAGE_ACTIVITY_ACTIONS];
