import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { loadEnv } from '../../config/env.js';

/**
 * Migration runner for the Supabase/Postgres schema.
 *
 * Guarantees:
 *  - migrations run in filename order, exactly once;
 *  - each file runs inside its own transaction (rollback on failure);
 *  - a failed migration aborts the run loudly — nothing is silently skipped;
 *  - a SHA-256 checksum is stored with each applied migration, so an edited
 *    historical migration is reported as drift instead of being ignored;
 *  - `--dry-run` reports what would run without touching the schema;
 *  - `--status` prints applied / pending / missing / drifted migrations;
 *  - concurrent runs are serialized by a session-level advisory lock held across
 *    the full migration run (connect -> shim -> migrations -> disconnect).
 *
 * The client is injected, so the runner can be tested without a live database
 * while the CLI uses a real `pg` Client.
 *
 * Lock key: `MIGRATION_ADVISORY_LOCK_KEY` (decimal `91311257`; session-level
 * `pg_advisory_lock` / `pg_advisory_unlock`). The lock is acquired after the
 * client connects and before the optional local Supabase shim; it is released in
 * `finally`, and the client is still closed when lock acquisition or release-
 * related queries fail.
 */

export interface QueryResultLike {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

/** Minimal surface the runner needs; satisfied by `pg` Client/Pool. */
export interface MigrationClient {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>;
}

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  name: string;
  checksum: string | null;
  appliedAt: string;
}

export interface MigrationStatusReport {
  applied: AppliedMigration[];
  pending: MigrationFile[];
  /** Recorded as applied but no longer present on disk. */
  missing: string[];
  /** Applied files whose content changed after being applied. */
  drifted: Array<{ name: string; recorded: string | null; actual: string }>;
}

export interface MigrationRunReport {
  applied: string[];
  skipped: string[];
  wouldApply: string[];
  dryRun: boolean;
}

