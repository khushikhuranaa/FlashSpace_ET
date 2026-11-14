import express, { Router, type Request, type Response } from 'express';
import { AppError } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { AccountService } from '../services/account.service.js';
import { asyncHandler } from '../middleware/auth.js';
import { checkPassword } from '../utils/password-policy.js';

const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

function accessToken(req: Request): string {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) throw new AppError('UNAUTHENTICATED', 'Missing Bearer token');
  return header.slice('Bearer '.length);
}

function clientContext(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.ip ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  };
}

/**
 * Account management endpoints (Module 1.6).
 *
 * Mounted behind `requireAuth`, so `req.user` is always a verified identity
 * resolved from the Supabase access token. No endpoint accepts a user id from
 * the client — the caller's own id is used, which is what prevents IDOR here.
 */
export function accountRoutes(account: AccountService, env: Env): Router {
  const router = Router();

  router.get(
    '/users/me',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ account: await account.me(req.user!) });
    }),
  );

  router.patch(
    '/users/me',
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { displayName?: unknown; preferences?: unknown };
      if (body.displayName !== undefined && typeof body.displayName !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'displayName must be a string');
      }
      const preferences: Record<string, unknown> = {};
      if (body.preferences !== undefined) {
        if (typeof body.preferences !== 'object' || body.preferences === null || Array.isArray(body.preferences)) {
          throw new AppError('VALIDATION_ERROR', 'preferences must be an object');
        }
        for (const [key, value] of Object.entries(body.preferences as Record<string, unknown>)) {
          if (['notifyInApp', 'notifyEmail', 'productUpdates'].includes(key)) {
            if (typeof value !== 'boolean') throw new AppError('VALIDATION_ERROR', `${key} must be a boolean`);
            preferences[key] = value;
          } else if (key === 'timezone' && typeof value === 'string') {
            preferences[key] = value.slice(0, 64);
          } else {
            throw new AppError('VALIDATION_ERROR', `Unsupported preference: ${key}`);
          }
        }
      }
      res.json({
        account: await account.update(
          req.user!,
          {
            ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
            ...(body.preferences !== undefined ? { preferences } : {}),
          },
          clientContext(req),
        ),
      });
    }),
  );

  // Raw image body (not multipart): the browser sends the file directly, and
  // express.raw keeps the bytes untouched for magic-number validation.
  router.post(
    '/users/me/avatar',
    express.raw({ type: AVATAR_TYPES as unknown as string[], limit: env.maxAvatarBytes }),
    asyncHandler(async (req: Request, res: Response) => {
      const contentType = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
      if (!(AVATAR_TYPES as readonly string[]).includes(contentType)) {
        throw new AppError('INVALID_FILE_TYPE', 'Avatar must be a PNG, JPEG, WebP or GIF image');
      }
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      res.status(201).json({ account: await account.uploadAvatar(req.user!, buffer, contentType) });
    }),
  );

  router.delete(
    '/users/me/avatar',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ account: await account.removeAvatar(req.user!) });
    }),
  );

  router.post(
    '/users/me/change-email',
    asyncHandler(async (req: Request, res: Response) => {
      const { newEmail } = req.body as { newEmail?: unknown };
      if (typeof newEmail !== 'string' || !newEmail.trim()) {
        throw new AppError('VALIDATION_ERROR', 'newEmail is required');
      }
      res.status(202).json(await account.requestEmailChange(req.user!, accessToken(req), newEmail));
    }),
  );

  router.post(
    '/users/me/change-password',
    asyncHandler(async (req: Request, res: Response) => {
      const { currentPassword, newPassword } = req.body as {
        currentPassword?: unknown;
        newPassword?: unknown;
      };
      if (typeof currentPassword !== 'string' || !currentPassword) {
        throw new AppError('VALIDATION_ERROR', 'currentPassword is required');
      }
      if (typeof newPassword !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'newPassword is required');
      }
      const check = checkPassword(newPassword, req.user!.email);
      if (!check.ok) throw new AppError('VALIDATION_ERROR', check.message ?? 'Invalid password');
      await account.changePassword(req.user!, accessToken(req), currentPassword, newPassword);
      res.json({ ok: true });
    }),
  );

  router.get(
    '/users/me/export',
    asyncHandler(async (req: Request, res: Response) => {
      const data = await account.export(req.user!);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="flashspace-account-${new Date().toISOString().slice(0, 10)}.json"`,
      );
      // Personal data: never cache in shared proxies.
      res.setHeader('Cache-Control', 'no-store');
      res.json(data);
    }),
  );

  router.delete(
    '/users/me',
    asyncHandler(async (req: Request, res: Response) => {
      const { password } = req.body as { password?: unknown };
      if (typeof password !== 'string' || !password) {
        throw new AppError('VALIDATION_ERROR', 'Confirm your password to delete the account');
      }
      await account.deleteAccount(req.user!, accessToken(req), password);
      res.status(204).end();
    }),
  );

  router.post(
    '/users/me/link-legacy',
    asyncHandler(async (req: Request, res: Response) => {
      const { email, password } = req.body as { email?: unknown; password?: unknown };
      if (typeof email !== 'string' || typeof password !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'email and password of the existing account are required');
      }
      res.json(await account.linkLegacyAccount(req.user!, accessToken(req), { email, password }));
    }),
  );

  return router;
}
