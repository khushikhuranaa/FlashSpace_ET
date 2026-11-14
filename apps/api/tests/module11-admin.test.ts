import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../src/app.js';

/**
 * Module 11 — Admin control panel.
 *
 * The suite is data-layer agnostic (memory by default, SQLite with
 * TEST_REPO_MODE=sqlite) and uses isolated worlds: every describe block builds
 * its own app + database, so no test touches project data.
 */
const REPO_MODE = process.env.TEST_REPO_MODE === 'sqlite' ? 'sqlite' : 'memory';
const STORAGE_DIR = './data/test-admin-storage';

function repoOverrides(): Partial<import('../src/config/env.js').Env> {
  return REPO_MODE === 'sqlite'
    ? { repoMode: 'sqlite', sqliteFile: ':memory:' }
    : { repoMode: 'memory' };
}

interface World {
  app: Express;
  ctx: AppContext;
  admin: { token: string; id: string };
  owner: { token: string; id: string };
  member: { token: string; id: string };
}

async function register(app: Express, email: string, displayName: string) {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: 'password123', displayName });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, id: res.body.user.id as string };
}

async function setupWorld(): Promise<World> {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  const { app, ctx } = buildApp({ localStorageDir: STORAGE_DIR, ...repoOverrides() });
  const admin = await register(app, 'admin@admin.dev', 'Ada Admin');
  const owner = await register(app, 'owner@admin.dev', 'Olive Owner');
  const member = await register(app, 'member@admin.dev', 'Marty Member');
  return { app, ctx, admin, owner, member };
}