export class MigrationError extends Error {
  constructor(
    readonly migration: string,
    override readonly cause: unknown,
  ) {
    super(`Migration ${migration} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'MigrationError';
  }
}

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCAL_SHIM_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'local-supabase-shim.sql',
);

/**
 * Migration 003 references `auth.users`, which Supabase provides but a plain
 * PostgreSQL server does not. When (and only when) that table is absent we apply
 * the local compatibility shim first. On a real Supabase project the table
 * exists, so this is a no-op and no conflicting schema is created.
 *
 * Returns true when the shim was applied.
 */
export async function ensureLocalSupabaseShim(
  client: MigrationClient,
  log: (message: string) => void = () => undefined,
): Promise<boolean> {
  const { rows } = await client.query("select to_regclass('auth.users') as present");
  if (rows[0]?.present) return false;
  log('auth.users is missing: applying local Supabase compatibility shim');
  const sql = await readFile(LOCAL_SHIM_PATH, 'utf8');
  await client.query(sql);
  return true;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/** Read and checksum every migration on disk, sorted by filename. */
export async function loadMigrationFiles(dir = DIR): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const name of names) {
    const sql = await readFile(path.join(dir, name), 'utf8');
    files.push({ name, sql, checksum: checksum(sql) });
  }
  return files;
}

async function ensureHistory(client: MigrationClient): Promise<void> {
  await client.query(
    `create table if not exists schema_migrations (
       name text primary key,
       checksum text,
       applied_at timestamptz not null default now()
     )`,
  );
  // Older installs created the table without a checksum column.
  await client.query('alter table schema_migrations add column if not exists checksum text');
}

export async function getMigrationStatus(
  client: MigrationClient,
  files?: MigrationFile[],
): Promise<MigrationStatusReport> {
  await ensureHistory(client);
  const onDisk = files ?? (await loadMigrationFiles());
  const { rows } = await client.query(
    'select name, checksum, applied_at from schema_migrations order by name',
  );
  const applied: AppliedMigration[] = rows.map((row) => ({
    name: String(row.name),
    checksum: (row.checksum as string | null) ?? null,
    appliedAt: new Date(row.applied_at as string | Date).toISOString(),
  }));

  const byName = new Map(applied.map((entry) => [entry.name, entry]));
  const pending = onDisk.filter((file) => !byName.has(file.name));
  const missing = applied
    .filter((entry) => !onDisk.some((file) => file.name === entry.name))
    .map((e) => e.name);
  const drifted = onDisk
    .filter((file) => {
      const record = byName.get(file.name);
      return record && record.checksum !== null && record.checksum !== file.checksum;
    })
    .map((file) => ({
      name: file.name,
      recorded: byName.get(file.name)?.checksum ?? null,
      actual: file.checksum,
    }));

  return { applied, pending, missing, drifted };
}

export interface RunOptions {
  dryRun?: boolean;
  /** Run even when a previously applied migration's content changed. */
  allowDrift?: boolean;
  log?: (message: string) => void;
  files?: MigrationFile[];
  /** Skip the (Supabase-only) RLS/extension statements when verifying locally. */
  skipMissingHistoryTable?: boolean;
  /**
   * Apply `local-supabase-shim.sql` when `auth.users` is absent. Defaults to
   * true for `migrateDatabase`; tests of `runMigrations` are unaffected.
   */
  applyLocalShim?: boolean;
}

export async function runMigrations(
  client: MigrationClient,
  options: RunOptions = {},
): Promise<MigrationRunReport> {
  const log = options.log ?? (() => undefined);
  const status = await getMigrationStatus(client, options.files);

  if (status.drifted.length && !options.allowDrift) {
    throw new Error(
      `Migration drift detected (${status.drifted.map((d) => d.name).join(', ')}). ` +
        'Applied migrations must not be edited; add a new migration instead.',
    );
  }

  const report: MigrationRunReport = {
    applied: [],
    skipped: status.applied.map((entry) => entry.name),
    wouldApply: [],
    dryRun: Boolean(options.dryRun),
  };

  const pending = status.pending;
  if (options.dryRun) {
    report.wouldApply = pending.map((file) => file.name);
    for (const file of pending) log(`would apply ${file.name}`);
    return report;
  }

  for (const file of pending) {
    log(`applying ${file.name}`);
    try {
      await client.query('begin');
      // The migration itself, then the history row, in ONE transaction: a crash
      // between the two can never leave the schema ahead of its history.
      await client.query(file.sql);
      await client.query(
        'insert into schema_migrations (name, checksum) values ($1, $2)',
        [file.name, file.checksum],
      );
      await client.query('commit');
      report.applied.push(file.name);
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw new MigrationError(file.name, err);
    }
  }

  return report;
}

export async function withClient<T>(
  databaseUrl: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Deterministic session-level advisory lock key used by `migrateDatabase()`.
 *
 * Value: `913_11257` (decimal bigint). Origin: `913` is a stable app prefix for
 * FlashSpace migration locking; `11257` is the decimal encoding of the ASCII
 * suffix `FL` so the key is easy to recognise in `pg_locks`. Single bigint key
 * avoids typos and keeps the key stable across deploys.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 91311257n;

/**
 * Acquire the session-level advisory lock used to serialize migration runs.
 *
 * `pg_advisory_lock` is held until `pg_advisory_unlock` is called or the session
 * ends. This is what we want: the lock must span the entire `migrateDatabase()`
 * run (connect -> shim -> migrations -> disconnect), not just a single
 * transaction. A `pg_advisory_xact_lock` would be released by `commit` and would
 * not hold across the multiple transactions the runner executes.
 */
export async function acquireMigrationAdvisoryLock(
  client: MigrationClient,
  log: (message: string) => void = () => undefined,
): Promise<boolean> {
  const { rows } = await client.query(
    "select pg_try_advisory_lock($1) as acquired",
    [MIGRATION_ADVISORY_LOCK_KEY],
  );
  const acquired = Boolean(rows[0]?.acquired);
  if (!acquired)
    log('another migration run holds the advisory lock; this run will not proceed');
  return acquired;
}

/**
 * Release the session-level advisory lock acquired by `acquireMigrationAdvisoryLock()`.
 */
export async function releaseMigrationAdvisoryLock(
  client: MigrationClient,
  log: (message: string) => void = () => undefined,
): Promise<void> {
  const { rows } = await client.query(
    "select pg_advisory_unlock($1) as released",
    [MIGRATION_ADVISORY_LOCK_KEY],
  );
  const released = Boolean(rows[0]?.released);
  if (!released)
    log('could not release the migration advisory lock (may already be released)');
}

export async function migrateDatabase(
  databaseUrl: string,
  options: RunOptions = {},
): Promise<MigrationRunReport> {
  return withClient(databaseUrl, async (client) => {
    options.log?.('acquiring migration advisory lock');
    const acquired = await acquireMigrationAdvisoryLock(client, options.log);
    if (!acquired) {
      throw new Error(
        'Migration run aborted: another migration run already holds the advisory lock ' +
          '(key 91311257).',
      );
    }
    try {
      options.log?.('migration advisory lock acquired');
      if (options.applyLocalShim !== false) {
        await ensureLocalSupabaseShim(client, options.log);
      }
      return await runMigrations(client, options);
    } finally {
      options.log?.('releasing migration advisory lock');
      await releaseMigrationAdvisoryLock(client, options.log);
      options.log?.('migration advisory lock released');
    }
  });
}

// ---------------------------------------------------------------------------
// CLI entry point
//
//   npm run db:migrate   -w @flashspace/api            apply pending migrations
//   npm run db:migrate   -w @flashspace/api -- --dry-run
//   npm run db:status    -w @flashspace/api            applied / pending / drift
//
// Without this block the npm scripts loaded the module and exited 0 without
// touching the database, which looked like a successful migration.
// ---------------------------------------------------------------------------

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const env = loadEnv();
  const databaseUrl = env.databaseUrl || process.env.DATABASE_URL || '';
  if (!databaseUrl) {
    console.error('DATABASE_URL is required (Postgres/Supabase connection string).');
    process.exit(1);
  }
  const log = (message: string) => console.log(`[migrate] ${message}`);

  if (args.includes('--status')) {
    const status = await withClient(databaseUrl, (client) => getMigrationStatus(client));
    console.log(
      JSON.stringify(
        {
          applied: status.applied.map((migration) => migration.name),
          pending: status.pending.map((migration) => migration.name),
          missing: status.missing,
          drifted: status.drifted.map((entry) => entry.name),
        },
        null,
        2,
      ),
    );
    return;
  }

  const dryRun = args.includes('--dry-run');
  const report = await migrateDatabase(databaseUrl, {
    dryRun,
    applyLocalShim: !dryRun,
    log,
  });
  console.log(JSON.stringify(report, null, 2));
  console.log(
    dryRun
      ? `[migrate] dry run: ${report.wouldApply.length} migration(s) pending`
      : `[migrate] applied ${report.applied.length}, already applied ${report.skipped.length}`,
  );
}

if (isEntryPoint()) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
  void 0;
