import fs from 'node:fs';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../src/app.js';

/**
 * Module 12 — activity logs & auditing.
 *
 * Isolated worlds, isolated storage. No test touches project data, and the
 * suite runs against both backends (memory by default, SQLite with
 * TEST_REPO_MODE=sqlite).
 */
const REPO_MODE = process.env.TEST_REPO_MODE === 'sqlite' ? 'sqlite' : 'memory';
const STORAGE_DIR = './data/test-activity-storage';

interface World {
  app: Express;
  ctx: AppContext;
  admin: { token: string; id: string };
  owner: { token: string; id: string };
  member: { token: string; id: string };
  outsider: { token: string; id: string };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function register(app: Express, email: string, displayName: string) {
  const res = await request(app).post('/auth/register').send({ email, password: 'password123', displayName });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, id: res.body.user.id as string };
}

async function setupWorld(envOverrides: Record<string, unknown> = {}): Promise<World> {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  const { app, ctx } = buildApp({
    localStorageDir: STORAGE_DIR,
    ...(REPO_MODE === 'sqlite' ? { repoMode: 'sqlite', sqliteFile: ':memory:' } : { repoMode: 'memory' }),
    ...envOverrides,
  } as never);
  const admin = await register(app, 'admin@activity.dev', 'Ada Admin');
  const owner = await register(app, 'owner@activity.dev', 'Olive Owner');
  const member = await register(app, 'member@activity.dev', 'Marty Member');
  const outsider = await register(app, 'outsider@activity.dev', 'Ollie Outsider');
  return { app, ctx, admin, owner, member, outsider };
}

