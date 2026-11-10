import request from 'supertest';
import type { Express } from 'express';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../src/app.js';

/**
 * Integration tests for Smart Storage Insights + Duplicate Detection.
 * They run against the real app, real storage adapter (local filesystem) and
 * the in-memory data layer. Set TEST_REPO_MODE=sqlite to run the same suite
 * against SQLite.
 */
const REPO_MODE = process.env.TEST_REPO_MODE === 'sqlite' ? 'sqlite' : 'memory';
const stamp = Date.now();

interface World {
  app: Express;
  ctx: AppContext;
  owner: { token: string; id: string };
  outsider: { token: string; id: string };
}

let baseUrl = '';
const servers: import('node:http').Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function register(app: Express, email: string, displayName: string) {
  const res = await request(app).post('/auth/register').send({ email, password: 'password123', displayName });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, id: res.body.user.id as string };
}

async function setupWorld(name: string): Promise<World> {
  const { app, ctx } = buildApp({
    localStorageDir: `./data/test-smart-${stamp}-${name}`,
    ...(REPO_MODE === 'sqlite' ? { repoMode: 'sqlite' as const, sqliteFile: ':memory:' } : { repoMode: 'memory' as const }),
  });
  const http = await import('node:http');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  servers.push(server);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  ctx.env.signedUrlBase = `http://127.0.0.1:${port}`;
  baseUrl = ctx.env.signedUrlBase;

  const owner = await register(app, `owner-${name}@smart.dev`, 'Olive Owner');
  const outsider = await register(app, `outsider-${name}@smart.dev`, 'Ollie Outsider');
  return { app, ctx, owner, outsider };
}

const futureDate = (days: number): string => new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();

async function makeSpace(app: Express, token: string, name = 'Smart Space'): Promise<string> {
  const res = await request(app)
    .post('/spaces')
    .set('Authorization', `Bearer ${token}`)
    .send({ name, purpose: 'Smart storage', startAt: new Date(Date.now() - 3600_000).toISOString(), expiryAt: futureDate(7) });
  expect(res.status).toBe(201);
  return res.body.space.id as string;
}

async function upload(
  app: Express,
  token: string,
  spaceId: string,
  name: string,
  body: Buffer | string,
  folderId: string | null = null,
): Promise<string> {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const init = await request(app)
    .post(`/spaces/${spaceId}/files/init-upload`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name, mimeType: 'application/octet-stream', sizeBytes: buf.length, folderId });
  expect(init.status).toBe(201);
  const put = await fetch(new URL(init.body.url, baseUrl), { method: 'PUT', body: buf });
  expect(put.status).toBe(200);
  const confirm = await request(app)
    .post(`/spaces/${spaceId}/files/${init.body.fileId}/confirm-upload`)
    .set('Authorization', `Bearer ${token}`);
  expect(confirm.status).toBe(200);
  return init.body.fileId as string;
}

