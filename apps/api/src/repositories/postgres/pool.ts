/**
 * PostgreSQL connection infrastructure.
 *
 * Design notes:
 *  - One `pg.Pool` per process, created lazily from `DATABASE_URL`.
 *  - Pool sizing and timeouts are configured through validated env values, so a
 *    hung database can never hang a request forever.
 *  - Errors and logs never include the connection string or credentials.
 *  - `withTransaction` is the only supported way to run multi-statement work:
 *    it always COMMITs on success, ROLLBACKs on failure and releases the client.
 *
 * This module deliberately contains no repository logic. It is the foundation
 * the PostgresDataLayer will be built on.
 */
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { Env } from '../../config/env.js';

export interface PostgresConnectionSettings {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  statementTimeoutMillis: number;
  applicationName: string;
}

export type PostgresHealth =
  | { status: 'not_applicable'; engine: 'memory' | 'sqlite' }
  | { status: 'unconfigured'; engine: 'postgres'; detail: string }
  | { status: 'healthy'; engine: 'postgres'; latencyMs: number }
  | {
      status: 'unavailable';
      engine: 'postgres';
      latencyMs: number;
      error: { code: string | null; message: string };
    };

/** Strip any `postgres://user:password@host` fragment before it reaches a log. */
export function redactConnectionString(value: string): string {
  return value.replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, '$1***@');
}

/** Turn an unknown driver error into a small, credential-free description. */
export function describePostgresError(err: unknown): { code: string | null; message: string } {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return {
      code: typeof code === 'string' ? code : null,
      message: redactConnectionString(err.message),
    };
  }
  return { code: null, message: redactConnectionString(String(err)) };
}

export function postgresSettingsFromEnv(env: Env): PostgresConnectionSettings | null {
  const connectionString = env.databaseUrl.trim();
  if (!connectionString) return null;
  return {
    connectionString,
    max: env.pgPoolMax,
    connectionTimeoutMillis: env.pgConnectTimeoutMs,
    idleTimeoutMillis: env.pgIdleTimeoutMs,
    statementTimeoutMillis: env.pgStatementTimeoutMs,
    applicationName: 'flashspace-api',
  };
}

export function createPostgresPool(settings: PostgresConnectionSettings): Pool {
  const config: PoolConfig = {
    connectionString: settings.connectionString,
    max: settings.max,
    connectionTimeoutMillis: settings.connectionTimeoutMillis,
    idleTimeoutMillis: settings.idleTimeoutMillis,
    statement_timeout: settings.statementTimeoutMillis,
    // Supabase's transaction pooler does not support named prepared statements.
    // Keeping this on is safe for both the direct connection and the pooler.
    application_name: settings.applicationName,
    allowExitOnIdle: false,
  };
  const pool = new Pool(config);
  // An idle client error is emitted asynchronously; without a listener Node
  // terminates the process. Log a redacted description and keep serving: the
  // pool replaces the broken client on the next checkout.
  pool.on('error', (err) => {
    const safe = describePostgresError(err);
    console.error(`[postgres] idle client error (${safe.code ?? 'unknown'}): ${safe.message}`);
  });
  return pool;
}

/**
 * Run `fn` in a transaction on one dedicated client.
 *
 * COMMIT on success, ROLLBACK on any thrown error, release in `finally`. A
 * rollback failure is logged and the original error is rethrown so callers see
 * the real cause. Nested transactions are intentionally not supported: services
 * in FlashSpace call repositories individually, and inventing savepoints would
 * hide double-commit bugs.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch (rollbackErr) {
      const safe = describePostgresError(rollbackErr);
      console.error(`[postgres] rollback failed (${safe.code ?? 'unknown'}): ${safe.message}`);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lazily-created shared pool for the process. Repository code and the health
 * endpoint share it so health checks cannot exhaust connections.
 */
let sharedPool: Pool | null = null;
let sharedConnectionString = '';

export function getSharedPostgresPool(env: Env): Pool | null {
  const settings = postgresSettingsFromEnv(env);
  if (!settings) return null;
  if (!sharedPool || sharedConnectionString !== settings.connectionString) {
    if (sharedPool) {
      const previous = sharedPool;
      // Best effort: the old pool may still be serving in-flight requests.
      void previous.end().catch(() => undefined);
    }
    sharedPool = createPostgresPool(settings);
    sharedConnectionString = settings.connectionString;
  }
  return sharedPool;
}

/** Close the shared pool during shutdown. Safe to call more than once. */
export async function closeSharedPostgresPool(): Promise<void> {
  const pool = sharedPool;
  sharedPool = null;
  sharedConnectionString = '';
  if (pool) await pool.end();
}

/** Test-only: drop the cached handle without touching the database. */
export function resetSharedPostgresPoolForTests(): void {
  sharedPool = null;
  sharedConnectionString = '';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`health check timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Real connection check, not a configuration check.
 *
 * - memory/sqlite → `not_applicable` (Postgres is not the active store)
 * - postgres without DATABASE_URL → `unconfigured`
 * - postgres with a URL → `select 1`, reported as `healthy`/`unavailable`
 */
export async function checkPostgresHealth(env: Env): Promise<PostgresHealth> {
  if (env.repoMode !== 'postgres') {
    return { status: 'not_applicable', engine: env.repoMode };
  }
  if (!env.databaseUrl.trim()) {
    return {
      status: 'unconfigured',
      engine: 'postgres',
      detail: 'DATABASE_URL is not set',
    };
  }

  const pool = getSharedPostgresPool(env);
  if (!pool) {
    return { status: 'unconfigured', engine: 'postgres', detail: 'DATABASE_URL is not set' };
  }

  const startedAt = Date.now();
  try {
    await withTimeout(pool.query('select 1 as ok'), Math.max(env.pgConnectTimeoutMs, 1_000));
    return { status: 'healthy', engine: 'postgres', latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      status: 'unavailable',
      engine: 'postgres',
      latencyMs: Date.now() - startedAt,
      error: describePostgresError(err),
    };
  }
}
