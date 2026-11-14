/** PostgreSQL implementation of `DuplicateFilesRepo`. */
import type { Pool } from 'pg';
import type { DuplicateFilesRepo, DuplicateFileRow } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { mapDuplicateFileRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, group_id, scan_id, file_id, name, object_key, size_bytes, mime_type, ' +
  'uploaded_at, uploader_id, excluded';

export class PostgresDuplicateFilesRepo implements DuplicateFilesRepo {
  constructor(private readonly pool: Pool) {}

  async insert(file: DuplicateFileRow): Promise<DuplicateFileRow> {
    try {
      await this.pool.query(
        `insert into duplicate_files
           (id, group_id, scan_id, file_id, name, object_key, size_bytes, mime_type,
            uploaded_at, uploader_id, excluded)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          file.id,
          file.groupId,
          file.scanId,
          file.fileId,
          file.name,
          file.objectKey,
          file.sizeBytes,
          file.mimeType,
          file.uploadedAt,
          file.uploaderId,
          file.excluded,
        ],
      );
      return file;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<DuplicateFileRow | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from duplicate_files where id = $1`,
        [id],
      );
      return rows[0] ? mapDuplicateFileRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForGroup(groupId: string): Promise<DuplicateFileRow[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from duplicate_files where group_id = $1`,
        [groupId],
      );
      return rows.map(mapDuplicateFileRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listAll(): Promise<DuplicateFileRow[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from duplicate_files`,
      );
      return rows.map(mapDuplicateFileRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async deleteForGroup(groupId: string): Promise<void> {
    try {
      await this.pool.query('delete from duplicate_files where group_id = $1', [groupId]);
    } catch (err) {
      mapPostgresError(err);
    }
  }

  async deleteForScan(scanId: string): Promise<void> {
    try {
      await this.pool.query('delete from duplicate_files where scan_id = $1', [scanId]);
    } catch (err) {
      mapPostgresError(err);
    }
  }
}
