/**
 * PostgreSQL API/service integration.
 *
 * Unlike the repository contract tests, this file boots the real Express app
 * with REPO_MODE=postgres and exercises supported workflows through HTTP:
 * auth/sessions, Spaces, folders/files, Vault, activity, invitations, join
 * links, notifications, extensions, scans, admin audit, email jobs, tokens,
 * lifecycle and restart persistence.
 *
 * Requires a real server: TEST_POSTGRES_URL=... npm test
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../src/app.js';
import { migrateDatabase } from '../src/repositories/postgres/migrate.js';
import {
  closeSharedPostgresPool,
  resetSharedPostgresPoolForTests,
} from '../src/repositories/postgres/pool.js';
import {
  createDisposableDatabase,
  postgresTestUrl,
  type DisposableDatabase,
} from './helpers/postgres.js';

const baseUrl = postgresTestUrl();
const describePg = baseUrl ? describe : describe.skip;

describePg('postgres API workflows', () => {
  let db: DisposableDatabase;
  let storageDir: string;
  let app: Express;
  let ctx: AppContext;
  let server: Server;
  let signedBase: string;

  let admin: { id: string; token: string };
  let member: { id: string; token: string };
  let outsider: { id: string; token: string };
  let spaceId: string;
  let folderId: string;
  let fileId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function listen(targetApp: Express): Promise<{ server: Server; base: string }> {
    const httpServer = createServer(targetApp);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { server: httpServer, base: `http://127.0.0.1:${port}` };
  }

  async function boot(): Promise<void> {
    const built = buildApp({
      repoMode: 'postgres',
      databaseUrl: db.url,
      nodeEnv: 'test',
      localStorageDir: storageDir,
      jobSecret: 'test-job-secret',
      webOrigin: '*',
    });
    app = built.app;
    ctx = built.ctx;
    const listener = await listen(app);
    server = listener.server;
    signedBase = listener.base;
    ctx.env.signedUrlBase = signedBase;
  }

  async function register(email: string, displayName: string) {
    const res = await request(app)
      .post('/auth/register')
      .send({ email, password: 'password123', displayName });
    expect(res.status).toBe(201);
    return { id: res.body.user.id as string, token: res.body.token as string };
  }

  async function authTokenFromOutbox(
    email: string,
    template: 'email-verification' | 'password-reset',
  ): Promise<string> {
    const outbox = await request(app).get('/dev/outbox');
    expect(outbox.status).toBe(200);
    const message = (outbox.body.messages as Array<{ to: string; template: string; text: string }>).find(
      (m) => m.to === email && m.template === template,
    );
    expect(message).toBeTruthy();
    const match = /[?&]token=([A-Za-z0-9_%.-]+)/.exec(message!.text);
    expect(match).toBeTruthy();
    return decodeURIComponent(match![1]!);
  }

  beforeAll(async () => {
    db = await createDisposableDatabase(baseUrl!);
    await migrateDatabase(db.url);
    storageDir = await mkdtemp(join(tmpdir(), 'fs-pg-api-'));
    resetSharedPostgresPoolForTests();
    await boot();
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeSharedPostgresPool();
    if (db) await db.drop();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  }, 60_000);

  it('reports real PostgreSQL health and registers the bootstrap admin', async () => {
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body.database).toMatchObject({ status: 'healthy', engine: 'postgres' });

    admin = await register('pg-admin@test.dev', 'Ada Admin');
    member = await register('pg-member@test.dev', 'Marty Member');
    outsider = await register('pg-outsider@test.dev', 'Ollie Outsider');
    const me = await request(app).get('/auth/me').set(auth(admin.token));
    expect(me.body.user.role).toBe('ADMIN');
  });

  it('rotates sessions, restores identity and revokes on logout', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'pg-admin@test.dev', password: 'password123' });
    expect(login.status).toBe(200);

    const refreshed = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });
    expect(refreshed.status).toBe(200);
    const restored = await request(app).get('/auth/me').set(auth(refreshed.body.token));
    expect(restored.status).toBe(200);
    expect(restored.body.user.email).toBe('pg-admin@test.dev');

    const sessions = await request(app).get('/auth/sessions').set(auth(refreshed.body.token));
    expect(sessions.body.sessions.length).toBeGreaterThan(0);

    const logout = await request(app).post('/auth/logout').set(auth(refreshed.body.token));
    expect(logout.status).toBe(204);
    const afterLogout = await request(app).get('/auth/me').set(auth(refreshed.body.token));
    expect(afterLogout.status).toBe(401);

    // A fresh login restores a usable session for later tests.
    const again = await request(app)
      .post('/auth/login')
      .send({ email: 'pg-admin@test.dev', password: 'password123' });
    admin.token = again.body.token;

    const profile = await request(app)
      .patch('/auth/me')
      .set(auth(admin.token))
      .send({ displayName: 'Ada PostgreSQL' });
    expect(profile.status).toBe(200);
    expect(profile.body.user.displayName).toBe('Ada PostgreSQL');
  });

  it('creates a Space with OWNER membership, folders and file metadata', async () => {
    const created = await request(app)
      .post('/spaces')
      .set(auth(admin.token))
      .send({
        name: 'PG Launch',
        purpose: 'Integration',
        startAt: new Date().toISOString(),
        expiryAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      });
    expect(created.status).toBe(201);
    spaceId = created.body.space.id;
    expect(created.body.space.status).toBe('ACTIVE');

    const detail = await request(app).get(`/spaces/${spaceId}`).set(auth(admin.token));
    expect(detail.body.space.role).toBe('OWNER');

    const listed = await request(app).get('/spaces').set(auth(admin.token));
    expect(listed.body.spaces.some((s: { id: string }) => s.id === spaceId)).toBe(true);

    const updated = await request(app)
      .patch(`/spaces/${spaceId}`)
      .set(auth(admin.token))
      .send({ description: 'Updated on PostgreSQL' });
    expect(updated.status).toBe(200);

    const folder = await request(app)
      .post(`/spaces/${spaceId}/folders`)
      .set(auth(admin.token))
      .send({ name: 'Docs' });
    expect(folder.status).toBe(201);
    folderId = folder.body.folder.id;

    const init = await request(app)
      .post(`/spaces/${spaceId}/files/init-upload`)
      .set(auth(admin.token))
      .send({ name: 'readme.txt', mimeType: 'text/plain', sizeBytes: 11, folderId });
    expect(init.status).toBe(201);
    fileId = init.body.fileId;
    expect(init.body.url).toContain('/storage-upload');

    const put = await fetch(new URL(init.body.url, signedBase), {
      method: 'PUT',
      body: 'hello world',
    });
    expect(put.status).toBe(200);

    const confirmed = await request(app)
      .post(`/spaces/${spaceId}/files/${fileId}/confirm-upload`)
      .set(auth(admin.token));
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.file.status).toBe('ACTIVE');

    const files = await request(app)
      .get(`/spaces/${spaceId}/files`)
      .set(auth(admin.token));
    expect(files.body.files.some((f: { id: string }) => f.id === fileId)).toBe(true);
  });

  it('records activity, extension requests, scans and duplicate insights', async () => {
    const activity = await request(app)
      .get(`/spaces/${spaceId}/activity`)
      .set(auth(admin.token));
    expect(activity.status).toBe(200);
    expect(activity.body.activity.length).toBeGreaterThan(0);

    const extension = await request(app)
      .post(`/spaces/${spaceId}/extensions`)
      .set(auth(admin.token))
      .send({ requestedDays: 3, reason: 'Need a little longer' });
    expect(extension.status).toBe(201);
    const extensions = await request(app)
      .get(`/spaces/${spaceId}/extensions`)
      .set(auth(admin.token));
    expect(extensions.body.requests.length).toBe(1);

    const scan = await request(app)
      .post(`/spaces/${spaceId}/scans`)
      .set(auth(admin.token));
    expect(scan.status).toBe(201);

    const duplicates = await request(app)
      .get(`/spaces/${spaceId}/duplicates`)
      .set(auth(admin.token));
    expect(duplicates.status).toBe(200);

  });

  it('accepts an invitation, enforces roles and handles a join link request', async () => {
    const denied = await request(app).get(`/spaces/${spaceId}`).set(auth(member.token));
    expect(denied.status).toBe(403);

    const invite = await request(app)
      .post(`/spaces/${spaceId}/invitations`)
      .set(auth(admin.token))
      .send({ email: 'pg-member@test.dev', role: 'EDITOR' });
    expect(invite.status).toBe(202);

    const notifications = await request(app).get('/notifications').set(auth(member.token));
    expect(notifications.body.notifications.length).toBeGreaterThan(0);
    const marked = await request(app).post('/notifications/read-all').set(auth(member.token));
    expect(marked.status).toBe(200);

    const accepted = await request(app)
      .post(`/spaces/${spaceId}/invitations/decision`)
      .set(auth(member.token))
      .send({ decision: 'ACCEPT' });
    expect(accepted.status).toBe(200);

    const memberView = await request(app).get(`/spaces/${spaceId}`).set(auth(member.token));
    expect(memberView.body.space.role).toBe('EDITOR');
    const members = await request(app).get(`/spaces/${spaceId}/members`).set(auth(admin.token));
    expect(members.status).toBe(200);

    const link = await request(app)
      .post(`/spaces/${spaceId}/invite-link`)
      .set(auth(admin.token))
      .send({ role: 'VIEWER' });
    expect(link.status).toBe(200);
    const token = (link.body.inviteLink.url as string).split('/').pop()!;

    const preview = await request(app).get(`/join-links/${token}`).set(auth(outsider.token));
    expect(preview.status).toBe(200);
    const joinRequest = await request(app)
      .post(`/join-links/${token}/requests`)
      .set(auth(outsider.token));
    expect(joinRequest.status).toBe(201);

    const requests = await request(app)
      .get(`/spaces/${spaceId}/join-requests`)
      .set(auth(admin.token));
    expect(requests.body.requests.length).toBe(1);
    const decided = await request(app)
      .post(`/join-requests/${requests.body.requests[0].id}/decision`)
      .set(auth(admin.token))
      .send({ decision: 'ACCEPT' });
    expect(decided.status).toBe(200);

    const outsiderView = await request(app).get(`/spaces/${spaceId}`).set(auth(outsider.token));
    expect(outsiderView.body.space.role).toBe('VIEWER');

    // Archiving is deliberately last: an archived Space rejects new invitations.
    const archived = await request(app)
      .post(`/spaces/${spaceId}/archive`)
      .set(auth(admin.token));
    expect(archived.status).toBe(200);
    expect(archived.body.archive).toBeTruthy();

    const vault = await request(app).get('/vault/archives').set(auth(admin.token));
    expect(vault.status).toBe(200);
    expect(vault.body.archives.length).toBeGreaterThan(0);
  });

  it('persists email jobs, verification tokens and admin audit rows', async () => {
    const jobs = await ctx.db.emailJobs.listAll();
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => j.id && j.to)).toBe(true);

    const verify = await request(app)
      .post('/auth/verify-email/request')
      .set(auth(admin.token));
    expect(verify.status).toBe(200);
    const token = await ctx.db.verificationTokens.findByPurposeAndUserId(
      'email-verification',
      admin.id,
    );
    expect(token).toBeDefined();
    expect(token!.tokenHash).not.toContain(admin.token);

    const roleChange = await request(app)
      .post(`/admin/users/${outsider.id}/role`)
      .set(auth(admin.token))
      .send({ role: 'ADMIN', confirm: true, reason: 'Integration check' });
    expect(roleChange.status).toBe(200);
    // Role changes are security events, so they belong to the SECURITY outlet.
    const audit = await request(app).get('/admin/audit?outlet=SECURITY').set(auth(admin.token));
    expect(audit.status).toBe(200);
    expect(audit.body.entries.length).toBeGreaterThan(0);
  });

  it('hardens verification, password reset and sessions on PostgreSQL', async () => {
    const edge = await register('pg-auth-edge@test.dev', 'PG Auth Edge');

    // Concurrent confirmation must consume the token exactly once.
    await request(app).post('/auth/verify-email/request').set(auth(edge.token)).expect(200);
    const concurrentToken = await authTokenFromOutbox('pg-auth-edge@test.dev', 'email-verification');
    const concurrent = await Promise.all([
      request(app).post(`/auth/verify-email/${encodeURIComponent(concurrentToken)}`),
      request(app).post(`/auth/verify-email/${encodeURIComponent(concurrentToken)}`),
    ]);
    expect(concurrent.map((r) => r.status).sort()).toEqual([200, 400]);
    const verified = await request(app).get('/auth/me').set(auth(edge.token));
    expect(verified.body.user.emailVerifiedAt).toBeTruthy();

    // A duplicate request supersedes the older verification link.
    await request(app).post('/auth/verify-email/request').set(auth(edge.token)).expect(200);
    const olderVerification = await authTokenFromOutbox('pg-auth-edge@test.dev', 'email-verification');
    await request(app).post('/auth/verify-email/request').set(auth(edge.token)).expect(200);
    const newerVerification = await authTokenFromOutbox('pg-auth-edge@test.dev', 'email-verification');
    expect(
      (await request(app).post(`/auth/verify-email/${encodeURIComponent(olderVerification)}`)).status,
    ).toBe(400);
    expect(
      (await request(app).post(`/auth/verify-email/${encodeURIComponent(newerVerification)}`)).status,
    ).toBe(200);

    // Password change revokes every session and any pending reset link.
    const secondSession = await request(app)
      .post('/auth/login')
      .send({ email: 'pg-auth-edge@test.dev', password: 'password123' });
    expect(secondSession.status).toBe(200);
    await request(app)
      .post('/auth/reset-password/request')
      .send({ email: 'pg-auth-edge@test.dev' })
      .expect(200);
    const preChangeReset = await authTokenFromOutbox('pg-auth-edge@test.dev', 'password-reset');

    const changed = await request(app)
      .post('/users/me/change-password')
      .set(auth(edge.token))
      .send({ currentPassword: 'password123', newPassword: 'password456' });
    expect(changed.status).toBe(200);
    expect((await request(app).get('/auth/me').set(auth(edge.token))).status).toBe(401);
    expect((await request(app).get('/auth/me').set(auth(secondSession.body.token))).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/auth/reset-password/confirm')
          .send({ token: preChangeReset, newPassword: 'attackerpass123' })
      ).status,
    ).toBe(400);

    const oldLogin = await request(app)
      .post('/auth/login')
      .send({ email: 'pg-auth-edge@test.dev', password: 'password123' });
    expect(oldLogin.status).toBe(401);
    const fresh = await request(app)
      .post('/auth/login')
      .send({ email: 'pg-auth-edge@test.dev', password: 'password456' });
    expect(fresh.status).toBe(200);

    // A pending verification link must be invalidated by a completed reset.
    await request(app)
      .post('/auth/verify-email/request')
      .set(auth(fresh.body.token))
      .expect(200);
    const pendingVerification = await authTokenFromOutbox(
      'pg-auth-edge@test.dev',
      'email-verification',
    );

    // Reset rotation: only the newest reset link can be consumed.
    await request(app)
      .post('/auth/reset-password/request')
      .send({ email: 'pg-auth-edge@test.dev' })
      .expect(200);
    const firstReset = await authTokenFromOutbox('pg-auth-edge@test.dev', 'password-reset');
    await request(app)
      .post('/auth/reset-password/request')
      .send({ email: 'pg-auth-edge@test.dev' })
      .expect(200);
    const secondReset = await authTokenFromOutbox('pg-auth-edge@test.dev', 'password-reset');
    expect(
      (
        await request(app)
          .post('/auth/reset-password/confirm')
          .send({ token: firstReset, newPassword: 'finalpass789' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/auth/reset-password/confirm')
          .send({ token: secondReset, newPassword: 'finalpass789' })
      ).status,
    ).toBe(200);
    expect((await request(app).get('/auth/me').set(auth(fresh.body.token))).status).toBe(401);
    expect(
      (
        await request(app).post(
          `/auth/verify-email/${encodeURIComponent(pendingVerification)}`,
        )
      ).status,
    ).toBe(400);

    // Session listing exposes device metadata, and one session can be revoked
    // without touching the current one.
    const deviceA = await request(app)
      .post('/auth/login')
      .set('User-Agent', 'PG Device A')
      .send({ email: 'pg-auth-edge@test.dev', password: 'finalpass789' });
    const deviceB = await request(app)
      .post('/auth/login')
      .set('User-Agent', 'PG Device B')
      .send({ email: 'pg-auth-edge@test.dev', password: 'finalpass789' });
    const sessions = await request(app).get('/auth/sessions').set(auth(deviceA.body.token));
    // Listing is historical: earlier revoked sessions remain visible.
    expect(sessions.body.sessions.length).toBeGreaterThanOrEqual(2);
    expect(
      sessions.body.sessions.some(
        (s: { id: string; current: boolean }) => s.id === deviceA.body.sessionId && s.current,
      ),
    ).toBe(true);
    expect(
      sessions.body.sessions.some((s: { userAgent: string }) => s.userAgent === 'PG Device B'),
    ).toBe(true);

    const revokeOne = await request(app)
      .delete(`/auth/sessions/${deviceB.body.sessionId}`)
      .set(auth(deviceA.body.token));
    expect(revokeOne.status).toBe(204);
    expect((await request(app).get('/auth/me').set(auth(deviceB.body.token))).status).toBe(401);
    expect((await request(app).get('/auth/me').set(auth(deviceA.body.token))).status).toBe(200);

    // Logout-all revokes the remaining device.
    const logoutAll = await request(app).post('/auth/logout-all').set(auth(deviceA.body.token));
    expect(logoutAll.status).toBe(200);
    expect(logoutAll.body.revoked).toBeGreaterThanOrEqual(1);
    expect((await request(app).get('/auth/me').set(auth(deviceA.body.token))).status).toBe(401);
  });

  it('runs the lifecycle job against PostgreSQL', async () => {
    const res = await request(app)
      .post('/jobs/lifecycle/run')
      .set('x-job-secret', 'test-job-secret');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('scanned');
  });

  it('keeps data across an app/pool restart and reports current migrations', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeSharedPostgresPool();
    resetSharedPostgresPoolForTests();
    await boot();

    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'pg-admin@test.dev', password: 'password123' });
    expect(login.status).toBe(200);

    const space = await request(app).get(`/spaces/${spaceId}`).set(auth(login.body.token));
    expect(space.status).toBe(200);
    expect(space.body.space.name).toBe('PG Launch');

    const files = await request(app)
      .get(`/spaces/${spaceId}/files`)
      .set(auth(login.body.token));
    expect(files.body.files.some((f: { id: string }) => f.id === fileId)).toBe(true);

    const members = await request(app)
      .get(`/spaces/${spaceId}/members`)
      .set(auth(login.body.token));
    expect(members.body.members.length).toBeGreaterThanOrEqual(3);

    const health = await request(app).get('/health');
    expect(health.body.database.status).toBe('healthy');
  });
});
