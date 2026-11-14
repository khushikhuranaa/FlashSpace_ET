/** PostgreSQL implementation of `JobsRepo` (lifecycle queue). */
import type { Pool } from 'pg';
import type { JobType, LifecycleJob } from '@flashspace/shared';
import type { JobsRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { withTransaction } from '../pool.js';
import { mapJobRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, job_type, space_id, idempotency_key, status, attempts, started_at, finished_at, error';

export class PostgresJobsRepo implements JobsRepo {
  constructor(private readonly pool: Pool) {}

  async insert(job: LifecycleJob): Promise<LifecycleJob> {
    try {
      await this.pool.query(
        `insert into jobs
           (id, job_type, space_id, idempotency_key, status, attempts, started_at, finished_at, error)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          job.id,
          job.jobType,
          job.spaceId,
          job.idempotencyKey,
          job.status,
          job.attempts,
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

  async findById(id: string): Promise<LifecycleJob | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from jobs where id = $1`,
        [id],
      );
      return rows[0] ? mapJobRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findByIdempotencyKey(key: string): Promise<LifecycleJob | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from jobs where idempotency_key = $1`,
        [key],
      );
      return rows[0] ? mapJobRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  /**
   * Claim the oldest pending job atomically. `FOR UPDATE SKIP LOCKED` inside
   * the UPDATE means two workers polling concurrently can never receive the
   * same job, while SQLite's single-writer model made a plain read-then-write
   * safe there.
   */
  async claimNext(jobType: JobType): Promise<LifecycleJob | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `update jobs
            set status = 'RUNNING', attempts = attempts + 1, started_at = $2
          where id = (
            select id from jobs
             where job_type = $1 and status = 'PENDING'
             order by started_at asc
             limit 1
             for update skip locked
          )
          returning ${COLUMNS}`,
        [jobType, new Date().toISOString()],
      );
      return rows[0] ? mapJobRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async update(id: string, patch: Partial<LifecycleJob>): Promise<LifecycleJob | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const current = await client.query<DbRow>(
          `select ${COLUMNS} from jobs where id = $1 for update`,
          [id],
        );
        const row = current.rows[0];
        if (!row) return undefined;
        const next: LifecycleJob = { ...mapJobRow(row), ...patch };
        const { rows } = await client.query<DbRow>(
          `update jobs
              set status = $2, attempts = $3, started_at = $4, finished_at = $5, error = $6
            where id = $1
            returning ${COLUMNS}`,
          [id, next.status, next.attempts, next.startedAt, next.finishedAt, next.error],
        );
        return rows[0] ? mapJobRow(rows[0]) : undefined;
      });
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async finish(id: string, patch: Partial<LifecycleJob>): Promise<LifecycleJob | undefined> {
    return this.update(id, { ...patch, finishedAt: new Date().toISOString() });
  }

  async list(limit = 50): Promise<LifecycleJob[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from jobs order by started_at desc limit $1`,
        [limit],
      );
      return rows.map(mapJobRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
