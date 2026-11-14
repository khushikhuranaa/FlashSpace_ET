import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { buildApp, type AppContext } from '../src/app.js';
import type { Env } from '../src/config/env.js';
import { VerificationTokensService } from '../src/services/verification-tokens.service.js';
import { signJwt } from '../src/utils/jwt.js';

/**
 * Module 18 — authentication hardening.
 *
 * These tests exercise the gaps that were not covered by the existing auth
 * suites: reset-token rotation, verification-token supersession, password-change
 * session invalidation, logout-all, session metadata and refresh replay on both
 * local backends.
 */
const MODES: Array<{ label: string; overrides: Partial<Env> }> = [
  { label: 'memory', overrides: { repoMode: 'memory' } },
  { label: 'sqlite', overrides: { repoMode: 'sqlite', sqliteFile: ':memory:' } },
];

interface Account {
  id: string;
  token: string;
  refreshToken: string;
  sessionId: string;
}

async function register(app: Express, email: string, userAgent = 'Auth Test'): Promise<Account> {
  const res = await request(app)
    .post('/auth/register')
    .set('User-Agent', userAgent)
    .send({ email, password: 'password123', displayName: 'Auth Hardening' });
  expect(res.status).toBe(201);
  return { id: res.body.user.id as string, ...(res.body as Omit<Account, 'id'>) };
}

async function login(app: Express, email: string, password = 'password123', userAgent = 'Second Device'): Promise<Account> {
  const res = await request(app)
    .post('/auth/login')
    .set('User-Agent', userAgent)
    .send({ email, password });
  expect(res.status).toBe(200);
  return { id: res.body.user.id as string, ...(res.body as Omit<Account, 'id'>) };
}

async function outbox(app: Express): Promise<Array<{ to: string; template: string; text: string }>> {
  const res = await request(app).get('/dev/outbox');
  expect(res.status).toBe(200);
  return res.body.messages as Array<{ to: string; template: string; text: string }>;
}

function tokenFromMessage(text: string): string {
  const match = /[?&]token=([A-Za-z0-9_%.-]+)/.exec(text);
  if (!match) throw new Error(`No token found in message: ${text.slice(0, 120)}`);
  return decodeURIComponent(match[1]!);
}

