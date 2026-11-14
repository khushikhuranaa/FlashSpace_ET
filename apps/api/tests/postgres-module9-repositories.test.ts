import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { Profile } from '@flashspace/shared';
import { loadEnv } from '../src/config/env.js';
import { SqliteDataLayer } from '../src/repositories/sqlite/sqlite.data-layer.js';
import {
  createPostgresCoreRepositories,
  type PostgresCoreRepositories,
} from '../src/repositories/postgres/core.js';
import type { EmailJobRow, HashedTokenRow } from '../src/repositories/data-layer.interface.js';
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

function profile(id: string, email: string, role: Profile['role'] = 'USER'): Profile {
  return {
    id,
    email,
    displayName: `User ${id}`,
    role,
    avatarUrl: null,
    createdAt: T0,
    updatedAt: T0,
    status: 'ACTIVE',
  };
}

function emailJob(id: string, patch: Partial<EmailJobRow> = {}): EmailJobRow {
  return {
    id,
    category: 'TRANSACTIONAL',
    template: 'welcome',
    to: `${id}@example.test`,
    subject: 'Welcome',
    entityId: 'entity-1',
    entityType: 'user',
    status: 'PENDING',
    attempts: 0,
    createdAt: T0,
    updatedAt: T0,
    lastAttemptAt: null,
    deliveredAt: null,
    error: null,
    idempotencyKey: `key-${id}`,
    ...patch,
  };
}

function token(id: string, userId: string, patch: Partial<HashedTokenRow> = {}): HashedTokenRow {
  return {
    id,
    userId,
    tokenHash: `hash-${id}`,
    purpose: 'EMAIL_VERIFICATION',
    expiresAt: T2,
    usedAt: null,
    createdAt: T0,
    ...patch,
  };
}

