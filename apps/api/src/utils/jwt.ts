import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JWT implementation for the local auth adapter.
 *
 * Verification is deliberately strict: the protected header must pin HS256
 * (so `alg: none` and algorithm-confusion attempts are rejected), the signature
 * is compared in constant time, and `exp`/`iat`/`sub` are validated before the
 * payload is trusted. In supabase auth mode tokens are verified with JWKS by
 * `verifySupabaseToken` instead.
 */

export interface JwtPayload {
  sub: string;
  email: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

export interface VerifyOptions {
  /** Reject tokens whose `iss` does not match (when configured). */
  issuer?: string;
  /** Reject tokens whose `aud` does not include this value (when configured). */
  audience?: string;
  /** Allowed clock skew in seconds for `iat` (default 60). */
  clockToleranceSeconds?: number;
}

/** Maximum token length we are willing to parse (cheap DoS guard). */
const MAX_TOKEN_LENGTH = 8 * 1024;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function decodeJson<T>(input: string): T | null {
  try {
    return JSON.parse(Buffer.from(input, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function signJwt(
  payload: { sub: string; email: string },
  secret: string,
  ttlSeconds: number,
  extra: Record<string, unknown> = {},
): string {
  const iat = Math.floor(Date.now() / 1000);
  const body: JwtPayload = { ...extra, ...payload, iat, exp: iat + ttlSeconds };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify(body));
  const sig = createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url');
  return `${header}.${claims}.${sig}`;
}

export function verifyJwt(token: string, secret: string, options: VerifyOptions = {}): JwtPayload | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, claims, sig] = parts as [string, string, string];

  const head = decodeJson<{ alg?: unknown; typ?: unknown }>(header);
  if (!head || head.alg !== 'HS256') return null;
  if (head.typ !== undefined && head.typ !== 'JWT') return null;

  const expected = createHmac('sha256', secret).update(`${header}.${claims}`).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  const payload = decodeJson<JwtPayload>(claims);
  if (!payload || typeof payload !== 'object') return null;

  if (typeof payload.sub !== 'string' || payload.sub.trim() === '') return null;
  if (payload.email !== undefined && typeof payload.email !== 'string') return null;
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) return null;

  const now = Math.floor(Date.now() / 1000);
  const tolerance = Math.max(0, options.clockToleranceSeconds ?? 60);
  if (payload.exp <= now) return null;
  // A token issued far in the future is malformed or forged, never legitimate.
  if (payload.iat > now + tolerance) return null;
  if (payload.exp <= payload.iat) return null;

  if (options.issuer !== undefined && payload.iss !== options.issuer) return null;
  if (options.audience !== undefined) {
    const aud = payload.aud;
    const ok =
      typeof aud === 'string' ? aud === options.audience : Array.isArray(aud) && aud.includes(options.audience);
    if (!ok) return null;
  }

  return payload;
}
