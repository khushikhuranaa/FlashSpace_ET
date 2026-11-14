import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { buildApp } from '../src/app.js';

/** Module 17 — refresh rotation, revocation and session listing (local auth). */

function build(): Express {
  const { app } = buildApp({
    repoMode: 'memory',
    authMode: 'local',
    nodeEnv: 'test',
    webOrigin: '*',
    emailTransport: 'mock',
  });
  return app;
}

async function register(app: Express, email: string) {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: 'password123', displayName: 'Session User' });
  expect(res.status).toBe(201);
  return res.body as {
    token: string;
    refreshToken: string;
    sessionId: string;
    expiresAt: string;
  };
}

describe('refresh token rotation', () => {
  it('rotates a refresh token and refuses the retired one', async () => {
    const app = build();
    const first = await register(app, 'rotate@local.test');

    const refreshed = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: first.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refreshToken).not.toBe(first.refreshToken);
    expect(refreshed.body.sessionId).not.toBe(first.sessionId);

    // The new access token works.
    const me = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${refreshed.body.token}`);
    expect(me.status).toBe(200);

    // Replaying the rotated token is treated as theft: every session dies.
    const replay = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: first.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    const afterReuse = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${refreshed.body.token}`);
    expect(afterReuse.status).toBe(401);
  });

  it('rejects unknown refresh tokens', async () => {
    const app = build();
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: 'not-a-real-token-value-xxxxxxxx' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });
});

describe('session revocation', () => {
  it('invalidates the access token on logout', async () => {
    const app = build();
    const session = await register(app, 'logout@local.test');

    const before = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${session.token}`);
    expect(before.status).toBe(200);

    const logout = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${session.token}`);
    expect(logout.status).toBe(204);

    const after = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${session.token}`);
    expect(after.status).toBe(401);

    const refreshAfterLogout = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: session.refreshToken });
    expect(refreshAfterLogout.status).toBe(401);
  });

  it('lists sessions and revokes another device without touching the current one', async () => {
    const app = build();
    const account = await register(app, 'devices@local.test');
    const second = await request(app)
      .post('/auth/login')
      .send({ email: 'devices@local.test', password: 'password123' });
    expect(second.status).toBe(200);

    const list = await request(app)
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${account.token}`);
    expect(list.status).toBe(200);
    expect(list.body.sessions).toHaveLength(2);
    const current = list.body.sessions.find((s: { current: boolean }) => s.current);
    expect(current.id).toBe(account.sessionId);

    const revoke = await request(app)
      .delete(`/auth/sessions/${second.body.sessionId}`)
      .set('Authorization', `Bearer ${account.token}`);
    expect(revoke.status).toBe(204);

    const otherAfter = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${second.body.token}`);
    expect(otherAfter.status).toBe(401);

    const currentAfter = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${account.token}`);
    expect(currentAfter.status).toBe(200);
  });

  it('revokes every session when the password is reset', async () => {
    const app = build();
    const session = await register(app, 'reset-sessions@local.test');
    const requestRes = await request(app)
      .post('/auth/reset-password/request')
      .send({ email: 'reset-sessions@local.test' });
    expect(requestRes.status).toBe(200);

    const outbox = await request(app).get('/dev/outbox');
    const message = outbox.body.messages.find(
      (m: { to: string; template: string }) =>
        m.to === 'reset-sessions@local.test' && m.template === 'password-reset',
    );
    const token = decodeURIComponent(
      /[?&]token=([A-Za-z0-9_%.-]+)/.exec(message.text as string)![1]!,
    );

    await request(app)
      .post('/auth/reset-password/confirm')
      .send({ token, newPassword: 'newpassword456' })
      .expect(200);

    const stale = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${session.token}`);
    expect(stale.status).toBe(401);
  });
});
