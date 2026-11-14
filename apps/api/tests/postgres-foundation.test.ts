import { afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { loadEnv } from '../src/config/env.js';
import { databaseMigrationStatus, migrateDatabase } from '../src/repositories/postgres/migrate.js';
import {
  checkPostgresHealth,
  closeSharedPostgresPool,
  createPostgresPool,
  resetSharedPostgresPoolForTests,
  withTransaction,
} from '../src/repositories/postgres/pool.js';
import {
  createDisposableDatabase,
  postgresTestUrl,
  type DisposableDatabase,
} from './helpers/postgres.js';

/**
 * PostgreSQL foundation tests. They require a real server:
 *   TEST_POSTGRES_URL=postgresql://postgres@localhost:5432/postgres npm test
 * Without it the whole file is skipped, so the default SQLite suite is unchanged.
 */
const baseUrl = postgresTestUrl();
const describePg = baseUrl ? describe : describe.skip;

const MIGRATIONS = [
  '001_init.sql',
  '002_smart_storage.sql',
  '003_auth_identity.sql',
  '004_dashboard.sql',
  '005_space_management.sql',
  '006_cloud_completion.sql',
  '007_email_verification.sql',
  '008_auth_sessions.sql',
  '009_email_retry_statuses.sql',
];

describePg('postgres migrations (disposable database)', () => {
  const created: DisposableDatabase[] = [];

  afterAll(async () => {
    for (const db of created) await db.drop();
  });

  it('applies 001–007 once and is idempotent on the second run', async () => {
    const db = await createDisposableDatabase(baseUrl!);
    created.push(db);

    const first = await migrateDatabase(db.url);
    expect(first.applied).toEqual(MIGRATIONS);
    expect(first.skipped).toEqual([]);
    expect(first.dryRun).toBe(false);

    const second = await migrateDatabase(db.url);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(MIGRATIONS);

    const status = await databaseMigrationStatus(db.url);
    expect(status.pending).toEqual([]);
    expect(status.missing).toEqual([]);
    expect(status.drifted).toEqual([]);
    expect(status.applied).toHaveLength(MIGRATIONS.length);

    const client = new Client({ connectionString: db.url });
    await client.connect();
    try {
      const tables = await client.query(
        "select count(*)::int as count from information_schema.tables where table_schema = 'public'",
      );
      expect(tables.rows[0]?.count).toBeGreaterThanOrEqual(30);
      const authUsers = await client.query("select to_regclass('auth.users') as present");
      expect(authUsers.rows[0]?.present).toBe('auth.users');
    } finally {
      await client.end();
    }
  });

  it('applies the local shim safely when test databases migrate concurrently', async () => {
    const first = await createDisposableDatabase(baseUrl!);
    const second = await createDisposableDatabase(baseUrl!);
    created.push(first, second);

    // The Supabase compatibility roles are cluster-wide. Two fresh databases
    // migrating in parallel must agree on those roles without either run
    // failing on a duplicate role.
    const [a, b] = await Promise.all([migrateDatabase(first.url), migrateDatabase(second.url)]);
    expect(a.applied).toEqual(MIGRATIONS);
    expect(b.applied).toEqual(MIGRATIONS);
  });

  it('reports a dry run without applying anything', async () => {
    const db = await createDisposableDatabase(baseUrl!);
    created.push(db);

    const report = await migrateDatabase(db.url, { dryRun: true });
    expect(report.wouldApply).toEqual(MIGRATIONS);

    const status = await databaseMigrationStatus(db.url);
    expect(status.applied).toEqual([]);
    expect(status.pending).toHaveLength(MIGRATIONS.length);
  });
});

describePg('postgres pool and transactions', () => {
  const created: DisposableDatabase[] = [];

  afterAll(async () => {
    await closeSharedPostgresPool();
    for (const db of created) await db.drop();
  });

  async function freshEnv() {
    const db = await createDisposableDatabase(baseUrl!);
    created.push(db);
    return loadEnv({
      repoMode: 'postgres',
      databaseUrl: db.url,
      nodeEnv: 'test',
      pgConnectTimeoutMs: 2_000,
      pgStatementTimeoutMs: 5_000,
    });
  }

  it('acquires and releases a client back to the pool', async () => {
    const env = await freshEnv();
    const pool = createPostgresPool({
      connectionString: env.databaseUrl,
      max: 2,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 5_000,
      statementTimeoutMillis: 5_000,
      applicationName: 'flashspace-test',
    });
    try {
      const client = await pool.connect();
      const result = await client.query<{ ok: number }>('select 1 as ok');
      expect(result.rows[0]?.ok).toBe(1);
      client.release();
      expect(pool.idleCount).toBe(1);
      expect(pool.waitingCount).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('commits a transaction and rolls back a failing one', async () => {
    const env = await freshEnv();
    const pool = createPostgresPool({
      connectionString: env.databaseUrl,
      max: 2,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 5_000,
      statementTimeoutMillis: 5_000,
      applicationName: 'flashspace-test',
    });
    try {
      await pool.query('create table tx_probe (id int primary key)');

      await withTransaction(pool, async (client) => {
        await client.query('insert into tx_probe (id) values ($1)', [1]);
      });
      const committed = await pool.query('select count(*)::int as count from tx_probe');
      expect(committed.rows[0]?.count).toBe(1);

      await expect(
        withTransaction(pool, async (client) => {
          await client.query('insert into tx_probe (id) values ($1)', [2]);
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      const afterRollback = await pool.query('select count(*)::int as count from tx_probe');
      expect(afterRollback.rows[0]?.count).toBe(1);
      // The failed transaction must not leak its client.
      expect(pool.idleCount).toBe(pool.totalCount);
    } finally {
      await pool.end();
    }
  });

  it('health check distinguishes healthy, unconfigured, unavailable and non-Postgres', async () => {
    const env = await freshEnv();
    resetSharedPostgresPoolForTests();
    try {
      const healthy = await checkPostgresHealth(env);
      expect(healthy.status).toBe('healthy');
      if (healthy.status === 'healthy') expect(healthy.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      await closeSharedPostgresPool();
    }

    const unconfigured = await checkPostgresHealth(
      loadEnv({ repoMode: 'postgres', databaseUrl: '', nodeEnv: 'test' }),
    );
    expect(unconfigured.status).toBe('unconfigured');

    const unavailable = await checkPostgresHealth(
      loadEnv({
        repoMode: 'postgres',
        databaseUrl: 'postgresql://postgres@127.0.0.1:1/absent',
        nodeEnv: 'test',
        pgConnectTimeoutMs: 500,
      }),
    );
    expect(unavailable.status).toBe('unavailable');
    if (unavailable.status === 'unavailable') {
      expect(unavailable.error.message).not.toContain('postgresql://');
    }

    const sqlite = await checkPostgresHealth(
      loadEnv({ repoMode: 'sqlite', nodeEnv: 'test' }),
    );
    expect(sqlite.status).toBe('not_applicable');
  });
});
