import request from 'supertest';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { buildApp, type AppContext } from '../src/app.js';
import type { Env } from '../src/config/env.js';

/**
 * Module 3 — Space management.
 *
 * Runs the real Express app against the real services and data layer (only the
 * repository backend is swappable). Everything asserted here is the behaviour a
 * browser would get, including the authorization denials that the UI merely
 * mirrors.
 */

const REPO_MODE = process.env.TEST_REPO_MODE === 'sqlite' ? 'sqlite' : 'memory';

function repoOverrides(): Partial<Env> {
  return REPO_MODE === 'sqlite'
    ? { repoMode: 'sqlite', sqliteFile: ':memory:' }
    : { repoMode: 'memory' };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let baseUrl = '';
const servers: http.Server[] = [];

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

interface Actor {
  token: string;
  id: string;
}

interface World {
  app: Express;
  ctx: AppContext;
  admin: Actor;
  owner: Actor;
  editor: Actor;
  viewer: Actor;
  outsider: Actor;
  spaces: {
    alpha: { id: string };
    beta: { id: string };
    gamma: { id: string };
  };
}

async function register(app: Express, email: string, displayName: string): Promise<Actor> {
  const res = await request(app).post('/auth/register').send({ email, password: 'password123', displayName });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, id: res.body.user.id as string };
}

async function createSpace(
  world: World,
  token: string,
  body: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const res = await request(world.app)
    .post('/spaces')
    .set('Authorization', `Bearer ${token}`)
    .send({ startAt: iso(-HOUR), expiryAt: iso(7 * DAY), ...body });
  expect(res.status).toBe(201);
  return res.body.space as { id: string; name: string };
}

async function uploadFile(
  world: World,
  token: string,
  spaceId: string,
  name: string,
  body: string,
): Promise<{ id: string; objectKey: string }> {
  const init = await request(world.app)
    .post(`/spaces/${spaceId}/files/init-upload`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name, mimeType: 'text/plain', sizeBytes: Buffer.byteLength(body) });
  expect(init.status).toBe(201);
  const put = await fetch(new URL(init.body.url as string, baseUrl), { method: 'PUT', body });
  expect(put.status).toBe(200);
  const confirm = await request(world.app)
    .post(`/spaces/${spaceId}/files/${init.body.fileId}/confirm-upload`)
    .set('Authorization', `Bearer ${token}`);
  expect(confirm.status).toBe(200);
  return confirm.body.file as { id: string; objectKey: string };
}

/** Builds one world shared by the read-only suites; stateful suites make their own where needed. */
async function setupWorld(): Promise<World> {
  const { app, ctx } = buildApp({ localStorageDir: './data/test-storage-m3', ...repoOverrides() });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  servers.push(server);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  ctx.env.signedUrlBase = `http://127.0.0.1:${port}`;
  baseUrl = ctx.env.signedUrlBase;

  // The first registered account becomes the global ADMIN (bootstrap rule).
  const admin = await register(app, 'admin.m3@test.dev', 'Ada Admin');
  const owner = await register(app, 'owner.m3@test.dev', 'Olive Owner');
  const editor = await register(app, 'editor.m3@test.dev', 'Marty Member');
  const viewer = await register(app, 'viewer.m3@test.dev', 'Vic Viewer');
  const outsider = await register(app, 'outsider.m3@test.dev', 'Ollie Outsider');

  const world: World = {
    app,
    ctx,
    admin,
    owner,
    editor,
    viewer,
    outsider,
    spaces: { alpha: { id: '' }, beta: { id: '' }, gamma: { id: '' } },
  };

  world.spaces.alpha = await createSpace(world, owner.token, {
    name: 'Alpha Sprint',
    purpose: 'Hackathon',
    description: 'Weekend build',
  });
  world.spaces.beta = await createSpace(world, owner.token, {
    name: 'Beta Review',
    purpose: 'Research',
    expiryAt: iso(2 * HOUR),
  });
  world.spaces.gamma = await createSpace(world, owner.token, {
    name: 'Gamma Launch',
    purpose: 'Event Planning',
  });

  // Create invitations (they stay PENDING for existing users under spec §2.6)
  // and insert memberships directly so the rest of the suite has active members.
  await request(app)
    .post(`/spaces/${world.spaces.alpha.id}/invitations`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ email: 'editor.m3@test.dev', role: 'EDITOR' });
  await request(app)
    .post(`/spaces/${world.spaces.alpha.id}/invitations`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ email: 'viewer.m3@test.dev', role: 'VIEWER' });
  await ctx.db.members.insert({
    spaceId: world.spaces.alpha.id,
    userId: editor.id,
    role: 'EDITOR',
    status: 'ACTIVE',
    joinedAt: new Date().toISOString(),
    revokedAt: null,
  });
  await ctx.db.members.insert({
    spaceId: world.spaces.alpha.id,
    userId: viewer.id,
    role: 'VIEWER',
    status: 'ACTIVE',
    joinedAt: new Date().toISOString(),
    revokedAt: null,
  });

  return world;
}

