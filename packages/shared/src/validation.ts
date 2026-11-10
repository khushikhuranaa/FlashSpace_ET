/** Zod schemas for every API boundary payload (PRD §18.3). */
import { z } from 'zod';

const isoDatetime = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Must be an ISO 8601 date-time' })
  .transform((v) => new Date(v).toISOString());

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().trim().min(1).max(80),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  avatarUrl: z.string().url().max(500).nullable().optional(),
});

export const memberRoleSchema = z.enum(['OWNER', 'EDITOR', 'VIEWER']);

export const createSpaceSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(120),
    purpose: z.string().trim().min(1, 'Purpose is required').max(300),
    description: z.string().trim().max(2000).default(''),
    startAt: isoDatetime,
    expiryAt: isoDatetime,
  })
  .refine((v) => Date.parse(v.expiryAt) > Date.parse(v.startAt), {
    message: 'expiryAt must be later than startAt',
    path: ['expiryAt'],
  });

export const updateSpaceSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  purpose: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(2000).optional(),
});

export const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email().optional(),
  userId: z.string().uuid().optional(),
  role: memberRoleSchema,
});

export const changeRoleSchema = z.object({ role: memberRoleSchema });

export const presignUploadSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(150).default('application/octet-stream'),
  size: z.number().int().positive().max(100 * 1024 * 1024 * 1024),
  folderId: z.string().uuid().nullable().optional(),
});

export const completeUploadSchema = z.object({
  fileId: z.string().uuid(),
  size: z.number().int().nonnegative().optional(),
});

export const patchFileSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  folderId: z.string().uuid().nullable().optional(),
});

export const createFolderSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().uuid().nullable().optional(),
});

export const extensionRequestSchema = z.object({
  requestedDays: z.number().int().min(1).max(365),
  reason: z.string().trim().min(1, 'A reason is required').max(1000),
});

export const extensionDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
});

export const markNotificationReadSchema = z.object({ read: z.boolean().default(true) });

export const listSpacesQuerySchema = z.object({
  status: z.string().trim().max(40).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateSpaceInput = z.infer<typeof createSpaceSchema>;
export type PresignUploadInput = z.infer<typeof presignUploadSchema>;
export type ExtensionRequestInput = z.infer<typeof extensionRequestSchema>;
