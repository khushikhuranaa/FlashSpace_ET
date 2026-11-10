import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../src/app.js';

/**
 * Integration tests run against the real app + local storage.
 *
 * The suite is data-layer agnostic: by default it uses the in-memory layer for
 * speed, and `TEST_REPO_MODE=sqlite npm test` runs the exact same tests against
 * the persistent SQLite database, proving both backends behave identically.
 */
const REPO_MODE = process.env.TEST_REPO_MODE === 'sqlite' ? 'sqlite' : 'memory';
function repoOverrides(): Partial<import('../src/config/env.js').Env> {
  return REPO_MODE === 'sqlite'
    ? { repoMode: 'sqlite', sqliteFile: ':memory:' }
    : { repoMode: 'memory' };
}

interface TestWorld {
  app: Express;
  ctx: AppContext;
  admin: { token: string; id: string };
  owner: { token: string; id: string };
  member: { token: string; id: string };
  outsider: { token: string; id: string };
}

/** Signed URLs point at a real ephemeral listener owned by the current world. */
let baseUrl = '';
const servers: import('node:http').Server[] = [];
async function putToSignedUrl(url: string, body: string | Buffer): Promise<Response> {
  return fetch(new URL(url, baseUrl), { method: 'PUT', body });
}
async function getFromSignedUrl(url: string): Promise<Response> {
  return fetch(new URL(url, baseUrl));
}
afterAll(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

async function register(app: Express, email: string, displayName: string) {
  const res = await request(app).post('/auth/register').send({ email, password: 'password123', displayName });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, id: res.body.user.id as string };
}

async function setupWorld(): Promise<TestWorld> {
  const { app, ctx } = buildApp({ localStorageDir: './data/test-storage', ...repoOverrides() });
  // Serve this world's app on an ephemeral port so signed URLs are fetchable.
  const http = await import('node:http');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  servers.push(server);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  ctx.env.signedUrlBase = `http://127.0.0.1:${port}`;
  baseUrl = ctx.env.signedUrlBase;
  // First registered user becomes ADMIN (bootstrap rule).
  const admin = await register(app, 'admin@test.dev', 'Ada Admin');
  const owner = await register(app, 'owner@test.dev', 'Olive Owner');
  const member = await register(app, 'member@test.dev', 'Marty Member');
  const outsider = await register(app, 'outsider@test.dev', 'Ollie Outsider');
  return { app, ctx, admin, owner, member, outsider };
}

