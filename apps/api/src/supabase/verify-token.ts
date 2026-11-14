import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { AppError } from '@flashspace/shared';
import type { Env } from '../config/env.js';

/**
 * Supabase access-token verification (Module 1.5).
 *
 * Supabase signs access tokens with an asymmetric key pair by default and
 * publishes the public keys at `<project>/auth/v1/.well-known/jwks.json`.
 * We verify against that JWKS with the project's issuer and the `authenticated`
 * audience, so a token can only be accepted if it was minted by this project.
 * Older projects still sign with the shared HS256 JWT secret; that path is
 * supported explicitly when SUPABASE_JWT_SECRET is configured.
 *
 * Nothing here trusts a user id or role supplied by the client: the identity
 * comes from the verified claims, and the application role is re-read from
 * Postgres by the caller — never from the token.
 */

export interface SupabaseIdentityClaims {
  sub: string;
  email: string;
  /** Supabase's own role claim ('authenticated'), not the app role. */
  supabaseRole: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(projectUrl: string) {
  const cached = jwksCache.get(projectUrl);
  if (cached) return cached;
  const url = new URL(`${projectUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`);
  const jwks = createRemoteJWKSet(url);
  jwksCache.set(projectUrl, jwks);
  return jwks;
}

export async function verifySupabaseToken(token: string, env: Env): Promise<SupabaseIdentityClaims> {
  if (!env.supabaseUrl) {
    throw new AppError('SUPABASE_NOT_CONFIGURED', 'SUPABASE_URL is required to verify Supabase sessions');
  }
  const issuer = `${env.supabaseUrl.replace(/\/$/, '')}/auth/v1`;

  let payload: JWTPayload;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg === 'HS256') {
      if (!env.supabaseJwtSecret) {
        throw new AppError(
          'SUPABASE_NOT_CONFIGURED',
          'This project still signs sessions with HS256: set SUPABASE_JWT_SECRET, or migrate to asymmetric signing keys',
        );
      }
      ({ payload } = await jwtVerify(token, new TextEncoder().encode(env.supabaseJwtSecret), {
        issuer,
        audience: 'authenticated',
      }));
    } else {
      ({ payload } = await jwtVerify(token, jwksFor(env.supabaseUrl), {
        issuer,
        audience: 'authenticated',
        algorithms: ['ES256', 'RS256', 'EdDSA'],
        clockTolerance: 5,
      }));
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    const reason = err instanceof Error ? err.message : 'invalid token';
    // Expired and malformed tokens both mean "sign in again", never a 500.
    throw new AppError('UNAUTHENTICATED', `Invalid or expired session: ${reason}`);
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const email = typeof payload.email === 'string' ? payload.email : '';
  if (!sub || !email) {
    throw new AppError('UNAUTHENTICATED', 'Session token is missing a subject or email claim');
  }

  return {
    sub,
    email: email.toLowerCase(),
    supabaseRole: typeof payload.role === 'string' ? payload.role : 'authenticated',
  };
}