async function zipBytesFromVault(app: Express, token: string, archiveId: string): Promise<Buffer> {
  const signed = await request(app).post(`/vault/archives/${archiveId}/download`).set('Authorization', `Bearer ${token}`);
  expect(signed.status).toBe(200);
  const res = await fetch(new URL(signed.body.url, baseUrl));
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

describe('smart storage: duplicate detection', () => {
  it('detects identical content under different names as exact duplicates', async () => {
    const { app, owner } = await setupWorld('dupnames');
    const spaceId = await makeSpace(app, owner.token);
    const payload = Buffer.alloc(1000, 'A');
    await upload(app, owner.token, spaceId, 'report.txt', payload);
    await upload(app, owner.token, spaceId, 'copy-of-report.txt', payload);

    const scan = await request(app).post(`/spaces/${spaceId}/scans`).set('Authorization', `Bearer ${owner.token}`);
    expect(scan.status).toBe(201);
    const insights = scan.body.insights;
    expect(insights.duplicateGroupCount).toBe(1);
    expect(insights.exactDuplicates).toHaveLength(1);
    expect(insights.exactDuplicates[0].fileCount).toBe(2);
    expect(insights.exactDuplicates[0].extraCopyCount).toBe(1);
    expect(insights.potentialSavingsBytes).toBe(1000);
    // Identical content under different names is the same content hash.
    const names = insights.exactDuplicates[0].files.map((f: { name: string }) => f.name).sort();
    expect(names).toEqual(['copy-of-report.txt', 'report.txt']);
  });

  it('does NOT treat same-named files with different content as duplicates', async () => {
    const { app, owner } = await setupWorld('samename');
    const spaceId = await makeSpace(app, owner.token);
    await upload(app, owner.token, spaceId, 'report.pdf', Buffer.alloc(500, 'x'));
    await upload(app, owner.token, spaceId, 'report.pdf', Buffer.alloc(500, 'y'));

    const scan = await request(app).post(`/spaces/${spaceId}/scans`).set('Authorization', `Bearer ${owner.token}`);
    expect(scan.status).toBe(201);
    expect(scan.body.insights.duplicateGroupCount).toBe(0);
    expect(scan.body.insights.potentialSavingsBytes).toBe(0);
    // Same name, different bytes → possible version, never an exact duplicate.
    expect(scan.body.insights.nearDuplicates.length).toBeGreaterThanOrEqual(1);
  });

  it('computes extra copies and savings correctly for three identical files', async () => {
    const { app, owner } = await setupWorld('three');
    const spaceId = await makeSpace(app, owner.token);
    const payload = Buffer.alloc(2 * 1024 * 1024, 'z'); // 2 MB
    await upload(app, owner.token, spaceId, 'a.bin', payload);
    await upload(app, owner.token, spaceId, 'b.bin', payload);
    await upload(app, owner.token, spaceId, 'c.bin', payload);

    const scan = await request(app).post(`/spaces/${spaceId}/scans`).set('Authorization', `Bearer ${owner.token}`);
    const insights = scan.body.insights;
    expect(insights.duplicateGroupCount).toBe(1);
    expect(insights.exactDuplicates[0].fileCount).toBe(3);
    expect(insights.exactDuplicates[0].extraCopyCount).toBe(2);
    expect(insights.exactDuplicates[0].potentialSavingsBytes).toBe(4 * 1024 * 1024);
    expect(insights.potentialSavingsBytes).toBe(4 * 1024 * 1024);
    expect(insights.totalFiles).toBe(3);
    expect(insights.totalBytes).toBe(6 * 1024 * 1024);
  });

  it('reports a failed scan with no fabricated duplicate results', async () => {
    const { app, ctx, owner } = await setupWorld('failscan');
    const spaceId = await makeSpace(app, owner.token);
    await upload(app, owner.token, spaceId, 'only.txt', 'hello');
    // Sabotage the stored object so nothing can be hashed.
    const file = ctx.db.files.listActiveForSpace(spaceId)[0]!;
    await ctx.storage.deleteObject(file.objectKey);

    const scan = await request(app).post(`/spaces/${spaceId}/scans`).set('Authorization', `Bearer ${owner.token}`);
    expect(scan.status).toBe(201);
    expect(scan.body.insights.scan.status).toBe('FAILED');
    expect(scan.body.insights.duplicateGroupCount).toBe(0);
    expect(scan.body.insights.exactDuplicates).toHaveLength(0);
    expect(scan.body.insights.unscannedFiles.length).toBeGreaterThanOrEqual(1);
    expect(scan.body.insights.scan.errorMessage).toBeTruthy();
  });

  it('returns an empty report (not fake data) before any scan runs', async () => {
    const { app, owner } = await setupWorld('noscans');
    const spaceId = await makeSpace(app, owner.token);
    await upload(app, owner.token, spaceId, 'x.txt', 'x');

    const res = await request(app).get(`/spaces/${spaceId}/insights`).set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.body.insights.scan.status).toBe('PENDING');
    expect(res.body.insights.duplicateGroupCount).toBe(0);
    expect(res.body.insights.totalFiles).toBe(1);
  });
});