async function newestToken(
  app: Express,
  email: string,
  template: 'email-verification' | 'password-reset',
): Promise<string> {
  const message = (await outbox(app)).find((m) => m.to === email && m.template === template);
  expect(message).toBeTruthy();
  return tokenFromMessage(message!.text);
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe.each(MODES)('authentication hardening ($label)', ({ overrides }) => {
  let app: Express;
  let ctx: AppContext;

  beforeEach(() => {
    ({ app, ctx } = buildApp({
      ...overrides,
      authMode: 'local',
      nodeEnv: 'test',
      webOrigin: '*',
      emailTransport: 'mock',
    }));
  });

  it('rotates reset tokens and invalidates pending verification tokens on reset', async () => {
    const account = await register(app, 'rotate-reset@local.test');

    expect(
      (
        await request(app)
          .post('/auth/verify-email/request')
          .set(bearer(account.token))
      ).status,
    ).toBe(200);
    const verificationToken = await newestToken(app, 'rotate-reset@local.test', 'email-verification');

    expect(
      (
        await request(app)
          .post('/auth/reset-password/request')
          .send({ email: 'rotate-reset@local.test' })
      ).status,
    ).toBe(200);
    const firstReset = await newestToken(app, 'rotate-reset@local.test', 'password-reset');

    expect(
      (
        await request(app)
          .post('/auth/reset-password/request')
          .send({ email: 'rotate-reset@local.test' })
      ).status,
    ).toBe(200);
    const secondReset = await newestToken(app, 'rotate-reset@local.test', 'password-reset');
    expect(secondReset).not.toBe(firstReset);

    const oldReset = await request(app)
      .post('/auth/reset-password/confirm')
      .send({ token: firstReset, newPassword: 'newpassword456' });
    expect(oldReset.status).toBe(400);

    const reset = await request(app)
      .post('/auth/reset-password/confirm')
      .send({ token: secondReset, newPassword: 'newpassword456' });
    expect(reset.status).toBe(200);

    // Reset revokes every session, including the one that requested it.
    expect((await request(app).get('/auth/me').set(bearer(account.token))).status).toBe(401);

    // The pending verification link must not survive the completed reset.
    const verification = await request(app).post(
      `/auth/verify-email/${encodeURIComponent(verificationToken)}`,
    );
    expect(verification.status).toBe(400);

    const relogin = await login(app, 'rotate-reset@local.test', 'newpassword456');
    expect(relogin.token).toBeTruthy();
  });

  it('supersedes the previous email-verification link and persists the verified timestamp', async () => {
    const account = await register(app, 'supersede@local.test');

    await request(app).post('/auth/verify-email/request').set(bearer(account.token)).expect(200);
    const first = await newestToken(app, 'supersede@local.test', 'email-verification');

    await request(app).post('/auth/verify-email/request').set(bearer(account.token)).expect(200);
    const second = await newestToken(app, 'supersede@local.test', 'email-verification');
    expect(second).not.toBe(first);

    expect((await request(app).post(`/auth/verify-email/${encodeURIComponent(first)}`)).status).toBe(400);

    const verified = await request(app).post(`/auth/verify-email/${encodeURIComponent(second)}`);
    expect(verified.status).toBe(200);

    const me = await request(app).get('/auth/me').set(bearer(account.token));
    expect(me.status).toBe(200);
    expect(me.body.user.emailVerifiedAt).toBeTruthy();

    // The consumed token cannot be replayed.
    expect((await request(app).post(`/auth/verify-email/${encodeURIComponent(second)}`)).status).toBe(400);
  });

  it('consumes a verification token once under concurrent confirmation', async () => {
    const account = await register(app, 'concurrent-verify@local.test');
    await request(app).post('/auth/verify-email/request').set(bearer(account.token)).expect(200);
    const token = await newestToken(app, 'concurrent-verify@local.test', 'email-verification');

    const results = await Promise.all([
      request(app).post(`/auth/verify-email/${encodeURIComponent(token)}`),
      request(app).post(`/auth/verify-email/${encodeURIComponent(token)}`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);

    const me = await request(app).get('/auth/me').set(bearer(account.token));
    expect(me.body.user.emailVerifiedAt).toBeTruthy();
  });

  it('rejects an expired verification token and consumes it', async () => {
    const account = await register(app, 'expired-verify@local.test');
    const expired = new VerificationTokensService(ctx.db, -1_000, -1_000);
    const issued = await expired.issueEmailVerificationToken(account.id);

    expect(
      (await request(app).post(`/auth/verify-email/${encodeURIComponent(issued.token)}`)).status,
    ).toBe(400);
    expect(
      (await request(app).post(`/auth/verify-email/${encodeURIComponent(issued.token)}`)).status,
    ).toBe(400);
  });

  it('revokes every session and pending reset link when the password changes', async () => {
    const first = await register(app, 'change-pass@local.test', 'First Device');
    const second = await login(app, 'change-pass@local.test', 'password123', 'Second Device');

    await request(app)
      .post('/auth/reset-password/request')
      .send({ email: 'change-pass@local.test' })
      .expect(200);
    const pendingReset = await newestToken(app, 'change-pass@local.test', 'password-reset');

    const changed = await request(app)
      .post('/users/me/change-password')
      .set(bearer(first.token))
      .send({ currentPassword: 'password123', newPassword: 'password456' });
    expect(changed.status).toBe(200);

    expect((await request(app).get('/auth/me').set(bearer(first.token))).status).toBe(401);
    expect((await request(app).get('/auth/me').set(bearer(second.token))).status).toBe(401);

    // A pre-change reset link must not be able to undo the password change.
    expect(
      (
        await request(app)
          .post('/auth/reset-password/confirm')
          .send({ token: pendingReset, newPassword: 'attackerpass123' })
      ).status,
    ).toBe(400);

    expect(
      (
        await request(app)
          .post('/auth/login')
          .send({ email: 'change-pass@local.test', password: 'password123' })
      ).status,
    ).toBe(401);

    const relogin = await login(app, 'change-pass@local.test', 'password456', 'New Device');
    expect(relogin.token).toBeTruthy();
  });

  it('invalidates an old-address verification link when the email changes', async () => {
    const account = await register(app, 'old-address@local.test');
    await request(app).post('/auth/verify-email/request').set(bearer(account.token)).expect(200);
    const oldAddressToken = await newestToken(app, 'old-address@local.test', 'email-verification');

    const changed = await request(app)
      .post('/users/me/change-email')
      .set(bearer(account.token))
      .send({ newEmail: 'new-address@local.test' });
    expect(changed.status).toBe(202);

    expect(
      (
        await request(app).post(
          `/auth/verify-email/${encodeURIComponent(oldAddressToken)}`,
        )
      ).status,
    ).toBe(400);
    const me = await request(app).get('/auth/me').set(bearer(account.token));
    expect(me.body.user.email).toBe('new-address@local.test');
    expect(me.body.user.emailVerifiedAt).toBeNull();
  });

  it('rejects an expired access token even when its session is active', async () => {
    const account = await register(app, 'expired-access@local.test');
    const expired = signJwt(
      { sub: account.id, email: 'expired-access@local.test' },
      ctx.env.localAuthSecret,
      -10,
      { sid: account.sessionId },
    );

    const res = await request(app).get('/auth/me').set(bearer(expired));
    expect(res.status).toBe(401);

    // The session itself remains valid for a freshly signed token.
    expect((await request(app).get('/auth/me').set(bearer(account.token))).status).toBe(200);
  });

  it('revokes one session without touching the current one', async () => {
    const first = await register(app, 'single-revoke@local.test', 'Keep Device');
    const second = await login(app, 'single-revoke@local.test', 'password123', 'Revoke Device');

    const revoke = await request(app)
      .delete(`/auth/sessions/${second.sessionId}`)
      .set(bearer(first.token));
    expect(revoke.status).toBe(204);

    expect((await request(app).get('/auth/me').set(bearer(second.token))).status).toBe(401);
    expect((await request(app).get('/auth/me').set(bearer(first.token))).status).toBe(200);
  });

  it('logout-all revokes every active session and its refresh token', async () => {
    const first = await register(app, 'logout-all@local.test', 'First Device');
    const second = await login(app, 'logout-all@local.test', 'password123', 'Second Device');

    const result = await request(app).post('/auth/logout-all').set(bearer(first.token));
    expect(result.status).toBe(200);
    expect(result.body.revoked).toBeGreaterThanOrEqual(2);

    expect((await request(app).get('/auth/me').set(bearer(first.token))).status).toBe(401);
    expect((await request(app).get('/auth/me').set(bearer(second.token))).status).toBe(401);

    expect(
      (await request(app).post('/auth/refresh').send({ refreshToken: first.refreshToken })).status,
    ).toBe(401);
    expect(
      (await request(app).post('/auth/refresh').send({ refreshToken: second.refreshToken })).status,
    ).toBe(401);
  });

  it('lists device metadata and rejects replay of a rotated refresh token', async () => {
    const first = await register(app, 'device-meta@local.test', 'Device One');
    const second = await login(app, 'device-meta@local.test', 'password123', 'Device Two');
    expect(second.sessionId).not.toBe(first.sessionId);

    const listed = await request(app).get('/auth/sessions').set(bearer(first.token));
    expect(listed.status).toBe(200);
    expect(listed.body.sessions).toHaveLength(2);
    const current = listed.body.sessions.find((s: { current: boolean }) => s.current);
    expect(current.id).toBe(first.sessionId);
    expect(current.userAgent).toBe('Device One');
    expect(listed.body.sessions.some((s: { userAgent: string }) => s.userAgent === 'Device Two')).toBe(true);

    const rotated = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: first.refreshToken });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(first.refreshToken);

    const replay = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: first.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // Replay detection kills the entire account's sessions, including the
    // replacement token that the legitimate client just received.
    expect(
      (await request(app).get('/auth/me').set(bearer(rotated.body.token))).status,
    ).toBe(401);
    expect(
      (await request(app).get('/auth/me').set(bearer(second.token))).status,
    ).toBe(401);

    // The context is exposed so the assertion above is not testing a mock.
    expect(ctx.env.repoMode).toBe(overrides.repoMode);
  });
});
