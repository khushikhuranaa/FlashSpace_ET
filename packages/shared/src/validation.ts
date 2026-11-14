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
  /** Free-text reason recorded when the request is rejected. */
  rejectionReason: z.string().trim().max(1000).optional(),
  /** Optional admin note visible only to admins. */
  adminNote: z.string().trim().max(1000).optional(),
});
export const cancelExtensionSchema = z.object({});


export const markNotificationReadSchema = z.object({ read: z.boolean().default(true) });

// ---- Module 11: admin control panel ----

/** Global role change. Space roles are deliberately not part of this payload. */
export const adminRoleChangeSchema = z.object({
  role: z.enum(['USER', 'ADMIN']),
  /** Required confirmation for sensitive changes; the API enforces it too. */
  confirm: z.literal(true),
});

export const adminUserQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  role: z.enum(['USER', 'ADMIN']).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  sort: z.enum(['created-asc', 'created-desc', 'name-asc', 'name-desc', 'activity-desc']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const adminSuspendSchema = z.object({
  reason: z.string().trim().min(5, 'A reason of at least 5 characters is required').max(1000),
  confirm: z.literal(true),
});

export const adminAuditQuerySchema = z.object({
  outlet: z.enum(['SECURITY', 'ADMIN', 'ALL']).optional(),
  action: z.string().trim().max(80).optional(),
  adminId: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type AdminRoleChangeInput = z.infer<typeof adminRoleChangeSchema>;

/** Server-side filters for activity reads and CSV exports (Module 12). */
export const activityQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  action: z.string().trim().max(80).optional(),
  category: z
    .enum([
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
    ])
    .optional(),
  actorType: z.enum(['USER', 'ADMIN', 'SYSTEM']).optional(),
  outcome: z.enum(['SUCCESS', 'FAILURE']).optional(),
  resourceType: z.string().trim().max(40).optional(),
  resourceId: z.string().trim().max(80).optional(),
  actorId: z.string().trim().max(80).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  sort: z.enum(['newest', 'oldest']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type ActivityQueryInput = z.infer<typeof activityQuerySchema>;

export const listSpacesQuerySchema = z.object({
  status: z.string().trim().max(40).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateSpaceInput = z.infer<typeof createSpaceSchema>;
export type PresignUploadInput = z.infer<typeof presignUploadSchema>;
export type ExtensionRequestInput = z.infer<typeof extensionRequestSchema>;
