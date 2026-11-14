/** PostgreSQL implementation of `FilesRepo` (metadata only; bytes stay in storage). */
import type { Pool } from 'pg';
import type { FileRecord } from '@flashspace/shared';
import type { FilesRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { withTransaction } from '../pool.js';
import { mapFileRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, space_id, folder_id, uploader_id, name, object_key, mime_type, size_bytes, etag, ' +
  'sha256, status, created_at, updated_at, deleted_at';

export class PostgresFilesRepo implements FilesRepo {
  constructor(private readonly pool: Pool) {}

  async insert(file: FileRecord): Promise<FileRecord> {
    try {
      await this.pool.query(
        `insert into files
           (id, space_id, folder_id, uploader_id, name, object_key, mime_type, size_bytes,
            etag, sha256, status, created_at, updated_at, deleted_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          file.id,
          file.spaceId,
          file.folderId,
          file.uploaderId,
          file.name,
          file.objectKey,
          file.mimeType,
          file.sizeBytes,
          file.etag,
          file.sha256,
          file.status,
          file.createdAt,
          file.updatedAt,
          file.deletedAt,
        ],
      );
      return file;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<FileRecord | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from files where id = $1`,
        [id],
      );
      return rows[0] ? mapFileRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForSpace(spaceId: string): Promise<FileRecord[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from files where space_id = $1 order by created_at desc`,
        [spaceId],
      );
      return rows.map(mapFileRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listAll(): Promise<FileRecord[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from files order by created_at desc`,
      );
      return rows.map(mapFileRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listActiveForSpace(spaceId: string): Promise<FileRecord[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from files
          where space_id = $1 and status = 'ACTIVE'
          order by created_at desc`,
        [spaceId],
      );
      return rows.map(mapFileRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findByObjectKey(objectKey: string): Promise<FileRecord | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from files where object_key = $1`,
        [objectKey],
      );
      return rows[0] ? mapFileRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async update(id: string, patch: Partial<FileRecord>): Promise<FileRecord | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const current = await client.query<DbRow>(
          `select ${COLUMNS} from files where id = $1 for update`,
          [id],
        );
        const row = current.rows[0];
        if (!row) return undefined;
        const next: FileRecord = {
          ...mapFileRow(row),
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        const { rows } = await client.query<DbRow>(
          `update files
              set name = $2, folder_id = $3, mime_type = $4, size_bytes = $5,
                  etag = $6, sha256 = $7, status = $8, updated_at = $9, deleted_at = $10
            where id = $1
            returning ${COLUMNS}`,
          [
            id,
            next.name,
            next.folderId,
            next.mimeType,
            next.sizeBytes,
            next.etag,
            next.sha256,
            next.status,
            next.updatedAt,
            next.deletedAt,
          ],
        );
        return rows[0] ? mapFileRow(rows[0]) : undefined;
      });
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async usedBytesForSpace(spaceId: string): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ total: string }>(
        `select coalesce(sum(size_bytes), 0)::text as total
           from files
          where space_id = $1 and status = 'ACTIVE'`,
        [spaceId],
      );
      return Number(rows[0]?.total ?? 0);
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
