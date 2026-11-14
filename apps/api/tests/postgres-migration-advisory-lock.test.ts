import { describe, it, expect } from 'vitest';
import {
  type MigrationClient,
  type RunOptions,
  runMigrations,
  loadMigrationFiles,
  MigrationError,
  MIGRATION_ADVISORY_LOCK_KEY,
  acquireMigrationAdvisoryLock,
  releaseMigrationAdvisoryLock,
} from '../src/repositories/postgres/migrate.js';

/**
 * TrackingClient is a mock MigrationClient used to verify the SQL the migration
 * runner emits, without connecting to a real database.
 *
 * It only implements the MigrationClient surface. The real migration entry point
 * `migrateDatabase()` creates a real `pg.Client` through `withClient()` and is
 * therefore NOT mockable with this class. For that reason this suite:
 *  - directly tests `acquireMigrationAdvisoryLock()` and
 *    `releaseMigrationAdvisoryLock()` (the lock helpers the runner calls), and
 *  - directly tests `runMigrations()` (transaction, dry-run, failure paths),
 *    but does NOT assert that `migrateDatabase()` acquires/releases the lock
 *    around a run — that is an integration behavior that requires either a real
 *    database or an injectable client factory, neither of which exists yet.
 */
class TrackingClient implements MigrationClient {
  readonly queries: Array<{ sql: string; params?: unknown[] }> = [];
  constructor(private readonly options: { failOn?: string } = {}) {}