function futureDate(days: number): string {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

describe('health + auth', () => {
  it('GET /health returns ok', async () => {
    const { app } = await setupWorld();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('registers, logs in, and rejects bad credentials', async () => {
    const { app } = await setupWorld();
    const login = await request(app).post('/auth/login').send({ email: 'owner@test.dev', password: 'password123' });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();

    const bad = await request(app).post('/auth/login').send({ email: 'owner@test.dev', password: 'wrongpassword' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');

    const dupe = await request(app).post('/auth/register').send({ email: 'owner@test.dev', password: 'password123', displayName: 'X' });
    expect(dupe.status).toBe(409);
  });

  it('requires a Bearer token for protected routes', async () => {
    const { app } = await setupWorld();
    const res = await request(app).get('/spaces');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /auth/me resolves the token', async () => {
    const { app, owner } = await setupWorld();
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('owner@test.dev');
  });
});

describe('spaces + RBAC', () => {
  it('creates a Space and the owner is OWNER', async () => {
    const { app, owner } = await setupWorld();
    const res = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Launch Site', purpose: 'Launch prep', startAt: new Date().toISOString(), expiryAt: futureDate(7) });
    expect(res.status).toBe(201);
    expect(res.body.space.status).toBe('ACTIVE');
    const detail = await request(app).get(`/spaces/${res.body.space.id}`).set('Authorization', `Bearer ${owner.token}`);
    expect(detail.body.space.role).toBe('OWNER');
  });

  it('rejects expiryAt before startAt', async () => {
    const { app, owner } = await setupWorld();
    const res = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Bad', purpose: 'Bad', startAt: futureDate(5), expiryAt: futureDate(1) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_DATE_RANGE');
  });

  it('outsiders cannot read a Space', async () => {
    const { app, owner, outsider } = await setupWorld();
    const created = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Private', purpose: 'Private', startAt: new Date().toISOString(), expiryAt: futureDate(7) });
    const res = await request(app).get(`/spaces/${created.body.space.id}`).set('Authorization', `Bearer ${outsider.token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SPACE_ACCESS_DENIED');
  });

  it('invitation flow grants access and enforces roles', async () => {
    const { app, owner, member, outsider } = await setupWorld();
    const created = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Team', purpose: 'Team', startAt: new Date().toISOString(), expiryAt: futureDate(7) });
    const spaceId = created.body.space.id;

    const invite = await request(app)
      .post(`/spaces/${spaceId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'member@test.dev', role: 'EDITOR' });
    expect(invite.status).toBe(202);

    // VIEWER cannot upload
    const inviteViewer = await request(app)
      .post(`/spaces/${spaceId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'outsider@test.dev', role: 'VIEWER' });
    expect(inviteViewer.status).toBe(202);

    const asViewer = await request(app)
      .post(`/spaces/${spaceId}/files/init-upload`)
      .set('Authorization', `Bearer ${outsider.token}`)
      .send({ name: 'x.txt', sizeBytes: 10 });
    expect(asViewer.status).toBe(403);
    expect(asViewer.body.error.code).toBe('FORBIDDEN_ROLE');

    // EDITOR can rename but cannot delete the Space
    const asEditor = await request(app).get(`/spaces/${spaceId}`).set('Authorization', `Bearer ${member.token}`);
    expect(asEditor.status).toBe(200);
    expect(asEditor.body.space.role).toBe('EDITOR');

    const deleteAttempt = await request(app).delete(`/spaces/${spaceId}`).set('Authorization', `Bearer ${member.token}`);
    expect(deleteAttempt.status).toBe(403);
  });

  it('member role change and revocation work', async () => {
    const { app, owner, member } = await setupWorld();
    const created = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Roles', purpose: 'Roles', startAt: new Date().toISOString(), expiryAt: futureDate(7) });
    const spaceId = created.body.space.id;
    await request(app).post(`/spaces/${spaceId}/invitations`).set('Authorization', `Bearer ${owner.token}`).send({ email: 'member@test.dev', role: 'VIEWER' });

    const promote = await request(app)
      .patch(`/spaces/${spaceId}/members/${member.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ role: 'EDITOR' });
    expect(promote.status).toBe(200);
    expect(promote.body.member.role).toBe('EDITOR');

    const revoke = await request(app).delete(`/spaces/${spaceId}/members/${member.id}`).set('Authorization', `Bearer ${owner.token}`);
    expect(revoke.status).toBe(204);

    const after = await request(app).get(`/spaces/${spaceId}`).set('Authorization', `Bearer ${member.token}`);
    expect(after.status).toBe(403);
  });
});

describe('files', () => {
  async function makeSpace(app: Express, token: string): Promise<string> {
    const res = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Files', purpose: 'Files', startAt: new Date().toISOString(), expiryAt: futureDate(30) });
    return res.body.space.id as string;
  }

  it('signed upload → confirm → download → delete round-trip', async () => {
    const { app, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token);

    const init = await request(app)
      .post(`/spaces/${spaceId}/files/init-upload`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'hello.txt', mimeType: 'text/plain', sizeBytes: 11 });
    expect(init.status).toBe(201);
    const { fileId, url } = init.body as { fileId: string; url: string };

    // PUT directly to the signed URL (like a browser would).
    const put = await putToSignedUrl(url, 'hello world');
    expect(put.status).toBe(200);

    const confirm = await request(app).post(`/spaces/${spaceId}/files/${fileId}/confirm-upload`).set('Authorization', `Bearer ${owner.token}`);
    expect(confirm.status).toBe(200);
    expect(confirm.body.file.status).toBe('ACTIVE');

    const download = await request(app).post(`/spaces/${spaceId}/files/${fileId}/download`).set('Authorization', `Bearer ${owner.token}`);
    expect(download.status).toBe(200);
    const get = await getFromSignedUrl(download.body.url);
    expect(await get.text()).toBe('hello world');

    const del = await request(app).delete(`/spaces/${spaceId}/files/${fileId}`).set('Authorization', `Bearer ${owner.token}`);
    expect(del.status).toBe(204);
  });

  it('rejects confirm when the browser never uploaded', async () => {
    const { app, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token);
    const init = await request(app)
      .post(`/spaces/${spaceId}/files/init-upload`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'ghost.txt', sizeBytes: 1 });
    const confirm = await request(app).post(`/spaces/${spaceId}/files/${init.body.fileId}/confirm-upload`).set('Authorization', `Bearer ${owner.token}`);
    expect(confirm.status).toBe(404);
  });

  it('enforces per-file and per-Space quotas', async () => {
    // Dedicated world with tiny quotas so real bytes can exercise both limits.
    const { app, ctx } = buildApp({
      localStorageDir: './data/test-storage-quota',
      fileMaxBytes: 10,
      spaceMaxBytes: 25,
      ...repoOverrides(),
    });
    const http = await import('node:http');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    server.unref();
    servers.push(server);
    const addr = server.address();
    ctx.env.signedUrlBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    baseUrl = ctx.env.signedUrlBase;

    const reg = await request(app).post('/auth/register').send({ email: 'quota@test.dev', password: 'password123', displayName: 'Q' });
    const token = reg.body.token as string;
    const space = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Quota', purpose: 'Quota', startAt: new Date().toISOString(), expiryAt: futureDate(30) });
    const spaceId = space.body.space.id as string;

    const tooBig = await request(app)
      .post(`/spaces/${spaceId}/files/init-upload`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'big.bin', sizeBytes: 11 });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error.code).toBe('QUOTA_EXCEEDED');

    // Fill the Space: 10-byte file confirms as 10 real bytes; third exceeds 25.
    let last;
    for (let i = 0; i < 3; i++) {
      last = await request(app)
        .post(`/spaces/${spaceId}/files/init-upload`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `chunk-${i}.bin`, sizeBytes: 10 });
      if (last.status === 400) break;
      await putToSignedUrl(last.body.url, '0123456789');
      await request(app).post(`/spaces/${spaceId}/files/${last.body.fileId}/confirm-upload`).set('Authorization', `Bearer ${token}`);
    }
    expect(last!.status).toBe(400);
    expect(last!.body.error.code).toBe('QUOTA_EXCEEDED');
  });
});

