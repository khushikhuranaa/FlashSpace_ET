/**
 * Data-layer factory. Everything above this line is storage-agnostic: services
 * only ever see the `DataLayer` contract.
 */
import type { Env } from '../config/env.js';
import type { DataLayer } from './data-layer.interface.js';
import { MemoryDataLayer } from './memory/data-layer.js';
import { SqliteDataLayer } from './sqlite/sqlite.data-layer.js';

export type { DataLayer } from './data-layer.interface.js';
export { MemoryDataLayer } from './memory/data-layer.js';
export { SqliteDataLayer } from './sqlite/sqlite.data-layer.js';

export function createDataLayer(env: Env): DataLayer {
  switch (env.repoMode) {
    case 'sqlite':
      return new SqliteDataLayer(env.sqliteFile);
    case 'memory':
      return new MemoryDataLayer();
    case 'postgres':
      throw new Error(
        'REPO_MODE=postgres is not wired up in this build. Use REPO_MODE=sqlite for a ' +
          'persistent local database (default) or REPO_MODE=memory for ephemeral state. ' +
          'The Postgres schema and runner live in src/repositories/postgres/.',
      );
    default:
      return new MemoryDataLayer();
  }
}