  async query(sql: string, params?: unknown[]) {
    this.queries.push({ sql, params });
    if (this.options.failOn && sql.includes(this.options.failOn)) {
      throw new Error('simulated failure');
    }
    if (/select pg_try_advisory_lock/.test(sql)) {
      const key = Number(MIGRATION_ADVISORY_LOCK_KEY);
      const requested = Array.isArray(params) ? Number(params[0] ?? NaN) : NaN;
      return { rows: [{ acquired: requested === key }], rowCount: 1 };
    }
    if (/select pg_advisory_unlock/.test(sql)) {
      return { rows: [{ released: true }], rowCount: 1 };
    }
    if (/select name, checksum, applied_at from schema_migrations/.test(sql)) {
      return {
        rows: this.history.map((row) => ({ ...row })),
        rowCount: this.history.length,
      };
    }
    if (/insert into schema_migrations/.test(sql)) {
      this.history.push({
        name: String(params?.[0]),
        checksum: String(params?.[1]),
        applied_at: new Date().toISOString(),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('create table')) return { rows: [], rowCount: 0 };
    if (/alter table schema_migrations add column/.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    if (/select 1 from schema_migrations/.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  }

  readonly history: Array<{
    name: string;
    checksum: string;
    applied_at: string;
  }> = [];
}

describe('postgres migration advisory lock', () => {
  it('documents the deterministic lock key', () => {
    expect(MIGRATION_ADVISORY_LOCK_KEY).toBe(91311257n);
    expect(String(MIGRATION_ADVISORY_LOCK_KEY)).toBe('91311257');
  });

  it('builds the advisory lock query with a bigint parameter the pg driver can send', async () => {
    const client = new TrackingClient();
    const acquired = await acquireMigrationAdvisoryLock(client);
    expect(acquired).toBe(true);
    expect(client.queries).toEqual([
      {
        sql: 'select pg_try_advisory_lock($1) as acquired',
        params: [MIGRATION_ADVISORY_LOCK_KEY],
      },
    ]);
  });

  it('releases the advisory lock through the unlock helper with the correct key', async () => {
    const client = new TrackingClient();
    await releaseMigrationAdvisoryLock(client);
    expect(client.queries).toEqual([
      {
        sql: 'select pg_advisory_unlock($1) as released',
        params: [MIGRATION_ADVISORY_LOCK_KEY],
      },
    ]);
  });

  it('runMigrations runs each pending migration in its own transaction', async () => {
    const client = new TrackingClient();
    const files = await loadMigrationFiles();
    const report = await runMigrations(client, { files });
    expect(report.applied).toContain('001_init.sql');
    expect(report.dryRun).toBe(false);
    const begins = client.queries.filter((q) => q.sql === 'begin');
    const commits = client.queries.filter((q) => q.sql === 'commit');
    expect(begins.length).toBeGreaterThanOrEqual(1);
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(begins.length).toBe(commits.length);
  });

  it('runMigrations aborts and throws MigrationError when a migration fails', async () => {
    const client = new TrackingClient({ failOn: 'insert into schema_migrations' });
    await expect(runMigrations(client)).rejects.toBeInstanceOf(MigrationError);
    const rollbackCalls = client.queries.filter((q) => q.sql === 'rollback');
    expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('runMigrations dry-run reports what would apply without touching the schema', async () => {
    const client = new TrackingClient({ failOn: 'begin' });
    const files = await loadMigrationFiles();
    const dry = await runMigrations(client, { files, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.wouldApply).toContain('001_init.sql');
    expect(client.queries.some((q) => q.sql.startsWith('begin'))).toBe(false);
  });

  it('runMigrations skips every migration when they are all already applied', async () => {
    const client = new TrackingClient();
    for (const [name, checksum] of [
      ['001_init.sql', 'ddea2270ecd6f4b3f09df70f787cfae0c9b1de65b4e3be41c89fa812a6a77e9b'],
      ['002_smart_storage.sql', 'edb5ac6a798f9068902e00de00f5ef4597eba4c1e1fa70d0bf1cd6052d4cf17e'],
      ['003_auth_identity.sql', '091a26e189e213befa049b0591024c38394fb0da644a8bbba802b5021fecb6be'],
      ['004_dashboard.sql', '16fa7e0a7beb9456e218c0ca558a90d4a1f0066a04f7fda89dd839da6b4b9fca'],
      ['005_space_management.sql', '0e31e3ce63165ac74a58ca1e0ecadb941e43546fb6297272e86b12f672cb9b51'],
      ['006_cloud_completion.sql', '75974fa82a22740203077840e137d30bf7c1d603440d9a1f577b65ebea34e730'],
      ['007_email_verification.sql', 'addb7ec4386e1b6529a0bb664bda0d2749f60e6031930a7d5b9bb651af8eeb49'],
      ['008_auth_sessions.sql', 'b728d93bafb01d971e5afa314cbebdcbc6bf7ab9e1a41c1b314e8757a779dcbd'],
      ['009_email_retry_statuses.sql', '8af34189f7fc8f8dc9f2f5daeb6484dd08e3528bc148a6fe2003a22adb39da59'],
      ['010_rls_policies.sql', '0d0c0f2d8720260a5804547ecb12e56313f0a0010d46a694bc6bc7596e44b38f']
    ]) {
      client.history.push({ name, checksum, applied_at: new Date().toISOString() });
    }
    const report = await runMigrations(client);
    expect(report.applied).toEqual([]);
    expect(report.skipped).toEqual([
      '001_init.sql',
      '002_smart_storage.sql',
      '003_auth_identity.sql',
      '004_dashboard.sql',
      '005_space_management.sql',
      '006_cloud_completion.sql',
      '007_email_verification.sql',
      '008_auth_sessions.sql',
      '009_email_retry_statuses.sql',
      '010_rls_policies.sql'
    ]);
    const begins = client.queries.filter((q) => q.sql === 'begin');
    expect(begins.length).toBe(0);
  });

  it('runMigrations detects drift when an applied migration is edited', async () => {
    const client = new TrackingClient();
    client.history.push({
      name: '001_init.sql',
      checksum: 'stale',
      applied_at: new Date().toISOString(),
    });
    await expect(runMigrations(client)).rejects.toThrow(/migration drift/i);
  });
});