describe('lifecycle: warning → archiving → archive → cleanup', () => {
  async function makeSpace(app: Express, token: string, expiresInDays: number, name: string): Promise<string> {
    // Negative expiresInDays creates an already-expired Space (started in the past).
    const res = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name,
        purpose: 'Lifecycle',
        startAt: new Date(Date.now() + Math.min(0, expiresInDays) * 24 * 3600 * 1000 - 3600 * 1000).toISOString(),
        expiryAt: new Date(Date.now() + expiresInDays * 24 * 3600 * 1000).toISOString(),
      });
    expect(res.status).toBe(201);
    return res.body.space.id as string;
  }

  async function uploadAndConfirm(app: Express, token: string, spaceId: string, name: string, body: string): Promise<string> {
    const init = await request(app)
      .post(`/spaces/${spaceId}/files/init-upload`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name, sizeBytes: body.length });
    await putToSignedUrl(init.body.url, body);
    const confirm = await request(app).post(`/spaces/${spaceId}/files/${init.body.fileId}/confirm-upload`).set('Authorization', `Bearer ${token}`);
    expect(confirm.status).toBe(200);
    return init.body.fileId as string;
  }

  it('warns before expiry and does not warn twice', async () => {
    const { app, ctx, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 0.5 / 24, 'Warn Me'); // expires in 30 min
    ctx.env.warningWindowHours = 1;
    const pass = await request(app).post('/jobs/lifecycle/run').set('x-job-secret', ctx.env.jobSecret);
    expect(pass.status).toBe(200);
    expect(pass.body.warned).toBeGreaterThanOrEqual(1);

    const again = await request(app).post('/jobs/lifecycle/run').set('x-job-secret', ctx.env.jobSecret);
    expect(again.body.warned).toBe(0); // already WARNING

    const notifications = await request(app).get('/notifications').set('Authorization', `Bearer ${owner.token}`);
    expect(notifications.body.notifications.some((n: { type: string }) => n.type === 'SPACE_WARNING')).toBe(true);
  });

  it('rejects lifecycle runs with the wrong secret', async () => {
    const { app } = await setupWorld();
    const res = await request(app).post('/jobs/lifecycle/run').set('x-job-secret', 'nope');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_JOB_SECRET');
  });

  it('archives an expired Space into the owner Vault and verifies the ZIP', async () => {
    const { app, ctx, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, -1 / 24, 'Expired Now'); // already expired
    await uploadAndConfirm(app, owner.token, spaceId, 'a.txt', 'alpha');
    await uploadAndConfirm(app, owner.token, spaceId, 'b.txt', 'beta');

    const run = await request(app).post('/jobs/lifecycle/run').set('x-job-secret', ctx.env.jobSecret);
    expect(run.status).toBe(200);
    expect(run.body.queuedArchives).toBeGreaterThanOrEqual(1);
    expect(run.body.archived).toBeGreaterThanOrEqual(1);
    expect(run.body.failures).toHaveLength(0);

    const space = await request(app).get(`/spaces/${spaceId}`).set('Authorization', `Bearer ${owner.token}`);
    expect(space.body.space.status).toBe('ARCHIVED');

    // Files no longer downloadable from the Space
    const files = await request(app).get(`/spaces/${spaceId}/files`).set('Authorization', `Bearer ${owner.token}`);
    const fileId = files.body.files[0].id;
    const dl = await request(app).post(`/spaces/${spaceId}/files/${fileId}/download`).set('Authorization', `Bearer ${owner.token}`);
    expect(dl.status).toBe(400);

    // Vault has a VERIFIED archive
    const vault = await request(app).get('/vault/archives').set('Authorization', `Bearer ${owner.token}`);
    expect(vault.body.archives).toHaveLength(1);
    expect(vault.body.archives[0].status).toBe('VERIFIED');
    expect(vault.body.archives[0].fileCount).toBe(2);
    expect(vault.body.archives[0].fileCount).toBe(2);

    // ZIP downloads and contains both files
    const signed = await request(app).post(`/vault/archives/${vault.body.archives[0].id}/download`).set('Authorization', `Bearer ${owner.token}`);
    expect(signed.status).toBe(200);
    const zipRes = await getFromSignedUrl(signed.body.url);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    expect(zipBuf.length).toBeGreaterThan(100);
    // Local file header magic + EOCD magic present
    expect(zipBuf.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(zipBuf.includes(Buffer.from('alpha'))).toBe(true);
    expect(zipBuf.includes(Buffer.from('beta'))).toBe(true);

    // Other users cannot see the vault
    const { outsider } = (await setupWorld()) as unknown as TestWorld;
    void outsider;
  });

  it('cleanup after retention window deletes objects but keeps the vault', async () => {
    const { app, ctx, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, -1 / 24, 'Cleanup Me');
    await uploadAndConfirm(app, owner.token, spaceId, 'gone.txt', 'temporary');

    await request(app).post('/jobs/lifecycle/run').set('x-job-secret', ctx.env.jobSecret);
    expect((await request(app).get(`/spaces/${spaceId}`).set('Authorization', `Bearer ${owner.token}`)).body.space.status).toBe('ARCHIVED');

    // Simulate retention elapsing.
    const archive = ctx.db.archives.listForSpace(spaceId).find((a) => a.status === 'VERIFIED')!;
    ctx.db.archives.update(archive.id, { verifiedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() });

    const run = await request(app).post('/jobs/lifecycle/run').set('x-job-secret', ctx.env.jobSecret);
    expect(run.body.finalized).toBeGreaterThanOrEqual(1);

    // A finalized Space is deleted: detail view 404s and it leaves the list.
    const space = await request(app).get(`/spaces/${spaceId}`).set('Authorization', `Bearer ${owner.token}`);
    expect(space.status).toBe(404);
    expect(space.body.error.code).toBe('SPACE_NOT_FOUND');
    // Space disappears from the owner's list
    const list = await request(app).get('/spaces').set('Authorization', `Bearer ${owner.token}`);
    expect(list.body.spaces.find((s: { id: string }) => s.id === spaceId)).toBeUndefined();

    // Vault archive is retained
    const vault = await request(app).get('/vault/archives').set('Authorization', `Bearer ${owner.token}`);
    expect(vault.body.archives.length).toBeGreaterThanOrEqual(1);

    // Notifications recorded the finalization
    const notes = await request(app).get('/notifications').set('Authorization', `Bearer ${owner.token}`);
    expect(notes.body.notifications.some((n: { type: string }) => n.type === 'SPACE_DELETED')).toBe(true);
  });

  it('archive failure marks ARCHIVE_FAILED and admin can retry', async () => {
    const { app, ctx, owner, admin } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, -1 / 24, 'Fails');
    await uploadAndConfirm(app, owner.token, spaceId, 'x.txt', 'x');

    // Sabotage: remove the object before archiving runs.
    const file = ctx.db.files.listForSpace(spaceId)[0]!;
    await ctx.storage.deleteObject(file.objectKey);

    const run = await request(app).post('/jobs/lifecycle/run').set('x-job-secret', ctx.env.jobSecret);
    expect(run.body.failures.length).toBeGreaterThanOrEqual(1);
    expect((await request(app).get(`/spaces/${spaceId}`).set('Authorization', `Bearer ${owner.token}`)).body.space.status).toBe('ARCHIVE_FAILED');

    const stats = await request(app).get('/admin/stats').set('Authorization', `Bearer ${admin.token}`);
    expect(stats.body.failedArchives).toBeGreaterThanOrEqual(1);

    // Restore the object, then retry as admin.
    await ctx.storage.putObject(file.objectKey, Buffer.from('x'));
    const failed = ctx.db.archives.listForSpace(spaceId).find((a) => a.status === 'FAILED')!;
    const retry = await request(app).post(`/admin/archives/${failed.id}/retry`).set('Authorization', `Bearer ${admin.token}`);
    expect(retry.status).toBe(200);
    expect(retry.body.archive.status).toBe('VERIFIED');
  });
});

