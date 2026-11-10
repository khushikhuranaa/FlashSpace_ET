import type { Request, Response, NextFunction } from 'express';
import type { AuthUser } from '@flashspace/shared';
import { AppError } from '@flashspace/shared';
import type { AuthService } from '../services/auth.service.js';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    user?: AuthUser;
  }
}

/** Extracts the Bearer token and resolves the AuthUser; rejects when missing. */
export function requireAuth(authService: AuthService) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) {
        throw new AppError('UNAUTHENTICATED', 'Missing Bearer token');
      }
      req.user = await authService.verifyToken(header.slice('Bearer '.length));
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Wraps an async handler so rejections reach the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'ADMIN') {
    next(new AppError('ADMIN_REQUIRED', 'Admin access required'));
    return;
  }
  next();
}
