import { Router, type Request, type Response } from 'express';
import { AppError } from '@flashspace/shared';
import type { AuthService } from '../services/auth.service.js';
import { asyncHandler, requireAuth } from '../middleware/auth.js';

export function authRoutes(authService: AuthService): Router {
  const router = Router();

  router.post(
    '/auth/register',
    asyncHandler(async (req: Request, res: Response) => {
      const { email, password, displayName } = req.body as Record<string, unknown>;
      if (typeof email !== 'string' || typeof password !== 'string' || password.length < 8) {
        throw new AppError('VALIDATION_ERROR', 'email and password (min 8 chars) are required');
      }
      const result = await authService.register(
        email.toLowerCase(),
        password,
        typeof displayName === 'string' && displayName.trim() ? displayName.trim() : email.split('@')[0]!,
      );
      res.status(201).json(result);
    }),
  );

  router.post(
    '/auth/login',
    asyncHandler(async (req: Request, res: Response) => {
      const { email, password } = req.body as Record<string, unknown>;
      if (typeof email !== 'string' || typeof password !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'email and password are required');
      }
      res.json(await authService.login(email.toLowerCase(), password));
    }),
  );

  router.get(
    '/auth/me',
    requireAuth(authService),
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ user: await authService.me(req.user!.id) });
    }),
  );

  router.patch(
    '/auth/me',
    requireAuth(authService),
    asyncHandler(async (req: Request, res: Response) => {
      const { displayName, avatarUrl } = req.body as Record<string, unknown>;
      res.json({
        user: await authService.updateProfile(req.user!.id, {
          ...(typeof displayName === 'string' ? { displayName } : {}),
          ...(avatarUrl === null || typeof avatarUrl === 'string' ? { avatarUrl } : {}),
        }),
      });
    }),
  );

  return router;
}
