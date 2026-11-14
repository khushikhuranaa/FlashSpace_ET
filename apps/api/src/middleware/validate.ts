import type { RequestHandler } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { AppError } from '@flashspace/shared';

/**
 * Module 14: request validation middleware.
 *
 * Validation happens at the HTTP edge, before services see anything, and the
 * parsed value replaces `req.body` / `req.query` so handlers cannot accidentally
 * read unvalidated fields. Errors use the standard API envelope with a
 * field-level message; the raw Zod issue list is attached for debugging without
 * leaking schema internals beyond field names.
 */

function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

function parseWith(schema: ZodTypeAny, value: unknown): unknown {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      firstIssueMessage(parsed.error),
      parsed.error.issues.slice(0, 10).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
    );
  }
  return parsed.data;
}

export function validateBody(schema: ZodTypeAny): RequestHandler {
  return (req, _res, next) => {
    try {
      req.body = parseWith(schema, req.body);
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function validateQuery(schema: ZodTypeAny): RequestHandler {
  return (req, _res, next) => {
    try {
      // Express 5 makes req.query read-only; Express 4 allows replacement. The
      // parsed value is also attached as `validatedQuery` for forward safety.
      const parsed = parseWith(schema, req.query);
      (req as unknown as { validatedQuery?: unknown }).validatedQuery = parsed;
      try {
        req.query = parsed as typeof req.query;
      } catch {
        // Ignore: handlers that need the parsed value use validatedQuery.
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function validateParams(schema: ZodTypeAny): RequestHandler {
  return (req, _res, next) => {
    try {
      req.params = parseWith(schema, req.params) as typeof req.params;
      next();
    } catch (err) {
      next(err);
    }
  };
}