describe('Module 3 — Space management', () => {
  let world: World;

  beforeAll(async () => {
    world = await setupWorld();
  });

  describe('creation', () => {
    it('creates the Space and assigns the creator as OWNER', async () => {
      const res = await request(world.app)
        .post('/spaces')
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({
          name: '  Created Space  ',
          purpose: 'Project Collaboration',
          description: 'Fresh',
          startAt: iso(-HOUR),
          expiryAt: iso(5 * DAY),
        });
      expect(res.status).toBe(201);
      expect(res.body.space.name).toBe('Created Space');
      expect(res.body.space.ownerId).toBe(world.owner.id);
      expect(res.body.space.status).toBe('ACTIVE');
      expect(res.body.space.invitationsEnabled).toBe(true);
      expect(res.body.space.defaultInviteRole).toBe('VIEWER');

      const member = await world.ctx.db.members.find(res.body.space.id, world.owner.id);
      expect(member?.role).toBe('OWNER');
      expect(member?.status).toBe('ACTIVE');

      const activity = await world.ctx.db.activity.listForSpace(res.body.space.id, 10);
      expect(activity.some((entry) => entry.action === 'SPACE_CREATED')).toBe(true);
    });

    it('validates the name, purpose and date range on the server', async () => {
      const base = { purpose: 'Research', startAt: iso(-HOUR), expiryAt: iso(DAY) };
      const shortName = await request(world.app)
        .post('/spaces')
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ ...base, name: 'ab' });
      expect(shortName.status).toBe(400);
      expect(shortName.body.error.code).toBe('VALIDATION_ERROR');

      const missingPurpose = await request(world.app)
        .post('/spaces')
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ ...base, name: 'Valid name', purpose: '   ' });
      expect(missingPurpose.status).toBe(400);

      const reversed = await request(world.app)
        .post('/spaces')
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'Reversed', purpose: 'Research', startAt: iso(DAY), expiryAt: iso(HOUR) });
      expect(reversed.status).toBe(400);
      expect(reversed.body.error.code).toBe('INVALID_DATE_RANGE');

      const badDate = await request(world.app)
        .post('/spaces')
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'Bad date', purpose: 'Research', startAt: 'not-a-date', expiryAt: iso(DAY) });
      expect(badDate.status).toBe(400);
    });

    it('never trusts a client supplied owner or role', async () => {
      const res = await request(world.app)
        .post('/spaces')
        .set('Authorization', `Bearer ${world.viewer.token}`)
        .send({
          name: 'Spoof Attempt',
          purpose: 'Research',
          startAt: iso(-HOUR),
          expiryAt: iso(DAY),
          ownerId: world.owner.id,
          role: 'OWNER',
        });
      expect(res.status).toBe(201);
      expect(res.body.space.ownerId).toBe(world.viewer.id);
      const membership = await world.ctx.db.members.find(res.body.space.id, world.viewer.id);
      expect(membership?.role).toBe('OWNER');
      const spoofed = await world.ctx.db.members.find(res.body.space.id, world.owner.id);
      expect(spoofed).toBeFalsy();
    });

    it('creates template folders through the normal creation path', async () => {
      const res = await request(world.app)
        .post('/spaces')
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ templateId: 'hackathon', startAt: iso(-HOUR), expiryAt: iso(3 * DAY) });
      expect(res.status).toBe(201);
      expect(res.body.space.name).toBe('Hackathon Workspace');
      expect(res.body.space.purpose).toBe('Hackathon');

      const folders = await world.ctx.db.folders.listForSpace(res.body.space.id);
      expect(folders.map((folder) => folder.name).sort()).toEqual(
        ['Demo', 'Design', 'Ideas', 'Prototype', 'Submission'].sort(),
      );
    });

    it('rejects an unknown template and unauthenticated creation', async () => {
      const unknown = await request(world.app)
        .post('/spaces')
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ templateId: 'does-not-exist', startAt: iso(-HOUR), expiryAt: iso(DAY) });
      expect(unknown.status).toBe(400);

      const anonymous = await request(world.app)
        .post('/spaces')
        .send({ name: 'Nope', purpose: 'Research', startAt: iso(-HOUR), expiryAt: iso(DAY) });
      expect(anonymous.status).toBe(401);
    });
  });

  describe('listing, search, filters and sorting', () => {
    it('filters owned Spaces by status', async () => {
      const res = await request(world.app)
        .get('/spaces?status=ACTIVE')
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(res.status).toBe(200);
      expect(res.body.spaces.length).toBeGreaterThan(0);
      for (const space of res.body.spaces) {
        expect(['DRAFT', 'ACTIVE', 'WARNING']).toContain(space.status);
      }
    });

    it('returns the expiring bucket from the real warning window', async () => {
      const res = await request(world.app)
        .get('/spaces?status=EXPIRING')
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(res.status).toBe(200);
      const ids = (res.body.spaces as { id: string }[]).map((space) => space.id);
      expect(ids).toContain(world.spaces.beta.id);
      expect(ids).not.toContain(world.spaces.gamma.id);
    });

    it('searches by name and filters by purpose', async () => {
      const search = await request(world.app)
        .get('/spaces?q=alpha')
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(search.status).toBe(200);
      expect(search.body.spaces).toHaveLength(1);
      expect(search.body.spaces[0].name).toBe('Alpha Sprint');

      const purpose = await request(world.app)
        .get('/spaces?purpose=Research')
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(purpose.status).toBe(200);
      for (const space of purpose.body.spaces) expect(space.purpose).toBe('Research');
    });

    it('sorts by name and by storage, and paginates with a total', async () => {
      const sorted = await request(world.app)
        .get('/spaces?sort=name-asc')
        .set('Authorization', `Bearer ${world.owner.token}`);
      const names = (sorted.body.spaces as { name: string }[]).map((space) => space.name);
      expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);

      const page = await request(world.app)
        .get('/spaces?sort=name-asc&limit=1&offset=1')
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(page.status).toBe(200);
      expect(page.body.spaces).toHaveLength(1);
      expect(page.body.total).toBe(sorted.body.spaces.length);

      const storage = await request(world.app)
        .get('/spaces?sort=storage')
        .set('Authorization', `Bearer ${world.owner.token}`);
      const bytes = (storage.body.spaces as { storageUsedBytes: number }[]).map((s) => s.storageUsedBytes);
      expect([...bytes].sort((a, b) => b - a)).toEqual(bytes);

      const invalid = await request(world.app)
        .get('/spaces?sort=sideways')
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(invalid.status).toBe(400);
    });

    it('shows shared Spaces with the caller role and hides non-member Spaces', async () => {
      const shared = await request(world.app)
        .get('/spaces?ownership=shared')
        .set('Authorization', `Bearer ${world.editor.token}`);
      expect(shared.status).toBe(200);
      expect(shared.body.spaces).toHaveLength(1);
      expect(shared.body.spaces[0].id).toBe(world.spaces.alpha.id);
      expect(shared.body.spaces[0].role).toBe('EDITOR');
      expect(shared.body.spaces[0].ownerName).toBe('Olive Owner');

      const outsiderList = await request(world.app)
        .get('/spaces')
        .set('Authorization', `Bearer ${world.outsider.token}`);
      expect(outsiderList.status).toBe(200);
      expect(outsiderList.body.spaces).toHaveLength(0);

      const denied = await request(world.app)
        .get(`/spaces/${world.spaces.alpha.id}`)
        .set('Authorization', `Bearer ${world.outsider.token}`);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('SPACE_ACCESS_DENIED');
    });
  });

  describe('settings and invitation controls', () => {
    it('lets the owner edit details and expiry', async () => {
      const res = await request(world.app)
        .patch(`/spaces/${world.spaces.gamma.id}/settings`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({
          name: 'Gamma Launch v2',
          description: 'Updated brief',
          purpose: 'Project Collaboration',
          expiryAt: iso(12 * DAY),
        });
      expect(res.status).toBe(200);
      expect(res.body.space.name).toBe('Gamma Launch v2');
      expect(res.body.space.description).toBe('Updated brief');
      expect(res.body.space.purpose).toBe('Project Collaboration');

      const stored = await world.ctx.db.spaces.findById(world.spaces.gamma.id);
      expect(stored?.name).toBe('Gamma Launch v2');
      expect(new Date(stored!.expiryAt).getTime()).toBeGreaterThan(Date.now() + 11 * DAY);
    });

    it('rejects invalid settings values', async () => {
      const shortName = await request(world.app)
        .patch(`/spaces/${world.spaces.gamma.id}/settings`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'no' });
      expect(shortName.status).toBe(400);

      const badExpiry = await request(world.app)
        .patch(`/spaces/${world.spaces.gamma.id}/settings`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ expiryAt: iso(-10 * DAY) });
      expect(badExpiry.status).toBe(400);
      expect(badExpiry.body.error.code).toBe('INVALID_DATE_RANGE');

      const ownerRole = await request(world.app)
        .patch(`/spaces/${world.spaces.gamma.id}/settings`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ defaultInviteRole: 'OWNER' });
      expect(ownerRole.status).toBe(400);

      const empty = await request(world.app)
        .patch(`/spaces/${world.spaces.gamma.id}/settings`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({});
      expect(empty.status).toBe(400);
    });

    it('refuses settings changes from editors, viewers and non-members', async () => {
      for (const actor of [world.editor, world.viewer, world.outsider]) {
        const res = await request(world.app)
          .patch(`/spaces/${world.spaces.alpha.id}/settings`)
          .set('Authorization', `Bearer ${actor.token}`)
          .send({ name: 'Hijacked Name' });
        expect(res.status).toBe(403);
      }
      const stored = await world.ctx.db.spaces.findById(world.spaces.alpha.id);
      expect(stored?.name).toBe('Alpha Sprint');
    });

    it('re-arms the lifecycle warning when the deadline moves out of the window', async () => {
      await world.ctx.db.spaces.update(world.spaces.alpha.id, { warningSentAt: iso(-HOUR) });
      const res = await request(world.app)
        .patch(`/spaces/${world.spaces.alpha.id}/settings`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ expiryAt: iso(9 * DAY) });
      expect(res.status).toBe(200);
      expect(res.body.space.warningSentAt).toBeNull();
    });

    it('enforces invitation settings and the default invite role', async () => {
      const off = await request(world.app)
        .patch(`/spaces/${world.spaces.alpha.id}/settings`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ invitationsEnabled: false });
      expect(off.status).toBe(200);
      expect(off.body.space.invitationsEnabled).toBe(false);

      const invite = await request(world.app)
        .post(`/spaces/${world.spaces.alpha.id}/invitations`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ email: 'outsider.m3@test.dev', role: 'VIEWER' });
      expect(invite.status).toBe(409);
      expect(invite.body.error.code).toBe('INVITATIONS_DISABLED');

      const link = await request(world.app)
        .post(`/spaces/${world.spaces.alpha.id}/invite-link`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({});
      expect(link.status).toBe(409);
      expect(link.body.error.code).toBe('INVITATIONS_DISABLED');

      const on = await request(world.app)
        .patch(`/spaces/${world.spaces.alpha.id}/settings`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ invitationsEnabled: true, defaultInviteRole: 'EDITOR' });
      expect(on.status).toBe(200);

      const reopened = await request(world.app)
        .post(`/spaces/${world.spaces.alpha.id}/invite-link`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({});
      expect(reopened.status).toBe(200);
      expect(reopened.body.inviteLink.role).toBe('EDITOR');
    });

    it('prevents privilege escalation through the membership API', async () => {
      // An editor cannot change anybody's role, not even to a valid role.
      const asEditor = await request(world.app)
        .patch(`/spaces/${world.spaces.alpha.id}/members/${world.viewer.id}`)
        .set('Authorization', `Bearer ${world.editor.token}`)
        .send({ role: 'VIEWER' });
      expect(asEditor.status).toBe(403);

      // OWNER is never assignable, by anyone, through this endpoint.
      for (const actor of [world.editor, world.owner]) {
        const escalation = await request(world.app)
          .patch(`/spaces/${world.spaces.alpha.id}/members/${actor.id}`)
          .set('Authorization', `Bearer ${actor.token}`)
          .send({ role: 'OWNER' });
        expect([400, 403]).toContain(escalation.status);
      }

      const stillEditor = await world.ctx.db.members.find(world.spaces.alpha.id, world.editor.id);
      expect(stillEditor?.role).toBe('EDITOR');
      const stillOwner = await world.ctx.db.members.find(world.spaces.alpha.id, world.owner.id);
      expect(stillOwner?.role).toBe('OWNER');
    });
  });

  describe('favourites', () => {
    it('stars and unstars a Space for the caller only', async () => {
      const star = await request(world.app)
        .post(`/spaces/${world.spaces.alpha.id}/favorite`)
        .set('Authorization', `Bearer ${world.editor.token}`);
      expect(star.status).toBe(200);
      expect(star.body.favorite).toBe(true);

      const favourites = await request(world.app)
        .get('/spaces/favorites')
        .set('Authorization', `Bearer ${world.editor.token}`);
      expect(favourites.status).toBe(200);
      expect(favourites.body.spaces.map((space: { id: string }) => space.id)).toContain(world.spaces.alpha.id);

      const ownerView = await request(world.app)
        .get('/spaces/favorites')
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(ownerView.body.spaces).toHaveLength(0);

      const membership = await world.ctx.db.members.find(world.spaces.alpha.id, world.editor.id);
      expect(membership?.role).toBe('EDITOR');

      const filtered = await request(world.app)
        .get('/spaces?favorite=true')
        .set('Authorization', `Bearer ${world.editor.token}`);
      expect(filtered.body.spaces).toHaveLength(1);

      const unstar = await request(world.app)
        .delete(`/spaces/${world.spaces.alpha.id}/favorite`)
        .set('Authorization', `Bearer ${world.editor.token}`);
      expect(unstar.status).toBe(200);
      expect(unstar.body.favorite).toBe(false);

      const after = await request(world.app)
        .get('/spaces/favorites')
        .set('Authorization', `Bearer ${world.editor.token}`);
      expect(after.body.spaces).toHaveLength(0);
    });

    it('refuses to star a Space the caller cannot open', async () => {
      const res = await request(world.app)
        .post(`/spaces/${world.spaces.alpha.id}/favorite`)
        .set('Authorization', `Bearer ${world.outsider.token}`);
      expect(res.status).toBe(403);
      const rows = await world.ctx.db.favoriteSpaces.listForUser(world.outsider.id);
      expect(rows).toHaveLength(0);
    });
  });

  describe('storage', () => {
    it('reports real accounting to members only', async () => {
      const owner = await request(world.app)
        .get(`/spaces/${world.spaces.alpha.id}/storage`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(owner.status).toBe(200);
      expect(owner.body.storage.spaceId).toBe(world.spaces.alpha.id);
      expect(owner.body.storage.quotaBytes).toBe(world.ctx.env.spaceMaxBytes);
      expect(owner.body.storage.fileCount).toBe(
        (await world.ctx.db.files.listActiveForSpace(world.spaces.alpha.id)).length,
      );

      const viewer = await request(world.app)
        .get(`/spaces/${world.spaces.alpha.id}/storage`)
        .set('Authorization', `Bearer ${world.viewer.token}`);
      expect(viewer.status).toBe(200);

      const outsider = await request(world.app)
        .get(`/spaces/${world.spaces.alpha.id}/storage`)
        .set('Authorization', `Bearer ${world.outsider.token}`);
      expect(outsider.status).toBe(403);
    });
  });

  describe('duplicate', () => {
    it('copies folders and files into a fresh Space owned by the caller', async () => {
      const source = await createSpace(world, world.owner.token, {
        name: 'Dup Source',
        purpose: 'Group Assignment',
        description: 'Template source',
      });
      await request(world.app)
        .post(`/spaces/${source.id}/folders`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'Docs' });
      await request(world.app)
        .post(`/spaces/${source.id}/folders`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'Assets' });
      const original = await uploadFile(world, world.owner.token, source.id, 'brief.txt', 'hello world');

      const newExpiry = iso(14 * DAY);
      const res = await request(world.app)
        .post(`/spaces/${source.id}/duplicate`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ name: 'Dup Copy', expiryAt: newExpiry, copyFiles: true });
      expect(res.status).toBe(201);

      const copy = res.body.space as {
        id: string;
        ownerId: string;
        expiryAt: string;
        members: { role: string }[];
      };
      expect(copy.id).not.toBe(source.id);
      expect(copy.ownerId).toBe(world.owner.id);
      expect(copy.members).toHaveLength(1);
      expect(copy.members[0].role).toBe('OWNER');
      expect(res.body.foldersCopied).toBe(2);
      expect(res.body.filesCopied).toBe(1);
      expect(res.body.filesSkipped).toBe(0);
      expect(Math.abs(new Date(copy.expiryAt).getTime() - new Date(newExpiry).getTime())).toBeLessThan(1000);

      const copyFolders = await world.ctx.db.folders.listForSpace(copy.id);
      expect(copyFolders.map((folder) => folder.name).sort()).toEqual(['Assets', 'Docs']);

      const copyFiles = await world.ctx.db.files.listActiveForSpace(copy.id);
      expect(copyFiles).toHaveLength(1);
      expect(copyFiles[0].id).not.toBe(original.id);
      expect(copyFiles[0].objectKey).not.toBe(original.objectKey);
      // The copied object is real bytes in storage, not a reference to the original.
      const stream = await world.ctx.storage.getObject(copyFiles[0].objectKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
      expect(Buffer.concat(chunks).toString()).toBe('hello world');
      expect(await world.ctx.db.files.usedBytesForSpace(copy.id)).toBe(Buffer.byteLength('hello world'));

      // The copy has its own lifecycle state and no inherited members.
      const stored = await world.ctx.db.spaces.findById(copy.id);
      expect(stored?.status).toBe('ACTIVE');
      expect(await world.ctx.db.members.find(copy.id, world.editor.id)).toBeFalsy();
    });

    it('duplicates folder structure only when file copying is not requested', async () => {
      const source = world.spaces.beta;
      const res = await request(world.app)
        .post(`/spaces/${source.id}/duplicate`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ copyFiles: false });
      expect(res.status).toBe(201);
      expect(res.body.filesCopied).toBe(0);
      const files = await world.ctx.db.files.listActiveForSpace(res.body.space.id);
      expect(files).toHaveLength(0);
      expect(res.body.space.name).toContain('(copy)');
    });

    it('refuses duplication from non-owners and rejects a past expiry', async () => {
      const asEditor = await request(world.app)
        .post(`/spaces/${world.spaces.alpha.id}/duplicate`)
        .set('Authorization', `Bearer ${world.editor.token}`)
        .send({});
      expect(asEditor.status).toBe(403);

      const pastExpiry = await request(world.app)
        .post(`/spaces/${world.spaces.alpha.id}/duplicate`)
        .set('Authorization', `Bearer ${world.owner.token}`)
        .send({ expiryAt: iso(-DAY) });
      expect(pastExpiry.status).toBe(400);
    });
  });

  describe('recently accessed', () => {
    it('records real opens and returns them for the caller', async () => {
      await request(world.app)
        .get(`/spaces/${world.spaces.gamma.id}`)
        .set('Authorization', `Bearer ${world.viewer.token}`)
        .expect(403);

      const opened = await request(world.app)
        .get(`/spaces/${world.spaces.alpha.id}`)
        .set('Authorization', `Bearer ${world.editor.token}`);
      expect(opened.status).toBe(200);

      const recent = await request(world.app)
        .get('/spaces/recent')
        .set('Authorization', `Bearer ${world.editor.token}`);
      expect(recent.status).toBe(200);
      expect(recent.body.spaces[0].id).toBe(world.spaces.alpha.id);

      const outsider = await request(world.app)
        .get('/spaces/recent')
        .set('Authorization', `Bearer ${world.outsider.token}`);
      expect(outsider.body.spaces).toHaveLength(0);
    });
  });

  describe('lifecycle authorisation', () => {
    it('keeps archive and delete owner-only', async () => {
      const editorArchive = await request(world.app)
        .post(`/spaces/${world.spaces.alpha.id}/archive`)
        .set('Authorization', `Bearer ${world.editor.token}`);
      expect(editorArchive.status).toBe(403);

      const editorDelete = await request(world.app)
        .delete(`/spaces/${world.spaces.alpha.id}`)
        .set('Authorization', `Bearer ${world.editor.token}`);
      expect(editorDelete.status).toBe(403);

      const viewerDelete = await request(world.app)
        .delete(`/spaces/${world.spaces.alpha.id}`)
        .set('Authorization', `Bearer ${world.viewer.token}`);
      expect(viewerDelete.status).toBe(403);
    });

    it('soft-deletes on owner request and hides the Space afterwards', async () => {
      const temp = await createSpace(world, world.owner.token, {
        name: 'Disposable Space',
        purpose: 'Research',
      });
      const res = await request(world.app)
        .delete(`/spaces/${temp.id}`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(res.status).toBe(204);

      const stored = await world.ctx.db.spaces.findById(temp.id);
      expect(stored?.status).toBe('DELETED');
      const gone = await request(world.app)
        .get(`/spaces/${temp.id}`)
        .set('Authorization', `Bearer ${world.owner.token}`);
      expect(gone.status).toBe(404);
    });
  });
});