describe('smart storage: archive plans', () => {
  it('defaults to a full archive that includes duplicates and real content', async () => {
    const { app, owner } = await setupWorld('full');
    const spaceId = await makeSpace(app, owner.token);
    const dup = Buffer.from('duplicate-payload');
    await upload(app, owner.token, spaceId, 'alpha.txt', dup);
    await upload(app, owner.token, spaceId, 'alpha-copy.txt', dup);
    await upload(app, owner.token, spaceId, 'beta.txt', 'unique-beta');

    const scan = await request(app).post(`/spaces/${spaceId}/scans`).set('Authorization', `Bearer ${owner.token}`);
    expect(scan.body.insights.duplicateGroupCount).toBe(1);

    // No exclusions → full archive.
    const plan = await request(app)
      .post(`/spaces/${spaceId}/plans`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ scanId: scan.body.insights.scan.id, excludedFileIds: [], explained: true });
    expect(plan.status).toBe(201);
    expect(plan.body.plan.willArchiveFileCount).toBe(3);
    expect(plan.body.plan.willExcludeFileCount).toBe(0);

    const confirm = await request(app).post(`/plans/${plan.body.plan.id}/confirm`).set('Authorization', `Bearer ${owner.token}`);
    expect(confirm.status).toBe(200);
    expect(confirm.body.plan.status).toBe('VERIFIED');
    expect(confirm.body.archiveJob.status).toBe('SUCCEEDED');

    // Space is archived only after the verified archive exists.
    const detail = await request(app).get(`/spaces/${spaceId}`).set('Authorization', `Bearer ${owner.token}`);
    expect(detail.body.space.status).toBe('ARCHIVED');

    const vault = await request(app).get('/vault/archives').set('Authorization', `Bearer ${owner.token}`);
    const archive = vault.body.archives.find((a: { spaceId: string }) => a.spaceId === spaceId);
    expect(archive).toBeTruthy();
    expect(archive.status).toBe('VERIFIED');
    expect(archive.fileCount).toBe(3);

    // ZIP has real bytes, all three entries (duplicates included), and is readable.
    const zip = await zipBytesFromVault(app, owner.token, archive.id);
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304'); // local file header
    expect(zip.subarray(zip.length - 22, zip.length - 18).toString('hex')).toBe('504b0506'); // EOCD
    expect(zip.includes(Buffer.from('alpha-copy.txt'))).toBe(true);
    expect(zip.includes(Buffer.from('alpha.txt'))).toBe(true);
    expect(zip.includes(Buffer.from('beta.txt'))).toBe(true);
    expect(zip.includes(dup)).toBe(true);
    expect(zip.includes(Buffer.from('unique-beta'))).toBe(true);
  });

  it('preserves nested folders, real bytes and scan paths in the archive', async () => {
    const { app, owner } = await setupWorld('folders');
    const spaceId = await makeSpace(app, owner.token);

    const docs = await request(app)
      .post(`/spaces/${spaceId}/folders`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'docs' });
    expect(docs.status).toBe(201);
    expect(docs.body.folder.path).toBe('docs/');

    const reports = await request(app)
      .post(`/spaces/${spaceId}/folders`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'reports', parentId: docs.body.folder.id });
    expect(reports.status).toBe(201);
    expect(reports.body.folder.path).toBe('docs/reports/');

    const payload = Buffer.from('nested-payload');
    await upload(app, owner.token, spaceId, 'root.txt', 'root-file');
    await upload(app, owner.token, spaceId, 'summary.txt', payload, reports.body.folder.id);
    // Same name + same content in a different folder: duplicates, distinct paths.
    await upload(app, owner.token, spaceId, 'summary.txt', payload, docs.body.folder.id);

    const scan = await request(app).post(`/spaces/${spaceId}/scans`).set('Authorization', `Bearer ${owner.token}`);
    expect(scan.status).toBe(201);
    const group = scan.body.insights.exactDuplicates[0];
    expect(group.fileCount).toBe(2);
    const paths = group.files.map((f: { path: string }) => f.path).sort();
    expect(paths).toEqual(['docs/reports/summary.txt', 'docs/summary.txt']);
    // Reported paths come from actual folder rows, not filenames alone.
    expect(group.files.some((f: { path: string }) => f.path.startsWith('docs/'))).toBe(true);

    const plan = await request(app)
      .post(`/spaces/${spaceId}/plans`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ excludedFileIds: [], explained: true });
    expect(plan.status).toBe(201);
    expect(plan.body.plan.willArchiveFileCount).toBe(3);
    const confirm = await request(app).post(`/plans/${plan.body.plan.id}/confirm`).set('Authorization', `Bearer ${owner.token}`);
    expect(confirm.status).toBe(200);

    const vault = await request(app).get('/vault/archives').set('Authorization', `Bearer ${owner.token}`);
    const archive = vault.body.archives.find((a: { spaceId: string }) => a.spaceId === spaceId);
    const zip = await zipBytesFromVault(app, owner.token, archive.id);

    // Nested entry names are preserved and every file's bytes are present.
    expect(zip.includes(Buffer.from('docs/reports/summary.txt'))).toBe(true);
    expect(zip.includes(Buffer.from('docs/summary.txt'))).toBe(true);
    expect(zip.includes(Buffer.from('root.txt'))).toBe(true);
    expect(zip.includes(payload)).toBe(true);
    expect(zip.includes(Buffer.from('root-file'))).toBe(true);
    // Both same-named entries survive (no silent overwrite inside the ZIP).
    const text = zip.toString('latin1');
    expect(text.split('docs/reports/summary.txt').length - 1).toBeGreaterThanOrEqual(1);
    expect(text.split('docs/summary.txt').length - 1).toBeGreaterThanOrEqual(1);
  });

  it('honours explicit exclusions in a selective archive', async () => {
    const { app, ctx, owner } = await setupWorld('selective');
    const spaceId = await makeSpace(app, owner.token);
    const keep = await upload(app, owner.token, spaceId, 'keep.txt', 'keep-me');
    const drop = await upload(app, owner.token, spaceId, 'drop.txt', 'drop-me');

    const scan = await request(app).post(`/spaces/${spaceId}/scans`).set('Authorization', `Bearer ${owner.token}`);

    const plan = await request(app)
      .post(`/spaces/${spaceId}/plans`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ scanId: scan.body.insights.scan.id, excludedFileIds: [drop], explained: true });
    expect(plan.status).toBe(201);
    expect(plan.body.plan.willArchiveFileCount).toBe(1);
    expect(plan.body.plan.willExcludeFileCount).toBe(1);
    expect(plan.body.plan.willExcludeBytes).toBe(Buffer.byteLength('drop-me'));

    const confirm = await request(app).post(`/plans/${plan.body.plan.id}/confirm`).set('Authorization', `Bearer ${owner.token}`);
    expect(confirm.status).toBe(200);

    const vault = await request(app).get('/vault/archives').set('Authorization', `Bearer ${owner.token}`);
    const archive = vault.body.archives.find((a: { spaceId: string }) => a.spaceId === spaceId);
    const zip = await zipBytesFromVault(app, owner.token, archive.id);
    expect(zip.includes(Buffer.from('keep.txt'))).toBe(true);
    expect(zip.includes(Buffer.from('drop.txt'))).toBe(false);
    expect(zip.includes(Buffer.from('drop-me'))).toBe(false);
    // The excluded file stays in storage — exclusion is not deletion.
    expect(ctx.db.files.findById(drop)?.status).toBe('ACTIVE');
    void keep;
  });

  it('refuses to confirm without an explicit acknowledgement', async () => {
    const { app, owner } = await setupWorld('noack');
    const spaceId = await makeSpace(app, owner.token);
    await upload(app, owner.token, spaceId, 'x.txt', 'x');
    const plan = await request(app)
      .post(`/spaces/${spaceId}/plans`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ excludedFileIds: [], explained: false });
    expect(plan.status).toBe(201);
    const confirm = await request(app).post(`/plans/${plan.body.plan.id}/confirm`).set('Authorization', `Bearer ${owner.token}`);
    expect(confirm.status).toBe(400);
  });

  it('keeps the Space and files intact when archive creation fails', async () => {
    const { app, ctx, owner } = await setupWorld('failarchive');
    const spaceId = await makeSpace(app, owner.token);
    await upload(app, owner.token, spaceId, 'boom.txt', 'boom');
    const file = ctx.db.files.listActiveForSpace(spaceId)[0]!;

    const plan = await request(app)
      .post(`/spaces/${spaceId}/plans`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ excludedFileIds: [], explained: true });
    expect(plan.status).toBe(201);

    // Sabotage the object AFTER the plan is created but before confirmation.
    await ctx.storage.deleteObject(file.objectKey);

    const confirm = await request(app).post(`/plans/${plan.body.plan.id}/confirm`).set('Authorization', `Bearer ${owner.token}`);
    expect(confirm.status).toBe(500);

    const detail = await request(app).get(`/spaces/${spaceId}`).set('Authorization', `Bearer ${owner.token}`);
    expect(detail.body.space.status).not.toBe('ARCHIVED');
    expect(detail.body.space.status).not.toBe('DELETED');
    // File row is preserved (not deleted).
    expect(ctx.db.files.findById(file.id)?.status).toBe('ACTIVE');
    // Plan + job recorded as failed so they can be retried.
    const review = await request(app).get(`/plans/${plan.body.plan.id}`).set('Authorization', `Bearer ${owner.token}`);
    expect(review.body.plan.status).toBe('FAILED');
    expect(review.body.archiveJob.status).toBe('FAILED');
    expect(review.body.plan.errorMessage).toBeTruthy();

    // Retryable: once the object is readable again an admin retry succeeds and
    // produces exactly one archive for the Space.
    await ctx.storage.putObject(file.objectKey, Buffer.from('boom'));
    const retried = await request(app)
      .post(`/plans/${plan.body.plan.id}/retry`)
      .set('Authorization', `Bearer ${owner.token}`);
    // The first registered user in this world is the ADMIN.
    expect(retried.status).toBe(200);
    expect(retried.body.plan.status).toBe('VERIFIED');
    expect(retried.body.archiveJob.status).toBe('SUCCEEDED');
    const archives = await request(app).get('/vault/archives').set('Authorization', `Bearer ${owner.token}`);
    expect(archives.body.archives.filter((a: { spaceId: string }) => a.spaceId === spaceId)).toHaveLength(1);
  });
});

