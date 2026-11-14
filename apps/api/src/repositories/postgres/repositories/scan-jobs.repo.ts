/** PostgreSQL implementation of `ScanJobsRepo` (storage insights). */
import type { Pool } from 'pg';
import type { ScanJobsRepo, ScanJobRow } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { withTransaction } from '../pool.js';
import { mapScanJobRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, space_id, owner_id, status, total_files, total_bytes, duplicate_groups, ' +
  'duplicate_file_count, extra_copy_count, potential_savings_bytes, large_file_count, ' +
  'near_duplicate_group_count, scanned_at, failed_at, error_message, created_at, updated_at';

export class PostgresScanJobsRepo implements ScanJobsRepo {
  constructor(private readonly pool: Pool) {}

  async insert(job: ScanJobRow): Promise<ScanJobRow> {
    try {
      await this.pool.query(
        `insert into scan_jobs
           (id, space_id, owner_id, status, total_files, total_bytes, duplicate_groups,
            duplicate_file_count, extra_copy_count, potential_savings_bytes, large_file_count,
            near_duplicate_group_count, scanned_at, failed_at, error_message, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          job.id,
          job.spaceId,
          job.ownerId,
          job.status,
          job.totalFiles,
          job.totalBytes,
          job.duplicateGroups,
          job.duplicateFileCount,
          job.extraCopyCount,
          job.potentialSavingsBytes,
          job.largeFileCount,
          job.nearDuplicateGroupCount,
          job.scannedAt,
          job.failedAt,
          job.errorMessage,
          job.createdAt,
          job.updatedAt,
        ],
      );
      return job;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<ScanJobRow | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from scan_jobs where id = $1`,
        [id],
      );
      return rows[0] ? mapScanJobRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForSpace(spaceId: string): Promise<ScanJobRow[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from scan_jobs
          where space_id = $1
          order by updated_at desc`,
        [spaceId],
      );
      return rows.map(mapScanJobRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async update(id: string, patch: Partial<ScanJobRow>): Promise<ScanJobRow | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const current = await client.query<DbRow>(
          `select ${COLUMNS} from scan_jobs where id = $1 for update`,
          [id],
        );
        const row = current.rows[0];
        if (!row) return undefined;
        const next: ScanJobRow = {
          ...mapScanJobRow(row),
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        const { rows } = await client.query<DbRow>(
          `update scan_jobs
              set status = $2, total_files = $3, total_bytes = $4, duplicate_groups = $5,
                  duplicate_file_count = $6, extra_copy_count = $7,
                  potential_savings_bytes = $8, large_file_count = $9,
                  near_duplicate_group_count = $10, scanned_at = $11, failed_at = $12,
                  error_message = $13, updated_at = $14
            where id = $1
            returning ${COLUMNS}`,
          [
            id,
            next.status,
            next.totalFiles,
            next.totalBytes,
            next.duplicateGroups,
            next.duplicateFileCount,
            next.extraCopyCount,
            next.potentialSavingsBytes,
            next.largeFileCount,
            next.nearDuplicateGroupCount,
            next.scannedAt,
            next.failedAt,
            next.errorMessage,
            next.updatedAt,
          ],
        );
        return rows[0] ? mapScanJobRow(rows[0]) : undefined;
      });
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
