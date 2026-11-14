/** PostgreSQL implementation of `ArchivesRepo` (Vault archive metadata). */
import type { Pool } from 'pg';
import type { Archive, ArchiveStatus } from '@flashspace/shared';
import type { ArchivesRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { withTransaction } from '../pool.js';
import { mapArchiveRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, space_id, owner_id, object_key, size_bytes, checksum, file_count, status, created_at, verified_at';

export class PostgresArchivesRepo implements ArchivesRepo {
  constructor(private readonly pool: Pool) {}

  async insert(archive: Archive): Promise<Archive> {
    try {
      await this.pool.query(
        `insert into archives
           (id, space_id, owner_id, object_key, size_bytes, checksum, file_count, status,
            created_at, verified_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          archive.id,
          archive.spaceId,
          archive.ownerId,
          archive.objectKey,
          archive.sizeBytes,
          archive.checksum,
          archive.fileCount,
          archive.status,
          archive.createdAt,
          archive.verifiedAt,
        ],
      );
      return archive;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<Archive | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from archives where id = $1`,
        [id],
      );
      return rows[0] ? mapArchiveRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForOwner(ownerId: string): Promise<Archive[]> {
    return this.listWhere('owner_id', ownerId);
  }

  async listByStatus(status: ArchiveStatus): Promise<Archive[]> {
    return this.listWhere('status', status);
  }

  async listForSpace(spaceId: string): Promise<Archive[]> {
    return this.listWhere('space_id', spaceId);
  }

  async listAll(): Promise<Archive[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from archives order by created_at desc`,
      );
      return rows.map(mapArchiveRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async update(id: string, patch: Partial<Archive>): Promise<Archive | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const current = await client.query<DbRow>(
          `select ${COLUMNS} from archives where id = $1 for update`,
          [id],
        );
        const row = current.rows[0];
        if (!row) return undefined;
        const next: Archive = { ...mapArchiveRow(row), ...patch };
        const { rows } = await client.query<DbRow>(
          `update archives
              set object_key = $2, size_bytes = $3, checksum = $4, file_count = $5,
                  status = $6, verified_at = $7
            where id = $1
            returning ${COLUMNS}`,
          [
            id,
            next.objectKey,
            next.sizeBytes,
            next.checksum,
            next.fileCount,
            next.status,
            next.verifiedAt,
          ],
        );
        return rows[0] ? mapArchiveRow(rows[0]) : undefined;
      });
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  private async listWhere(column: 'owner_id' | 'space_id' | 'status', value: string): Promise<Archive[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from archives where ${column} = $1 order by created_at desc`,
        [value],
      );
      return rows.map(mapArchiveRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