describe('smart storage: authorization', () => {
  it('outsiders cannot scan, plan or archive another Space', async () => {
    const { app, owner, outsider } = await setupWorld('authz');
    const spaceId = await makeSpace(app, owner.token);
    await upload(app, owner.token, spaceId, 'secret.txt', 'secret');

    const scan = await request(app).post(`/spaces/${spaceId}/scans`).set('Authorization', `Bearer ${outsider.token}`);
    expect(scan.status).toBe(403);

    const insights = await request(app).get(`/spaces/${spaceId}/insights`).set('Authorization', `Bearer ${outsider.token}`);
    expect(insights.status).toBe(403);

    const plan = await request(app)
      .post(`/spaces/${spaceId}/plans`)
      .set('Authorization', `Bearer ${outsider.token}`)
      .send({ excludedFileIds: [], explained: true });
    expect(plan.status).toBe(403);

    // A real plan created by the owner cannot be confirmed by an outsider.
    const ownerPlan = await request(app)
      .post(`/spaces/${spaceId}/plans`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ excludedFileIds: [], explained: true });
    expect(ownerPlan.status).toBe(201);

    const confirm = await request(app).post(`/plans/${ownerPlan.body.plan.id}/confirm`).set('Authorization', `Bearer ${outsider.token}`);
    expect(confirm.status).toBe(403);

    const review = await request(app).get(`/plans/${ownerPlan.body.plan.id}`).set('Authorization', `Bearer ${outsider.token}`);
    expect(review.status).toBe(403);
  });

  it('requires authentication for every insights endpoint', async () => {
    const { app, owner } = await setupWorld('authn');
    const spaceId = await makeSpace(app, owner.token);
    for (const path of [`/spaces/${spaceId}/insights`, `/spaces/${spaceId}/duplicates`, `/spaces/${spaceId}/plans`]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
    }
  });
});

describe('smart storage: expiry reminders', () => {
  it('sends the reminder once and records warningSentAt', async () => {
    const { app, ctx, owner } = await setupWorld('reminder');
    const created = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        name: 'Expiring',
        purpose: 'Reminder',
        startAt: new Date(Date.now() - 3600_000).toISOString(),
        expiryAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
    const spaceId = created.body.space.id;
    ctx.env.warningWindowHours = 1;

    const first = await request(app).post('/jobs/lifecycle/run').set('x-job-secret', ctx.env.jobSecret);
    expect(first.body.warned).toBeGreaterThanOrEqual(1);

    const second = await request(app).post('/jobs/lifecycle/run').set('x-job-secret', ctx.env.jobSecret);
    expect(second.body.warned).toBe(0);

    const space = ctx.db.spaces.findById(spaceId);
    expect(space?.warningSentAt).toBeTruthy();
    expect(space?.status).toBe('WARNING');

    const notes = await request(app).get('/notifications').set('Authorization', `Bearer ${owner.token}`);
    const reminders = notes.body.notifications.filter((n: { type: string; spaceId: string }) => n.type === 'SPACE_WARNING' && n.spaceId === spaceId);
    expect(reminders).toHaveLength(1);
  });
});
