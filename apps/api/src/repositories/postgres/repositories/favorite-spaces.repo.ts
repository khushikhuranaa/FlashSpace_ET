/** PostgreSQL implementation of `FavoriteSpacesRepo`. */
import type { Pool } from 'pg';
import type { FavoriteSpacesRepo, FavoriteSpace } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { mapFavoriteSpaceRow, type DbRow } from './rows.js';

export class PostgresFavoriteSpacesRepo implements FavoriteSpacesRepo {
  constructor(private readonly pool: Pool) {}

  async add(userId: string, spaceId: string, at: string): Promise<void> {
    try {
      // Starring is idempotent: the composite primary key keeps one row.
      await this.pool.query(
        `insert into space_favorites (user_id, space_id, created_at)
         values ($1,$2,$3)
         on conflict (user_id, space_id) do nothing`,
        [userId, spaceId, at],
      );
    } catch (err) {
      mapPostgresError(err);
    }
  }

  async remove(userId: string, spaceId: string): Promise<boolean> {
    try {
      const { rowCount } = await this.pool.query(
        'delete from space_favorites where user_id = $1 and space_id = $2',
        [userId, spaceId],
      );
      return (rowCount ?? 0) > 0;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForUser(userId: string): Promise<FavoriteSpace[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select user_id, space_id, created_at
           from space_favorites
          where user_id = $1
          order by created_at desc`,
        [userId],
      );
      return rows.map(mapFavoriteSpaceRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
