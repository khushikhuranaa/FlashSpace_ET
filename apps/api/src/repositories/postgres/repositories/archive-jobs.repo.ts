/** PostgreSQL implementation of `ArchiveJobsRepo`. */
import type { Pool } from 'pg';
import type { ArchiveJobsRepo, ArchiveJobRow } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { withTransaction } from '../pool.js';
import { mapArchiveJobRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, plan_id, space_id, owner_id, idempotency_key, status, attempts, archive_id, ' +
  'started_at, finished_at, error';

export class PostgresArchiveJobsRepo implements ArchiveJobsRepo {
  constructor(private readonly pool: Pool) {}

  async insert(job: ArchiveJobRow): Promise<ArchiveJobRow> {
    try {
      await this.pool.query(
        `insert into archive_jobs
           (id, plan_id, space_id, owner_id, idempotency_key, status, attempts,
            archive_id, started_at, finished_at, error)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          job.id,
          job.planId,
          job.spaceId,
          job.ownerId,
          job.idempotencyKey,
          job.status,
          job.attempts,
          job.archiveId,
          job.startedAt,
          job.finishedAt,
          job.error,
        ],
      );
      return job;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<ArchiveJobRow | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from archive_jobs where id = $1`,
        [id],
      );
      return rows[0] ? mapArchiveJobRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findByPlanId(planId: string): Promise<ArchiveJobRow | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from archive_jobs where plan_id = $1`,
        [planId],
      );
      return rows[0] ? mapArchiveJobRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findByIdempotencyKey(key: string): Promise<ArchiveJobRow | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from archive_jobs where idempotency_key = $1`,
        [key],
      );
      return rows[0] ? mapArchiveJobRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findByEntity(entityType: string, entityId: string): Promise<ArchiveJobRow | undefined> {
    const column =
      entityType === 'plan' ? 'plan_id' : entityType === 'space' ? 'space_id' : 'id';
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from archive_jobs
          where ${column} = $1
          order by started_at desc
          limit 1`,
        [entityId],
      );
      return rows[0] ? mapArchiveJobRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async update(id: string, patch: Partial<ArchiveJobRow>): Promise<ArchiveJobRow | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const current = await client.query<DbRow>(
          `select ${COLUMNS} from archive_jobs where id = $1 for update`,
          [id],
        );
        const row = current.rows[0];
        if (!row) return undefined;
        const next: ArchiveJobRow = { ...mapArchiveJobRow(row), ...patch };
        const { rows } = await client.query<DbRow>(
          `update archive_jobs
              set status = $2, attempts = $3, archive_id = $4, finished_at = $5, error = $6
            where id = $1
            returning ${COLUMNS}`,
          [id, next.status, next.attempts, next.archiveId, next.finishedAt, next.error],
        );
        return rows[0] ? mapArchiveJobRow(rows[0]) : undefined;
      });
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
