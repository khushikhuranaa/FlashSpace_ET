/** PostgreSQL implementation of `EmailJobsRepo` (delivery tracking only). */
import type { Pool } from 'pg';
import type { EmailJobsRepo, EmailJobRow } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { withTransaction } from '../pool.js';
import { mapEmailJobRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, category, template, to_address, subject, entity_id, entity_type, status, attempts, ' +
  'created_at, updated_at, last_attempt_at, delivered_at, error, idempotency_key';

export class PostgresEmailJobsRepo implements EmailJobsRepo {
  constructor(private readonly pool: Pool) {}

  async insert(job: EmailJobRow): Promise<EmailJobRow> {
    try {
      await this.pool.query(
        `insert into email_jobs
           (id, category, template, to_address, subject, entity_id, entity_type, status,
            attempts, created_at, updated_at, last_attempt_at, delivered_at, error, idempotency_key)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          job.id,
          job.category,
          job.template,
          job.to,
          job.subject,
          job.entityId,
          job.entityType,
          job.status,
          job.attempts,
          job.createdAt,
          job.updatedAt,
          job.lastAttemptAt,
          job.deliveredAt,
          job.error,
          job.idempotencyKey ?? null,
        ],
      );
      return job;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<EmailJobRow | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from email_jobs where id = $1`,
        [id],
      );
      return rows[0] ? mapEmailJobRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findByEntity(entityType: string, entityId: string): Promise<EmailJobRow | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from email_jobs
          where entity_type = $1 and entity_id = $2
          order by created_at desc
          limit 1`,
        [entityType, entityId],
      );
      return rows[0] ? mapEmailJobRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listFailed(limit = 100): Promise<EmailJobRow[]> {
    return this.listWhere("status = 'FAILED'", limit);
  }

  async listPending(limit = 100): Promise<EmailJobRow[]> {
    return this.listWhere(
      "status in ('PENDING', 'PROCESSING', 'RETRY_SCHEDULED')",
      limit,
    );
  }

  async listAll(limit = 200): Promise<EmailJobRow[]> {
    return this.listWhere('true', limit);
  }

  async update(id: string, patch: Partial<EmailJobRow>): Promise<EmailJobRow | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const current = await client.query<DbRow>(
          `select ${COLUMNS} from email_jobs where id = $1 for update`,
          [id],
        );
        const row = current.rows[0];
        if (!row) return undefined;
        const next: EmailJobRow = { ...mapEmailJobRow(row), ...patch };
        const { rows } = await client.query<DbRow>(
          `update email_jobs
              set status = $2, attempts = $3, updated_at = $4, last_attempt_at = $5,
                  delivered_at = $6, error = $7, idempotency_key = $8
            where id = $1
            returning ${COLUMNS}`,
          [
            id,
            next.status,
            next.attempts,
            next.updatedAt,
            next.lastAttemptAt,
            next.deliveredAt,
            next.error,
            next.idempotencyKey ?? null,
          ],
        );
        return rows[0] ? mapEmailJobRow(rows[0]) : undefined;
      });
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  private async listWhere(condition: string, limit: number): Promise<EmailJobRow[]> {
    try {
      // `condition` is a private constant, never user input.
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from email_jobs
          where ${condition}
          order by created_at desc
          limit $1`,
        [limit],
      );
      return rows.map(mapEmailJobRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
