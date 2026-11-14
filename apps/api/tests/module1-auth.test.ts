import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { SignJWT } from 'jose';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { verifySupabaseToken } from '../src/supabase/verify-token.js';
import { checkPassword } from '../src/utils/password-policy.js';

/**
 * Module 1 — automated local tests.
 *
 * These cover everything that can be proven without a live Supabase project:
 * token verification logic (signature, issuer, audience, expiry, HS256 path),
 * provider switching, and the password policy. Tests that need the real
 * project (registration, verification email, RLS, avatar Storage) live in the
 * live integration suite and are NOT simulated here with mocks.
 */

const PROJECT = 'https://module1-test.supabase.co';
const ISSUER = `${PROJECT}/auth/v1`;
const JWT_SECRET = 'test-only-hs256-secret-value';

function supabaseEnv(overrides: Partial<ReturnType<typeof loadEnv>> = {}) {
  return loadEnv({
    repoMode: 'memory',
    authMode: 'supabase',
    supabaseUrl: PROJECT,
    supabaseAnonKey: 'test-anon-key',
    supabaseServiceKey: 'test-service-key',
    supabaseJwtSecret: JWT_SECRET,
    webOrigin: '*',
    ...overrides,
  });
}

function localEnv() {
  return loadEnv({ repoMode: 'memory', authMode: 'local', webOrigin: '*', nodeEnv: 'test' });
}

async function signToken(
  options: { sub?: string; email?: string; issuer?: string; audience?: string; expiresIn?: string; secret?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: options.email ?? 'member@flashspace.dev', role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? 'authenticated')
    .setSubject(options.sub ?? '11111111-1111-4111-8111-111111111111')
    .setIssuedAt(now)
    .setExpirationTime(options.expiresIn ?? '1h')
    .sign(new TextEncoder().encode(options.secret ?? JWT_SECRET));
}

