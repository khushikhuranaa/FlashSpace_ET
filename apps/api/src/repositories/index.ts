/**
 * Data-layer factory. Everything above this line is storage-agnostic: services
 * only ever see the `DataLayer` contract.
 */
import type { Env } from '../config/env.js';
import type { DataLayer } from './data-layer.interface.js';
import { MemoryDataLayer } from './memory/data-layer.js';
import { SqliteDataLayer } from './sqlite/sqlite.data-layer.js';
import { createPostgresDataLayer } from './postgres/data-layer.js';

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
      // No silent fallback: a missing URL is a configuration error, and a
      // connection failure is surfaced at boot by server.ts before listening.
      return createPostgresDataLayer(env);
    default:
      return new MemoryDataLayer();
  }
}