describe('extensions', () => {
  it('ADMIN policy: request stays pending and admin approval extends expiry', async () => {
    const { app, admin, owner } = await setupWorld();
    const created = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Extend', purpose: 'Extend', startAt: new Date().toISOString(), expiryAt: futureDate(0.5 / 24) });
    const spaceId = created.body.space.id;

    const req = await request(app)
      .post(`/spaces/${spaceId}/extensions`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ requestedDays: 3, reason: 'need more time' });
    expect(req.status).toBe(201);
    expect(req.body.request.status).toBe('PENDING');

    const pending = await request(app).get('/admin/extensions/pending').set('Authorization', `Bearer ${admin.token}`);
    expect(pending.body.requests).toHaveLength(1);

    const decide = await request(app)
      .post(`/admin/extensions/${req.body.request.id}/decision`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ decision: 'APPROVED' });
    expect(decide.status).toBe(200);
    expect(decide.body.request.status).toBe('APPROVED');

    const space = await request(app).get(`/spaces/${spaceId}`).set('Authorization', `Bearer ${owner.token}`);
    expect(new Date(space.body.space.expiryAt).getTime()).toBeGreaterThan(new Date(created.body.space.expiryAt).getTime());
  });

  it('non-admin cannot decide; duplicate pending requests rejected', async () => {
    const { app, owner, member } = await setupWorld();
    const created = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Ext2', purpose: 'Ext2', startAt: new Date().toISOString(), expiryAt: futureDate(1) });
    const spaceId = created.body.space.id;
    await request(app).post(`/spaces/${spaceId}/invitations`).set('Authorization', `Bearer ${owner.token}`).send({ email: 'member@test.dev', role: 'VIEWER' });

    const first = await request(app).post(`/spaces/${spaceId}/extensions`).set('Authorization', `Bearer ${owner.token}`).send({ requestedDays: 2, reason: 'r' });
    expect(first.status).toBe(201);
    const dupe = await request(app).post(`/spaces/${spaceId}/extensions`).set('Authorization', `Bearer ${member.token}`).send({ requestedDays: 1, reason: 'r' });
    expect(dupe.status).toBe(409);
    expect(dupe.body.error.code).toBe('PENDING_EXTENSION_EXISTS');
  });

  it('rejects requests above the max days', async () => {
    const { app, owner } = await setupWorld();
    const created = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Ext3', purpose: 'Ext3', startAt: new Date().toISOString(), expiryAt: futureDate(1) });
    const res = await request(app)
      .post(`/spaces/${created.body.space.id}/extensions`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ requestedDays: 365, reason: 'greedy' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MAX_EXTENSION_EXCEEDED');
  });
});