describe('Supabase access-token verification', () => {
  it('accepts a valid Supabase-shaped token and returns the verified identity', async () => {
    const token = await signToken({ sub: '22222222-2222-4222-8222-222222222222', email: 'Ada@FlashSpace.dev' });
    const claims = await verifySupabaseToken(token, supabaseEnv());
    expect(claims.sub).toBe('22222222-2222-4222-8222-222222222222');
    expect(claims.email).toBe('ada@flashspace.dev');
    expect(claims.supabaseRole).toBe('authenticated');
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ email: 'expired@flashspace.dev', role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setSubject('33333333-3333-4333-8333-333333333333')
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 3600)
      .sign(new TextEncoder().encode(JWT_SECRET));

    await expect(verifySupabaseToken(token, supabaseEnv())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects a token minted for a different project (issuer mismatch)', async () => {
    const token = await signToken({ issuer: 'https://other-project.supabase.co/auth/v1' });
    await expect(verifySupabaseToken(token, supabaseEnv())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects a token with the wrong audience', async () => {
    const token = await signToken({ audience: 'anon' });
    await expect(verifySupabaseToken(token, supabaseEnv())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects a token signed with the wrong secret', async () => {
    const token = await signToken({ secret: 'not-the-project-secret' });
    await expect(verifySupabaseToken(token, supabaseEnv())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects an HS256 token when no JWT secret is configured', async () => {
    const token = await signToken();
    await expect(verifySupabaseToken(token, supabaseEnv({ supabaseJwtSecret: '' }))).rejects.toMatchObject({
      code: 'SUPABASE_NOT_CONFIGURED',
    });
  });

  it('refuses to verify anything when the project URL is missing', async () => {
    // The env loader already rejects a half-configured supabase mode at boot,
    // so model a runtime object that lost its URL rather than a bootable env.
    const unconfigured = { ...supabaseEnv(), supabaseUrl: '' };
    await expect(verifySupabaseToken('any.token.here', unconfigured)).rejects.toMatchObject({
      code: 'SUPABASE_NOT_CONFIGURED',
    });
  });

  it('rejects a malformed token without throwing a 500', async () => {
    await expect(verifySupabaseToken('not-a-jwt', supabaseEnv())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('provider switching', () => {
  it('reports local mode and keeps local register/login enabled', async () => {
    const { app } = buildApp({ repoMode: 'memory', authMode: 'local', nodeEnv: 'test' });
    const config = await request(app).get('/auth/config');
    expect(config.status).toBe(200);
    expect(config.body.mode).toBe('local');
    expect(config.body.localAuthEnabled).toBe(true);
    // Local auth now ships working verification and recovery flows.
    expect(config.body.features.emailVerification).toBe(true);
    expect(config.body.features.passwordRecovery).toBe(true);

    const registered = await request(app)
      .post('/auth/register')
      .send({ email: 'local@flashspace.dev', password: 'password123', displayName: 'Local User' });
    expect(registered.status).toBe(201);
    expect(registered.body.user.role).toBe('ADMIN'); // first account on a fresh install
  });

  it('reports supabase mode and refuses to create accounts in Express', async () => {
    const { app } = buildApp({
      repoMode: 'memory',
      authMode: 'supabase',
      supabaseUrl: PROJECT,
      supabaseAnonKey: 'test-anon-key',
      supabaseServiceKey: 'test-service-key',
      webOrigin: '*',
      nodeEnv: 'test',
    });
    const config = await request(app).get('/auth/config');
    expect(config.body.mode).toBe('supabase');
    expect(config.body.localAuthEnabled).toBe(false);
    expect(config.body.features.emailVerification).toBe(true);
    // No key material is ever returned.
    expect(JSON.stringify(config.body)).not.toMatch(/test-service-key|test-anon-key/);

    const registered = await request(app)
      .post('/auth/register')
      .send({ email: 'x@y.dev', password: 'password123' });
    expect(registered.status).toBe(409);
    expect(registered.body.error.code).toBe('AUTH_PROVIDER_SUPABASE');
  });

  it('requires a bearer token on account endpoints', async () => {
    const { app } = buildApp({ repoMode: 'memory', authMode: 'local', nodeEnv: 'test' });
    const res = await request(app).get('/users/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged token on account endpoints', async () => {
    const { app } = buildApp({
      repoMode: 'memory',
      authMode: 'supabase',
      supabaseUrl: PROJECT,
      supabaseAnonKey: 'test-anon-key',
      supabaseServiceKey: 'test-service-key',
      supabaseJwtSecret: JWT_SECRET,
      webOrigin: '*',
      nodeEnv: 'test',
    });
    const forged = await signToken({ secret: 'attacker-secret' });
    const res = await request(app).get('/users/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('serves account settings from the local profile in local mode', async () => {
    const { app } = buildApp({ repoMode: 'memory', authMode: 'local', nodeEnv: 'test' });
    const login = await request(app)
      .post('/auth/register')
      .send({ email: 'local2@flashspace.dev', password: 'password123' });
    const res = await request(app).get('/users/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.account.email).toBe('local2@flashspace.dev');
    expect(res.body.account.createdAt).toBeTruthy();
    expect(res.body.account.emailVerified).toBe(false);

    const changed = await request(app)
      .post('/users/me/change-password')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ currentPassword: 'password123', newPassword: 'newpassword456' });
    expect(changed.status).toBe(200);

    const relogin = await request(app)
      .post('/auth/login')
      .send({ email: 'local2@flashspace.dev', password: 'newpassword456' });
    expect(relogin.status).toBe(200);
  });
});

describe('password policy', () => {
  it('requires length, a letter and a digit', () => {
    expect(checkPassword('short1').ok).toBe(false);
    expect(checkPassword('allletters').ok).toBe(false);
    expect(checkPassword('12345678').ok).toBe(false);
    expect(checkPassword('password123').ok).toBe(true);
  });

  it('rejects a password equal to the email address', () => {
    expect(checkPassword('member1flashspace', 'member1flashspace').ok).toBe(false);
  });

  it('scores stronger passwords higher', () => {
    expect(checkPassword('password123').score).toBeLessThan(checkPassword('Str0nger-Passw0rd!').score);
    expect(checkPassword('Str0nger-Passw0rd!').score).toBe(4);
  });

  it('caps the password at 72 characters', () => {
    expect(checkPassword(`${'a1'.repeat(40)}`).ok).toBe(false);
  });
});
