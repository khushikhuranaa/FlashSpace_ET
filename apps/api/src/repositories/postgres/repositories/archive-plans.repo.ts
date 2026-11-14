/** PostgreSQL implementation of `ArchivePlansRepo`. */
import type { Pool } from 'pg';
import type { ArchivePlansRepo, ArchivePlanRow } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { withTransaction } from '../pool.js';
import { mapArchivePlanRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, space_id, owner_id, scan_id, status, excluded_file_ids, will_archive_file_count, ' +
  'will_archive_bytes, will_exclude_file_count, will_exclude_bytes, potential_savings_bytes, ' +
  'explained, confirmed_at, archive_job_id, error_message, created_at, updated_at';

export class PostgresArchivePlansRepo implements ArchivePlansRepo {
  constructor(private readonly pool: Pool) {}

  async insert(plan: ArchivePlanRow): Promise<ArchivePlanRow> {
    try {
      await this.pool.query(
        `insert into archive_plans
           (id, space_id, owner_id, scan_id, status, excluded_file_ids,
            will_archive_file_count, will_archive_bytes, will_exclude_file_count,
            will_exclude_bytes, potential_savings_bytes, explained, confirmed_at,
            archive_job_id, error_message, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          plan.id,
          plan.spaceId,
          plan.ownerId,
          plan.scanId,
          plan.status,
          plan.excludedFileIds.join(','),
          plan.willArchiveFileCount,
          plan.willArchiveBytes,
          plan.willExcludeFileCount,
          plan.willExcludeBytes,
          plan.potentialSavingsBytes,
          plan.explained,
          plan.confirmedAt,
          plan.archiveJobId,
          plan.errorMessage,
          plan.createdAt,
          plan.updatedAt,
        ],
      );
      return plan;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<ArchivePlanRow | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from archive_plans where id = $1`,
        [id],
      );
      return rows[0] ? mapArchivePlanRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForSpace(spaceId: string): Promise<ArchivePlanRow[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from archive_plans
          where space_id = $1
          order by updated_at desc`,
        [spaceId],
      );
      return rows.map(mapArchivePlanRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async update(id: string, patch: Partial<ArchivePlanRow>): Promise<ArchivePlanRow | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const current = await client.query<DbRow>(
          `select ${COLUMNS} from archive_plans where id = $1 for update`,
          [id],
        );
        const row = current.rows[0];
        if (!row) return undefined;
        const next: ArchivePlanRow = {
          ...mapArchivePlanRow(row),
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        const { rows } = await client.query<DbRow>(
          `update archive_plans
              set status = $2, scan_id = $3, excluded_file_ids = $4,
                  will_archive_file_count = $5, will_archive_bytes = $6,
                  will_exclude_file_count = $7, will_exclude_bytes = $8,
                  potential_savings_bytes = $9, explained = $10, confirmed_at = $11,
                  archive_job_id = $12, error_message = $13, updated_at = $14
            where id = $1
            returning ${COLUMNS}`,
          [
            id,
            next.status,
            next.scanId,
            Array.isArray(next.excludedFileIds)
              ? next.excludedFileIds.join(',')
              : next.excludedFileIds,
            next.willArchiveFileCount,
            next.willArchiveBytes,
            next.willExcludeFileCount,
            next.willExcludeBytes,
            next.potentialSavingsBytes,
            next.explained,
            next.confirmedAt,
            next.archiveJobId,
            next.errorMessage,
            next.updatedAt,
          ],
        );
        return rows[0] ? mapArchivePlanRow(rows[0]) : undefined;
      });
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async deleteForSpace(spaceId: string): Promise<void> {
    try {
      await this.pool.query('delete from archive_plans where space_id = $1', [spaceId]);
    } catch (err) {
      mapPostgresError(err);
    }
  }
}
