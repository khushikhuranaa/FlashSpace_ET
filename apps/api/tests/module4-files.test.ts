import request from 'supertest';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { buildApp, type AppContext } from '../src/app.js';
import type { Env } from '../src/config/env.js';

/**
 * Module 4 — file & folder management.
 *
 * These tests drive the real upload protocol (init-upload → signed PUT →
 * confirm), then exercise browsing, previews, metadata, moves, restore, bulk
 * actions and folder operations. Local storage + in-memory/SQLite repositories
 * are the same ones the app uses; nothing is mocked at the service boundary.
 */

const REPO_MODE = process.env.TEST_REPO_MODE === 'sqlite' ? 'sqlite' : 'memory';

function repoOverrides(): Partial<Env> {
  return REPO_MODE === 'sqlite'
    ? { repoMode: 'sqlite', sqliteFile: ':memory:' }
    : { repoMode: 'memory' };
}

const DAY = 86_400_000;
const servers: http.Server[] = [];
let baseUrl = '';

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

interface Actor {
  token: string;
  id: string;
}

interface World {
  app: Express;
  ctx: AppContext;
  owner: Actor;
  editor: Actor;
  viewer: Actor;
  outsider: Actor;
  spaceId: string;
  otherSpaceId: string;
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function wire(app: Express, ctx: AppContext): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  servers.push(server);
  const address = server.address();
  ctx.env.signedUrlBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  baseUrl = ctx.env.signedUrlBase;
}

async function register(app: Express, email: string, displayName: string): Promise<Actor> {
  const res = await request(app).post('/auth/register').send({ email, password: 'password123', displayName });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, id: res.body.user.id as string };
}

async function createSpace(world: World, token: string, name: string): Promise<string> {
  const res = await request(world.app)
    .post('/spaces')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name,
      purpose: 'Project Collaboration',
      startAt: iso(-DAY),
      expiryAt: iso(7 * DAY),
    });
  expect(res.status).toBe(201);
  return res.body.space.id as string;
}

async function createFolder(world: World, token: string, spaceId: string, name: string, parentId: string | null = null) {
  const res = await request(world.app)
    .post(`/spaces/${spaceId}/folders`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name, parentId });
  expect(res.status).toBe(201);
  return res.body.folder as { id: string; path: string };
}

async function upload(
  world: World,
  token: string,
  spaceId: string,
  file: { name: string; mimeType?: string; body: string | Buffer; folderId?: string | null },
): Promise<{ id: string; objectKey: string }> {
  const bytes = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body);
  const init = await request(world.app)
    .post(`/spaces/${spaceId}/files/init-upload`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: file.name,
      mimeType: file.mimeType ?? 'text/plain',
      sizeBytes: bytes.length,
      folderId: file.folderId ?? null,
    });
  expect(init.status).toBe(201);
  const put = await fetch(new URL(init.body.url as string, baseUrl), { method: 'PUT', body: bytes });
  expect(put.status).toBe(200);
  const confirm = await request(world.app)
    .post(`/spaces/${spaceId}/files/${init.body.fileId}/confirm-upload`)
    .set('Authorization', `Bearer ${token}`);
  expect(confirm.status).toBe(200);
  return confirm.body.file as { id: string; objectKey: string };
}

async function setupWorld(options: Partial<Env> = {}): Promise<World> {
  const { app, ctx } = buildApp({ localStorageDir: './data/test-storage-m4', ...repoOverrides(), ...options });
  await wire(app, ctx);
  const owner = await register(app, `owner.m4${Math.random().toString(36).slice(2, 7)}@test.dev`, 'Olive Owner');
  const editor = await register(app, `editor.m4${Math.random().toString(36).slice(2, 7)}@test.dev`, 'Eddie Editor');
  const viewer = await register(app, `viewer.m4${Math.random().toString(36).slice(2, 7)}@test.dev`, 'Vera Viewer');
  const outsider = await register(app, `out.m4${Math.random().toString(36).slice(2, 7)}@test.dev`, 'Out Sider');

  const world: World = { app, ctx, owner, editor, viewer, outsider, spaceId: '', otherSpaceId: '' };
  world.spaceId = await createSpace(world, owner.token, 'Files Main');
  world.otherSpaceId = await createSpace(world, owner.token, 'Files Other');

  // Membership rows are seeded directly so these tests do not depend on the
  // invitation email flow (covered by its own suite).
  for (const [actor, role] of [
    [editor, 'EDITOR'],
    [viewer, 'VIEWER'],
  ] as const) {
    await ctx.db.members.insert({
      spaceId: world.spaceId,
      userId: actor.id,
      role,
      status: 'ACTIVE',
      joinedAt: new Date().toISOString(),
      revokedAt: null,
    });
  }
  return world;
}

