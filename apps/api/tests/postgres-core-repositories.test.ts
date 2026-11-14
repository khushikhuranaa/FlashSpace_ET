import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { Profile, Space, SpaceMember } from '@flashspace/shared';
import { loadEnv } from '../src/config/env.js';
import { SqliteDataLayer } from '../src/repositories/sqlite/sqlite.data-layer.js';
import { createPostgresCoreRepositories, type PostgresCoreRepositories } from '../src/repositories/postgres/core.js';
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

function profile(id: string, email: string, patch: Partial<Profile> = {}): Profile {
  return {
    id,
    email,
    displayName: `User ${id}`,
    role: 'USER',
    avatarUrl: null,
    createdAt: T0,
    updatedAt: T0,
    status: 'ACTIVE',
    suspendedAt: null,
    suspendedBy: null,
    suspensionReason: null,
    lastActiveAt: null,
    emailVerifiedAt: null,
    ...patch,
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
    expiryAt: T2,
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

function member(
  spaceId: string,
  userId: string,
  role: SpaceMember['role'],
  patch: Partial<SpaceMember> = {},
): SpaceMember {
  return {
    spaceId,
    userId,
    role,
    status: 'ACTIVE',
    joinedAt: T1,
    revokedAt: null,
    ...patch,
  };
}

describePg('postgres core repositories', () => {
  let db: DisposableDatabase;
  let pool: Pool;
  let repos: PostgresCoreRepositories;

  beforeAll(async () => {
    db = await createDisposableDatabase(baseUrl!);
    const report = await migrateDatabase(db.url, { applyLocalShim: true });
    expect(report.applied).toContain('008_auth_sessions.sql');
    pool = new Pool({ connectionString: db.url, max: 4 });
    const env = loadEnv({ repoMode: 'postgres', databaseUrl: db.url, nodeEnv: 'test' });
    repos = createPostgresCoreRepositories(env, pool);
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
  });

  beforeEach(async () => {
    // Disposable database only; profiles cascade to every table under test.
    await pool.query('truncate table profiles cascade');
  });

  describe('auth + profiles', () => {
    it('creates a profile and credentials, and finds them by id and email', async () => {
      const p = profile('u1', 'One@Example.test');
      await repos.auth.create(p, 'scrypt$hash');

      const byId = await repos.auth.findById('u1');
      expect(byId).toMatchObject({
        id: 'u1',
        email: 'one@example.test',
        displayName: 'User u1',
        role: 'USER',
        status: 'ACTIVE',
        avatarUrl: null,
      });
      expect(byId?.createdAt).toBe(T0);

      const byEmail = await repos.auth.findByEmail('ONE@example.test');
      expect(byEmail?.id).toBe('u1');

      const credentials = await repos.auth.getCredentials('u1');
      expect(credentials?.passwordHash).toBe('scrypt$hash');
      expect(credentials?.profile.id).toBe('u1');
    });

    it('rejects duplicate emails and does not leave credentials behind', async () => {
      await repos.auth.create(profile('u1', 'dup@example.test'), 'hash-1');
      await expect(
        repos.auth.create(profile('u2', 'dup@example.test'), 'hash-2'),
      ).rejects.toMatchObject({ code: 'DUPLICATE' });

      const rows = await pool.query('select 1 from credentials where user_id = $1', ['u2']);
      expect(rows.rowCount).toBe(0);
      expect(await repos.auth.count()).toBe(1);
    });

    it('updates display name/avatar, password and verification state', async () => {
      await repos.auth.create(profile('u1', 'update@example.test'), 'old-hash');

      const updated = await repos.auth.update('u1', { displayName: 'Renamed' });
      expect(updated?.displayName).toBe('Renamed');
      expect(updated?.avatarUrl).toBeNull();

      const avatar = await repos.auth.update('u1', { avatarUrl: 'avatars/u1/a.webp' });
      expect(avatar?.avatarUrl).toBe('avatars/u1/a.webp');
      expect(avatar?.displayName).toBe('Renamed');

      const cleared = await repos.auth.update('u1', { avatarUrl: null });
      expect(cleared?.avatarUrl).toBeNull();

      await repos.auth.setPasswordHash('u1', 'new-hash');
      expect((await repos.auth.getCredentials('u1'))?.passwordHash).toBe('new-hash');

      await repos.auth.markEmailVerified('u1', T2);
      const verified = await repos.auth.findById('u1');
      expect(verified?.emailVerifiedAt).toBe(T2);

      await repos.auth.touchLastActive('u1', T3);
      expect((await repos.auth.findById('u1'))?.lastActiveAt).toBe(T3);
    });

    it('changes email only when unique, and resets verification', async () => {
      await repos.auth.create(profile('u1', 'a@example.test'), 'h');
      await repos.auth.create(profile('u2', 'b@example.test'), 'h');
      await repos.auth.markEmailVerified('u1', T1);

      expect(await repos.auth.updateEmail('u1', 'b@example.test')).toBeUndefined();
      expect((await repos.auth.findById('u1'))?.email).toBe('a@example.test');

      const changed = await repos.auth.updateEmail('u1', 'New@Example.test');
      expect(changed?.email).toBe('new@example.test');
      expect(changed?.emailVerifiedAt).toBeNull();
    });

    it('lists users with search, role/status filters, sorting and pagination', async () => {
      await repos.auth.create(profile('u1', 'ann@example.test', {
        displayName: 'Ann',
        createdAt: T0,
        lastActiveAt: T2,
      }), 'h');
      await repos.auth.create(profile('u2', 'bob@example.test', {
        displayName: 'Bob',
        role: 'ADMIN',
        createdAt: T1,
      }), 'h');
      await repos.auth.setStatus('u2', {
        status: 'SUSPENDED',
        suspendedAt: T2,
        suspendedBy: 'admin',
        suspensionReason: 'test',
      });

      const found = await repos.auth.list({ q: 'bob', limit: 10, offset: 0 });
      expect(found.total).toBe(1);
      expect(found.users[0]?.id).toBe('u2');

      const admins = await repos.auth.list({ role: 'ADMIN', limit: 10, offset: 0 });
      expect(admins.users.map((u) => u.id)).toEqual(['u2']);

      const suspended = await repos.auth.list({ status: 'SUSPENDED', limit: 10, offset: 0 });
      expect(suspended.users.map((u) => u.id)).toEqual(['u2']);

      const byName = await repos.auth.list({ sort: 'name-desc', limit: 10, offset: 0 });
      expect(byName.users.map((u) => u.displayName)).toEqual(['Bob', 'Ann']);

      const firstPage = await repos.auth.list({ sort: 'created-asc', limit: 1, offset: 0 });
      expect(firstPage.users.map((u) => u.id)).toEqual(['u1']);
      const secondPage = await repos.auth.list({ sort: 'created-asc', limit: 1, offset: 1 });
      expect(secondPage.users.map((u) => u.id)).toEqual(['u2']);

      // Suspension does not change the role, and countAdmins counts roles.
      expect(await repos.auth.countAdmins()).toBe(1);
      await repos.auth.setRole('u2', 'USER');
      expect(await repos.auth.countAdmins()).toBe(0);
      await repos.auth.setRole('u1', 'ADMIN');
      expect(await repos.auth.countAdmins()).toBe(1);
    });

    it('ensureProfile is idempotent and updates/deletes as expected', async () => {
      const p = profile('u1', 'ensure@example.test');
      expect((await repos.auth.ensureProfile(p)).id).toBe('u1');
      expect((await repos.auth.ensureProfile({ ...p, displayName: 'Ignored' })).displayName).toBe(
        'User u1',
      );

      await repos.auth.promoteToAdmin('u1');
      expect((await repos.auth.findById('u1'))?.role).toBe('ADMIN');

      await repos.auth.setStatus('u1', {
        status: 'SUSPENDED',
        suspendedAt: T2,
        suspendedBy: 'root',
        suspensionReason: 'abuse',
      });
      const suspended = await repos.auth.findById('u1');
      expect(suspended).toMatchObject({ status: 'SUSPENDED', suspensionReason: 'abuse' });
      expect(suspended?.suspendedAt).toBe(T2);

      expect((await repos.auth.all()).map((u) => u.id)).toEqual(['u1']);
      await repos.auth.delete('u1');
      expect(await repos.auth.findById('u1')).toBeUndefined();
      expect(await repos.auth.count()).toBe(0);
    });
  });

  describe('sessions', () => {
    beforeEach(async () => {
      await repos.auth.create(profile('u1', 'sessions@example.test'), 'h');
      await repos.auth.create(profile('u2', 'other@example.test'), 'h');
    });

    it('inserts hashed sessions, looks them up and rotates the hash', async () => {
      const session = {
        id: 's1',
        userId: 'u1',
        refreshTokenHash: 'hash-1',
        createdAt: T0,
        expiresAt: T2,
        revokedAt: null,
        lastUsedAt: T0,
        userAgent: 'vitest',
        ip: '127.0.0.1',
      };
      await repos.sessions.insert(session);
      expect(await repos.sessions.findById('s1')).toMatchObject(session);
      expect((await repos.sessions.findByRefreshHash('hash-1'))?.id).toBe('s1');

      const rotated = await repos.sessions.update('s1', {
        refreshTokenHash: 'hash-2',
        lastUsedAt: T1,
        expiresAt: T3,
      });
      expect(rotated).toMatchObject({ refreshTokenHash: 'hash-2', lastUsedAt: T1 });
      expect(await repos.sessions.findByRefreshHash('hash-1')).toBeUndefined();
      expect((await repos.sessions.findByRefreshHash('hash-2'))?.id).toBe('s1');

      await expect(
        repos.sessions.insert({ ...session, id: 's2', refreshTokenHash: 'hash-2' }),
      ).rejects.toMatchObject({ code: 'DUPLICATE' });
      await expect(
        repos.sessions.insert({ ...session, id: 's3', userId: 'missing-user', refreshTokenHash: 'h3' }),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });
    });

    it('lists sessions newest first and revokes all but the current one', async () => {
      const base = {
        userId: 'u1',
        createdAt: T0,
        expiresAt: T2,
        revokedAt: null,
        lastUsedAt: T0,
        userAgent: null,
        ip: null,
      };
      await repos.sessions.insert({ ...base, id: 's1', refreshTokenHash: 'h1' });
      await repos.sessions.insert({ ...base, id: 's2', refreshTokenHash: 'h2', createdAt: T1 });

      const list = await repos.sessions.listForUser('u1');
      expect(list.map((s) => s.id)).toEqual(['s2', 's1']);

      expect(await repos.sessions.revokeAllForUser('u1', T2, 's2')).toBe(1);
      expect((await repos.sessions.findById('s1'))?.revokedAt).toBe(T2);
      expect((await repos.sessions.findById('s2'))?.revokedAt).toBeNull();

      expect(await repos.sessions.revokeAllForUser('u1', T3)).toBe(1);
      expect((await repos.sessions.findById('s2'))?.revokedAt).toBe(T3);
      expect(await repos.sessions.revokeAllForUser('u2', T3)).toBe(0);
    });
  });

  describe('spaces', () => {
    beforeEach(async () => {
      await repos.auth.create(profile('owner', 'owner@example.test'), 'h');
      await repos.auth.create(profile('editor', 'editor@example.test'), 'h');
      await repos.auth.create(profile('viewer', 'viewer@example.test'), 'h');
      await repos.auth.create(profile('stranger', 'stranger@example.test'), 'h');
    });

    it('creates, reads, lists and updates spaces without losing fields', async () => {
      await repos.spaces.insert(space('s1', 'owner', { createdAt: T0 }));
      await repos.spaces.insert(space('s2', 'owner', { createdAt: T1, status: 'DRAFT' }));

      expect((await repos.spaces.findById('s1'))?.ownerId).toBe('owner');
      expect((await repos.spaces.list()).map((s) => s.id)).toEqual(['s2', 's1']);

      const updated = await repos.spaces.update('s1', { name: 'Renamed', status: 'WARNING' });
      expect(updated).toMatchObject({ name: 'Renamed', status: 'WARNING', ownerId: 'owner' });
      expect(updated?.purpose).toBe('Testing');
      expect(updated?.invitationsEnabled).toBe(true);
      expect(updated?.updatedAt).not.toBe(T0);

      expect(await repos.spaces.update('missing', { name: 'x' })).toBeUndefined();
      await expect(
        repos.spaces.insert(space('s3', 'ghost-owner')),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });
    });

    it('lists owned and active member spaces only, respecting revocation', async () => {
      await repos.spaces.insert(space('s1', 'owner', { createdAt: T0 }));
      await repos.spaces.insert(space('s2', 'owner', { createdAt: T1 }));
      await repos.spaces.insert(space('s3', 'owner', { createdAt: T2 }));

      await repos.members.insert(member('s1', 'editor', 'EDITOR', { joinedAt: T1 }));
      await repos.members.insert(member('s2', 'viewer', 'VIEWER', { joinedAt: T1 }));
      await repos.members.insert(member('s2', 'stranger', 'VIEWER', {
        joinedAt: T1,
        status: 'REVOKED',
        revokedAt: T2,
      }));

      expect((await repos.spaces.listForUser('owner')).map((s) => s.id)).toEqual(['s3', 's2', 's1']);
      expect((await repos.spaces.listForUser('editor')).map((s) => s.id)).toEqual(['s1']);
      expect((await repos.spaces.listForUser('viewer')).map((s) => s.id)).toEqual(['s2']);
      // A revoked member is not a member.
      expect(await repos.spaces.listForUser('stranger')).toEqual([]);
    });
  });

  describe('members', () => {
    beforeEach(async () => {
      await repos.auth.create(profile('owner', 'owner@example.test'), 'h');
      await repos.auth.create(profile('m1', 'm1@example.test'), 'h');
      await repos.auth.create(profile('m2', 'm2@example.test'), 'h');
      await repos.spaces.insert(space('s1', 'owner'));
    });

    it('adds, reads, updates and revokes memberships', async () => {
      await repos.members.insert(member('s1', 'owner', 'OWNER', { joinedAt: T0 }));
      await repos.members.insert(member('s1', 'm1', 'VIEWER', { joinedAt: T1 }));
      await repos.members.insert(member('s1', 'm2', 'EDITOR', { joinedAt: T2 }));

      expect((await repos.members.find('s1', 'm1'))?.role).toBe('VIEWER');
      expect((await repos.members.listForSpace('s1')).map((m) => m.userId)).toEqual([
        'owner',
        'm1',
        'm2',
      ]);
      expect((await repos.members.listForUser('m1')).map((m) => m.spaceId)).toEqual(['s1']);

      await expect(
        repos.members.insert(member('s1', 'm1', 'EDITOR')),
      ).rejects.toMatchObject({ code: 'DUPLICATE' });
      await expect(
        repos.members.insert(member('missing-space', 'm1', 'VIEWER')),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });

      const changed = await repos.members.update('s1', 'm1', { role: 'EDITOR' });
      expect(changed?.role).toBe('EDITOR');
      expect(await repos.members.update('s1', 'ghost', { role: 'EDITOR' })).toBeUndefined();

      expect(await repos.members.countByRole('s1', 'EDITOR')).toBe(2);
      expect(await repos.members.revokeAllForSpace('s1')).toBe(3);
      expect(await repos.members.countByRole('s1', 'EDITOR')).toBe(0);
      expect(await repos.members.listForUser('m1')).toEqual([]);
    });
  });

  describe('access', () => {
    beforeEach(async () => {
      await repos.auth.create(profile('u1', 'access@example.test'), 'h');
      await repos.auth.create(profile('u2', 'other@example.test'), 'h');
      await repos.spaces.insert(space('s1', 'u2'));
      await repos.spaces.insert(space('s2', 'u2'));
    });

    it('upserts access timestamps and lists newest first with a limit', async () => {
      await repos.access.touch('s1', 'u1', T0);
      await repos.access.touch('s2', 'u1', T1);
      await repos.access.touch('s1', 'u1', T2);

      const recent = await repos.access.listForUser('u1');
      expect(recent.map((a) => a.spaceId)).toEqual(['s1', 's2']);
      expect(recent[0]?.lastAccessedAt).toBe(T2);

      expect((await repos.access.listForUser('u1', 1)).map((a) => a.spaceId)).toEqual(['s1']);
      expect(await repos.access.listForUser('u2')).toEqual([]);
      await expect(repos.access.touch('missing', 'u1', T3)).rejects.toMatchObject({
        code: 'FOREIGN_KEY_VIOLATION',
      });
    });
  });

  it('persists data across a pool restart', async () => {
    await repos.auth.create(profile('persist', 'persist@example.test'), 'h');
    await repos.spaces.insert(space('persist-space', 'persist'));

    const restartPool = new Pool({ connectionString: db.url, max: 2 });
    try {
      const env = loadEnv({ repoMode: 'postgres', databaseUrl: db.url, nodeEnv: 'test' });
      const reopened = createPostgresCoreRepositories(env, restartPool);
      expect((await reopened.auth.findByEmail('persist@example.test'))?.id).toBe('persist');
      expect((await reopened.spaces.findById('persist-space'))?.ownerId).toBe('persist');
    } finally {
      await restartPool.end();
    }
  });
});

