import type { Request, RequestHandler, Response } from 'express';

/**
 * Module 14: rate limiting for sensitive endpoints.
 *
 * The default store is in-memory, which is correct for a single process and
 * for tests. A multi-instance deployment must supply a shared store (Redis,
 * Postgres advisory-lock counters, etc.) through `RateLimitStore`; without it
 * each instance enforces its own budget. This limitation is documented in
 * docs/SECURITY.md rather than hidden.
 */

export interface RateLimitHit {
  count: number;
  /** Epoch milliseconds at which the current window ends. */
  resetAt: number;
}

export interface RateLimitStore {
  hit(key: string, windowMs: number, now?: number): RateLimitHit;
  reset?(): void;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, RateLimitHit>();
  private lastSweep = 0;

  hit(key: string, windowMs: number, now: number = Date.now()): RateLimitHit {
    this.sweep(now);
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      const created: RateLimitHit = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, created);
      return created;
    }
    existing.count += 1;
    return existing;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000 && this.buckets.size < 10_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    // Hard ceiling so a spoofed-key flood cannot grow memory without bound.
    if (this.buckets.size > 50_000) this.buckets.clear();
  }

  reset(): void {
    this.buckets.clear();
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** Shared default store (also used by the security tests to reset state). */
export const defaultRateLimitStore = new MemoryRateLimitStore();

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed per key per window. `<= 0` disables the limiter. */
  max: number;
  /** Namespace so two limiters never share a counter. */
  prefix: string;
  /** Derive the counter key; return null to skip limiting this request. */
  key?: (req: Request) => string | null;
  store?: RateLimitStore;
  message?: string;
  now?: () => number;
}

/**
 * The key always includes the authenticated user when one exists, so an
 * attacker cannot escape their budget by rotating IPs. Unauthenticated
 * endpoints fall back to `req.ip`, which Express derives from the socket and,
 * when `trust proxy` is configured, from the trusted X-Forwarded-For chain —
 * never from an arbitrary client-supplied header.
 */
export function clientKey(req: Request): string {
  return req.user?.id ?? req.ip ?? 'unknown';
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const store = options.store ?? defaultRateLimitStore;
  const now = options.now ?? Date.now;
  return (req: Request, res: Response, next): void => {
    if (!Number.isFinite(options.max) || options.max <= 0) {
      next();
      return;
    }
    const raw = options.key ? options.key(req) : clientKey(req);
    if (!raw) {
      next();
      return;
    }
    const current = now();
    const hit = store.hit(`${options.prefix}:${raw}`, options.windowMs, current);
    const remaining = Math.max(0, options.max - hit.count);

    res.setHeader('RateLimit-Limit', String(options.max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(hit.resetAt / 1000)));

    if (hit.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((hit.resetAt - current) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: options.message ?? 'Too many requests. Please wait and try again.',
          requestId: req.requestId,
          retryAfterSeconds: retryAfter,
        },
      });
      return;
    }
    next();
  };
}

/** Key for credential endpoints: IP + normalized email, so one account cannot be hammered. */
export function credentialKey(req: Request): string {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  const normalized = typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : 'anonymous';
  return `${clientKey(req)}:${normalized}`;
}

/**
 * Account-only key used alongside `credentialKey`. Rotating source IPs must
 * not reset the budget for a single email address.
 */
export function credentialAccountKey(req: Request): string | null {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim()
    ? email.trim().toLowerCase().slice(0, 254)
    : null;
}
