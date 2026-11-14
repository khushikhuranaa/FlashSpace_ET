/** PostgreSQL implementation of `DuplicateGroupsRepo`. */
import type { Pool } from 'pg';
import type { DuplicateGroupsRepo, DuplicateGroupRow } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { withTransaction } from '../pool.js';
import { mapDuplicateGroupRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, scan_id, content_hash, file_count, extra_copy_count, total_bytes, ' +
  'potential_savings_bytes, representative_name';

export class PostgresDuplicateGroupsRepo implements DuplicateGroupsRepo {
  constructor(private readonly pool: Pool) {}

  async insert(group: DuplicateGroupRow): Promise<DuplicateGroupRow> {
    try {
      await this.pool.query(
        `insert into duplicate_groups
           (id, scan_id, content_hash, file_count, extra_copy_count, total_bytes,
            potential_savings_bytes, representative_name)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          group.id,
          group.scanId,
          group.contentHash,
          group.fileCount,
          group.extraCopyCount,
          group.totalBytes,
          group.potentialSavingsBytes,
          group.representativeName,
        ],
      );
      return group;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<DuplicateGroupRow | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from duplicate_groups where id = $1`,
        [id],
      );
      return rows[0] ? mapDuplicateGroupRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForScan(scanId: string): Promise<DuplicateGroupRow[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from duplicate_groups
          where scan_id = $1
          order by total_bytes desc`,
        [scanId],
      );
      return rows.map(mapDuplicateGroupRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async deleteForScan(scanId: string): Promise<void> {
    try {
      // Explicit order matches SQLite (files first, then groups). The FK also
      // cascades, but deleting both keeps behaviour obvious and independent of
      // constraint timing.
      await withTransaction(this.pool, async (client) => {
        await client.query('delete from duplicate_files where scan_id = $1', [scanId]);
        await client.query('delete from duplicate_groups where scan_id = $1', [scanId]);
      });
    } catch (err) {
      mapPostgresError(err);
    }
  }
}