describe('SQLite/PostgreSQL parity', () => {
  it('returns the same projections for the core read paths', async () => {
    if (!baseUrl) return; // the PostgreSQL half is unavailable
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

      const p = profile('u1', 'parity@example.test');
      const s = space('s1', 'u1');
      const m = member('s1', 'u2', 'VIEWER');
      const u2 = profile('u2', 'member@example.test');

      for (const layer of [sqlite, pg]) {
        await layer.auth.create(p, 'hash');
        await layer.auth.create(u2, 'hash');
        await layer.spaces.insert(s);
        await layer.members.insert(m);
        await layer.access.touch('s1', 'u2', T1);
        await layer.sessions.insert({
          id: 'sess',
          userId: 'u1',
          refreshTokenHash: 'rh',
          createdAt: T0,
          expiresAt: T2,
          revokedAt: null,
          lastUsedAt: T0,
          userAgent: null,
          ip: null,
        });
        await layer.auth.update('u1', { displayName: 'Parity' });
      }

      const expected = {
        id: 'u1',
        email: 'parity@example.test',
        displayName: 'Parity',
        avatarUrl: null,
        emailVerifiedAt: null,
      };
      expect(await sqlite.auth.findById('u1')).toMatchObject(expected);
      expect(await pg.auth.findById('u1')).toMatchObject(expected);

      expect((await sqlite.spaces.listForUser('u2')).map((x) => x.id)).toEqual(
        (await pg.spaces.listForUser('u2')).map((x) => x.id),
      );
      expect((await sqlite.members.listForSpace('s1')).map((x) => x.userId)).toEqual(
        (await pg.members.listForSpace('s1')).map((x) => x.userId),
      );
      expect((await sqlite.access.listForUser('u2')).map((x) => x.spaceId)).toEqual(
        (await pg.access.listForUser('u2')).map((x) => x.spaceId),
      );
      expect((await sqlite.sessions.listForUser('u1')).map((x) => x.id)).toEqual(
        (await pg.sessions.listForUser('u1')).map((x) => x.id),
      );
    } finally {
      await pool?.end();
      await db.drop();
    }
  });
});