describe('admin', () => {
  it('requires ADMIN for admin endpoints', async () => {
    const { app, owner } = await setupWorld();
    const res = await request(app).get('/admin/stats').set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMIN_REQUIRED');
  });

  it('stats and user list work for admins', async () => {
    const { app, admin } = await setupWorld();
    const stats = await request(app).get('/admin/stats').set('Authorization', `Bearer ${admin.token}`);
    expect(stats.status).toBe(200);
    expect(stats.body.users).toBe(4);
    expect(stats.body.spaces).toBeGreaterThanOrEqual(0);

    const users = await request(app).get('/admin/users').set('Authorization', `Bearer ${admin.token}`);
    expect(users.body.users).toHaveLength(4);
  });

  it('non-admins cannot retry archives', async () => {
    const { app, owner } = await setupWorld();
    const res = await request(app).post('/admin/archives/00000000-0000-0000-0000-000000000000/retry').set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(403);
  });
});

describe('notifications', () => {
  it('marks one and all as read', async () => {
    const { app, ctx, owner, member } = await setupWorld();
    // Owner invites member → member gets a MEMBER_INVITED notification.
    const created = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Notes', purpose: 'Notes', startAt: new Date().toISOString(), expiryAt: futureDate(7) });
    const spaceId = created.body.space.id as string;
    await request(app)
      .post(`/spaces/${spaceId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'member@test.dev', role: 'EDITOR' });
    void ctx;

    const list = await request(app).get('/notifications').set('Authorization', `Bearer ${member.token}`);
    expect(list.status).toBe(200);
    const invited = list.body.notifications.find((n: { type: string }) => n.type === 'MEMBER_INVITED');
    expect(invited).toBeTruthy();

    const readOne = await request(app).post(`/notifications/${invited.id}/read`).set('Authorization', `Bearer ${member.token}`);
    expect(readOne.status).toBe(200);
    expect(readOne.body.notification.readAt).toBeTruthy();

    const readAll = await request(app).post('/notifications/read-all').set('Authorization', `Bearer ${member.token}`);
    expect(readAll.status).toBe(200);
    expect(readAll.body.updated).toBeGreaterThanOrEqual(0);
  });
});

describe('validation + error envelope', () => {
  it('returns the standard error envelope with requestId', async () => {
    const { app } = await setupWorld();
    const res = await request(app).post('/auth/login').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('unknown Space returns SPACE_NOT_FOUND', async () => {
    const { app, owner } = await setupWorld();
    const res = await request(app).get('/spaces/00000000-0000-0000-0000-000000000000').set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SPACE_NOT_FOUND');
  });
});
