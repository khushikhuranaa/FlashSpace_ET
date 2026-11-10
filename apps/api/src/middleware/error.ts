import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { AppError, toErrorBody } from '@flashspace/shared';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    userId?: string;
    profileRole?: 'USER' | 'ADMIN';
  }
}

/** Attaches a request id and stamps it on errors. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

/** Single error funnel — every thrown/rejected error becomes the standard envelope. */
export function errorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const body = toErrorBody(err, req.requestId);
  if (body.code === 'INTERNAL') {
    // Detail goes to the server log only; the client never sees it (PRD §8.1).
    console.error(`[request ${req.requestId}]`, err);
  }
  const status =
    err instanceof AppError
      ? err.status
      : typeof (err as { status?: number })?.status === 'number'
        ? (err as { status: number }).status
        : 500;
  res.status(status).json({ error: body });
}
