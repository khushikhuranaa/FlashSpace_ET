/** PostgreSQL implementation of `FoldersRepo`. */
import type { Pool } from 'pg';
import type { Folder } from '@flashspace/shared';
import type { FoldersRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { mapFolderRow, type DbRow } from './rows.js';

const COLUMNS = 'id, space_id, parent_id, name, path, created_at, updated_at';

export class PostgresFoldersRepo implements FoldersRepo {
  constructor(private readonly pool: Pool) {}

  async insert(folder: Folder): Promise<Folder> {
    try {
      await this.pool.query(
        `insert into folders (id, space_id, parent_id, name, path, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          folder.id,
          folder.spaceId,
          folder.parentId,
          folder.name,
          folder.path,
          folder.createdAt,
          folder.updatedAt,
        ],
      );
      return folder;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<Folder | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from folders where id = $1`,
        [id],
      );
      return rows[0] ? mapFolderRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForSpace(spaceId: string): Promise<Folder[]> {
    try {
      // SQLite returns insertion order; created_at + id is its stable analogue.
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from folders where space_id = $1 order by created_at asc, id asc`,
        [spaceId],
      );
      return rows.map(mapFolderRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async update(id: string, patch: Partial<Folder>): Promise<Folder | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `update folders
            set parent_id = case when $2 then $3 else parent_id end,
                name = coalesce($4, name),
                path = coalesce($5, path),
                updated_at = $6
          where id = $1
          returning ${COLUMNS}`,
        [
          id,
          patch.parentId !== undefined,
          patch.parentId ?? null,
          patch.name ?? null,
          patch.path ?? null,
          new Date().toISOString(),
        ],
      );
      return rows[0] ? mapFolderRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      const { rowCount } = await this.pool.query('delete from folders where id = $1', [id]);
      return (rowCount ?? 0) > 0;
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
