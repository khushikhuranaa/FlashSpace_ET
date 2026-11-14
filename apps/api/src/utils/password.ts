import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing for the local auth adapter (Supabase Auth owns credentials
 * in supabase mode).
 *
 * Format v2: `scrypt$v2$<N>$<r>$<p>$<saltHex>$<hashHex>`
 * Legacy:    `scrypt$<saltHex>$<hashHex>` (default cost, still verifiable)
 *
 * Costs are stored with the hash so they can be raised later without a mass
 * reset: existing hashes keep verifying, and `needsRehash()` lets the login
 * path upgrade them in place after a successful sign-in.
 */

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

/** ~16 MiB, ~40 ms on current hardware: OWASP-acceptable scrypt baseline. */
export const CURRENT_SCRYPT: ScryptParams = { N: 1 << 14, r: 8, p: 1, keylen: 64 };
const LEGACY_SCRYPT: ScryptParams = { N: 1 << 14, r: 8, p: 1, keylen: 64 };

/** scrypt needs 128*N*r bytes; allow a generous ceiling for the default. */
const MAX_MEM = 128 * 1024 * 1024;
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;
const MAX_KEYLEN = 128;

function derive(password: string, salt: Buffer, params: ScryptParams): Buffer {
  return scryptSync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEM,
  });
}

function parse(stored: string):
  | { params: ScryptParams; salt: Buffer; hash: Buffer; legacy: boolean }
  | null {
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt') return null;
  try {
    if (parts[1] === 'v2') {
      if (parts.length !== 7) return null;
      const N = Number(parts[2]);
      const r = Number(parts[3]);
      const p = Number(parts[4]);
      const saltHex = parts[5]!;
      const hashHex = parts[6]!;
      // Never let a tampered record force an enormous KDF run (memory DoS).
      if (!Number.isInteger(N) || N < 1024 || N > MAX_N) return null;
      if (!Number.isInteger(r) || r < 1 || r > MAX_R) return null;
      if (!Number.isInteger(p) || p < 1 || p > MAX_P) return null;
      const salt = Buffer.from(saltHex, 'hex');
      const hash = Buffer.from(hashHex, 'hex');
      if (salt.length < 8 || hash.length < 16 || hash.length > MAX_KEYLEN) return null;
      return { params: { N, r, p, keylen: hash.length }, salt, hash, legacy: false };
    }
    if (parts.length !== 3) return null;
    const salt = Buffer.from(parts[1]!, 'hex');
    const hash = Buffer.from(parts[2]!, 'hex');
    if (salt.length < 8 || hash.length < 16) return null;
    return { params: { ...LEGACY_SCRYPT, keylen: hash.length }, salt, hash, legacy: true };
  } catch {
    return null;
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = derive(password, salt, CURRENT_SCRYPT);
  return `scrypt$v2$${CURRENT_SCRYPT.N}$${CURRENT_SCRYPT.r}$${CURRENT_SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parsed = parse(stored);
  if (!parsed) return false;
  let actual: Buffer;
  try {
    actual = derive(password, parsed.salt, parsed.params);
  } catch {
    return false;
  }
  return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash);
}

/**
 * True when a stored hash uses an older format or weaker cost than the current
 * policy, so the login path can transparently upgrade it.
 */
export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  if (!parsed) return true;
  const p = parsed.params;
  return (
    parsed.legacy ||
    p.N < CURRENT_SCRYPT.N ||
    p.r < CURRENT_SCRYPT.r ||
    p.p !== CURRENT_SCRYPT.p ||
    p.keylen !== CURRENT_SCRYPT.keylen
  );
}

/** Re-exported so callers can label hashes without importing crypto. */
export function hashAlgorithm(stored: string): string {
  return stored.split('$')[0] ?? 'unknown';
}
