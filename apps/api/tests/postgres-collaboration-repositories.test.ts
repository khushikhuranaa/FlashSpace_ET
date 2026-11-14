import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { Profile, Space } from '@flashspace/shared';
import { loadEnv } from '../src/config/env.js';
import { SqliteDataLayer } from '../src/repositories/sqlite/sqlite.data-layer.js';
import {
  createPostgresCoreRepositories,
  type PostgresCoreRepositories,
} from '../src/repositories/postgres/core.js';
import { migrateDatabase } from '../src/repositories/postgres/migrate.js';
import {
  createDisposableDatabase,
  postgresTestUrl,
  type DisposableDatabase,
} from './helpers/postgres.js';

const baseUrl = postgresTestUrl();
const describePg = baseUrl ? describe : describe.skip;

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const T2 = '2026-01-03T00:00:00.000Z';
const T3 = '2026-01-04T00:00:00.000Z';

function profile(id: string, email: string): Profile {
  return {
    id,
    email,
    displayName: `User ${id}`,
    role: 'USER',
    avatarUrl: null,
    createdAt: T0,
    updatedAt: T0,
    status: 'ACTIVE',
  };
}

function space(id: string, ownerId: string, patch: Partial<Space> = {}): Space {
  return {
    id,
    ownerId,
    name: `Space ${id}`,
    purpose: 'Testing',
    description: '',
    startAt: T0,
    expiryAt: T3,
    status: 'ACTIVE',
    warningSentAt: null,
    archivedManually: false,
    invitationsEnabled: true,
    defaultInviteRole: 'VIEWER',
    createdAt: T0,
    updatedAt: T0,
    ...patch,
  };
}

