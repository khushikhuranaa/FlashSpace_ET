/**
 * Structured application errors with stable machine-readable codes.
 * The API error envelope is: { error: { code, message, requestId?, details? } }
 */
import type { ApiError } from './types.js';

export const ERROR_STATUS: Record<string, number> = {
  VALIDATION_ERROR: 400,
  INVALID_DATE_RANGE: 400,
  QUOTA_EXCEEDED: 400,
  SPACE_NOT_WRITABLE: 400,
  MAX_EXTENSION_EXCEEDED: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  REFRESH_TOKEN_INVALID: 401,
  REFRESH_TOKEN_REUSED: 401,
  SESSION_EXPIRED: 401,
  SESSION_NOT_FOUND: 404,
  INVALID_JOB_SECRET: 401,
  SPACE_ACCESS_DENIED: 403,
  FORBIDDEN_ROLE: 403,
  ADMIN_REQUIRED: 403,
  OWNER_ONLY: 403,
  NOT_FOUND: 404,
  SPACE_NOT_FOUND: 404,
  FILE_NOT_FOUND: 404,
  ARCHIVE_NOT_FOUND: 404,
  MEMBER_NOT_FOUND: 404,
  EMAIL_NOT_REGISTERED: 404,
  CONFLICT: 409,
  EMAIL_ALREADY_REGISTERED: 409,
  ALREADY_MEMBER: 409,
  INVITATION_PENDING: 409,
  INVITATION_NOT_FOUND: 404,
  INVITATION_INVALID: 410,
  INVITATION_EXPIRED: 410,
  INVITATION_REVOKED: 409,
  INVITATION_ALREADY_ACCEPTED: 409,
  INVITATION_EMAIL_MISMATCH: 403,
  INVITATION_NOT_PENDING: 409,
  JOIN_REQUEST_ALREADY_PENDING: 409,
  INVITE_LINK_INVALID: 410,
  JOIN_REQUEST_NOT_FOUND: 404,
  SPACE_NOT_ARCHIVING: 409,
  ARCHIVE_NOT_VERIFIED: 409,
  PENDING_EXTENSION_EXISTS: 409,
  REQUEST_ALREADY_DECIDED: 409,
  UPLOAD_INCOMPLETE: 409,
  IDEMPOTENT_NOOP: 409,
  INTERNAL: 500,
  STORAGE_ERROR: 500,
  ARCHIVE_ERROR: 500,
  CLEANUP_ERROR: 500,

  // ---- Module 4: file & folder management ----
  FILE_TYPE_NOT_ALLOWED: 400,
  MIME_MISMATCH: 400,
  FOLDER_NOT_EMPTY: 409,
  FOLDER_EXISTS: 409,
  FILE_OBJECT_MISSING: 404,

  // ---- Module 1: authentication & account management ----
  RATE_LIMITED: 429,
  REAUTH_REQUIRED: 401,
  ACCOUNT_DISABLED: 403,
  EMAIL_NOT_VERIFIED: 403,
  PROFILE_NOT_FOUND: 404,
  LEGACY_ACCOUNT_NOT_FOUND: 404,
  EMAIL_ALREADY_IN_USE: 409,
  LEGACY_ACCOUNT_EXISTS: 409,
  OWNED_SPACES_SHARED: 409,
  AUTH_PROVIDER_SUPABASE: 409,
  INVITATIONS_DISABLED: 409,
  SPACE_READ_ONLY: 409,
  INVALID_FILE_TYPE: 415,
  SUPABASE_NOT_CONFIGURED: 503,
  CONFIGURATION_REQUIRED: 503,
  EMAIL_CHANGE_FAILED: 502,
  PASSWORD_UPDATE_FAILED: 502,
  ACCOUNT_DELETE_FAILED: 502,
  PROFILE_ERROR: 500,
  EXPORT_FAILED: 500,

  // ---- Module 11: admin control panel ----
  CONFIRMATION_REQUIRED: 400,
  INVALID_ROLE_CHANGE: 400,
  INVALID_SUSPENSION: 400,
  ACCOUNT_SUSPENDED: 403,
  ALREADY_SUSPENDED: 409,
  NOT_SUSPENDED: 409,
  LAST_ADMIN: 409,
  NO_CHANGE: 409,
  JOB_NOT_FOUND: 404,
  JOB_NOT_RETRYABLE: 409,
  ARCHIVE_JOB_ACTIVE: 409,
  ARCHIVE_ALREADY_VERIFIED: 409,
  MAX_RETRIES_EXCEEDED: 409,
  ADMIN_ACTION_FAILED: 500,

  // ---- Module 14: security & production hardening ----
  MALWARE_DETECTED: 422,
  PAYLOAD_TOO_LARGE: 413,
};

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: keyof typeof ERROR_STATUS | string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code] ?? 500;
    this.details = details;
  }
}

export function toErrorBody(err: unknown, requestId?: string): ApiError['error'] {
  if (err instanceof AppError) {
    return {
      code: err.code,
      message: err.message,
      ...(requestId ? { requestId } : {}),
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
  }
  // Never leak internals (PRD §8.1).
  return {
    code: 'INTERNAL',
    message: 'An unexpected error occurred',
    ...(requestId ? { requestId } : {}),
  };
}
