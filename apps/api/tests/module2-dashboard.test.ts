import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Space } from '@flashspace/shared';
import { buildApp, type AppContext } from '../src/app.js';
import { newId } from '../src/utils/ids.js';

/**
 * Module 2 — dashboard + global search.
 *
 * Runs against the real Express app and the real services; only the storage
 * backend is the in-memory layer. The point of these tests is authorization:
 * every section must be built from the caller's accessible Spaces, and global
 * search must never reveal a Space, file or folder the caller cannot open.
 */

const HOUR = 3_600_000;

interface World {
  app: Express;
  ctx: AppContext;
  owner: { token: string; id: string };
  other: { token: string; id: string };
  admin: { token: string; id: string };
}

async function register(app: Express, email: string, displayName: string) {
  const res = await request(app).post('/auth/register').send({ email, password: 'password123', displayName });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, id: res.body.user.id as string };
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function seedSpace(
  ctx: AppContext,
  ownerId: string,
  overrides: Partial<Space> & { name: string },
): Space {
  const now = new Date().toISOString();
  const space: Space = {
    id: newId(),
    ownerId,
    name: overrides.name,
    purpose: 'Weekend sprint',
    description: '',
    startAt: now,
    expiryAt: iso(7 * 24 * HOUR),
    status: 'ACTIVE',
    warningSentAt: null,
    archivedManually: false,
    invitationsEnabled: true,
    defaultInviteRole: 'VIEWER',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  ctx.db.spaces.insert(space);
  ctx.db.members.insert({
    spaceId: space.id,
    userId: ownerId,
    role: 'OWNER',
    status: 'ACTIVE',
    joinedAt: now,
    revokedAt: null,
  });
  return space;
}

function seedFile(ctx: AppContext, spaceId: string, uploaderId: string, name: string, sizeBytes: number, createdAt = iso(-HOUR)) {
  const file = {
    id: newId(),
    spaceId,
    folderId: null,
    uploaderId,
    name,
    objectKey: `private/${spaceId}/${name}`,
    mimeType: name.endsWith('.png') ? 'image/png' : 'text/plain',
    sizeBytes,
    etag: null,
    sha256: null,
    status: 'ACTIVE' as const,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
  ctx.db.files.insert(file);
  return file;
}

function seedFolder(ctx: AppContext, spaceId: string, name: string) {
  const now = new Date().toISOString();
  const folder = {
    id: newId(),
    spaceId,
    parentId: null,
    name,
    path: `${name}/`,
    createdAt: now,
    updatedAt: now,
  };
  ctx.db.folders.insert(folder);
  return folder;
}

let world: World;
let ownerSpace: Space;
let archivedSpace: Space;
let draftSpace: Space;
let otherSpace: Space;

beforeAll(async () => {
  const { app, ctx } = buildApp({ repoMode: 'memory', localStorageDir: './data/test-storage' });
  const admin = await register(app, 'admin@m2.dev', 'Ada Admin');
  const owner = await register(app, 'owner@m2.dev', 'Olive Owner');
  const other = await register(app, 'other@m2.dev', 'Otto Other');

  ownerSpace = seedSpace(ctx, owner.id, {
    name: 'Alpha Sprint',
    purpose: 'Design handoff',
    status: 'ACTIVE',
    expiryAt: iso(2 * HOUR),
  });
  archivedSpace = seedSpace(ctx, owner.id, {
    name: 'Beta Archive',
    status: 'ARCHIVED',
    expiryAt: iso(-3 * 24 * HOUR),
  });
  draftSpace = seedSpace(ctx, owner.id, {
    name: 'Gamma Draft',
    status: 'DRAFT',
    expiryAt: iso(10 * 24 * HOUR),
  });
  otherSpace = seedSpace(ctx, other.id, { name: 'Shared Secrets', purpose: 'Not yours' });

  seedFile(ctx, ownerSpace.id, owner.id, 'alpha-notes.txt', 100, iso(-2 * HOUR));
  seedFile(ctx, ownerSpace.id, owner.id, 'diagram.png', 50, iso(-1 * HOUR));
  seedFolder(ctx, ownerSpace.id, 'Deliverables');
  seedFile(ctx, otherSpace.id, other.id, 'alpha-private.txt', 999, iso(-30 * 60 * 1000));

  ctx.db.activity.append({
    userId: owner.id,
    spaceId: ownerSpace.id,
    fileId: null,
    action: 'FILE_UPLOADED',
    metadata: {},
  });
  ctx.db.activity.append({
    userId: other.id,
    spaceId: otherSpace.id,
    fileId: null,
    action: 'SPACE_CREATED',
    metadata: {},
  });

  // Invitation addressed to the owner from a Space it has not joined.
  ctx.db.invitations.insert({
    id: newId(),
    spaceId: otherSpace.id,
    inviterId: other.id,
    email: 'owner@m2.dev',
    intendedRole: 'EDITOR',
    tokenHash: null,
    status: 'PENDING',
    expiresAt: iso(3 * 24 * HOUR),
    createdAt: new Date().toISOString(),
  });
  // Expired invitation must never show up on the dashboard.
  ctx.db.invitations.insert({
    id: newId(),
    spaceId: otherSpace.id,
    inviterId: other.id,
    email: 'owner@m2.dev',
    intendedRole: 'VIEWER',
    tokenHash: null,
    status: 'PENDING',
    expiresAt: iso(-HOUR),
    createdAt: iso(-5 * 24 * HOUR),
  });

  world = { app, ctx, owner, other, admin };
});

describe('dashboard summary', () => {
  it('requires authentication', async () => {
    const res = await request(world.app).get('/dashboard/summary');
    expect(res.status).toBe(401);
  });

  it('returns personalized counts from the user’s own Spaces', async () => {
    const res = await request(world.app)
      .get('/dashboard/summary')
      .set('Authorization', `Bearer ${world.owner.token}`);
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ total: 3, active: 1, expiring: 1, archived: 1 });
    expect(res.body.errors).toEqual([]);
    expect(res.body.expiring).toHaveLength(1);
    expect(res.body.expiring[0].id).toBe(ownerSpace.id);
    expect(res.body.expiring[0].remainingMs).toBeGreaterThan(0);
  });

  it('reports real storage totals and a non-negative available balance', async () => {
    const res = await request(world.app)
      .get('/dashboard/summary')
      .set('Authorization', `Bearer ${world.owner.token}`);
    const storage = res.body.storage;
    expect(storage.usedBytes).toBe(150); // 100 + 50 seeded bytes
    expect(storage.freeBytes).toBe(storage.quotaBytes - 150);
    expect(storage.freeBytes).toBeGreaterThanOrEqual(0);
    expect(storage.quotaBytes).toBe(world.ctx.env.spaceMaxBytes * world.ctx.env.maxActiveSpacesPerUser);
  });

  it('lists recent uploads only from accessible Spaces', async () => {
    const res = await request(world.app)
      .get('/dashboard/summary')
      .set('Authorization', `Bearer ${world.owner.token}`);
    const names = res.body.recentUploads.map((f: { name: string }) => f.name);
    expect(names).toContain('diagram.png');
    expect(names).not.toContain('alpha-private.txt');
    // Newest first.
    expect(names[0]).toBe('diagram.png');
    expect(res.body.recentUploads[0].spaceName).toBe('Alpha Sprint');
    expect(res.body.recentUploads[0].uploaderName).toBe('Olive Owner');
    expect(JSON.stringify(res.body)).not.toMatch(/objectKey|object_key|private\//);
  });

  it('shows activity for the user and their Spaces, never another user’s Space', async () => {
    const owner = await request(world.app)
      .get('/dashboard/summary')
      .set('Authorization', `Bearer ${world.owner.token}`);
    const ownerEvents = owner.body.activity.map((a: { action: string }) => a.action);
    expect(ownerEvents).toContain('FILE_UPLOADED');
    expect(ownerEvents).not.toContain('SPACE_CREATED');

    const other = await request(world.app)
      .get('/dashboard/summary')
      .set('Authorization', `Bearer ${world.other.token}`);
    const otherEvents = other.body.activity.map((a: { spaceId: string }) => a.spaceId);
    expect(otherEvents).not.toContain(ownerSpace.id);
  });

  it('shows pending invitations addressed to the account, not expired ones', async () => {
    const res = await request(world.app)
      .get('/dashboard/summary')
      .set('Authorization', `Bearer ${world.owner.token}`);
    expect(res.body.invitations).toHaveLength(1);
    expect(res.body.invitations[0]).toMatchObject({
      kind: 'EMAIL',
      spaceName: 'Shared Secrets',
      inviterName: 'Otto Other',
      role: 'EDITOR',
    });

    const other = await request(world.app)
      .get('/dashboard/summary')
      .set('Authorization', `Bearer ${world.other.token}`);
    expect(other.body.invitations).toHaveLength(0);
  });

  it('records recently accessed Spaces only on real Space opens', async () => {
    const before = await request(world.app)
      .get('/dashboard/summary')
      .set('Authorization', `Bearer ${world.owner.token}`);
    expect(before.body.recentSpaces).toHaveLength(0);

    const open = await request(world.app)
      .get(`/spaces/${ownerSpace.id}`)
      .set('Authorization', `Bearer ${world.owner.token}`);
    expect(open.status).toBe(200);

    const after = await request(world.app)
      .get('/dashboard/summary')
      .set('Authorization', `Bearer ${world.owner.token}`);
    expect(after.body.recentSpaces).toHaveLength(1);
    expect(after.body.recentSpaces[0]).toMatchObject({
      id: ownerSpace.id,
      name: 'Alpha Sprint',
      ownerName: 'Olive Owner',
      role: 'OWNER',
    });
    expect(after.body.recentSpaces[0].lastAccessedAt).toBeTruthy();

    // Another user's dashboard is untouched.
    const other = await request(world.app)
      .get('/dashboard/summary')
      .set('Authorization', `Bearer ${world.other.token}`);
    expect(other.body.recentSpaces.map((s: { id: string }) => s.id)).not.toContain(ownerSpace.id);
  });

  it('gives a brand-new account empty sections instead of fake data', async () => {
    const fresh = await register(world.app, 'fresh@m2.dev', 'Fresh Start');
    const res = await request(world.app)
      .get('/dashboard/summary')
      .set('Authorization', `Bearer ${fresh.token}`);
    expect(res.body.counts).toEqual({ total: 0, active: 0, expiring: 0, archived: 0 });
    expect(res.body.activity).toEqual([]);
    expect(res.body.recentUploads).toEqual([]);
    expect(res.body.recentSpaces).toEqual([]);
    expect(res.body.invitations).toEqual([]);
  });
});

describe('global search', () => {
  const search = (query: string, who: keyof Pick<World, 'owner' | 'other' | 'admin'> = 'owner') =>
    request(world.app)
      .get(`/search${query}`)
      .set('Authorization', `Bearer ${world[who].token}`);

  it('requires authentication', async () => {
    const res = await request(world.app).get('/search?q=alpha');
    expect(res.status).toBe(401);
  });

  it('matches Spaces by partial, case-insensitive name and description', async () => {
    const byName = await search('?q=ALPH');
    expect(byName.status).toBe(200);
    expect(byName.body.spaces.map((s: { name: string }) => s.name)).toEqual(['Alpha Sprint']);

    const byPurpose = await search('?q=design');
    expect(byPurpose.body.spaces).toHaveLength(1);
    expect(byPurpose.body.spaces[0].id).toBe(ownerSpace.id);
  });

  it('matches files and folders, with the owning Space attached', async () => {
    const files = await search('?q=diagram');
    expect(files.body.files).toHaveLength(1);
    expect(files.body.files[0]).toMatchObject({
      name: 'diagram.png',
      type: 'file',
      spaceId: ownerSpace.id,
      spaceName: 'Alpha Sprint',
      detail: 'image/png',
      sizeBytes: 50,
    });
    expect(JSON.stringify(files.body)).not.toMatch(/objectKey|private\//);

    const folders = await search('?q=deliver');
    expect(folders.body.folders).toHaveLength(1);
    expect(folders.body.folders[0]).toMatchObject({ name: 'Deliverables', spaceId: ownerSpace.id });
  });

  it('ignores queries shorter than the minimum length', async () => {
    const res = await search('?q=a');
    expect(res.body.spaces).toEqual([]);
    expect(res.body.files).toEqual([]);
    expect(res.body.minQueryLength).toBe(2);
  });

  it('normalizes whitespace and special characters safely', async () => {
    const spaced = await search('?q=%20%20alpha%20%20');
    expect(spaced.body.query).toBe('alpha');
    expect(spaced.body.spaces).toHaveLength(1);

    const quoted = await search('?q=%27%22%25_');
    expect(quoted.status).toBe(200);
    expect(quoted.body.spaces).toEqual([]);
  });

  it('applies category and per-category limits', async () => {
    const filesOnly = await search('?q=alpha&category=files');
    expect(filesOnly.body.spaces).toEqual([]);
    expect(filesOnly.body.files).toHaveLength(1);

    const limited = await search('?q=a&category=files&limit=1');
    expect(limited.body.files).toHaveLength(0); // below min length, never unbounded

    const spacesOnly = await search('?q=e&category=spaces');
    expect(spacesOnly.body.files).toEqual([]);
  });

  it('rejects an unknown category and a non-numeric limit', async () => {
    const badCategory = await search('?q=alpha&category=admins');
    expect(badCategory.status).toBe(400);
    const badLimit = await search('?q=alpha&limit=abc');
    expect(badLimit.status).toBe(400);
  });

  it('never returns another user’s Spaces, files or folders', async () => {
    // `diagram` and `Deliverables` exist only inside the owner's Space.
    const res = await search('?q=diagram', 'other');
    expect(res.body.spaces).toEqual([]);
    expect(res.body.files).toEqual([]);
    expect(res.body.folders).toEqual([]);

    const folders = await search('?q=deliver', 'other');
    expect(folders.body.folders).toEqual([]);
  });

  it('cannot widen scope with a spaceId the caller does not belong to', async () => {
    const res = await search(`?q=alpha&spaceId=${otherSpace.id}`, 'owner');
    expect(res.body.spaces).toEqual([]);
    expect(res.body.files).toEqual([]);
  });

  it('filters by file type', async () => {
    const images = await search('?q=alpha&category=files&type=image/');
    expect(images.body.files).toEqual([]); // alpha-notes.txt is text/plain

    const all = await search('?q=alpha&category=files');
    expect(all.body.files).toHaveLength(1);

    const png = await search('?q=diagram&category=files&type=image/');
    expect(png.body.files).toHaveLength(1);
  });
});

describe('admin protection', () => {
  it('blocks a normal member from admin APIs even with a valid token', async () => {
    const res = await request(world.app)
      .get('/admin/stats')
      .set('Authorization', `Bearer ${world.owner.token}`);
    expect(res.status).toBe(403);
  });

  it('still allows the bootstrap admin', async () => {
    const res = await request(world.app)
      .get('/admin/stats')
      .set('Authorization', `Bearer ${world.admin.token}`);
    expect(res.status).toBe(200);
  });
});
