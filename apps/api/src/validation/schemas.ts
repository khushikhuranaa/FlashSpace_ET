import { z } from 'zod';

/**
 * Module 14: central Zod schemas for sensitive request payloads.
 *
 * Rules of thumb applied here:
 *  - emails are trimmed + lower-cased once, so identity comparison is stable;
 *  - every free-text field has an explicit maximum length;
 *  - passwords have a floor (8) but no gratuitous composition rules;
 *  - numeric fields are integers within realistic ranges;
 *  - unknown fields are rejected on credential endpoints (`strict`), where an
 *    extra property is always a mistake or an attack, and stripped elsewhere so
 *    future client additions do not break existing calls.
 */

export const EMAIL_MAX = 254;
export const NAME_MAX = 80;
export const PURPOSE_MAX = 200;
export const DESCRIPTION_MAX = 2_000;
export const FILE_NAME_MAX = 255;
export const MIME_MAX = 255;
export const TOKEN_MAX = 512;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Email is required')
  .max(EMAIL_MAX, `Email must be at most ${EMAIL_MAX} characters`)
  .email('Enter a valid email address');

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters`);

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1, 'Password is required').max(PASSWORD_MAX),
  })
  .strict();

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: z.string().trim().min(1).max(NAME_MAX).optional(),
  })
  .strict();

export const resetRequestSchema = z.object({ email: emailSchema }).strict();

export const resetConfirmSchema = z
  .object({
    token: z.string().min(10, 'Invalid token').max(TOKEN_MAX),
    newPassword: passwordSchema,
  })
  .strict();

export const tokenParamSchema = z.object({
  token: z.string().min(10, 'Invalid token').max(TOKEN_MAX),
});

export const profilePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(NAME_MAX).optional(),
    // Absolute or provider-signed URL. Length-bounded rather than pattern-locked
    // so local relative preview URLs keep working.
    avatarUrl: z.string().max(2_048).nullable().optional(),
  })
  .strict();

const isoDateTime = z
  .string()
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Must be an ISO datetime');

export const spaceCreateSchema = z
  .object({
    name: z.string().trim().max(NAME_MAX).optional(),
    purpose: z.string().trim().max(PURPOSE_MAX).optional(),
    description: z.string().max(DESCRIPTION_MAX).optional(),
    startAt: isoDateTime,
    expiryAt: isoDateTime,
    templateId: z.string().max(64).nullable().optional(),
  })
  // Unknown fields (e.g. a client-supplied ownerId/role) are stripped, not
  // honoured: creation always uses the authenticated caller's identity.
  .strip();

export const spacePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX).optional(),
    purpose: z.string().trim().min(1).max(PURPOSE_MAX).optional(),
    description: z.string().max(DESCRIPTION_MAX).optional(),
    expiryAt: isoDateTime.optional(),
  })
  .strict();

export const invitationSchema = z
  .object({
    email: emailSchema,
    role: z.enum(['EDITOR', 'VIEWER']),
  })
  .strict();

export const initUploadSchema = z
  .object({
    name: z.string().trim().min(1, 'File name is required').max(FILE_NAME_MAX),
    mimeType: z.string().trim().min(1).max(MIME_MAX).optional(),
    sizeBytes: z
      .number()
      .int('sizeBytes must be an integer')
      .min(0, 'sizeBytes must be non-negative')
      .max(10 * 1024 * 1024 * 1024, 'sizeBytes is out of range'),
    folderId: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

export const renameFileSchema = z
  .object({ name: z.string().trim().min(1, 'File name is required').max(FILE_NAME_MAX) })
  .strict();