function futureDate(days: number): string {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

async function createSpace(app: Express, token: string, name: string, expiryDays = 7): Promise<string> {
  // An already-expired Space needs a start time in the past, otherwise the API
  // (correctly) rejects expiryAt <= startAt.
  const startAt =
    expiryDays <= 0
      ? new Date(Date.now() + expiryDays * 24 * 3600 * 1000 - 3600 * 1000).toISOString()
      : new Date().toISOString();
  const res = await request(app)
    .post('/spaces')
    .set('Authorization', `Bearer ${token}`)
    .send({ name, purpose: 'Admin test', startAt, expiryAt: futureDate(expiryDays) });
  expect(res.status).toBe(201);
  return res.body.space.id as string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

afterAll(() => {
  fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('admin: access control', () => {
  it('rejects unauthenticated callers', async () => {
    const { app } = await setupWorld();
    const res = await request(app).get('/admin/overview');
    expect(res.status).toBe(401);
  });

  it('rejects ordinary users and Space owners on every admin surface', async () => {
    const { app, owner, member } = await setupWorld();
    const spaceId = await createSpace(app, owner.token, 'Owned');

    const paths = [
      '/admin/overview',
      '/admin/health',
      '/admin/users',
      `/admin/users/${member.id}`,
      '/admin/jobs',
      '/admin/jobs/failed',
      '/admin/archives',
      '/admin/cleanup',
      '/admin/extensions',
      '/admin/audit',
      '/admin/security-events',
      '/admin/analytics',
      `/admin/users/${member.id}/suspend`,
      `/admin/users/${member.id}/role`,
    ];
    for (const p of paths) {
      const res = await request(app)
        .post(p)
        .set(auth(owner.token))
        .send({ role: 'ADMIN', confirm: true, reason: 'self escalation' });
      expect([403, 404, 405]).toContain(res.status);
      if (res.status === 403) expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    }

    // Space ownership grants nothing globally.
    const asMember = await request(app).get('/admin/overview').set(auth(member.token));
    expect(asMember.status).toBe(403);
    expect(spaceId).toBeTruthy();
  });
});

describe('admin: dashboard', () => {
  it('aggregates users, Spaces, storage and jobs from live rows', async () => {
    const { app, admin, owner } = await setupWorld();
    await createSpace(app, owner.token, 'Alpha', 5);
    await createSpace(app, owner.token, 'Beta', 20);

    const res = await request(app).get('/admin/overview').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.users.total).toBe(3);
    expect(res.body.users.admins).toBe(1);
    expect(res.body.users.suspended).toBe(0);
    expect(res.body.users.registeredLast7Days).toBe(3);
    expect(res.body.spaces.total).toBe(2);
    expect(res.body.spaces.active).toBe(2);
    expect(res.body.storage.temporaryBytes).toBe(0);
    expect(res.body.storage.vaultBytes).toBe(0);
    expect(res.body.jobs.total).toBe(0);
    expect(res.body.email.mode).toBe('mock');
    expect(res.body.email.configured).toBe(false);
  });

  it('counts Spaces by lifecycle state after a lifecycle pass', async () => {
    const { app, ctx, admin, owner } = await setupWorld();
    await createSpace(app, owner.token, 'Expiring', -1 / 24);
    await request(app).post('/jobs/lifecycle/run').set('x-job-secret', ctx.env.jobSecret);

    const res = await request(app).get('/admin/overview').set(auth(admin.token));
    expect(res.body.spaces.archived).toBeGreaterThanOrEqual(1);
    expect(res.body.jobs.total).toBeGreaterThanOrEqual(1);
    expect(res.body.jobs.succeeded).toBeGreaterThanOrEqual(1);
    expect(res.body.jobs.lastSuccessAt).toBeTruthy();
  });

  it('keeps the legacy /admin/stats shape working', async () => {
    const { app, admin } = await setupWorld();
    const res = await request(app).get('/admin/stats').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.users).toBe(3);
    expect(res.body.spacesByStatus).toBeTypeOf('object');
  });
});

describe('admin: health', () => {
  it('reports database and API health, and never claims mock email works', async () => {
    const { app, admin } = await setupWorld();
    const res = await request(app).get('/admin/health').set(auth(admin.token));
    expect(res.status).toBe(200);

    const byName = Object.fromEntries(
      res.body.checks.map((c: { name: string; status: string }) => [c.name, c.status]),
    );
    expect(byName.api).toBe('ok');
    expect(byName.database).toBe('ok');
    expect(byName.storage).toBe('ok');
    expect(byName.email).toBe('unconfigured');
    expect(byName.worker).toBe('unconfigured');
    expect(res.body.version).toContain('api@');
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('marks the worker degraded after repeated failures', async () => {
    const { app, ctx, admin, owner } = await setupWorld();
    const spaceId = await createSpace(app, owner.token, 'Failing');
    await ctx.db.jobs.insert({
      id: crypto.randomUUID(),
      jobType: 'ARCHIVE',
      spaceId,
      idempotencyKey: 'fail-1',
      status: 'FAILED',
      attempts: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: 'boom',
    });
    const res = await request(app).get('/admin/health').set(auth(admin.token));
    const worker = res.body.checks.find((c: { name: string }) => c.name === 'worker');
    expect(worker.status).toBe('degraded');
  });
});

describe('admin: user directory', () => {
  it('lists, searches, filters and paginates server-side', async () => {
    const { app, admin } = await setupWorld();
    for (let i = 0; i < 4; i++) {
      await register(app, `extra${i}@admin.dev`, `Extra ${i}`);
    }

    const all = await request(app).get('/admin/users?limit=2&offset=0').set(auth(admin.token));
    expect(all.status).toBe(200);
    expect(all.body.users).toHaveLength(2);
    expect(all.body.total).toBe(7);

    const page2 = await request(app).get('/admin/users?limit=2&offset=2').set(auth(admin.token));
    expect(page2.body.users[0].id).not.toBe(all.body.users[0].id);

    const search = await request(app).get('/admin/users?q=olive').set(auth(admin.token));
    expect(search.body.users).toHaveLength(1);
    expect(search.body.users[0].email).toBe('owner@admin.dev');

    const admins = await request(app).get('/admin/users?role=ADMIN').set(auth(admin.token));
    expect(admins.body.users.every((u: { role: string }) => u.role === 'ADMIN')).toBe(true);

    const byId = await request(app).get(`/admin/users?q=${all.body.users[0].id}`).set(auth(admin.token));
    expect(byId.body.users).toHaveLength(1);
  });

  it('never exposes credential material', async () => {
    const { app, admin } = await setupWorld();
    const res = await request(app).get('/admin/users').set(auth(admin.token));
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('password_hash');
  });

  it('returns user detail with ownership counts and activity', async () => {
    const { app, admin, owner } = await setupWorld();
    await createSpace(app, owner.token, 'Owned by owner');

    const res = await request(app).get(`/admin/users/${owner.id}`).set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(owner.id);
    expect(res.body.counts.spacesOwned).toBe(1);
    expect(Array.isArray(res.body.spacesOwned)).toBe(true);
    expect(res.body.counts.memberships).toBeGreaterThanOrEqual(1);
  });

  it('404s for an unknown user', async () => {
    const { app, admin } = await setupWorld();
    const res = await request(app)
      .get('/admin/users/00000000-0000-0000-0000-000000000000')
      .set(auth(admin.token));
    expect(res.status).toBe(404);
  });
});

describe('admin: role management', () => {
  it('requires explicit confirmation', async () => {
    const { app, admin, member } = await setupWorld();
    const res = await request(app)
      .post(`/admin/users/${member.id}/role`)
      .set(auth(admin.token))
      .send({ role: 'ADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('promotes and demotes, recording an audited before/after', async () => {
    const { app, admin, member } = await setupWorld();
    const promote = await request(app)
      .post(`/admin/users/${member.id}/role`)
      .set(auth(admin.token))
      .send({ role: 'ADMIN', confirm: true, reason: 'needs admin' });
    expect(promote.status).toBe(200);
    expect(promote.body.user.role).toBe('ADMIN');

    const audit = await request(app).get('/admin/audit?outlet=SECURITY').set(auth(admin.token));
    const entry = audit.body.entries.find(
      (e: { action: string; targetId: string }) =>
        e.action === 'SECURITY_ROLE_GRANTED' && e.targetId === member.id,
    );
    expect(entry).toBeTruthy();
    expect(entry.metadata.previousRole).toBe('USER');
    expect(entry.metadata.newRole).toBe('ADMIN');

    const demote = await request(app)
      .post(`/admin/users/${member.id}/role`)
      .set(auth(admin.token))
      .send({ role: 'USER', confirm: true });
    expect(demote.status).toBe(200);
    expect(demote.body.user.role).toBe('USER');
  });

  it('protects the last administrator', async () => {
    const { app, admin } = await setupWorld();
    const res = await request(app)
      .post(`/admin/users/${admin.id}/role`)
      .set(auth(admin.token))
      .send({ role: 'USER', confirm: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.code).toBe('LAST_ADMIN');
  });

  it('does not touch Space roles when the global role changes', async () => {
    const { app, ctx, admin, owner } = await setupWorld();
    const spaceId = await createSpace(app, owner.token, 'Role isolation');
    await request(app)
      .post(`/admin/users/${owner.id}/role`)
      .set(auth(admin.token))
      .send({ role: 'ADMIN', confirm: true });
    const membership = await ctx.db.members.find(spaceId, owner.id);
    expect(membership?.role).toBe('OWNER');
  });
});

describe('admin: suspension', () => {
  it('requires a reason and confirmation', async () => {
    const { app, admin, member } = await setupWorld();
    const noReason = await request(app)
      .post(`/admin/users/${member.id}/suspend`)
      .set(auth(admin.token))
      .send({ reason: 'no', confirm: true });
    expect(noReason.status).toBe(400);

    const noConfirm = await request(app)
      .post(`/admin/users/${member.id}/suspend`)
      .set(auth(admin.token))
      .send({ reason: 'spamming the platform' });
    expect(noConfirm.status).toBe(400);
  });

  it('blocks sign-in and existing sessions, then reactivates', async () => {
    const { app, admin, owner } = await setupWorld();
    const spaceId = await createSpace(app, owner.token, 'Survives suspension');

    const suspend = await request(app)
      .post(`/admin/users/${owner.id}/suspend`)
      .set(auth(admin.token))
      .send({ reason: 'abusive behaviour', confirm: true });
    expect(suspend.status).toBe(200);
    expect(suspend.body.user.status).toBe('SUSPENDED');

    // Existing bearer token stops working on the very next request.
    const me = await request(app).get('/auth/me').set(auth(owner.token));
    expect(me.status).toBeGreaterThanOrEqual(400);
    expect(me.body.error.code).toBe('ACCOUNT_SUSPENDED');

    // Sign-in is refused.
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@admin.dev', password: 'password123' });
    expect(login.status).toBeGreaterThanOrEqual(400);
    expect(login.body.error.code).toBe('ACCOUNT_SUSPENDED');

    // Data is preserved and ownership is not transferred.
    const detail = await request(app).get(`/admin/users/${owner.id}`).set(auth(admin.token));
    expect(detail.body.counts.spacesOwned).toBe(1);
    const space = await request(app).get(`/spaces/${spaceId}`).set(auth(admin.token));
    expect(space.status).toBe(200);

    const audit = await request(app).get('/admin/security-events').set(auth(admin.token));
    expect(
      audit.body.entries.some(
        (e: { action: string; targetId: string }) =>
          e.action === 'SECURITY_ACCOUNT_SUSPENDED' && e.targetId === owner.id,
      ),
    ).toBe(true);

    const reactivate = await request(app)
      .post(`/admin/users/${owner.id}/reactivate`)
      .set(auth(admin.token));
    expect(reactivate.status).toBe(200);
    expect(reactivate.body.user.status).toBe('ACTIVE');

    const relogin = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@admin.dev', password: 'password123' });
    expect(relogin.status).toBe(200);
  });

  it('cannot suspend yourself or the last admin', async () => {
    const { app, admin } = await setupWorld();
    const self = await request(app)
      .post(`/admin/users/${admin.id}/suspend`)
      .set(auth(admin.token))
      .send({ reason: 'testing self', confirm: true });
    expect(self.status).toBeGreaterThanOrEqual(400);
    expect(['INVALID_SUSPENSION', 'LAST_ADMIN']).toContain(self.body.error.code);
  });

  it('rejects suspending an already-suspended account', async () => {
    const { app, admin, member } = await setupWorld();
    await request(app)
      .post(`/admin/users/${member.id}/suspend`)
      .set(auth(admin.token))
      .send({ reason: 'first time', confirm: true });
    const again = await request(app)
      .post(`/admin/users/${member.id}/suspend`)
      .set(auth(admin.token))
      .send({ reason: 'second time', confirm: true });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.body.error.code).toBe('ALREADY_SUSPENDED');
  });
});

describe('admin: lifecycle jobs', () => {
  it('lists, filters and details jobs with retry eligibility', async () => {
    const { app, ctx, admin, owner } = await setupWorld();
    const spaceId = await createSpace(app, owner.token, 'Job space');
    await ctx.db.jobs.insert({
      id: crypto.randomUUID(),
      jobType: 'ARCHIVE',
      spaceId,
      idempotencyKey: 'job-filter-1',
      status: 'FAILED',
      attempts: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: 'disk full',
    });

    const all = await request(app).get('/admin/jobs').set(auth(admin.token));
    expect(all.status).toBe(200);
    expect(all.body.jobs).toHaveLength(1);
    expect(all.body.jobs[0].spaceName).toBe('Job space');
    expect(all.body.jobs[0].retryable).toBe(true);
    expect(all.body.jobs[0].maxAttempts).toBeGreaterThan(0);

    const filtered = await request(app).get('/admin/jobs?status=SUCCEEDED').set(auth(admin.token));
    expect(filtered.body.jobs).toHaveLength(0);

    const byType = await request(app).get('/admin/jobs?jobType=ARCHIVE').set(auth(admin.token));
    expect(byType.body.jobs).toHaveLength(1);

    const search = await request(app).get('/admin/jobs?q=job-filter-1').set(auth(admin.token));
    expect(search.body.jobs).toHaveLength(1);

    const detail = await request(app)
      .get(`/admin/jobs/${all.body.jobs[0].id}`)
      .set(auth(admin.token));
    expect(detail.status).toBe(200);
    expect(detail.body.job.id).toBe(all.body.jobs[0].id);
    expect(Array.isArray(detail.body.transitions)).toBe(true);
  });

  it('shows failed jobs and refuses to retry non-retryable ones', async () => {
    const { app, ctx, admin, owner } = await setupWorld();
    const spaceId = await createSpace(app, owner.token, 'Cleanup job');
    const jobId = crypto.randomUUID();
    await ctx.db.jobs.insert({
      id: jobId,
      jobType: 'CLEANUP',
      spaceId,
      idempotencyKey: 'cleanup-1',
      status: 'FAILED',
      attempts: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: 'nope',
    });

    const failed = await request(app).get('/admin/jobs/failed').set(auth(admin.token));
    expect(failed.body.jobs).toHaveLength(1);
    expect(failed.body.jobs[0].retryable).toBe(false);

    const retry = await request(app)
      .post(`/admin/jobs/${jobId}/retry`)
      .set(auth(admin.token));
    expect(retry.status).toBeGreaterThanOrEqual(400);
    expect(retry.body.error.code).toBe('JOB_NOT_RETRYABLE');
  });

  it('retries a failed archive job through the shared archive runner', async () => {
    const { app, ctx, admin, owner } = await setupWorld();
    const spaceId = await createSpace(app, owner.token, 'Retryable');

    // A real file whose object is present, so the archive runner can succeed.
    const now = new Date().toISOString();
    const objectKey = `spaces/${spaceId}/retry.txt`;
    await ctx.db.files.insert({
      id: crypto.randomUUID(),
      spaceId,
      folderId: null,
      uploaderId: owner.id,
      name: 'retry.txt',
      objectKey,
      mimeType: 'text/plain',
      sizeBytes: 5,
      etag: null,
      sha256: null,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    await ctx.storage.putObject(objectKey, Buffer.from('hello'));

    // A real archive row in FAILED state plus a matching failed job.
    const archiveId = crypto.randomUUID();
    await ctx.db.archives.insert({
      id: archiveId,
      spaceId,
      ownerId: owner.id,
      objectKey: `archives/${spaceId}.zip`,
      sizeBytes: 0,
      checksum: null,
      fileCount: 0,
      status: 'FAILED',
      createdAt: now,
      verifiedAt: null,
    });
    const jobId = crypto.randomUUID();
    await ctx.db.jobs.insert({
      id: jobId,
      jobType: 'ARCHIVE',
      spaceId,
      idempotencyKey: 'retry-archive-1',
      status: 'FAILED',
      attempts: 0,
      startedAt: now,
      finishedAt: now,
      error: 'transient',
    });

    const retry = await request(app).post(`/admin/jobs/${jobId}/retry`).set(auth(admin.token));
    expect(retry.status).toBe(200);
    expect(retry.body.job.status).toBe('SUCCEEDED');

    const audit = await request(app).get('/admin/audit?outlet=ADMIN').set(auth(admin.token));
    expect(audit.body.entries.some((e: { action: string }) => e.action === 'ARCHIVE_RETRIED')).toBe(true);
  });

  it('never overwrites a verified archive and blocks duplicate active jobs', async () => {
    const { app, ctx, admin, owner } = await setupWorld();
    const spaceId = await createSpace(app, owner.token, 'Verified exists');

    const failedId = crypto.randomUUID();
    await ctx.db.archives.insert({
      id: failedId,
      spaceId,
      ownerId: owner.id,
      objectKey: `archives/${failedId}.zip`,
      sizeBytes: 0,
      checksum: null,
      fileCount: 0,
      status: 'FAILED',
      createdAt: new Date().toISOString(),
      verifiedAt: null,
    });
    await ctx.db.archives.insert({
      id: crypto.randomUUID(),
      spaceId,
      ownerId: owner.id,
      objectKey: `archives/${spaceId}-verified.zip`,
      sizeBytes: 10,
      checksum: 'abc',
      fileCount: 1,
      status: 'VERIFIED',
      createdAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
    });

    const res = await request(app)
      .post(`/admin/archives/${failedId}/retry`)
      .set(auth(admin.token));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.code).toBe('ARCHIVE_ALREADY_VERIFIED');

    // With no verified archive but an active job, the retry is refused too.
    const other = crypto.randomUUID();
    const otherSpaceId = await createSpace(app, owner.token, 'Active job');
    await ctx.db.archives.insert({
      id: other,
      spaceId: otherSpaceId,
      ownerId: owner.id,
      objectKey: `archives/${other}.zip`,
      sizeBytes: 0,
      checksum: null,
      fileCount: 0,
      status: 'FAILED',
      createdAt: new Date().toISOString(),
      verifiedAt: null,
    });
    await ctx.db.jobs.insert({
      id: crypto.randomUUID(),
      jobType: 'ARCHIVE',
      spaceId: otherSpaceId,
      idempotencyKey: 'active-job-1',
      status: 'RUNNING',
      attempts: 1,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    });
    const dup = await request(app).post(`/admin/archives/${other}/retry`).set(auth(admin.token));
    expect(dup.status).toBeGreaterThanOrEqual(400);
    expect(dup.body.error.code).toBe('ARCHIVE_JOB_ACTIVE');
  });

  it('refuses retry of an archive that is not failed', async () => {
    const { app, ctx, admin, owner } = await setupWorld();
    const spaceId = await createSpace(app, owner.token, 'Verified only');
    const archiveId = crypto.randomUUID();
    await ctx.db.archives.insert({
      id: archiveId,
      spaceId,
      ownerId: owner.id,
      objectKey: 'archives/x.zip',
      sizeBytes: 1,
      checksum: 'c',
      fileCount: 1,
      status: 'VERIFIED',
      createdAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
    });
    const res = await request(app)
      .post(`/admin/archives/${archiveId}/retry`)
      .set(auth(admin.token));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.code).toBe('IDEMPOTENT_NOOP');
  });
});

describe('admin: cleanup + archives + extensions', () => {
  it('reports cleanup runs and Spaces awaiting cleanup', async () => {
    const { app, ctx, admin, owner } = await setupWorld();
    const spaceId = await createSpace(app, owner.token, 'Archived space', -1 / 24);
    await request(app).post('/jobs/lifecycle/run').set('x-job-secret', ctx.env.jobSecret);

    const res = await request(app).get('/admin/cleanup').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.runs)).toBe(true);
    expect(Array.isArray(res.body.awaiting)).toBe(true);
    expect(res.body.failed).toBe(0);
    expect(spaceId).toBeTruthy();
  });

  it('lists archives by status with Space names', async () => {
    const { app, admin, owner, ctx } = await setupWorld();
    const spaceId = await createSpace(app, owner.token, 'Archive list');
    await ctx.db.archives.insert({
      id: crypto.randomUUID(),
      spaceId,
      ownerId: owner.id,
      objectKey: 'archives/list.zip',
      sizeBytes: 42,
      checksum: 'abc',
      fileCount: 2,
      status: 'VERIFIED',
      createdAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
    });

    const all = await request(app).get('/admin/archives').set(auth(admin.token));
    expect(all.body.archives).toHaveLength(1);
    expect(all.body.archives[0].spaceName).toBe('Archive list');

    const verified = await request(app).get('/admin/archives?status=VERIFIED').set(auth(admin.token));
    expect(verified.body.archives).toHaveLength(1);
    const failed = await request(app).get('/admin/archives?status=FAILED').set(auth(admin.token));
    expect(failed.body.archives).toHaveLength(0);
  });

  it('lists extension requests and approves them through the existing service', async () => {
    const { app, admin, owner } = await setupWorld();
    const spaceId = await createSpace(app, owner.token, 'Extend me', 0.5 / 24);

    const requested = await request(app)
      .post(`/spaces/${spaceId}/extensions`)
      .set(auth(owner.token))
      .send({ requestedDays: 2, reason: 'still working' });
    expect(requested.status).toBe(201);

    const list = await request(app).get('/admin/extensions').set(auth(admin.token));
    expect(list.body.requests).toHaveLength(1);
    expect(list.body.requests[0].status).toBe('PENDING');

    const decision = await request(app)
      .post(`/admin/extensions/${requested.body.request.id}/decision`)
      .set(auth(admin.token))
      .send({ decision: 'APPROVED' });
    expect(decision.status).toBe(200);
    expect(decision.body.request.status).toBe('APPROVED');

    // Approval moves the persisted expiry forward.
    const space = await request(app).get(`/spaces/${spaceId}`).set(auth(owner.token));
    expect(new Date(space.body.space.expiryAt).getTime()).toBeGreaterThan(Date.now() + 24 * 3600 * 1000);

    const again = await request(app)
      .post(`/admin/extensions/${requested.body.request.id}/decision`)
      .set(auth(admin.token))
      .send({ decision: 'APPROVED' });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });
});

describe('admin: audit trail', () => {
  it('appends an entry for every user-detail view and is append-only over HTTP', async () => {
    const { app, admin, member } = await setupWorld();
    await request(app).get(`/admin/users/${member.id}`).set(auth(admin.token));

    const audit = await request(app).get('/admin/audit').set(auth(admin.token));
    expect(audit.status).toBe(200);
    expect(audit.body.total).toBeGreaterThanOrEqual(1);
    expect(audit.body.entries[0].adminName).toBe('Ada Admin');

    // No mutation routes exist for audit history.
    for (const method of ['put', 'patch', 'delete'] as const) {
      const res = await request(app)[method]('/admin/audit').set(auth(admin.token)).send({});
      expect(res.status).toBe(404);
    }
  });

  it('separates security events from operational audit entries', async () => {
    const { app, admin, member } = await setupWorld();
    await request(app)
      .post(`/admin/users/${member.id}/role`)
      .set(auth(admin.token))
      .send({ role: 'ADMIN', confirm: true });

    const security = await request(app).get('/admin/security-events').set(auth(admin.token));
    expect(security.status).toBe(200);
    expect(security.body.entries.every((e: { action: string }) => e.action.startsWith('SECURITY_'))).toBe(true);

    const adminOnly = await request(app).get('/admin/audit?outlet=ADMIN').set(auth(admin.token));
    expect(adminOnly.body.entries.every((e: { action: string }) => !e.action.startsWith('SECURITY_'))).toBe(true);
  });

  it('never records credentials in audit metadata', async () => {
    const { app, admin, member } = await setupWorld();
    await request(app)
      .post(`/admin/users/${member.id}/suspend`)
      .set(auth(admin.token))
      .send({ reason: 'policy violation', confirm: true });
    const res = await request(app).get('/admin/audit').set(auth(admin.token));
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('password');
    expect(body).not.toContain('token');
  });
});

describe('admin: analytics', () => {
  it('computes daily buckets from persisted rows', async () => {
    const { app, admin, owner } = await setupWorld();
    await createSpace(app, owner.token, 'Analytics space');

    const res = await request(app).get('/admin/analytics?days=7').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    expect(res.body.registrations).toHaveLength(7);
    expect(res.body.totals.registrations).toBe(3);
    expect(res.body.totals.spacesCreated).toBe(1);
    const total = res.body.registrations.reduce(
      (sum: number, b: { count: number }) => sum + b.count,
      0,
    );
    expect(total).toBe(3);
  });

  it('names metrics it cannot compute instead of inventing values', async () => {
    const { app, admin } = await setupWorld();
    const res = await request(app).get('/admin/analytics?days=3').set(auth(admin.token));
    expect(res.body.unavailable).toContain('storageGrowth');
    expect(res.body.storageGrowth).toBeUndefined();
  });

  it('clamps the requested window', async () => {
    const { app, admin } = await setupWorld();
    const res = await request(app).get('/admin/analytics?days=500').set(auth(admin.token));
    expect(res.body.days).toBe(90);
  });
});

describe('admin: regression', () => {
  it('keeps Space RBAC intact (VIEWER cannot manage members)', async () => {
    const { app, ctx, owner, member } = await setupWorld();
    const spaceId = await createSpace(app, owner.token, 'RBAC check');
    await ctx.db.members.insert({
      spaceId,
      userId: member.id,
      role: 'VIEWER',
      status: 'ACTIVE',
      joinedAt: new Date().toISOString(),
      revokedAt: null,
    });
    const res = await request(app)
      .patch(`/spaces/${spaceId}/members/${member.id}`)
      .set(auth(member.token))
      .send({ role: 'EDITOR' });
    expect(res.status).toBe(403);
  });

  it('keeps notifications and lifecycle behaviour working', async () => {
    const { app, ctx, owner } = await setupWorld();
    await createSpace(app, owner.token, 'Notify me', 0.5 / 24);
    ctx.env.warningWindowHours = 1;
    await request(app).post('/jobs/lifecycle/run').set('x-job-secret', ctx.env.jobSecret);

    const notes = await request(app).get('/notifications').set(auth(owner.token));
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.some((n: { type: string }) => n.type === 'SPACE_WARNING')).toBe(true);
  });

  it('serves the admin console only to admins after a suspension of another account', async () => {
    const { app, admin, member } = await setupWorld();
    await request(app)
      .post(`/admin/users/${member.id}/suspend`)
      .set(auth(admin.token))
      .send({ reason: 'regression check', confirm: true });

    const adminStillWorks = await request(app).get('/admin/overview').set(auth(admin.token));
    expect(adminStillWorks.status).toBe(200);
    expect(adminStillWorks.body.users.suspended).toBe(1);
    const suspendedAttempt = await request(app).get('/admin/overview').set(auth(member.token));
    expect(suspendedAttempt.status).toBeGreaterThanOrEqual(400);
  });
});