describePg('postgres collaboration repositories', () => {
  let db: DisposableDatabase;
  let pool: Pool;
  let repos: PostgresCoreRepositories;

  beforeAll(async () => {
    db = await createDisposableDatabase(baseUrl!);
    await migrateDatabase(db.url);
    pool = new Pool({ connectionString: db.url, max: 4 });
    repos = createPostgresCoreRepositories(
      loadEnv({ repoMode: 'postgres', databaseUrl: db.url, nodeEnv: 'test' }),
      pool,
    );
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
  });

  beforeEach(async () => {
    await pool.query('truncate table profiles cascade');
    await repos.auth.create(profile('owner', 'owner@example.test'), 'h');
    await repos.auth.create(profile('member', 'member@example.test'), 'h');
    await repos.spaces.insert(space('s1', 'owner'));
    await repos.spaces.insert(space('s2', 'owner'));
  });

  describe('folders', () => {
    it('supports create/read/list/update/delete with Space-scoped uniqueness', async () => {
      await repos.folders.insert({
        id: 'f1',
        spaceId: 's1',
        parentId: null,
        name: 'Docs',
        path: 'Docs',
        createdAt: T0,
        updatedAt: T0,
      });
      await repos.folders.insert({
        id: 'f2',
        spaceId: 's1',
        parentId: 'f1',
        name: 'Specs',
        path: 'Docs/Specs',
        createdAt: T1,
        updatedAt: T1,
      });

      expect(await repos.folders.findById('f1')).toMatchObject({ name: 'Docs', parentId: null });
      expect((await repos.folders.listForSpace('s1')).map((f) => f.id)).toEqual(['f1', 'f2']);
      expect(await repos.folders.listForSpace('s2')).toEqual([]);

      const renamed = await repos.folders.update('f2', { name: 'Design', parentId: null });
      expect(renamed).toMatchObject({ name: 'Design', parentId: null, path: 'Docs/Specs' });
      expect(await repos.folders.update('missing', { name: 'x' })).toBeUndefined();

      await expect(
        repos.folders.insert({
          id: 'f3',
          spaceId: 's1',
          parentId: null,
          name: 'Docs',
          path: 'Docs',
          createdAt: T2,
          updatedAt: T2,
        }),
      ).rejects.toMatchObject({ code: 'DUPLICATE' });
      await expect(
        repos.folders.insert({
          id: 'f4',
          spaceId: 'missing',
          parentId: null,
          name: 'x',
          path: 'x',
          createdAt: T2,
          updatedAt: T2,
        }),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });

      expect(await repos.folders.delete('f2')).toBe(true);
      expect(await repos.folders.delete('f2')).toBe(false);
      expect(await repos.folders.findById('f2')).toBeUndefined();
    });
  });

  describe('files', () => {
    it('stores metadata, filters deleted rows and sums active bytes', async () => {
      await repos.folders.insert({
        id: 'f1',
        spaceId: 's1',
        parentId: null,
        name: 'Docs',
        path: 'Docs',
        createdAt: T0,
        updatedAt: T0,
      });
      await repos.files.insert({
        id: 'file1',
        spaceId: 's1',
        folderId: 'f1',
        uploaderId: 'owner',
        name: 'a.txt',
        objectKey: 'spaces/s1/a.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        etag: 'etag-a',
        sha256: null,
        status: 'ACTIVE',
        createdAt: T0,
        updatedAt: T0,
        deletedAt: null,
      });
      await repos.files.insert({
        id: 'file2',
        spaceId: 's1',
        folderId: null,
        uploaderId: 'member',
        name: 'b.txt',
        objectKey: 'spaces/s1/b.txt',
        mimeType: 'text/plain',
        sizeBytes: 25,
        etag: null,
        sha256: 'sha',
        status: 'PENDING',
        createdAt: T1,
        updatedAt: T1,
        deletedAt: null,
      });
      await repos.files.insert({
        id: 'file3',
        spaceId: 's1',
        folderId: null,
        uploaderId: 'owner',
        name: 'c.txt',
        objectKey: 'spaces/s1/c.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        etag: null,
        sha256: null,
        status: 'DELETED',
        createdAt: T2,
        updatedAt: T2,
        deletedAt: T2,
      });

      expect((await repos.files.findById('file1'))?.sizeBytes).toBe(10);
      expect((await repos.files.findByObjectKey('spaces/s1/a.txt'))?.id).toBe('file1');
      expect((await repos.files.listForSpace('s1')).map((f) => f.id)).toEqual([
        'file3',
        'file2',
        'file1',
      ]);
      expect((await repos.files.listActiveForSpace('s1')).map((f) => f.id)).toEqual([
        'file2',
        'file1',
      ]);
      expect((await repos.files.listAll()).map((f) => f.id)).toEqual(['file3', 'file2', 'file1']);
      expect(await repos.files.usedBytesForSpace('s1')).toBe(35);

      const updated = await repos.files.update('file2', {
        status: 'ACTIVE',
        folderId: 'f1',
        sizeBytes: 30,
      });
      expect(updated).toMatchObject({ status: 'ACTIVE', folderId: 'f1', sizeBytes: 30 });
      expect(updated?.name).toBe('b.txt');
      expect(await repos.files.usedBytesForSpace('s1')).toBe(40);

      await expect(
        repos.files.insert({
          id: 'dup',
          spaceId: 's1',
          folderId: null,
          uploaderId: 'owner',
          name: 'dup',
          objectKey: 'spaces/s1/a.txt',
          mimeType: 'text/plain',
          sizeBytes: 1,
          etag: null,
          sha256: null,
          status: 'ACTIVE',
          createdAt: T2,
          updatedAt: T2,
          deletedAt: null,
        }),
      ).rejects.toMatchObject({ code: 'DUPLICATE' });
      await expect(
        repos.files.insert({
          id: 'bad-fk',
          spaceId: 'missing',
          folderId: null,
          uploaderId: 'owner',
          name: 'bad',
          objectKey: 'bad',
          mimeType: 'text/plain',
          sizeBytes: 1,
          etag: null,
          sha256: null,
          status: 'ACTIVE',
          createdAt: T2,
          updatedAt: T2,
          deletedAt: null,
        }),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });
      await expect(
        repos.files.insert({
          id: 'negative',
          spaceId: 's1',
          folderId: null,
          uploaderId: 'owner',
          name: 'negative',
          objectKey: 'negative',
          mimeType: 'text/plain',
          sizeBytes: -1,
          etag: null,
          sha256: null,
          status: 'ACTIVE',
          createdAt: T2,
          updatedAt: T2,
          deletedAt: null,
        }),
      ).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATION' });
    });
  });

  describe('invitations and invite links', () => {
    it('normalises email, keeps only pending lookups and updates decisions', async () => {
      await repos.invitations.insert({
        id: 'i1',
        spaceId: 's1',
        inviterId: 'owner',
        email: 'Guest@Example.test',
        intendedRole: 'EDITOR',
        tokenHash: 'hash-1',
        status: 'PENDING',
        expiresAt: T2,
        createdAt: T0,
      });
      await repos.invitations.insert({
        id: 'i2',
        spaceId: 's1',
        inviterId: 'owner',
        email: 'other@example.test',
        intendedRole: 'VIEWER',
        tokenHash: 'hash-2',
        status: 'ACCEPTED',
        expiresAt: T2,
        createdAt: T1,
      });

      expect(await repos.invitations.findById('i1')).toMatchObject({
        email: 'guest@example.test',
        tokenHash: 'hash-1',
      });
      expect((await repos.invitations.listForSpace('s1')).map((i) => i.id)).toEqual(['i2', 'i1']);
      expect((await repos.invitations.listAll()).map((i) => i.id)).toEqual(['i2', 'i1']);

      expect((await repos.invitations.findBySpaceAndEmail('s1', 'GUEST@example.test'))?.id).toBe(
        'i1',
      );
      expect(
        await repos.invitations.findBySpaceAndEmail('s1', 'other@example.test'),
      ).toBeUndefined();

      const accepted = await repos.invitations.update('i1', {
        status: 'ACCEPTED',
        tokenHash: null,
      });
      expect(accepted).toMatchObject({ status: 'ACCEPTED', tokenHash: null });
      expect(
        await repos.invitations.findBySpaceAndEmail('s1', 'guest@example.test'),
      ).toBeUndefined();
      expect(await repos.invitations.update('missing', { status: 'EXPIRED' })).toBeUndefined();

      await expect(
        repos.invitations.insert({
          id: 'bad',
          spaceId: 'missing',
          inviterId: 'owner',
          email: 'x@example.test',
          intendedRole: 'VIEWER',
          tokenHash: 'h',
          status: 'PENDING',
          expiresAt: T2,
          createdAt: T0,
        }),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });
    });

    it('stores invite links, resolves tokens, revokes and rotates', async () => {
      await repos.inviteLinks.insert({
        id: 'l1',
        spaceId: 's1',
        createdBy: 'owner',
        token: 'token-1',
        role: 'EDITOR',
        createdAt: T0,
        revokedAt: null,
      });
      await repos.inviteLinks.insert({
        id: 'l2',
        spaceId: 's1',
        createdBy: 'owner',
        token: 'token-2',
        role: 'VIEWER',
        createdAt: T1,
        revokedAt: null,
      });

      expect((await repos.inviteLinks.findByToken('token-1'))?.id).toBe('l1');
      expect((await repos.inviteLinks.findActiveForSpace('s1'))?.id).toBe('l2');
      expect((await repos.inviteLinks.listForSpace('s1')).map((l) => l.id)).toEqual(['l2', 'l1']);

      await repos.inviteLinks.update('l2', { revokedAt: T2 });
      expect((await repos.inviteLinks.findActiveForSpace('s1'))?.id).toBe('l1');
      expect((await repos.inviteLinks.findById('l2'))?.revokedAt).toBe(T2);
      expect(await repos.inviteLinks.update('missing', { role: 'VIEWER' })).toBeUndefined();

      await expect(
        repos.inviteLinks.insert({
          id: 'l3',
          spaceId: 's1',
          createdBy: 'owner',
          token: 'token-1',
          role: 'VIEWER',
          createdAt: T3,
          revokedAt: null,
        }),
      ).rejects.toMatchObject({ code: 'DUPLICATE' });
    });
  });

  describe('join requests and extension requests', () => {
    it('tracks join requests by Space, requester, invitation and status', async () => {
      await repos.invitations.insert({
        id: 'i1',
        spaceId: 's1',
        inviterId: 'owner',
        email: 'member@example.test',
        intendedRole: 'VIEWER',
        tokenHash: 'h',
        status: 'PENDING',
        expiresAt: T2,
        createdAt: T0,
      });
      await repos.joinRequests.insert({
        id: 'j1',
        spaceId: 's1',
        requesterId: 'member',
        role: 'VIEWER',
        source: 'EMAIL',
        invitationId: 'i1',
        status: 'PENDING',
        createdAt: T0,
        decidedBy: null,
        decidedAt: null,
      });
      await repos.joinRequests.insert({
        id: 'j2',
        spaceId: 's1',
        requesterId: 'member',
        role: 'EDITOR',
        source: 'LINK',
        invitationId: null,
        status: 'DECLINED',
        createdAt: T1,
        decidedBy: 'owner',
        decidedAt: T1,
      });

      expect(await repos.joinRequests.findById('j1')).toMatchObject({ source: 'EMAIL' });
      expect((await repos.joinRequests.listForSpace('s1')).map((j) => j.id)).toEqual(['j2', 'j1']);
      expect(
        (await repos.joinRequests.listForSpace('s1', 'PENDING')).map((j) => j.id),
      ).toEqual(['j1']);
      expect((await repos.joinRequests.listForRequester('member')).map((j) => j.id)).toEqual([
        'j2',
        'j1',
      ]);
      expect((await repos.joinRequests.findPendingForUser('s1', 'member'))?.id).toBe('j1');
      expect((await repos.joinRequests.findOpenForInvitation('i1'))?.id).toBe('j1');
      expect((await repos.joinRequests.listAll()).map((j) => j.id)).toEqual(['j2', 'j1']);

      const accepted = await repos.joinRequests.update('j1', {
        status: 'ACCEPTED',
        decidedBy: 'owner',
        decidedAt: T2,
      });
      expect(accepted).toMatchObject({ status: 'ACCEPTED', decidedBy: 'owner' });
      expect(await repos.joinRequests.update('missing', { status: 'ACCEPTED' })).toBeUndefined();

      await expect(
        repos.joinRequests.insert({
          id: 'bad',
          spaceId: 's1',
          requesterId: 'ghost',
          role: 'VIEWER',
          source: 'LINK',
          invitationId: null,
          status: 'PENDING',
          createdAt: T2,
          decidedBy: null,
          decidedAt: null,
        }),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });
    });

    it('tracks extension decisions and enforces positive requested days', async () => {
      await repos.extensionRequests.insert({
        id: 'e1',
        spaceId: 's1',
        requesterId: 'member',
        requestedDays: 3,
        reason: 'Need more time',
        status: 'PENDING',
        decidedBy: null,
        decidedAt: null,
        rejectionReason: null,
        adminNote: null,
        previousExpiryAt: null,
        newExpiryAt: null,
        approvalMethod: null,
        createdAt: T0,
      });

      expect(await repos.extensionRequests.findById('e1')).toMatchObject({
        requestedDays: 3,
        status: 'PENDING',
      });
      expect((await repos.extensionRequests.listForSpace('s1')).map((e) => e.id)).toEqual(['e1']);
      expect((await repos.extensionRequests.listAll()).map((e) => e.id)).toEqual(['e1']);
      expect((await repos.extensionRequests.findPendingForSpace('s1'))?.id).toBe('e1');

      const approved = await repos.extensionRequests.update('e1', {
        status: 'APPROVED',
        decidedBy: 'owner',
        decidedAt: T1,
        previousExpiryAt: T3,
        newExpiryAt: T2,
        approvalMethod: 'MANUAL',
      });
      expect(approved).toMatchObject({
        status: 'APPROVED',
        previousExpiryAt: T3,
        newExpiryAt: T2,
        approvalMethod: 'MANUAL',
      });
      expect(await repos.extensionRequests.findPendingForSpace('s1')).toBeUndefined();
      expect(await repos.extensionRequests.update('missing', { status: 'REJECTED' })).toBeUndefined();

      await expect(
        repos.extensionRequests.insert({
          id: 'e2',
          spaceId: 's1',
          requesterId: 'member',
          requestedDays: 0,
          reason: 'bad',
          status: 'PENDING',
          decidedBy: null,
          decidedAt: null,
          rejectionReason: null,
          adminNote: null,
          previousExpiryAt: null,
          newExpiryAt: null,
          approvalMethod: null,
          createdAt: T1,
        }),
      ).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATION' });
    });
  });

  describe('notifications', () => {
    it('lists, marks one read idempotently and marks all read', async () => {
      await repos.notifications.insert({
        id: 'n1',
        userId: 'member',
        spaceId: 's1',
        type: 'MEMBER_INVITED',
        title: 'Invitation',
        body: 'Join s1',
        inviteLinkId: null,
        joinRequestId: null,
        readAt: null,
        createdAt: T0,
      });
      await repos.notifications.insert({
        id: 'n2',
        userId: 'member',
        spaceId: 's2',
        type: 'SPACE_WARNING',
        title: 'Expiring',
        body: 'Soon',
        inviteLinkId: null,
        joinRequestId: null,
        readAt: null,
        createdAt: T1,
      });

      expect((await repos.notifications.listForUser('member')).map((n) => n.id)).toEqual([
        'n2',
        'n1',
      ]);
      expect(await repos.notifications.listForUser('owner')).toEqual([]);

      const first = await repos.notifications.markRead('n1');
      expect(first?.readAt).not.toBeNull();
      const second = await repos.notifications.markRead('n1');
      expect(second?.readAt).toBe(first?.readAt);

      expect(await repos.notifications.markAllRead('member')).toBe(1);
      expect((await repos.notifications.findById('n2'))?.readAt).not.toBeNull();
      expect(await repos.notifications.markAllRead('member')).toBe(0);
      expect(await repos.notifications.markRead('missing')).toBeUndefined();

      await expect(
        repos.notifications.insert({
          id: 'bad',
          userId: 'ghost',
          spaceId: null,
          type: 'SPACE_WARNING',
          title: 'x',
          body: 'x',
          inviteLinkId: null,
          joinRequestId: null,
          readAt: null,
          createdAt: T2,
        }),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });
    });
  });

  describe('activity', () => {
    it('appends with inferred fields and deduplicates event keys', async () => {
      const entry = await repos.activity.append({
        userId: 'owner',
        spaceId: 's1',
        action: 'SPACE_CREATED',
        metadata: { name: 'Demo' },
      });
      expect(entry).toMatchObject({
        userId: 'owner',
        spaceId: 's1',
        action: 'SPACE_CREATED',
        actorType: 'USER',
        outcome: 'SUCCESS',
        category: 'SPACE',
        resourceType: 'space',
        resourceId: 's1',
      });
      expect(entry.metadata).toEqual({ name: 'Demo' });
      expect(typeof entry.id).toBe('number');

      const keyed = await repos.activity.append({
        action: 'FILE_UPLOADED',
        fileId: null,
        eventKey: 'once-only',
        actorType: 'SYSTEM',
        category: 'FILE',
      });
      const duplicate = await repos.activity.append({
        action: 'FILE_UPLOADED',
        eventKey: 'once-only',
        category: 'FILE',
      });
      expect(duplicate.id).toBe(keyed.id);
      expect(duplicate.actorType).toBe('SYSTEM');
      expect(await repos.activity.findById(keyed.id)).toMatchObject({ eventKey: 'once-only' });

      const system = await repos.activity.append({ action: 'LIFECYCLE_RUN' });
      expect(system).toMatchObject({ actorType: 'SYSTEM', resourceType: null, resourceId: null });

      await expect(
        repos.activity.append({ action: 'BAD', userId: 'ghost' }),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });
    });

    it('lists newest first and filters/paginates without leaking other Spaces', async () => {
      const spaceIds = ['s1', 's2'];
      for (let i = 0; i < 5; i += 1) {
        await repos.activity.append({
          userId: i % 2 === 0 ? 'owner' : 'member',
          spaceId: spaceIds[i % 2]!,
          action: i === 4 ? 'FILE_DELETED' : 'FILE_UPLOADED',
          category: 'FILE',
          outcome: i === 3 ? 'FAILURE' : 'SUCCESS',
          resourceType: 'file',
          resourceId: `file-${i}`,
        });
      }

      const all = await repos.activity.listAll(3);
      expect(all).toHaveLength(3);
      expect(all[0]!.id).toBeGreaterThan(all[1]!.id);

      const forSpace = await repos.activity.listForSpace('s1');
      expect(forSpace.every((e) => e.spaceId === 's1')).toBe(true);
      expect(forSpace[0]!.id).toBeGreaterThan(forSpace.at(-1)!.id);

      const forUser = await repos.activity.listForUser('owner');
      expect(forUser.every((e) => e.userId === 'owner')).toBe(true);

      const page = await repos.activity.query({ spaceId: 's1', limit: 1, offset: 0 });
      expect(page.entries).toHaveLength(1);
      expect(page.total).toBe(3);
      expect(page.limit).toBe(1);
      expect(page.offset).toBe(0);

      const oldest = await repos.activity.query({ sort: 'oldest', limit: 10 });
      expect(oldest.entries[0]!.id).toBeLessThan(oldest.entries.at(-1)!.id);

      const failures = await repos.activity.query({ outcome: 'FAILURE', limit: 10 });
      expect(failures.entries).toHaveLength(1);
      expect(failures.entries[0]!.resourceId).toBe('file-3');

      const actions = await repos.activity.query({ action: 'FILE_DELETED', limit: 10 });
      expect(actions.total).toBe(1);

      const scoped = await repos.activity.query({ spaceIds: ['s2'], limit: 10 });
      expect(scoped.entries.every((e) => e.spaceId === 's2')).toBe(true);

      expect(await repos.activity.query({ spaceIds: [], limit: 10 })).toEqual({
        entries: [],
        total: 0,
        limit: 10,
        offset: 0,
      });
      expect((await repos.activity.query({ userIds: ['member'], limit: 10 })).total).toBe(2);
      expect((await repos.activity.query({ actorType: 'USER', limit: 10 })).total).toBe(5);

      const future = await repos.activity.query({ from: '2030-01-01T00:00:00.000Z', limit: 10 });
      expect(future.total).toBe(0);
      const past = await repos.activity.query({ to: '2000-01-01T00:00:00.000Z', limit: 10 });
      expect(past.total).toBe(0);
    });
  });

  it('persists collaboration rows across a pool restart', async () => {
    await repos.folders.insert({
      id: 'persist-folder',
      spaceId: 's1',
      parentId: null,
      name: 'Persist',
      path: 'Persist',
      createdAt: T0,
      updatedAt: T0,
    });
    await repos.notifications.insert({
      id: 'persist-note',
      userId: 'owner',
      spaceId: 's1',
      type: 'SPACE_WARNING',
      title: 'Persist',
      body: 'Persist',
      inviteLinkId: null,
      joinRequestId: null,
      readAt: null,
      createdAt: T0,
    });

    const restartPool = new Pool({ connectionString: db.url, max: 2 });
    try {
      const reopened = createPostgresCoreRepositories(
        loadEnv({ repoMode: 'postgres', databaseUrl: db.url, nodeEnv: 'test' }),
        restartPool,
      );
      expect(await reopened.folders.findById('persist-folder')).toMatchObject({ name: 'Persist' });
      expect(await reopened.notifications.findById('persist-note')).toMatchObject({
        title: 'Persist',
      });
    } finally {
      await restartPool.end();
    }
  });
});

