import type { Request, Response, NextFunction } from 'express';
import type { AuthUser } from '@flashspace/shared';
import { AppError } from '@flashspace/shared';
import type { TokenVerifier } from '../services/identity.service.js';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    user?: AuthUser;
  }
}

/**
 * Extracts the Bearer token and resolves the AuthUser; rejects when missing.
 *
 * The verifier is local JWT in development and Supabase (JWKS) when
 * AUTH_MODE=supabase, so authorization code never needs to know which provider
 * issued the session. The user it returns is always resolved server-side.
 */
export function requireAuth(identity: TokenVerifier) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) {
        throw new AppError('UNAUTHENTICATED', 'Missing Bearer token');
      }
      req.user = await identity.verifyToken(header.slice('Bearer '.length));
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
