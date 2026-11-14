import { buildApp } from './app.js';
import { checkPostgresHealth, closeSharedPostgresPool } from './repositories/postgres/pool.js';
import { migrateDatabase } from './repositories/postgres/migrate.js';

async function start(): Promise<void> {
  const { app, ctx } = buildApp();

  // Never announce a healthy server when PostgreSQL mode cannot reach its
  // database. Local/memory modes have no external dependency to check.
  if (ctx.env.repoMode === 'postgres') {
    const health = await checkPostgresHealth(ctx.env);
    if (health.status !== 'healthy') {
      if (health.status === 'unavailable') {
        console.error(
          `[startup] PostgreSQL unavailable (${health.error.code ?? 'unknown'}): ${health.error.message}`,
        );
      } else if (health.status === 'unconfigured') {
        console.error(`[startup] PostgreSQL is not configured: ${health.detail}`);
      } else {
        console.error('[startup] PostgreSQL is not ready');
      }
      await closeSharedPostgresPool().catch(() => undefined);
      process.exit(1);
    }
  }

  // Single-instance hosts (Render/Fly) can apply the schema during boot. The
  // migration runner takes a Postgres advisory lock, so concurrent instances are
  // serialized instead of racing; migrations are checksummed and transactional.
  if (ctx.env.repoMode === 'postgres' && ctx.env.runMigrationsOnBoot) {
    const report = await migrateDatabase(ctx.env.databaseUrl, {
      log: (message) => console.log(`[migrate] ${message}`),
    });
    console.log(
      `[migrate] applied ${report.applied.length}, already applied ${report.skipped.length}`,
    );
  }

  const port = ctx.env.port;
  const server = app.listen(port, () => {
    console.log(
      `FlashSpace API listening on http://localhost:${port} (env: ${ctx.env.nodeEnv}, repo: ${ctx.env.repoMode}, storage: ${ctx.env.storageMode})`,
    );
  });

  // Local dev convenience: run the lifecycle pass every 5 minutes in-process.
  // In production an external scheduler (platform cron or GitHub Actions) hits
  // POST /jobs/lifecycle/run — an in-process timer would run once per instance
  // and disappear whenever the host restarts.
  if (ctx.env.nodeEnv !== 'production') {
    const intervalMs = 5 * 60 * 1000;
    setInterval(() => {
      ctx.services.lifecycle
        .runLifecyclePass({ source: 'cron', jobSecret: ctx.env.jobSecret })
        .then((r) => {
          if (r.scanned > 0 && (r.warned || r.archived || r.finalized || r.failures.length)) {
            console.log('[lifecycle]', JSON.stringify(r));
          }
        })
        .catch((err) => console.error('[lifecycle] failed', err));
    }, intervalMs).unref();
  }

  /** Stop accepting requests, let in-flight work finish, then exit. */
  function shutdown(signal: string): void {
    console.log(`[shutdown] ${signal} received, closing server`);
    server.close(async (err) => {
      if (err) {
        console.error('[shutdown] error while closing', err);
        process.exit(1);
      }
      try {
        await closeSharedPostgresPool();
      } catch (poolErr) {
        console.error('[shutdown] error while closing the Postgres pool', poolErr);
      }
      process.exit(0);
    });
    // Don't hang forever on a stuck connection (e.g. a paused upload stream).
    setTimeout(() => {
      console.error('[shutdown] forced exit after 10s');
      process.exit(1);
    }, 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void start().catch((err) => {
  console.error('[startup] failed', err);
  process.exit(1);
});
