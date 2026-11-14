/**
 * Complete PostgreSQL DataLayer.
 *
 * All 26 repository domains come from `createPostgresCoreRepositories`; this
 * module adds the two non-repository members the DataLayer contract requires:
 * an in-process notification bus and a real health check.
 */
import type { Env } from '../../config/env.js';
import type { DataLayer } from '../data-layer.interface.js';
import { createPostgresCoreRepositories } from './core.js';
import { getSharedPostgresPool } from './pool.js';
import { PostgresNotificationBus } from './notification-bus.js';

export function createPostgresDataLayer(env: Env): DataLayer {
  const pool = getSharedPostgresPool(env);
  if (!pool) {
    throw new Error(
      'REPO_MODE=postgres requires DATABASE_URL (PostgreSQL connection string) on the API',
    );
  }
  const repositories = createPostgresCoreRepositories(env, pool);
  return {
    ...repositories,
    notificationBus: new PostgresNotificationBus(),
    healthCheck: async () => {
      // A real round-trip: /ready must fail when the database is unreachable.
      await pool.query('select 1');
    },
  };
}
