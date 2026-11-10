import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Local signed-URL tokens: HMAC(token, secret) over a base64url JSON payload.
 * Mirrors provider signed URLs: short-lived, unforgeable, no credentials in
 * the browser — the HMAC secret never leaves the API process.
 */

export interface SignedTokenPayload {
  method: 'PUT' | 'GET';
  key: string;
  exp: number; // unix seconds
  filename?: string;
}

export function signStorageToken(
  payload: { method: 'PUT' | 'GET'; key: string; expiresInSeconds: number; filename?: string },
  secret: string,
): { token: string; expiresAt: string } {
  const exp = Math.floor(Date.now() / 1000) + payload.expiresInSeconds;
  const body = Buffer.from(JSON.stringify({ method: payload.method, key: payload.key, exp, filename: payload.filename }), 'utf8').toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return { token: `${body}.${mac}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyStorageToken(
  token: string,
  secret: string,
): (SignedTokenPayload & { ok: true }) | { ok: false } {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false };
  const [body, mac] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  let actual: Buffer;
  try {
    actual = Buffer.from(mac, 'base64url');
  } catch {
    return { ok: false };
  }
  const expectedBuf = Buffer.from(expected, 'base64url');
  if (actual.length !== expectedBuf.length || !timingSafeEqual(actual, expectedBuf)) {
    return { ok: false };
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedTokenPayload;
    if (payload.exp * 1000 < Date.now()) return { ok: false };
    return { ...payload, ok: true };
  } catch {
    return { ok: false };
  }
}
