import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  loadMigrationFiles,
  getMigrationStatus,
  runMigrations,
  MigrationError,
  type MigrationClient,
} from '../src/repositories/postgres/migrate.js';
import {
  applyPlan,
  buildMigrationPlan,
  buildPlan,
  checkTableParity,
  readSourceTables,
  TABLE_ORDER,
  type SourceTable,
} from '../src/migration/sqlite-to-postgres.js';
import { SqliteDataLayer } from '../src/repositories/sqlite/sqlite.data-layer.js';
import { SupabaseStorageAdapter } from '../src/storage/supabase.storage.js';

/**
 * Module 15 — cloud preparation.
 *
 * Everything here is hermetic: the runner and importer are exercised with an
 * injected client, and SQLite fixtures live in temporary files. The local
 * PostgreSQL verification (migrations + real import) was performed separately
 * against a throwaway cluster; see the Module 15 report.
 */

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const tempDirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `flashspace-cloud-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

interface HistoryRow {
  name: string;
  checksum: string | null;
  applied_at: string;
}

class FakeClient implements MigrationClient {
  readonly queries: Array<{ sql: string; params?: unknown[] }> = [];
  readonly history: HistoryRow[] = [];
  constructor(private readonly options: { failOn?: string } = {}) {}

  async query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    this.queries.push({ sql, params });
    if (this.options.failOn && sql.includes(this.options.failOn)) throw new Error('simulated failure');
    if (/select name, checksum, applied_at from schema_migrations/.test(sql)) {
      return { rows: this.history.map((row) => ({ ...row })), rowCount: this.history.length };
    }
    if (/insert into schema_migrations/.test(sql)) {
      this.history.push({
        name: String(params?.[0]),
        checksum: String(params?.[1]),
        applied_at: new Date().toISOString(),
      });
    }
    if (/select count\(\*\)::int as count/.test(sql)) return { rows: [{ count: 0 }], rowCount: 1 };
    if (sql.startsWith('insert into')) {
      // Number of tuples in the multi-row insert.
      const tuples = (sql.match(/\), \(/g)?.length ?? 0) + 1;
      return { rows: [], rowCount: tuples };
    }
    return { rows: [], rowCount: 0 };
  }
}

function migrationFiles() {
  return loadMigrationFiles();
}

describe('migration runner', () => {
  it('loads migrations in filename order with stable checksums', async () => {
    const files = await migrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files.map((file) => file.name)).toEqual([...files.map((file) => file.name)].sort());
    expect(files[0]!.name).toBe('001_init.sql');
    expect(files.at(-1)!.name).toBe('010_rls_policies.sql');
    expect(files[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic: re-reading the same file yields the same checksum.
    expect((await migrationFiles())[0]!.checksum).toBe(files[0]!.checksum);
  });

  it('applies pending migrations in order, each in its own transaction', async () => {
    const client = new FakeClient();
    const files = await migrationFiles();
    const report = await runMigrations(client, { files });

    expect(report.applied).toEqual(files.map((file) => file.name));
    expect(client.history.map((row) => row.name)).toEqual(files.map((file) => file.name));

    const begins = client.queries.filter((query) => query.sql === 'begin');
    const commits = client.queries.filter((query) => query.sql === 'commit');
    expect(begins.length).toBe(files.length);
    expect(commits.length).toBe(files.length);
    expect(client.history.every((row) => typeof row.checksum === 'string' && row.checksum.length === 64)).toBe(true);
  });

  it('skips already-applied migrations on a second run', async () => {
    const client = new FakeClient();
    const files = await migrationFiles();
    await runMigrations(client, { files });
    const before = client.queries.length;
    const second = await runMigrations(client, { files });
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(files.length);
    // Only status/ensure-history queries ran; no migration bodies.
    expect(client.queries.length - before).toBeLessThan(10);
  });

  it('aborts loudly and rolls back when a migration fails', async () => {
    const client = new FakeClient({ failOn: 'alter table public.profiles' });
    await expect(runMigrations(client)).rejects.toBeInstanceOf(MigrationError);
    // 003 failed; 001/002 were committed and remain recorded.
    expect(client.history.map((row) => row.name)).toEqual(['001_init.sql', '002_smart_storage.sql']);
    expect(client.queries.some((query) => query.sql === 'rollback')).toBe(true);
  });

  it('detects drift when an applied migration was edited', async () => {
    const client = new FakeClient();
    const files = await migrationFiles();
    client.history.push({ name: files[0]!.name, checksum: 'deadbeef', applied_at: new Date().toISOString() });
    const status = await getMigrationStatus(client, files);
    expect(status.drifted.map((entry) => entry.name)).toEqual([files[0]!.name]);
    await expect(runMigrations(client, { files })).rejects.toThrow(/drift/i);
  });

  it('reports missing migrations and supports dry runs', async () => {
    const client = new FakeClient();
    client.history.push({ name: '000_removed.sql', checksum: 'x'.repeat(64), applied_at: new Date().toISOString() });
    const files = await migrationFiles();
    const status = await getMigrationStatus(client, files);
    expect(status.missing).toEqual(['000_removed.sql']);
    expect(status.pending.length).toBe(files.length);

    const dry = await runMigrations(client, { files, dryRun: true });
    expect(dry.wouldApply).toEqual(files.map((file) => file.name));
    expect(dry.applied).toEqual([]);
    expect(client.queries.some((query) => query.sql === 'begin')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SQLite inventory + dry run
// ---------------------------------------------------------------------------

async function seedSqlite(): Promise<string> {
  const dir = await tmpDir('sqlite');
  const file = path.join(dir, 'flashspace.db');
  new SqliteDataLayer(file);
  const db = new DatabaseSync(file);
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  const insert = (table: string, row: Record<string, unknown>) => {
    const columns = Object.keys(row);
    db.prepare(`insert into ${table} (${columns.join(',')}) values (${columns.map(() => '?').join(',')})`).run(
      ...columns.map((column) => row[column] as never),
    );
  };
  insert('profiles', {
    id: 'p1', email: 'ada@example.test', display_name: 'Ada', role: 'ADMIN', avatar_url: null,
    created_at: now, updated_at: now, status: 'ACTIVE', suspended_at: null, suspended_by: null,
    suspension_reason: null, last_active_at: now,
  });
  insert('profiles', {
    id: 'p2', email: 'lin@example.test', display_name: 'Lin', role: 'USER', avatar_url: null,
    created_at: now, updated_at: now, status: 'SUSPENDED', suspended_at: now, suspended_by: 'p1',
    suspension_reason: 'test', last_active_at: null,
  });
  insert('spaces', {
    id: 's1', owner_id: 'p1', name: 'Sprint', purpose: 'Project Collaboration', description: '',
    start_at: now, expiry_at: later, status: 'ACTIVE', warning_sent_at: null, archived_manually: 0,
    invitations_enabled: 1, default_invite_role: 'VIEWER', created_at: now, updated_at: now,
  });
  insert('members', { space_id: 's1', user_id: 'p2', role: 'VIEWER', status: 'ACTIVE', joined_at: now, revoked_at: null });
  insert('files', {
    id: 'file1', space_id: 's1', folder_id: null, uploader_id: 'p1', name: 'a.txt',
    object_key: 'spaces/s1/file1/a.txt', mime_type: 'text/plain', size_bytes: 3, etag: null,
    sha256: null, status: 'ACTIVE', created_at: now, updated_at: now, deleted_at: null,
  });
  insert('activity', {
    id: 1, user_id: 'p1', space_id: 's1', file_id: 'file1', action: 'FILE_UPLOADED',
    metadata: JSON.stringify({ name: 'a.txt' }), created_at: now, actor_type: 'USER',
    outcome: 'SUCCESS', category: 'FILE', resource_type: 'file', resource_id: 'file1',
    reason: null, correlation_id: null, event_key: 'evt-1',
  });
  insert('lifecycle_transitions', {
    id: 'lt1', space_id: 's1', actor_id: 'p1', previous_status: 'DRAFT', new_status: 'ACTIVE',
    reason: 'start', timestamp: now,
  });
  db.close();
  return file;
}

function targetColumnsFor(tables: SourceTable[]): Record<string, string[]> {
  return Object.fromEntries(
    tables.map((table) => [
      table.name,
      table.columns.map((column) =>
        table.name === 'profiles' && column === 'status' ? 'account_status' : column,
      ),
    ]),
  );
}

describe('SQLite → Postgres data migration', () => {
  it('inventories the source without modifying it', async () => {
    const file = await seedSqlite();
    const tables = await readSourceTables(file, TABLE_ORDER);
    const names = tables.map((table) => table.name);
    expect(names).toContain('profiles');
    expect(names).toContain('activity');
    expect(tables.find((table) => table.name === 'profiles')!.rows.length).toBe(2);
    expect(tables.find((table) => table.name === 'activity')!.rows[0]!.event_key).toBe('evt-1');

    const parity = checkTableParity(tables, [...names, 'legacy_account_links']);
    expect(parity.missingInTarget).toEqual([]);
    expect(parity.missingInSource).toEqual(['legacy_account_links']);
  });

  it('dry-runs with conversions, FK checks and no blocking issues', async () => {
    const file = await seedSqlite();
    const tables = await readSourceTables(file, TABLE_ORDER);
    const report = buildPlan(tables, { sourceFile: file, targetColumns: targetColumnsFor(tables) });

    expect(report.blocking).toEqual([]);
    expect(report.totals.sourceRows).toBe(7);
    expect(report.totals.insertableRows).toBe(7);

    const profiles = report.tables.find((table) => table.table === 'profiles')!;
    expect(profiles.columns).toContain('account_status');
    expect(profiles.columns).not.toContain('status');
  });

  it('converts SQLite booleans, JSON text and empty strings', () => {
    const source: SourceTable[] = [
      {
        name: 'spaces',
        columns: ['id', 'owner_id', 'invitations_enabled', 'archived_manually'],
        rows: [{ id: 's1', owner_id: 'p1', invitations_enabled: 1, archived_manually: 0 }],
      },
      {
        name: 'activity',
        columns: ['id', 'metadata', 'reason'],
        rows: [{ id: 1, metadata: '{"a":1}', reason: '' }],
      },
    ];
    const { plans } = buildMigrationPlan(source, {
      sourceFile: 'memory',
      targetColumns: {
        spaces: ['id', 'owner_id', 'invitations_enabled', 'archived_manually'],
        activity: ['id', 'metadata', 'reason'],
      },
    });
    const spaceRow = plans.find((plan) => plan.table === 'spaces')!.rows[0]!;
    expect(spaceRow.invitations_enabled).toBe(true);
    expect(spaceRow.archived_manually).toBe(false);
    const activityRow = plans.find((plan) => plan.table === 'activity')!.rows[0]!;
    expect(activityRow.metadata).toEqual({ a: 1 });
    expect(activityRow.reason).toBeNull();
  });

  it('skips orphaned rows and duplicate keys instead of importing them', () => {
    const source: SourceTable[] = [
      { name: 'profiles', columns: ['id', 'email'], rows: [{ id: 'p1', email: 'a@x.test' }] },
      {
        name: 'spaces',
        columns: ['id', 'owner_id'],
        rows: [
          { id: 's1', owner_id: 'ghost' },
          { id: 's2', owner_id: 'p1' },
        ],
      },
      {
        name: 'jobs',
        columns: ['id', 'idempotency_key'],
        rows: [
          { id: 'j1', idempotency_key: 'k' },
          { id: 'j2', idempotency_key: 'k' },
        ],
      },
    ];
    const report = buildPlan(source, {
      sourceFile: 'memory',
      targetColumns: {
        profiles: ['id', 'email'],
        spaces: ['id', 'owner_id'],
        jobs: ['id', 'idempotency_key'],
      },
    });
    const kinds = report.blocking.map((issue) => issue.kind).sort();
    expect(kinds).toEqual(['DUPLICATE_KEY', 'ORPHAN_FK']);
    expect(report.totals.skippedRows).toBe(2);
    expect(report.totals.insertableRows).toBe(3);
  });

  it('flags a source table that has no target table', () => {
    const source: SourceTable[] = [{ name: 'orphan_table', columns: ['id'], rows: [{ id: 'x' }] }];
    const report = buildPlan(source, { sourceFile: 'memory', targetColumns: {} });
    expect(report.tables[0]!.skippedRows).toBe(1);
    expect(report.blocking[0]!.kind).toBe('UNKNOWN_TARGET_TABLE');
  });

  it('applies the plan in one transaction with quoted identifiers', async () => {
    const file = await seedSqlite();
    const tables = await readSourceTables(file, TABLE_ORDER);
    const { plans } = buildMigrationPlan(tables, {
      sourceFile: file,
      targetColumns: targetColumnsFor(tables),
    });
    const client = new FakeClient();
    const result = await applyPlan(client, plans);

    expect(result.inserted).toBeGreaterThanOrEqual(7);
    expect(client.queries[0]!.sql).toBe('begin');
    expect(client.queries.at(-1)!.sql).toBe('commit');
    const inserts = client.queries.filter((query) => query.sql.startsWith('insert into'));
    expect(inserts.length).toBe(6); // six non-empty tables, seven rows total
    expect(inserts.every((query) => query.sql.includes('on conflict do nothing'))).toBe(true);
    expect(inserts.some((query) => query.sql.includes('"lifecycle_transitions"') && query.sql.includes('"timestamp"'))).toBe(true);
    expect(client.queries.some((query) => query.sql.includes('setval(pg_get_serial_sequence'))).toBe(true);
  });

  it('rolls back the whole import when a target insert fails', async () => {
    const file = await seedSqlite();
    const tables = await readSourceTables(file, TABLE_ORDER);
    const { plans } = buildMigrationPlan(tables, {
      sourceFile: file,
      targetColumns: targetColumnsFor(tables),
    });
    const client = new FakeClient({ failOn: 'insert into "files"' });
    await expect(applyPlan(client, plans)).rejects.toThrow(/simulated failure/);
    expect(client.queries.some((query) => query.sql === 'rollback')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Supabase Storage adapter contract
// ---------------------------------------------------------------------------

interface StorageCall {
  op: string;
  args: unknown[];
}

function fakeSupabase(): { client: SupabaseClient; calls: StorageCall[] } {
  const calls: StorageCall[] = [];
  const bucket = (name: string) => ({
    createSignedUploadUrl: async (key: string, options: unknown) => {
      calls.push({ op: 'createSignedUploadUrl', args: [name, key, options] });
      return { data: { signedUrl: `https://storage.test/${name}/${key}?token=up`, path: key, token: 'up' }, error: null };
    },
    createSignedUrl: async (key: string, expires: number, options: unknown) => {
      calls.push({ op: 'createSignedUrl', args: [name, key, expires, options] });
      return { data: { signedUrl: `https://storage.test/${name}/${key}?token=dl` }, error: null };
    },
    upload: async (key: string, payload: Buffer, options: unknown) => {
      calls.push({ op: 'upload', args: [name, key, payload.length, options] });
      return { data: { path: key }, error: null };
    },
    download: async (key: string) => {
      calls.push({ op: 'download', args: [name, key] });
      return { data: { arrayBuffer: async () => new TextEncoder().encode('payload').buffer }, error: null };
    },
    list: async (dir: string, options: unknown) => {
      calls.push({ op: 'list', args: [name, dir, options] });
      if (dir === 'spaces/s1') {
        return {
          data: [
            { id: null, name: 'nested', metadata: null },
            { id: 'f1', name: 'other.txt', metadata: { size: 7, eTag: 'etag-0' } },
          ],
          error: null,
        };
      }
      if (dir === 'spaces/s1/nested') {
        return { data: [{ id: 'f2', name: 'a.txt', metadata: { size: 42, eTag: 'etag-1' } }], error: null };
      }
      if (dir === 'spaces/s1/file1') {
        return { data: [{ id: 'f3', name: 'a.png', metadata: { size: 42, eTag: 'etag-1' } }], error: null };
      }
      return { data: [], error: null };
    },
    remove: async (keys: string[]) => {
      calls.push({ op: 'remove', args: [name, keys] });
      return { data: keys.map((key) => ({ name: key })), error: null };
    },
  });

  const client = {
    storage: { from: (name: string) => bucket(name) },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe('Supabase Storage adapter', () => {
  function adapter() {
    const fake = fakeSupabase();
    return {
      adapter: new SupabaseStorageAdapter('https://project.test', 'service-key', 'space-files', 600, fake.client),
      calls: fake.calls,
    };
  }

  it('issues signed upload URLs capped at the provider window', async () => {
    const { adapter: storage, calls } = adapter();
    const signed = await storage.createSignedUploadUrl('spaces/s1/file1/a.txt', 24 * 60 * 60);
    expect(signed.url).toContain('token=up');
    const expiryMs = new Date(signed.expiresAt).getTime() - Date.now();
    expect(expiryMs).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 5_000);
    expect(calls[0]!.args[2]).toEqual({ upsert: false });
  });

  it('creates attachment and inline download URLs', async () => {
    const { adapter: storage, calls } = adapter();
    await storage.createSignedDownloadUrl('spaces/s1/file1/a.txt', 300, 'a.txt');
    await storage.createSignedDownloadUrl('spaces/s1/file1/a.png', 300, undefined, 'image/png');
    expect(calls[0]!.args[3]).toEqual({ download: 'a.txt' });
    expect(calls[1]!.args[3]).toEqual({});
  });

  it('uploads with a MIME type and reports provider metadata', async () => {
    const { adapter: storage, calls } = adapter();
    const info = await storage.putObject('spaces/s1/file1/a.png', Buffer.from('png-bytes'));
    const upload = calls.find((call) => call.op === 'upload')!;
    expect((upload.args[3] as { contentType: string }).contentType).toBe('image/png');
    expect(info.size).toBe(42);
    expect(info.etag).toBe('etag-1');
  });

  it('downloads, lists nested objects and deletes', async () => {
    const { adapter: storage, calls } = adapter();
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.getObject('spaces/s1/file1/a.txt')) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('payload');

    const listed = await storage.listObjects('spaces/s1');
    expect(listed.map((object) => object.key)).toEqual(['spaces/s1/nested/a.txt', 'spaces/s1/other.txt']);
    expect(listed[0]!.size).toBe(42);

    await storage.deleteObject('spaces/s1/file1/a.txt');
    expect(calls.find((call) => call.op === 'remove')!.args[1]).toEqual(['spaces/s1/file1/a.txt']);
  });

  it('surfaces provider errors as STORAGE_ERROR', async () => {
    const failing = {
      storage: {
        from: () => ({
          remove: async () => ({ data: null, error: { message: 'denied' } }),
        }),
      },
    } as unknown as SupabaseClient;
    const storage = new SupabaseStorageAdapter('https://project.test', 'key', 'bucket', 600, failing);
    await expect(storage.deleteObject('x')).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });
});

// ---------------------------------------------------------------------------
// Schema parity (static)
// ---------------------------------------------------------------------------

describe('schema parity', () => {
  it('has a target table for every source table', async () => {
    const source = await readSourceTables(await seedSqlite(), TABLE_ORDER);
    // Target table list as created by the migrations (verified against a local
    // Postgres during Module 15); keep this list in sync with 00*.sql.
    const target = [
      'profiles', 'credentials', 'spaces', 'members', 'folders', 'invitations', 'invite_links',
      'join_requests', 'extension_requests', 'files', 'archives', 'notifications', 'jobs',
      'cleanup_runs', 'activity', 'scan_jobs', 'duplicate_groups', 'duplicate_files',
      'archive_plans', 'archive_jobs', 'space_access', 'space_favorites', 'legacy_account_links',
      'account_audit', 'admin_audit', 'lifecycle_transitions', 'email_jobs', 'verification_tokens',
    ];
    const parity = checkTableParity(source, target);
    expect(parity.missingInTarget).toEqual([]);
  });
});