describe('collaboration repositories SQLite parity', () => {
  it('matches SQLite for folders, files, invitations, notifications and activity reads', async () => {
    if (!baseUrl) return;
    const db = await createDisposableDatabase(baseUrl);
    let pool: Pool | null = null;
    const sqlite = new SqliteDataLayer(':memory:');
    try {
      await migrateDatabase(db.url);
      pool = new Pool({ connectionString: db.url, max: 2 });
      const pg = createPostgresCoreRepositories(
        loadEnv({ repoMode: 'postgres', databaseUrl: db.url, nodeEnv: 'test' }),
        pool,
      );

      for (const layer of [sqlite, pg]) {
        await layer.auth.create(profile('owner', 'parity@example.test'), 'h');
        await layer.spaces.insert(space('s1', 'owner'));
        await layer.folders.insert({
          id: 'f1',
          spaceId: 's1',
          parentId: null,
          name: 'Docs',
          path: 'Docs',
          createdAt: T0,
          updatedAt: T0,
        });
        await layer.files.insert({
          id: 'file1',
          spaceId: 's1',
          folderId: 'f1',
          uploaderId: 'owner',
          name: 'a.txt',
          objectKey: 'a.txt',
          mimeType: 'text/plain',
          sizeBytes: 7,
          etag: null,
          sha256: null,
          status: 'ACTIVE',
          createdAt: T0,
          updatedAt: T0,
          deletedAt: null,
        });
        await layer.invitations.insert({
          id: 'i1',
          spaceId: 's1',
          inviterId: 'owner',
          email: 'Guest@Example.test',
          intendedRole: 'VIEWER',
          tokenHash: 'hash',
          status: 'PENDING',
          expiresAt: T2,
          createdAt: T0,
        });
        await layer.notifications.insert({
          id: 'n1',
          userId: 'owner',
          spaceId: 's1',
          type: 'SPACE_WARNING',
          title: 'Hi',
          body: 'Body',
          inviteLinkId: null,
          joinRequestId: null,
          readAt: null,
          createdAt: T0,
        });
        await layer.activity.append({ userId: 'owner', spaceId: 's1', action: 'SPACE_CREATED' });
      }

      expect((await sqlite.folders.listForSpace('s1')).map((f) => f.id)).toEqual(
        (await pg.folders.listForSpace('s1')).map((f) => f.id),
      );
      expect((await sqlite.files.listActiveForSpace('s1')).map((f) => f.name)).toEqual(
        (await pg.files.listActiveForSpace('s1')).map((f) => f.name),
      );
      expect((await sqlite.invitations.findBySpaceAndEmail('s1', 'guest@example.test'))?.id).toBe(
        (await pg.invitations.findBySpaceAndEmail('s1', 'guest@example.test'))?.id,
      );
      expect((await sqlite.files.usedBytesForSpace('s1'))).toBe(
        await pg.files.usedBytesForSpace('s1'),
      );
      expect((await sqlite.notifications.listForUser('owner')).map((n) => n.title)).toEqual(
        (await pg.notifications.listForUser('owner')).map((n) => n.title),
      );
      expect((await sqlite.activity.query({ limit: 10 })).entries.map((e) => e.action)).toEqual(
        (await pg.activity.query({ limit: 10 })).entries.map((e) => e.action),
      );
    } finally {
      await pool?.end();
      await db.drop();
    }
  });
});