describePg('postgres email, token and audit repositories', () => {
  let db: DisposableDatabase;
  let pool: Pool;
  let repos: PostgresCoreRepositories;

  beforeAll(async () => {
    db = await createDisposableDatabase(baseUrl!);
    const report = await migrateDatabase(db.url);
    expect(report.applied).toContain('009_email_retry_statuses.sql');
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
    // email_jobs has no profile FK, so it is not covered by the cascade.
    await pool.query('truncate table email_jobs');
    await pool.query('truncate table profiles cascade');
    await repos.auth.create(profile('admin', 'admin@example.test', 'ADMIN'), 'h');
    await repos.auth.create(profile('user', 'user@example.test'), 'h');
  });

  describe('email jobs', () => {
    it('tracks the full retry lifecycle now allowed by migration 009', async () => {
      await repos.emailJobs.insert(emailJob('e1'));
      expect(await repos.emailJobs.findById('e1')).toMatchObject({
        to: 'e1@example.test',
        status: 'PENDING',
        attempts: 0,
      });
      expect((await repos.emailJobs.findByEntity('user', 'entity-1'))?.id).toBe('e1');
      expect((await repos.emailJobs.listPending()).map((j) => j.id)).toEqual(['e1']);

      const processing = await repos.emailJobs.update('e1', {
        status: 'PROCESSING',
        updatedAt: T1,
        lastAttemptAt: T1,
      });
      expect(processing).toMatchObject({ status: 'PROCESSING', attempts: 0 });

      const retrying = await repos.emailJobs.update('e1', {
        status: 'RETRY_SCHEDULED',
        attempts: 1,
        updatedAt: T1,
        lastAttemptAt: T1,
        error: 'temporary failure',
      });
      expect(retrying).toMatchObject({
        status: 'RETRY_SCHEDULED',
        attempts: 1,
        error: 'temporary failure',
      });
      expect((await repos.emailJobs.listPending()).map((j) => j.id)).toEqual(['e1']);
      expect(await repos.emailJobs.listFailed()).toEqual([]);

      const sent = await repos.emailJobs.update('e1', {
        status: 'SENT',
        attempts: 2,
        updatedAt: T2,
        lastAttemptAt: T2,
        deliveredAt: T2,
        error: null,
      });
      expect(sent).toMatchObject({ status: 'SENT', attempts: 2, deliveredAt: T2, error: null });
      expect(await repos.emailJobs.listPending()).toEqual([]);
      expect(await repos.emailJobs.update('missing', { status: 'FAILED' })).toBeUndefined();

      await expect(repos.emailJobs.insert(emailJob('e1'))).rejects.toMatchObject({
        code: 'DUPLICATE',
      });
      await expect(
        repos.emailJobs.insert(emailJob('e2', { idempotencyKey: 'key-e1' })),
      ).rejects.toMatchObject({ code: 'DUPLICATE' });
    });

    it('filters failures, orders newest first and allows multiple null idempotency keys', async () => {
      await repos.emailJobs.insert(emailJob('e1', { status: 'FAILED', createdAt: T0 }));
      await repos.emailJobs.insert(
        emailJob('e2', { status: 'FAILED', createdAt: T1, idempotencyKey: null }),
      );
      await repos.emailJobs.insert(
        emailJob('e3', { status: 'PENDING', createdAt: T2, idempotencyKey: null }),
      );

      expect((await repos.emailJobs.listFailed()).map((j) => j.id)).toEqual(['e2', 'e1']);
      expect((await repos.emailJobs.listAll()).map((j) => j.id)).toEqual(['e3', 'e2', 'e1']);
      expect((await repos.emailJobs.listAll(1)).map((j) => j.id)).toEqual(['e3']);
      // Latest by created_at, not insertion order.
      expect((await repos.emailJobs.findByEntity('user', 'entity-1'))?.id).toBe('e3');
    });
  });

  describe('verification tokens', () => {
    it('stores hashes, resolves the pending token and consumes without reuse', async () => {
      await repos.verificationTokens.insert(token('t1', 'user'));
      await repos.verificationTokens.insert(
        token('t2', 'user', { purpose: 'PASSWORD_RESET', createdAt: T1 }),
      );

      expect((await repos.verificationTokens.findByPurposeAndUserId('EMAIL_VERIFICATION', 'user'))?.id).toBe(
        't1',
      );
      expect((await repos.verificationTokens.findByPurposeAndUserId('PASSWORD_RESET', 'user'))?.id).toBe(
        't2',
      );
      expect((await repos.verificationTokens.findByTokenHash('hash-t1', 'EMAIL_VERIFICATION'))?.id).toBe(
        't1',
      );
      // Wrong purpose must not resolve.
      expect(await repos.verificationTokens.findByTokenHash('hash-t1', 'PASSWORD_RESET')).toBeUndefined();

      const used = await repos.verificationTokens.markUsed('t1');
      expect(used?.usedAt).not.toBeNull();
      expect(
        await repos.verificationTokens.findByPurposeAndUserId('EMAIL_VERIFICATION', 'user'),
      ).toBeUndefined();
      // The service still needs the row to detect reuse and reject it.
      expect(
        (await repos.verificationTokens.findByTokenHash('hash-t1', 'EMAIL_VERIFICATION'))?.usedAt,
      ).not.toBeNull();

      expect(await repos.verificationTokens.destroy('t1')).toBe(true);
      expect(await repos.verificationTokens.destroy('t1')).toBe(false);
      expect(
        await repos.verificationTokens.findByTokenHash('hash-t1', 'EMAIL_VERIFICATION'),
      ).toBeUndefined();
      expect(await repos.verificationTokens.markUsed('missing')).toBeUndefined();

      // t2 still exists (different purpose) and its id is still taken.
      await expect(
        repos.verificationTokens.insert(token('t2', 'user', { purpose: 'PASSWORD_RESET' })),
      ).rejects.toMatchObject({ code: 'DUPLICATE' });
      await expect(
        repos.verificationTokens.insert(token('t3', 'ghost')),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });
    });
  });

  describe('admin audit', () => {
    it('appends metadata and filters by action, admin and outlet with pagination', async () => {
      const security = await repos.adminAudit.append({
        adminId: 'admin',
        action: 'SECURITY_LOGIN_FAILED',
        targetType: 'user',
        targetId: 'user',
        outcome: 'FAILURE',
        reason: 'bad password',
        metadata: { ip: '127.0.0.1', attempt: 2 },
      });
      expect(security).toMatchObject({
        adminId: 'admin',
        action: 'SECURITY_LOGIN_FAILED',
        outcome: 'FAILURE',
        metadata: { ip: '127.0.0.1', attempt: 2 },
      });
      expect(security.id).toBeTruthy();
      expect(security.createdAt).toBeTruthy();

      await repos.adminAudit.append({
        adminId: 'admin',
        action: 'SECURITY_RATE_LIMITED',
        targetType: 'user',
        targetId: 'user',
        outcome: 'SUCCESS',
        reason: null,
        metadata: {},
      });
      await repos.adminAudit.append({
        adminId: 'admin',
        action: 'USER_ROLE_CHANGED',
        targetType: 'user',
        targetId: 'user',
        outcome: 'SUCCESS',
        reason: 'promotion',
        metadata: { from: 'USER', to: 'ADMIN' },
      });

      const all = await repos.adminAudit.list({ limit: 10, offset: 0 });
      expect(all.total).toBe(3);
      expect(all.entries).toHaveLength(3);

      const securityOnly = await repos.adminAudit.list({
        outlet: 'SECURITY',
        limit: 10,
        offset: 0,
      });
      expect(securityOnly.total).toBe(2);
      expect(securityOnly.entries.every((e) => e.action.startsWith('SECURITY_'))).toBe(true);

      const adminOnly = await repos.adminAudit.list({ outlet: 'ADMIN', limit: 10, offset: 0 });
      expect(adminOnly.entries.map((e) => e.action)).toEqual(['USER_ROLE_CHANGED']);

      const byAction = await repos.adminAudit.list({
        action: 'SECURITY_LOGIN_FAILED',
        limit: 10,
        offset: 0,
      });
      expect(byAction.total).toBe(1);
      expect(byAction.entries[0]?.reason).toBe('bad password');

      const byAdmin = await repos.adminAudit.list({
        adminId: 'admin',
        limit: 1,
        offset: 1,
      });
      expect(byAdmin.total).toBe(3);
      expect(byAdmin.entries).toHaveLength(1);

      const none = await repos.adminAudit.list({ action: 'MISSING', limit: 10, offset: 0 });
      expect(none).toEqual({ entries: [], total: 0 });

      await expect(
        repos.adminAudit.append({
          adminId: 'ghost',
          action: 'USER_ROLE_CHANGED',
          targetType: 'user',
          targetId: 'user',
          outcome: 'SUCCESS',
          reason: null,
          metadata: {},
        }),
      ).rejects.toMatchObject({ code: 'FOREIGN_KEY_VIOLATION' });
    });
  });

  it('persists email jobs, tokens and audit rows across a pool restart', async () => {
    await repos.emailJobs.insert(emailJob('persist-email'));
    await repos.verificationTokens.insert(token('persist-token', 'user'));
    const audit = await repos.adminAudit.append({
      adminId: 'admin',
      action: 'USER_SUSPENDED',
      targetType: 'user',
      targetId: 'user',
      outcome: 'SUCCESS',
      reason: 'persistence',
      metadata: { source: 'test' },
    });

    const restartPool = new Pool({ connectionString: db.url, max: 2 });
    try {
      const reopened = createPostgresCoreRepositories(
        loadEnv({ repoMode: 'postgres', databaseUrl: db.url, nodeEnv: 'test' }),
        restartPool,
      );
      expect((await reopened.emailJobs.findById('persist-email'))?.status).toBe('PENDING');
      expect(
        (await reopened.verificationTokens.findByTokenHash('hash-persist-token', 'EMAIL_VERIFICATION'))
          ?.id,
      ).toBe('persist-token');
      expect((await reopened.adminAudit.list({ limit: 10, offset: 0 })).entries[0]?.id).toBe(
        audit.id,
      );
    } finally {
      await restartPool.end();
    }
  });
});

