/** PostgreSQL implementation of `SpaceAccessRepo`. */
import type { Pool } from 'pg';
import type { SpaceAccess, SpaceAccessRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { mapAccessRow, type DbRow } from './rows.js';

export class PostgresSpaceAccessRepo implements SpaceAccessRepo {
  constructor(private readonly pool: Pool) {}

  async touch(spaceId: string, userId: string, at: string): Promise<void> {
    try {
      await this.pool.query(
        `insert into space_access (space_id, user_id, last_accessed_at)
         values ($1,$2,$3)
         on conflict (space_id, user_id)
         do update set last_accessed_at = excluded.last_accessed_at`,
        [spaceId, userId, at],
      );
    } catch (err) {
      mapPostgresError(err);
    }
  }

  async listForUser(userId: string, limit = 20): Promise<SpaceAccess[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select space_id, user_id, last_accessed_at
           from space_access
          where user_id = $1
          order by last_accessed_at desc
          limit $2`,
        [userId, limit],
      );
      return rows.map(mapAccessRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
