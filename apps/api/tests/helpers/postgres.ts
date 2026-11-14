/**
 * Disposable PostgreSQL databases for repository contract tests.
 *
 * Safety rules:
 *  - Tests run only when TEST_POSTGRES_URL is set; otherwise they skip.
 *  - The URL is rejected when it looks like Supabase, so a misconfigured local
 *    environment can never create/drop databases in the cloud project.
 *  - Every database is created with a `fs_test_` prefix and dropped afterwards;
 *    the connection's own database and the SQLite file are never touched.
 */
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';

const CLOUD_HOST = /(^|\.)supabase\.(co|com|net)$|pooler\.supabase/i;

export interface DisposableDatabase {
  url: string;
  name: string;
  drop: () => Promise<void>;
}

export function assertDisposablePostgresUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('TEST_POSTGRES_URL must be a valid postgresql:// URL');
  }
  if (CLOUD_HOST.test(parsed.hostname)) {
    throw new Error('TEST_POSTGRES_URL points at Supabase; refusing to create or drop databases there');
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new Error('TEST_POSTGRES_URL must use the postgres:// or postgresql:// scheme');
  }
}

export function postgresTestUrl(): string | null {
  const url = process.env.TEST_POSTGRES_URL?.trim();
  if (!url) return null;
  assertDisposablePostgresUrl(url);
  return url;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function adminClient(url: string): Promise<Client> {
  // `postgres` always exists and is the standard maintenance database. If the
  // supplied URL already targets it, this is a no-op.
  const client = new Client({
    connectionString: withDatabase(url, 'postgres'),
    connectionTimeoutMillis: 5_000,
    application_name: 'flashspace-test-admin',
  });
  await client.connect();
  return client;
}

/** Create an empty database and return its URL plus an idempotent drop helper. */
export async function createDisposableDatabase(
  baseUrl: string,
): Promise<DisposableDatabase> {
  assertDisposablePostgresUrl(baseUrl);
  const name = `fs_test_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const client = await adminClient(baseUrl);
  try {
    await client.query(`create database "${name}"`);
  } finally {
    await client.end();
  }

  let dropped = false;
  return {
    name,
    url: withDatabase(baseUrl, name),
    drop: async () => {
      if (dropped) return;
      dropped = true;
      const admin = await adminClient(baseUrl);
      try {
        await admin.query(
          'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
          [name],
        );
        await admin.query(`drop database if exists "${name}"`);
      } finally {
        await admin.end();
      }
    },
  };
}