describe('module 9 repositories SQLite parity', () => {
  it('matches SQLite for email jobs, verification tokens and audit listing', async () => {
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
        await layer.auth.create(profile('admin', 'parity-admin@example.test', 'ADMIN'), 'h');
        await layer.auth.create(profile('user', 'parity@example.test'), 'h');
        await layer.emailJobs.insert(emailJob('e1'));
        await layer.emailJobs.update('e1', { status: 'RETRY_SCHEDULED', attempts: 1, updatedAt: T1 });
        await layer.verificationTokens.insert(token('t1', 'user'));
        await layer.verificationTokens.markUsed('t1');
        await layer.adminAudit.append({
          adminId: 'admin',
          action: 'SECURITY_LOGIN_FAILED',
          targetType: 'user',
          targetId: 'user',
          outcome: 'FAILURE',
          reason: 'parity',
          metadata: { a: 1 },
        });
      }

      const sqliteEmail = await sqlite.emailJobs.findById('e1');
      const pgEmail = await pg.emailJobs.findById('e1');
      expect({ status: pgEmail?.status, attempts: pgEmail?.attempts }).toEqual({
        status: sqliteEmail?.status,
        attempts: sqliteEmail?.attempts,
      });
      expect((await sqlite.verificationTokens.findByTokenHash('hash-t1', 'EMAIL_VERIFICATION'))?.usedAt).not.toBeNull();
      expect((await pg.verificationTokens.findByTokenHash('hash-t1', 'EMAIL_VERIFICATION'))?.usedAt).not.toBeNull();
      const sqliteAudit = await sqlite.adminAudit.list({ outlet: 'SECURITY', limit: 10, offset: 0 });
      const pgAudit = await pg.adminAudit.list({ outlet: 'SECURITY', limit: 10, offset: 0 });
      expect(pgAudit.total).toBe(sqliteAudit.total);
      expect(pgAudit.entries[0]?.metadata).toEqual(sqliteAudit.entries[0]?.metadata);
    } finally {
      await pool?.end();
      await db.drop();
    }
  });
});