function binaryParser(res: NodeJS.ReadableStream, callback: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('Module 4 — file and folder management', () => {
  let world: World;

  beforeAll(async () => {
    world = await setupWorld();
  });

  describe('upload and integrity', () => {
    it('uploads, confirms and records a checksum', async () => {
      const file = await upload(world, world.owner.token, world.spaceId, { name: 'notes.txt', body: 'hello world' });
      const details = await request(world.app)
        .get(`/spaces/${world.spaceId}/files/${file.id}`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(details.status).toBe(200);
      expect(details.body.file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(details.body.file.storageStatus).toBe('PRESENT');
      expect(details.body.file.previewKind).toBe('text');
      expect(details.body.file.uploaderName).toBe('Olive Owner');
    });

    it('rejects blocked file types and MIME spoofing', async () => {
      const blocked = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/init-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'payload.exe', mimeType: 'application/octet-stream', sizeBytes: 10 });
      expect(blocked.status).toBe(400);
      expect(blocked.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');

      const spoofed = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/init-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'fake.png', mimeType: 'image/png', sizeBytes: 11 });
      expect(spoofed.status).toBe(201);
      const put = await fetch(new URL(spoofed.body.url as string, baseUrl), {
        method: 'PUT',
        body: Buffer.from('not-a-png!!'),
      });
      expect(put.status).toBe(200);
      const confirm = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/${spoofed.body.fileId}/confirm-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(confirm.status).toBe(400);
      expect(confirm.body.error.code).toBe('MIME_MISMATCH');

      const list = await request(world.app)
        .get(`/spaces/${world.spaceId}/files`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      const ids = (list.body.files as { id: string }[]).map((f) => f.id);
      expect(ids).not.toContain(spoofed.body.fileId);
    });

    it('does not signature-check generic binary MIME types', async () => {
      // A legitimate generic upload (application/octet-stream) with a .bin
      // extension must be accepted even though we cannot verify a magic number.
      // The blocked-extension list is the only extension-based check.
      const generic = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/init-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'data.bin', mimeType: 'application/octet-stream', sizeBytes: 8 });
      expect(generic.status).toBe(201);
      const put = await fetch(new URL(generic.body.url as string, baseUrl), {
        method: 'PUT',
        body: Buffer.from('\x00\x01\x02\x03\x04\x05\x06\x07'),
      });
      expect(put.status).toBe(200);
      const confirm = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/${generic.body.fileId}/confirm-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(confirm.status).toBe(200);
      expect(confirm.body.file.status).toBe('ACTIVE');
    });

    it('does not infer a signature from the filename extension alone', async () => {
      // Upload a real PNG as application/octet-stream: the extension is .png
      // but the declared MIME is generic, so no signature check runs and the
      // upload is accepted. Naming a file .png does not make it an image.
      const pngBytes = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('fake-png-body'),
      ]);
      const init = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/init-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'photo.png', mimeType: 'application/octet-stream', sizeBytes: pngBytes.length });
      expect(init.status).toBe(201);
      const put = await fetch(new URL(init.body.url as string, baseUrl), {
        method: 'PUT',
        body: pngBytes,
      });
      expect(put.status).toBe(200);
      const confirm = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/${init.body.fileId}/confirm-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(confirm.status).toBe(200);
      expect(confirm.body.file.status).toBe('ACTIVE');
      // It is still classified as an image by the type bucket because of the
      // extension, but no signature verification was performed.
      const listed = await request(world.app)
        .get(`/spaces/${world.spaceId}/files/${init.body.fileId}`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(listed.body.file.previewKind).toBe('image');
    });

    it('catches a spoofed PDF declared as application/pdf', async () => {
      // A caller that declares application/pdf but uploads random bytes must be
      // rejected, because application/pdf triggers a PDF signature check.
      const init = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/init-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'doc.pdf', mimeType: 'application/pdf', sizeBytes: 12 });
      expect(init.status).toBe(201);
      const put = await fetch(new URL(init.body.url as string, baseUrl), {
        method: 'PUT',
        body: Buffer.from('not-a-pdf!!'),
      });
      expect(put.status).toBe(200);
      const confirm = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/${init.body.fileId}/confirm-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(confirm.status).toBe(400);
      expect(confirm.body.error.code).toBe('MIME_MISMATCH');
    });

    it('catches a spoofed ZIP declared as application/zip', async () => {
      const init = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/init-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'archive.zip', mimeType: 'application/zip', sizeBytes: 6 });
      expect(init.status).toBe(201);
      const put = await fetch(new URL(init.body.url as string, baseUrl), {
        method: 'PUT',
        body: Buffer.from('nope!!!'),
      });
      expect(put.status).toBe(200);
      const confirm = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/${init.body.fileId}/confirm-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(confirm.status).toBe(400);
      expect(confirm.body.error.code).toBe('MIME_MISMATCH');
    });

    it('accepts a correctly-signed PNG declared as image/png', async () => {
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('minimal-png'),
      ]);
      const init = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/init-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'real.png', mimeType: 'image/png', sizeBytes: png.length });
      expect(init.status).toBe(201);
      const put = await fetch(new URL(init.body.url as string, baseUrl), {
        method: 'PUT',
        body: png,
      });
      expect(put.status).toBe(200);
      const confirm = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/${init.body.fileId}/confirm-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(confirm.status).toBe(200);
      expect(confirm.body.file.status).toBe('ACTIVE');
    });

    it('accepts a correctly-signed PDF declared as application/pdf', async () => {
      const pdf = Buffer.concat([
        Buffer.from('%PDF-1.4\n'),
        Buffer.from('fake-pdf-body'),
      ]);
      const init = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/init-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'real.pdf', mimeType: 'application/pdf', sizeBytes: pdf.length });
      expect(init.status).toBe(201);
      const put = await fetch(new URL(init.body.url as string, baseUrl), {
        method: 'PUT',
        body: pdf,
      });
      expect(put.status).toBe(200);
      const confirm = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/${init.body.fileId}/confirm-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(confirm.status).toBe(200);
      expect(confirm.body.file.status).toBe('ACTIVE');
    });

    it('rejects a blocked extension regardless of declared MIME', async () => {
      // Even if the caller declares a safe MIME, a blocked extension must be
      // rejected at init-upload time (before any storage operation).
      const badExt = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/init-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'installer.exe', mimeType: 'application/pdf', sizeBytes: 4 });
      expect(badExt.status).toBe(400);
      expect(badExt.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
    });

    it('cancels an unconfirmed upload and refuses to cancel a confirmed one', async () => {
      const init = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/init-upload`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'draft.txt', mimeType: 'text/plain', sizeBytes: 5 });
      expect(init.status).toBe(201);
      await fetch(new URL(init.body.url as string, baseUrl), { method: 'PUT', body: 'draft' });

      const cancel = await request(world.app)
        .delete(`/spaces/${world.spaceId}/files/${init.body.fileId}/upload`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(cancel.status).toBe(204);
      const stored = await world.ctx.db.files.findById(init.body.fileId);
      expect(stored?.status).toBe('DELETED');

      const active = await upload(world, world.owner.token, world.spaceId, { name: 'settled.txt', body: 'done' });
      const lateCancel = await request(world.app)
        .delete(`/spaces/${world.spaceId}/files/${active.id}/upload`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(lateCancel.status).toBe(400);
    });

    it('enforces quota against reserved uploads', async () => {
      const small = await setupWorld({ fileMaxBytes: 40, spaceMaxBytes: 50 });
      const first = await request(small.app)
        .post(`/spaces/${small.spaceId}/files/init-upload`)
        .set('Authorization', `Bearer ${small.owner.token}`)
        .send({ name: 'a.txt', mimeType: 'text/plain', sizeBytes: 40 });
      expect(first.status).toBe(201);

      // The first upload is still PENDING: its bytes are reserved, so a second
      // file that would overflow the remaining capacity must be refused.
      const second = await request(small.app)
        .post(`/spaces/${small.spaceId}/files/init-upload`)
        .set('Authorization', `Bearer ${small.owner.token}`)
        .send({ name: 'b.txt', mimeType: 'text/plain', sizeBytes: 40 });
      expect(second.status).toBe(400);
      expect(second.body.error.code).toBe('QUOTA_EXCEEDED');

      const tooBig = await request(small.app)
        .post(`/spaces/${small.spaceId}/files/init-upload`)
        .set('Authorization', `Bearer ${small.owner.token}`)
        .send({ name: 'c.txt', mimeType: 'text/plain', sizeBytes: 41 });
      expect(tooBig.status).toBe(400);
    });
  });

  describe('browsing, previews and metadata', () => {
    it('lists with folder scoping, type filters, counts and sorting', async () => {
      const docs = await createFolder(world, world.owner.token, world.spaceId, 'Docs');
      const spec = await createFolder(world, world.owner.token, world.spaceId, 'Spec', docs.id);
      await upload(world, world.owner.token, world.spaceId, {
        name: 'spec.txt',
        body: 'spec body',
        folderId: spec.id,
      });
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('fake-png-body'),
      ]);
      await upload(world, world.owner.token, world.spaceId, {
        name: 'diagram.png',
        mimeType: 'image/png',
        body: png,
        folderId: docs.id,
      });

      const inDocs = await request(world.app)
        .get(`/spaces/${world.spaceId}/files?folderId=${docs.id}&sort=name-asc`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(inDocs.status).toBe(200);
      expect(inDocs.body.files.map((f: { name: string }) => f.name)).toEqual(['diagram.png']);
      expect(inDocs.body.files[0].folderPath).toBe('Docs/');
      expect(inDocs.body.counts.image).toBeGreaterThanOrEqual(1);

      const images = await request(world.app)
        .get(`/spaces/${world.spaceId}/files?type=image`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      // The image filter matches by type bucket (MIME or extension), so the
      // result includes both the PNG (image/png) and any other images.
      expect(images.body.files.some((f: { name: string }) => f.name === 'diagram.png')).toBe(true);

      const search = await request(world.app)
        .get(`/spaces/${world.spaceId}/files?q=spec`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(search.body.files).toHaveLength(1);
      expect(search.body.files[0].name).toBe('spec.txt');

      const invalid = await request(world.app)
        .get(`/spaces/${world.spaceId}/files?sort=nope`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(invalid.status).toBe(400);
    });

    it('issues inline previews for images and text only', async () => {
      const text = await upload(world, world.owner.token, world.spaceId, { name: 'readme.md', body: '# hello' });

      const preview = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/${text.id}/preview`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(preview.status).toBe(200);
      expect(preview.body.preview.kind).toBe('text');
      const fetched = await fetch(new URL(preview.body.preview.url as string, baseUrl));
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get('content-disposition')).toBe('inline');
      expect(await fetched.text()).toBe('# hello');

      // ZIP archives have no preview kind and no capability URL.
      const zip = await upload(world, world.owner.token, world.spaceId, {
        name: 'bundle.zip',
        mimeType: 'application/zip',
        body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
      });
      const noPreview = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/${zip.id}/preview`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(noPreview.status).toBe(200);
      expect(noPreview.body.preview.kind).toBe('none');
      expect(noPreview.body.preview.url).toBe('');
    });
  });

  describe('file operations', () => {
    it('moves a file without changing its object and still downloads it', async () => {
      const folder = await createFolder(world, world.owner.token, world.spaceId, 'Moved');
      const file = await upload(world, world.owner.token, world.spaceId, { name: 'move.txt', body: 'move me' });

      const moved = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/${file.id}/move`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ folderId: folder.id });
      expect(moved.status).toBe(200);
      expect(moved.body.file.folderId).toBe(folder.id);
      expect(moved.body.file.objectKey).toBe(file.objectKey);

      const download = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/${file.id}/download`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(download.status).toBe(200);
      const fetched = await fetch(new URL(download.body.url as string, baseUrl));
      expect(await fetched.text()).toBe('move me');
    });

    it('deletes and restores a file, refusing restore when the object is gone', async () => {
      const file = await upload(world, world.owner.token, world.spaceId, { name: 'restore.txt', body: 'bring back' });
      await request(world.app)
        .delete(`/spaces/${world.spaceId}/files/${file.id}`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .expect(204);

      const restore = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/${file.id}/restore`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(restore.status).toBe(200);
      expect(restore.body.file.status).toBe('ACTIVE');

      const second = await upload(world, world.owner.token, world.spaceId, { name: 'lost.txt', body: 'gone' });
      await request(world.app)
        .delete(`/spaces/${world.spaceId}/files/${second.id}`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .expect(204);
      await world.ctx.storage.deleteObject(second.objectKey);
      const missing = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/${second.id}/restore`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('FILE_OBJECT_MISSING');
    });

    it('bulk deletes, moves and downloads with per-file results', async () => {
      const target = await createFolder(world, world.owner.token, world.spaceId, 'Bulk');
      const one = await upload(world, world.owner.token, world.spaceId, { name: 'bulk-1.txt', body: 'one' });
      const two = await upload(world, world.owner.token, world.spaceId, { name: 'bulk-2.txt', body: 'two' });
      const foreign = await upload(world, world.owner.token, world.otherSpaceId, { name: 'other.txt', body: 'x' });

      const move = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/bulk-move`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ fileIds: [one.id, two.id], folderId: target.id });
      expect(move.status).toBe(200);
      expect(move.body.succeeded).toHaveLength(2);

      // A file from another Space can never be operated on through this Space.
      const mixed = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/bulk-delete`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ fileIds: [one.id, foreign.id] });
      expect(mixed.status).toBe(200);
      expect(mixed.body.succeeded).toEqual([one.id]);
      expect(mixed.body.failed).toHaveLength(1);

      const zip = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/bulk-download`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .buffer(true)
        .parse(binaryParser)
        .send({ fileIds: [two.id] });
      expect(zip.status).toBe(200);
      expect(zip.headers['content-type']).toBe('application/zip');
      expect((zip.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    });
  });

  describe('folder operations', () => {
    it('nests, renames, moves and reports recursive stats', async () => {
      const docs = await createFolder(world, world.owner.token, world.spaceId, 'Handbook');
      const child = await createFolder(world, world.owner.token, world.spaceId, 'Chapters', docs.id);
      expect(child.path).toBe('Handbook/Chapters/');
      await upload(world, world.owner.token, world.spaceId, {
        name: 'chapter-1.txt',
        body: 'chapter',
        folderId: child.id,
      });

      const renamed = await request(world.app)
        .patch(`/spaces/${world.spaceId}/folders/${docs.id}`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'Manual' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.folder.path).toBe('Manual/');
      const childAfter = await world.ctx.db.folders.findById(child.id);
      expect(childAfter?.path).toBe('Manual/Chapters/');

      const stats = await request(world.app)
        .get(`/spaces/${world.spaceId}/folders/stats?folderId=${docs.id}`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(stats.status).toBe(200);
      expect(stats.body.stats.fileCount).toBe(1);
      expect(stats.body.stats.folderCount).toBe(1);

      // Manual still contains Chapters at this point, so this is a real cycle.
      const cycle = await request(world.app)
        .post(`/spaces/${world.spaceId}/folders/${docs.id}/move`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ parentId: child.id });
      expect(cycle.status).toBe(400);
      expect(cycle.body.error.code).toBe('VALIDATION_ERROR');

      const moved = await request(world.app)
        .post(`/spaces/${world.spaceId}/folders/${child.id}/move`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ parentId: null });
      expect(moved.status).toBe(200);
      expect(moved.body.folder.path).toBe('Chapters/');
    });

    it('requires recursive deletion for non-empty folders', async () => {
      const folder = await createFolder(world, world.owner.token, world.spaceId, 'Old');
      const inner = await createFolder(world, world.owner.token, world.spaceId, 'Inner', folder.id);
      await upload(world, world.owner.token, world.spaceId, { name: 'old.txt', body: 'old', folderId: inner.id });

      const plain = await request(world.app)
        .delete(`/spaces/${world.spaceId}/folders/${folder.id}`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(plain.status).toBe(409);
      expect(plain.body.error.code).toBe('FOLDER_NOT_EMPTY');

      const recursive = await request(world.app)
        .delete(`/spaces/${world.spaceId}/folders/${folder.id}?recursive=true`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(recursive.status).toBe(200);
      expect(recursive.body.filesDeleted).toBe(1);
      expect(recursive.body.foldersDeleted).toBe(2);
      expect(await world.ctx.db.folders.findById(inner.id)).toBeFalsy();

      const empty = await createFolder(world, world.owner.token, world.spaceId, 'Truly Empty');
      const removed = await request(world.app)
        .delete(`/spaces/${world.spaceId}/folders/${empty.id}`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(removed.status).toBe(200);
    });
  });

  describe('permissions and isolation', () => {
    it('lets viewers read but not mutate, and blocks outsiders entirely', async () => {
      const file = await upload(world, world.owner.token, world.spaceId, { name: 'shared.txt', body: 'shared' });

      const viewerList = await request(world.app)
        .get(`/spaces/${world.spaceId}/files`)
        .set('Authorization', `Bearer ${world.viewer.token}`);
      expect(viewerList.status).toBe(200);

      const viewerPreview = await request(world.app)
        .post(`/spaces/${world.spaceId}/files/${file.id}/preview`)
        .set('Authorization', `Bearer ${world.viewer.token}`);
      expect(viewerPreview.status).toBe(200);

      const forbidden = [
        request(world.app)
          .post(`/spaces/${world.spaceId}/files/init-upload`)
          .set('Authorization', `Bearer ${world.viewer.token}`)
          .send({ name: 'nope.txt', sizeBytes: 4 }),
        request(world.app)
          .post(`/spaces/${world.spaceId}/folders`)
          .set('Authorization', `Bearer ${world.viewer.token}`)
          .send({ name: 'nope' }),
        request(world.app)
          .post(`/spaces/${world.spaceId}/files/${file.id}/move`)
          .set('Authorization', `Bearer ${world.viewer.token}`)
          .send({ folderId: null }),
        request(world.app)
          .delete(`/spaces/${world.spaceId}/files/${file.id}`)
          .set('Authorization', `Bearer ${world.viewer.token}`),
        request(world.app)
          .post(`/spaces/${world.spaceId}/files/bulk-delete`)
          .set('Authorization', `Bearer ${world.viewer.token}`)
          .send({ fileIds: [file.id] }),
        request(world.app)
          .delete(`/spaces/${world.spaceId}/folders/whatever`)
          .set('Authorization', `Bearer ${world.viewer.token}`),
      ];
      for (const response of await Promise.all(forbidden)) {
        expect(response.status).toBe(403);
      }

      const outsider = await request(world.app)
        .get(`/spaces/${world.spaceId}/files`)
        .set('Authorization', `Bearer ${world.outsider.token}`);
      expect(outsider.status).toBe(403);

      const crossSpace = await request(world.app)
        .get(`/spaces/${world.spaceId}/files/${file.id}`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(crossSpace.status).toBe(200);
      const wrongSpace = await request(world.app)
        .get(`/spaces/${world.otherSpaceId}/files/${file.id}`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(wrongSpace.status).toBe(404);
    });

    it('keeps a renamed and moved tree archivable', async () => {
      const res = await request(world.app)
        .post(`/spaces/${world.spaceId}/archive`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(res.status).toBe(200);
      expect(res.body.archive.status).toBe('VERIFIED');
      expect(res.body.archive.fileCount).toBeGreaterThan(0);
      const space = await world.ctx.db.spaces.findById(world.spaceId);
      expect(space?.status).toBe('ARCHIVED');
    });
  });
});