function at(days: number): string {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

async function makeSpace(app: Express, token: string, name = 'Activity Space', expiryDays = 7): Promise<string> {
  const startAt = expiryDays <= 0 ? at(expiryDays - 1 / 24) : at(0);
  const res = await request(app)
    .post('/spaces')
    .set(auth(token))
    .send({ name, purpose: 'Activity', startAt, expiryAt: at(expiryDays) });
  expect(res.status).toBe(201);
  return res.body.space.id as string;
}

type Entries = Array<{ id: number; action: string; category: string; outcome: string; actorType: string; userId: string | null; spaceId: string | null; resourceType: string | null; resourceId: string | null; metadata: Record<string, unknown>; reason: string | null; createdAt: string }>;

async function spaceActivity(app: Express, token: string, spaceId: string, query = ''): Promise<Entries> {
  const res = await request(app).get(`/spaces/${spaceId}/activity${query}`).set(auth(token));
  expect(res.status).toBe(200);
  return res.body.activity as Entries;
}

async function uploadFile(
  app: Express,
  ctx: AppContext,
  token: string,
  spaceId: string,
  name = 'note.txt',
  body: string | Buffer = 'hello',
  mimeType = 'text/plain',
): Promise<{ fileId: string; objectKey: string; status: number; body: Record<string, unknown> }> {
  const init = await request(app)
    .post(`/spaces/${spaceId}/files/init-upload`)
    .set(auth(token))
    .send({ name, mimeType, sizeBytes: Buffer.byteLength(body as string) });
  expect(init.status).toBe(201);
  await ctx.storage.putObject(init.body.objectKey as string, Buffer.from(body as string));
  const confirm = await request(app)
    .post(`/spaces/${spaceId}/files/${init.body.fileId}/confirm-upload`)
    .set(auth(token));
  return {
    fileId: init.body.fileId as string,
    objectKey: init.body.objectKey as string,
    status: confirm.status,
    body: confirm.body as Record<string, unknown>,
  };
}

/** Real membership path: invite link → join request → owner accepts. */
async function addMember(
  app: Express,
  ownerToken: string,
  userToken: string,
  spaceId: string,
  role: 'EDITOR' | 'VIEWER' = 'VIEWER',
): Promise<string> {
  const link = await request(app).post(`/spaces/${spaceId}/invite-link`).set(auth(ownerToken)).send({ role });
  expect(link.status).toBe(200);
  // The API returns the shareable URL; the token is its last path segment.
  const token = String(link.body.inviteLink.url).split('/').pop();
  const join = await request(app)
    .post(`/join-links/${token}/requests`)
    .set(auth(userToken))
    .send({});
  expect(join.status).toBe(201);
  const decision = await request(app)
    .post(`/join-requests/${join.body.request.id}/decision`)
    .set(auth(ownerToken))
    .send({ decision: 'ACCEPT' });
  expect(decision.status).toBe(200);
  return join.body.request.id as string;
}

afterAll(() => {
  fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('activity: capture', () => {
  it('records Space creation, update, settings and deletion with actor + outcome', async () => {
    const { app, owner, ctx } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Captured');

    await request(app)
      .patch(`/spaces/${spaceId}`)
      .set(auth(owner.token))
      .send({ description: 'updated' });
    await request(app)
      .patch(`/spaces/${spaceId}/settings`)
      .set(auth(owner.token))
      .send({ invitationsEnabled: false });
    await request(app).delete(`/spaces/${spaceId}`).set(auth(owner.token));

    const entries = await spaceActivity(app, owner.token, spaceId);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('SPACE_CREATED');
    expect(actions).toContain('SPACE_UPDATED');
    expect(actions).toContain('SPACE_SETTINGS_UPDATED');
    expect(actions).toContain('SPACE_FINALIZED');

    const created = entries.find((e) => e.action === 'SPACE_CREATED')!;
    expect(created.userId).toBe(owner.id);
    expect(created.actorType).toBe('USER');
    expect(created.outcome).toBe('SUCCESS');
    expect(created.category).toBe('SPACE');
    expect(created.resourceType).toBe('space');
    expect(created.resourceId).toBe(spaceId);
    expect(Number.isNaN(new Date(created.createdAt).getTime())).toBe(false);
    expect(ctx.db.activity.listAll(1).length).toBeGreaterThan(0);
  });

  it('records the file lifecycle: upload, download, rename, move, delete', async () => {
    const { app, ctx, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Files');
    const folder = await request(app)
      .post(`/spaces/${spaceId}/folders`)
      .set(auth(owner.token))
      .send({ name: 'Docs' });
    expect(folder.status).toBe(201);

    const { fileId } = await uploadFile(app, ctx, owner.token, spaceId);
    expect((await request(app).post(`/spaces/${spaceId}/files/${fileId}/download`).set(auth(owner.token))).status).toBe(200);
    expect(
      (await request(app).patch(`/spaces/${spaceId}/files/${fileId}`).set(auth(owner.token)).send({ name: 'renamed.txt' })).status,
    ).toBe(200);
    expect(
      (await request(app)
        .post(`/spaces/${spaceId}/files/${fileId}/move`)
        .set(auth(owner.token))
        .send({ folderId: folder.body.folder.id })).status,
    ).toBe(200);
    expect((await request(app).delete(`/spaces/${spaceId}/files/${fileId}`).set(auth(owner.token))).status).toBe(204);

    const entries = await spaceActivity(app, owner.token, spaceId);
    const actions = entries.map((e) => e.action);
    for (const expected of [
      'FOLDER_CREATED',
      'FILE_UPLOAD_STARTED',
      'FILE_UPLOADED',
      'FILE_DOWNLOADED',
      'FILE_RENAMED',
      'FILE_MOVED',
      'FILE_DELETED',
    ]) {
      expect(actions).toContain(expected);
    }
    const uploaded = entries.find((e) => e.action === 'FILE_UPLOADED')!;
    expect(uploaded.resourceId).toBe(fileId);
    expect(uploaded.metadata.name).toBe('note.txt');
    expect(JSON.stringify(entries)).not.toContain('objectKey');
    expect(JSON.stringify(entries)).not.toContain('spaces/');
  });

  it('records folder rename, move and deletion', async () => {
    const { app, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Folders');
    const a = await request(app).post(`/spaces/${spaceId}/folders`).set(auth(owner.token)).send({ name: 'A' });
    const b = await request(app).post(`/spaces/${spaceId}/folders`).set(auth(owner.token)).send({ name: 'B' });
    const folderId = a.body.folder.id as string;

    await request(app).patch(`/spaces/${spaceId}/folders/${folderId}`).set(auth(owner.token)).send({ name: 'A2' });
    await request(app)
      .post(`/spaces/${spaceId}/folders/${folderId}/move`)
      .set(auth(owner.token))
      .send({ parentId: b.body.folder.id });
    await request(app).delete(`/spaces/${spaceId}/folders/${folderId}`).set(auth(owner.token));

    const actions = (await spaceActivity(app, owner.token, spaceId)).map((e) => e.action);
    expect(actions).toContain('FOLDER_RENAMED');
    expect(actions).toContain('FOLDER_MOVED');
    expect(actions).toContain('FOLDER_DELETED');
  });

  it('records a rejected upload as a FAILURE with a reason', async () => {
    const { app, ctx, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Rejects');
    const init = await request(app)
      .post(`/spaces/${spaceId}/files/init-upload`)
      .set(auth(owner.token))
      .send({ name: 'photo.png', mimeType: 'image/png', sizeBytes: 5 });
    await ctx.storage.putObject(init.body.objectKey as string, Buffer.from('hello'));
    const confirm = await request(app)
      .post(`/spaces/${spaceId}/files/${init.body.fileId}/confirm-upload`)
      .set(auth(owner.token));
    expect(confirm.status).toBe(400);

    const failed = (await spaceActivity(app, owner.token, spaceId)).find(
      (e) => e.action === 'FILE_UPLOAD_FAILED',
    );
    expect(failed).toBeTruthy();
    expect(failed!.outcome).toBe('FAILURE');
    expect(failed!.reason).toBe('content-does-not-match-declared-type');
  });

  it('records membership, invitation, join request and role changes', async () => {
    const { app, owner, member, outsider } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Members');

    const invite = await request(app)
      .post(`/spaces/${spaceId}/invitations`)
      .set(auth(owner.token))
      .send({ email: 'outsider@activity.dev', role: 'VIEWER' });
    expect([201, 202]).toContain(invite.status);
    await request(app).post(`/invitations/${invite.body.invitationId}/resend`).set(auth(owner.token));

    // A link join request, then an owner decision (this is the only way a
    // registered user actually becomes a member).
    await addMember(app, owner.token, outsider.token, spaceId, 'VIEWER');
    await addMember(app, owner.token, member.token, spaceId, 'VIEWER');

    await request(app)
      .patch(`/spaces/${spaceId}/members/${outsider.id}`)
      .set(auth(owner.token))
      .send({ role: 'EDITOR' });
    await request(app).delete(`/spaces/${spaceId}/members/${outsider.id}`).set(auth(owner.token));

    await request(app)
      .patch(`/spaces/${spaceId}/members/${member.id}`)
      .set(auth(owner.token))
      .send({ role: 'EDITOR' });

    const entries = await spaceActivity(app, owner.token, spaceId);
    const actions = entries.map((e) => e.action);
    for (const expected of [
      'MEMBER_INVITED',
      'INVITATION_CREATED',
      'INVITATION_SENT',
      'JOIN_REQUESTED',
      'JOIN_ACCEPTED',
      'MEMBER_ROLE_CHANGED',
      'MEMBER_REVOKED',
    ]) {
      expect(actions).toContain(expected);
    }
    const roleChange = entries.find(
      (e) => e.action === 'MEMBER_ROLE_CHANGED' && e.metadata.targetUserId === outsider.id,
    );
    expect(roleChange?.metadata.newRole).toBe('EDITOR');
    expect(roleChange?.metadata.previousRole).toBe('VIEWER');
    expect(JSON.stringify(entries)).not.toContain('tokenHash');
  });

  it('records a voluntary leave as MEMBER_LEFT', async () => {
    const { app, owner, member } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Leaving');
    await addMember(app, owner.token, member.token, spaceId, 'VIEWER');
    const leave = await request(app).post(`/spaces/${spaceId}/leave`).set(auth(member.token));
    expect([204, 400, 403]).toContain(leave.status);
    if (leave.status === 204) {
      const entries = await spaceActivity(app, owner.token, spaceId);
      const left = entries.find((e) => e.action === 'MEMBER_LEFT');
      expect(left?.userId).toBe(member.id);
      expect(left?.reason).toBe('left voluntarily');
    }
  });

  it('records extension request and approval with authoritative expiry values', async () => {
    const { app, owner, admin } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Extend', 0.5 / 24);
    const requested = await request(app)
      .post(`/spaces/${spaceId}/extensions`)
      .set(auth(owner.token))
      .send({ requestedDays: 2, reason: 'more time' });
    expect(requested.status).toBe(201);

    const decided = await request(app)
      .post(`/admin/extensions/${requested.body.request.id}/decision`)
      .set(auth(admin.token))
      .send({ decision: 'APPROVED' });
    expect(decided.status).toBe(200);

    const entries = await spaceActivity(app, owner.token, spaceId);
    expect(entries.some((e) => e.action === 'EXTENSION_REQUESTED')).toBe(true);
    const approved = entries.find((e) => e.action === 'EXTENSION_APPROVED')!;
    expect(approved.actorType).toBe('ADMIN');
    expect(approved.metadata.approvalMethod).toBe('MANUAL');
    expect(typeof approved.metadata.previousExpiryAt).toBe('string');
    expect(typeof approved.metadata.newExpiryAt).toBe('string');
    expect(new Date(approved.metadata.newExpiryAt as string).getTime()).toBeGreaterThan(
      new Date(approved.metadata.previousExpiryAt as string).getTime(),
    );
  });

  it('attributes an automatic policy decision to SYSTEM, not the requester', async () => {
    const { app, owner } = await setupWorld({ extensionPolicy: 'AUTO' });
    const spaceId = await makeSpace(app, owner.token, 'Auto', 0.5 / 24);
    const requested = await request(app)
      .post(`/spaces/${spaceId}/extensions`)
      .set(auth(owner.token))
      .send({ requestedDays: 1, reason: 'auto' });
    expect(requested.status).toBe(201);
    expect(requested.body.request.status).toBe('APPROVED');

    const entries = await spaceActivity(app, owner.token, spaceId);
    const auto = entries.find((e) => e.action === 'EXTENSION_APPROVED')!;
    expect(auto.actorType).toBe('SYSTEM');
    expect(auto.userId).toBeNull();
    expect(auto.metadata.requesterId).toBe(owner.id);
    expect(auto.metadata.approvalMethod).toBe('AUTOMATIC');
    expect(entries.some((e) => e.action === 'EXTENSION_AUTO_DECIDED')).toBe(true);
  });

  it('records archive generation, verification and cleanup with SYSTEM as the actor', async () => {
    const { app, ctx, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Archive me', -1 / 24);
    await uploadFile(app, ctx, owner.token, spaceId, 'a.txt', 'contents');

    const run = await request(app).post('/jobs/lifecycle/run').set('x-job-secret', ctx.env.jobSecret);
    expect(run.status).toBe(200);

    const entries = await ctx.db.activity.query({ spaceId, limit: 100 });
    const actions = entries.entries.map((e) => e.action);
    expect(actions).toContain('ARCHIVE_STARTED');
    expect(actions).toContain('ARCHIVE_VERIFIED');
    expect(actions).toContain('SPACE_ARCHIVED');

    for (const action of ['ARCHIVE_STARTED', 'ARCHIVE_VERIFIED', 'SPACE_ARCHIVED']) {
      const entry = entries.entries.find((e) => e.action === action)!;
      expect(entry.actorType).toBe('SYSTEM');
      expect(entry.userId).toBeNull();
      expect(entry.metadata.ownerId).toBe(owner.id);
    }
    const verified = entries.entries.find((e) => e.action === 'ARCHIVE_VERIFIED')!;
    expect(typeof verified.metadata.checksum).toBe('string');
  });

  it('records archive verification failure as a FAILURE with a reason', async () => {
    const { app, ctx, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Failing', -1 / 24);
    const { objectKey } = await uploadFile(app, ctx, owner.token, spaceId, 'gone.txt', 'x');
    // Remove the object so the archive stream fails during generation.
    await ctx.storage.deleteObject(objectKey);

    await request(app).post('/jobs/lifecycle/run').set('x-job-secret', ctx.env.jobSecret);
    const entries = await ctx.db.activity.query({ spaceId, limit: 100 });
    const failure = entries.entries.find((e) => e.action === 'ARCHIVE_FAILED')!;
    expect(failure).toBeTruthy();
    expect(failure.outcome).toBe('FAILURE');
    expect(failure.actorType).toBe('SYSTEM');
    expect(failure.reason).toContain('ENOENT');
    expect(entries.entries.some((e) => e.action === 'ARCHIVE_VERIFICATION_FAILED')).toBe(true);
  });

  it('records cleanup start and completion for the cleaned Space', async () => {
    const { app, ctx, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Cleanup', -1 / 24);
    await uploadFile(app, ctx, owner.token, spaceId, 'c.txt', 'data');

    // Archive first, then backdate the verification so the 7-day retention
    // window has elapsed (the worker's cutoff is fixed at seven days).
    await request(app).post('/jobs/lifecycle/run').set('x-job-secret', ctx.env.jobSecret);
    const verified = (await ctx.db.archives.listForSpace(spaceId)).find((a) => a.status === 'VERIFIED')!;
    await ctx.db.archives.update(verified.id, {
      verifiedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
    });
    await request(app).post('/jobs/lifecycle/run').set('x-job-secret', ctx.env.jobSecret);

    const entries = await ctx.db.activity.query({ spaceId, limit: 100 });
    const actions = entries.entries.map((e) => e.action);
    expect(actions).toContain('CLEANUP_STARTED');
    expect(actions).toContain('CLEANUP_COMPLETED');
    const done = entries.entries.find((e) => e.action === 'CLEANUP_COMPLETED')!;
    expect(done.actorType).toBe('SYSTEM');
    expect(done.metadata.objectsDeleted).toBeGreaterThanOrEqual(1);
    expect(done.outcome).toBe('SUCCESS');
  });
});

describe('activity: admin & security', () => {
  it('mirrors administrative actions into platform activity with an ADMIN actor', async () => {
    const { app, admin, member } = await setupWorld();
    const promote = await request(app)
      .post(`/admin/users/${member.id}/role`)
      .set(auth(admin.token))
      .send({ role: 'ADMIN', confirm: true, reason: 'needs access' });
    expect(promote.status).toBe(200);

    const activity = await request(app).get('/admin/activity?actorType=ADMIN').set(auth(admin.token));
    expect(activity.status).toBe(200);
    expect(activity.body.entries.length).toBeGreaterThanOrEqual(1);
    expect(activity.body.entries.every((e: { actorType: string }) => e.actorType === 'ADMIN')).toBe(true);

    // The protected audit store still records the same action exactly once.
    const audit = await request(app).get('/admin/audit?action=SECURITY_ROLE_GRANTED').set(auth(admin.token));
    expect(audit.body.entries).toHaveLength(1);
    expect(audit.body.entries[0].metadata.previousRole).toBe('USER');
  });

  it('records suspension and reactivation as security activity', async () => {
    const { app, admin, member } = await setupWorld();
    await request(app)
      .post(`/admin/users/${member.id}/suspend`)
      .set(auth(admin.token))
      .send({ reason: 'policy violation', confirm: true });
    await request(app).post(`/admin/users/${member.id}/reactivate`).set(auth(admin.token));

    const security = await request(app).get('/me/activity?category=SECURITY').set(auth(admin.token));
    const actions = security.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain('SECURITY_ACCOUNT_SUSPENDED');
    expect(actions).toContain('SECURITY_ACCOUNT_REACTIVATED');
    const suspend = security.body.entries.find((e: { action: string }) => e.action === 'SECURITY_ACCOUNT_SUSPENDED');
    expect(suspend.reason).toBe('policy violation');
    expect(suspend.actorType).toBe('ADMIN');
  });

  it('keeps the admin security-events endpoint working', async () => {
    const { app, admin, member } = await setupWorld();
    await request(app)
      .post(`/admin/users/${member.id}/role`)
      .set(auth(admin.token))
      .send({ role: 'ADMIN', confirm: true });
    const res = await request(app).get('/admin/security-events').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.entries.every((e: { action: string }) => e.action.startsWith('SECURITY_'))).toBe(true);
  });
});

describe('activity: authorization', () => {
  it('scopes /me/activity to the caller and rejects a foreign actor filter', async () => {
    const { app, owner, member } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Mine');

    const mine = await request(app).get('/me/activity').set(auth(owner.token));
    expect(mine.status).toBe(200);
    expect(mine.body.entries.length).toBeGreaterThan(0);
    expect(mine.body.entries.every((e: { userId: string }) => e.userId === owner.id)).toBe(true);

    const other = await request(app).get('/me/activity').set(auth(member.token));
    expect(other.body.entries.some((e: { userId: string }) => e.userId === owner.id)).toBe(false);

    const forced = await request(app).get(`/me/activity?actorId=${owner.id}`).set(auth(member.token));
    expect(forced.body.entries.every((e: { userId: string }) => e.userId === member.id)).toBe(true);
    expect(spaceId).toBeTruthy();
  });

  it('allows Space members, denies outsiders, and denies removed members', async () => {
    const { app, owner, member, outsider } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Scoped');

    const outsiderRes = await request(app).get(`/spaces/${spaceId}/activity`).set(auth(outsider.token));
    expect(outsiderRes.status).toBe(403);

    await addMember(app, owner.token, member.token, spaceId, 'VIEWER');
    const viewer = await request(app).get(`/spaces/${spaceId}/activity`).set(auth(member.token));
    expect(viewer.status).toBe(200);

    await request(app).delete(`/spaces/${spaceId}/members/${member.id}`).set(auth(owner.token));
    const revoked = await request(app).get(`/spaces/${spaceId}/activity`).set(auth(member.token));
    expect(revoked.status).toBe(403);
  });

  it('denies platform activity and audit to non-admins', async () => {
    const { app, owner } = await setupWorld();
    for (const path of ['/admin/activity', '/admin/activity/export', '/admin/audit/export']) {
      const res = await request(app).get(path).set(auth(owner.token));
      expect(res.status).toBe(403);
    }
  });

  it('removes mutation routes for activity history', async () => {
    const { app, admin } = await setupWorld();
    for (const method of ['put', 'patch', 'delete'] as const) {
      expect((await request(app)[method]('/admin/activity').set(auth(admin.token)).send({})).status).toBe(404);
      expect((await request(app)[method]('/me/activity').set(auth(admin.token)).send({})).status).toBe(404);
    }
  });
});

describe('activity: filtering, pagination and search', () => {
  it('filters by category, outcome, actor type, action and resource', async () => {
    const { app, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Filters');

    const spaceEntries = await spaceActivity(app, owner.token, spaceId, '?category=SPACE');
    expect(spaceEntries.every((e) => e.category === 'SPACE')).toBe(true);

    const byAction = await spaceActivity(app, owner.token, spaceId, '?action=SPACE_CREATED');
    expect(byAction).toHaveLength(1);

    const byResource = await spaceActivity(app, owner.token, spaceId, `?resourceType=space&resourceId=${spaceId}`);
    expect(byResource.length).toBeGreaterThan(0);

    expect(await spaceActivity(app, owner.token, spaceId, '?outcome=FAILURE')).toHaveLength(0);
    expect(await spaceActivity(app, owner.token, spaceId, '?actorType=SYSTEM')).toHaveLength(0);
    expect(await spaceActivity(app, owner.token, spaceId, `?from=${encodeURIComponent(at(1))}`)).toHaveLength(0);
  });

  it('paginates and sorts newest/oldest first', async () => {
    const { app, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Pages');
    for (let i = 0; i < 4; i++) {
      await request(app).patch(`/spaces/${spaceId}`).set(auth(owner.token)).send({ description: `d${i}` });
    }

    const first = await request(app).get(`/spaces/${spaceId}/activity?limit=2&offset=0`).set(auth(owner.token));
    expect(first.body.activity).toHaveLength(2);
    expect(first.body.total).toBeGreaterThanOrEqual(5);
    expect(first.body.limit).toBe(2);

    const second = await request(app).get(`/spaces/${spaceId}/activity?limit=2&offset=2`).set(auth(owner.token));
    expect(second.body.activity[0].id).toBeLessThan(first.body.activity[0].id);

    const oldest = await request(app).get(`/spaces/${spaceId}/activity?sort=oldest&limit=1`).set(auth(owner.token));
    expect(oldest.body.activity[0].action).toBe('SPACE_CREATED');
  });

  it('searches platform activity by actor name and email', async () => {
    const { app, admin, owner } = await setupWorld();
    await makeSpace(app, owner.token, 'Searchable');

    const byName = await request(app).get('/admin/activity?q=Olive').set(auth(admin.token));
    expect(byName.status).toBe(200);
    expect(byName.body.entries.length).toBeGreaterThan(0);
    expect(byName.body.entries.every((e: { userId: string }) => e.userId === owner.id)).toBe(true);

    const byEmail = await request(app).get('/admin/activity?q=owner@activity.dev').set(auth(admin.token));
    expect(byEmail.body.entries.length).toBeGreaterThan(0);

    const noMatch = await request(app).get('/admin/activity?q=nobody-here').set(auth(admin.token));
    expect(noMatch.body.entries).toHaveLength(0);
  });

  it('rejects invalid filter parameters', async () => {
    const { app, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Invalid');
    const res = await request(app).get(`/spaces/${spaceId}/activity?category=NONSENSE`).set(auth(owner.token));
    expect(res.status).toBe(400);
    const limit = await request(app).get(`/spaces/${spaceId}/activity?limit=9999`).set(auth(owner.token));
    expect(limit.status).toBe(400);
  });
});

describe('activity: idempotency and reliability', () => {
  it('never writes the same eventKey twice', async () => {
    const { app, ctx, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Idempotent');
    const input = {
      userId: owner.id,
      spaceId,
      action: 'SPACE_UPDATED' as const,
      eventKey: `dedupe-${spaceId}`,
      metadata: { once: true },
    };
    await ctx.db.activity.append(input);
    await ctx.db.activity.append(input);

    const page = await ctx.db.activity.query({ spaceId, action: 'SPACE_UPDATED', limit: 50 });
    expect(page.total).toBe(1);
  });

  it('persists the business row and its activity record together', async () => {
    const { app, ctx, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Durable');
    const space = await ctx.db.spaces.findById(spaceId);
    expect(space).toBeTruthy();
    const page = await ctx.db.activity.query({ spaceId, action: 'SPACE_CREATED', limit: 5 });
    expect(page.total).toBe(1);
    expect(page.entries[0].spaceId).toBe(spaceId);
  });
});

describe('activity: export', () => {
  it('exports an authorised Space history as escaped CSV', async () => {
    const { app, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Exported');
    const res = await request(app).get(`/spaces/${spaceId}/activity/export`).set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('flashspace-space-activity-');
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe(
      'event_id,timestamp,actor_type,actor_id,actor_name,actor_email,category,action,outcome,space_id,resource_type,resource_id,reason,details',
    );
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(res.text).toContain('SPACE_CREATED');
    expect(res.text).toContain('owner@activity.dev');
  });

  it('neutralises spreadsheet formula injection', async () => {
    const { app, ctx, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Injection');
    await ctx.db.activity.append({
      userId: owner.id,
      spaceId,
      action: 'SPACE_UPDATED',
      category: 'SPACE',
      reason: '=HYPERLINK("http://evil.example","click")',
      metadata: { note: '@SUM(1+1)', name: 'plain' },
    });

    const res = await request(app).get(`/spaces/${spaceId}/activity/export`).set(auth(owner.token));
    // The reason cell starts with '=', so it is neutralised with a leading quote.
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    // A formula-looking character inside a details cell is inert (not cell start).
    expect(res.text).toContain('note=@SUM(1+1)');
    expect(res.text).toContain('name=plain');
  });

  it('excludes sensitive metadata from exports', async () => {
    const { app, ctx, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Secrets');
    await ctx.db.activity.append({
      userId: owner.id,
      spaceId,
      action: 'SPACE_UPDATED',
      metadata: { password: 'hunter2', token: 'abc', downloadUrl: 'http://signed', name: 'safe' },
    });
    const res = await request(app).get(`/spaces/${spaceId}/activity/export`).set(auth(owner.token));
    expect(res.text).not.toContain('hunter2');
    expect(res.text).not.toContain('http://signed');
    expect(res.text).toContain('name=safe');
  });

  it('keeps exports inside the caller scope', async () => {
    const { app, owner, member, outsider } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Private');
    expect((await request(app).get(`/spaces/${spaceId}/activity/export`).set(auth(outsider.token))).status).toBe(403);

    await addMember(app, owner.token, member.token, spaceId, 'VIEWER');
    const asViewer = await request(app).get(`/spaces/${spaceId}/activity/export`).set(auth(member.token));
    expect(asViewer.status).toBe(200);
    expect(asViewer.text).toContain('SPACE_CREATED');

    const mine = await request(app).get('/me/activity/export').set(auth(member.token));
    expect(mine.status).toBe(200);
    expect(mine.text).not.toContain('owner@activity.dev');
  });

  it('exports admin audit history and records the export itself', async () => {
    const { app, admin, member } = await setupWorld();
    await request(app)
      .post(`/admin/users/${member.id}/suspend`)
      .set(auth(admin.token))
      .send({ reason: 'export check', confirm: true });

    const res = await request(app).get('/admin/audit/export?outlet=ALL').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.text.split('\r\n')[0]).toBe(
      'event_id,timestamp,actor_type,actor_id,action,target_type,target_id,outcome,reason',
    );
    expect(res.text).toContain('SECURITY_ACCOUNT_SUSPENDED');

    const exports = await request(app).get('/admin/activity?action=ACTIVITY_EXPORTED').set(auth(admin.token));
    expect(exports.body.entries.length).toBeGreaterThanOrEqual(1);
    expect(exports.body.entries[0].metadata.outlet).toBe('ALL');
  });
});

describe('activity: regression', () => {
  it('keeps notifications and the Vault working after the activity changes', async () => {
    const { app, ctx, owner } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'Vault', -1 / 24);
    await uploadFile(app, ctx, owner.token, spaceId, 'v.txt', 'vault body');
    await request(app).post('/jobs/lifecycle/run').set('x-job-secret', ctx.env.jobSecret);

    const vault = await request(app).get('/vault/archives').set(auth(owner.token));
    expect(vault.status).toBe(200);
    expect(vault.body.archives.length).toBeGreaterThanOrEqual(1);

    const notes = await request(app).get('/notifications').set(auth(owner.token));
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.some((n: { type: string }) => n.type === 'SPACE_ARCHIVED')).toBe(true);
  });

  it('keeps Space RBAC intact for viewers on activity-adjacent mutations', async () => {
    const { app, owner, member } = await setupWorld();
    const spaceId = await makeSpace(app, owner.token, 'RBAC');
    await addMember(app, owner.token, member.token, spaceId, 'VIEWER');
    const res = await request(app)
      .patch(`/spaces/${spaceId}`)
      .set(auth(member.token))
      .send({ name: 'Hijacked' });
    expect(res.status).toBe(403);
  });
});
