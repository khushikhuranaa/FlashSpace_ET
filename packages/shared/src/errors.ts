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
