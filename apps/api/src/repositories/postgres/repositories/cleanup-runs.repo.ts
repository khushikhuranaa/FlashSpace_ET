/** PostgreSQL implementation of `CleanupRunsRepo`. */
import type { Pool } from 'pg';
import type { CleanupRun } from '@flashspace/shared';
import type { CleanupRunsRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { withTransaction } from '../pool.js';
import { mapCleanupRunRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, space_id, archive_id, status, memberships_revoked, objects_deleted, started_at, finished_at, error';

export class PostgresCleanupRunsRepo implements CleanupRunsRepo {
  constructor(private readonly pool: Pool) {}

  async insert(run: CleanupRun): Promise<CleanupRun> {
    try {
      await this.pool.query(
        `insert into cleanup_runs
           (id, space_id, archive_id, status, memberships_revoked, objects_deleted,
            started_at, finished_at, error)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          run.id,
          run.spaceId,
          run.archiveId,
          run.status,
          run.membershipsRevoked,
          run.objectsDeleted,
          run.startedAt,
          run.finishedAt,
          run.error,
        ],
      );
      return run;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<CleanupRun | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from cleanup_runs where id = $1`,
        [id],
      );
      return rows[0] ? mapCleanupRunRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForSpace(spaceId: string): Promise<CleanupRun[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from cleanup_runs
          where space_id = $1
          order by started_at desc`,
        [spaceId],
      );
      return rows.map(mapCleanupRunRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listAll(limit = 100): Promise<CleanupRun[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from cleanup_runs order by started_at desc limit $1`,
        [limit],
      );
      return rows.map(mapCleanupRunRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async update(id: string, patch: Partial<CleanupRun>): Promise<CleanupRun | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const current = await client.query<DbRow>(
          `select ${COLUMNS} from cleanup_runs where id = $1 for update`,
          [id],
        );
        const row = current.rows[0];
        if (!row) return undefined;
        const next: CleanupRun = { ...mapCleanupRunRow(row), ...patch };
        const { rows } = await client.query<DbRow>(
          `update cleanup_runs
              set status = $2, memberships_revoked = $3, objects_deleted = $4,
                  finished_at = $5, error = $6
            where id = $1
            returning ${COLUMNS}`,
          [
            id,
            next.status,
            next.membershipsRevoked,
            next.objectsDeleted,
            next.finishedAt,
            next.error,
          ],
        );
        return rows[0] ? mapCleanupRunRow(rows[0]) : undefined;
      });
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
