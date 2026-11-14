/** PostgreSQL implementation of `ExtensionRequestsRepo`. */
import type { Pool } from 'pg';
import type { ExtensionRequest } from '@flashspace/shared';
import type { ExtensionRequestsRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { withTransaction } from '../pool.js';
import { mapExtensionRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, space_id, requester_id, requested_days, reason, status, decided_by, decided_at, ' +
  'rejection_reason, admin_note, previous_expiry_at, new_expiry_at, approval_method, created_at';

export class PostgresExtensionRequestsRepo implements ExtensionRequestsRepo {
  constructor(private readonly pool: Pool) {}

  async insert(req: ExtensionRequest): Promise<ExtensionRequest> {
    try {
      await this.pool.query(
        `insert into extension_requests
           (id, space_id, requester_id, requested_days, reason, status, decided_by, decided_at,
            rejection_reason, admin_note, previous_expiry_at, new_expiry_at, approval_method, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          req.id,
          req.spaceId,
          req.requesterId,
          req.requestedDays,
          req.reason,
          req.status,
          req.decidedBy,
          req.decidedAt,
          req.rejectionReason ?? null,
          req.adminNote ?? null,
          req.previousExpiryAt ?? null,
          req.newExpiryAt ?? null,
          req.approvalMethod ?? null,
          req.createdAt,
        ],
      );
      return req;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<ExtensionRequest | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from extension_requests where id = $1`,
        [id],
      );
      return rows[0] ? mapExtensionRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForSpace(spaceId: string): Promise<ExtensionRequest[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from extension_requests
          where space_id = $1
          order by created_at desc`,
        [spaceId],
      );
      return rows.map(mapExtensionRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listAll(): Promise<ExtensionRequest[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from extension_requests order by created_at desc`,
      );
      return rows.map(mapExtensionRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findPendingForSpace(spaceId: string): Promise<ExtensionRequest | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from extension_requests
          where space_id = $1 and status = 'PENDING'
          limit 1`,
        [spaceId],
      );
      return rows[0] ? mapExtensionRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async update(
    id: string,
    patch: Partial<ExtensionRequest>,
  ): Promise<ExtensionRequest | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const current = await client.query<DbRow>(
          `select ${COLUMNS} from extension_requests where id = $1 for update`,
          [id],
        );
        const row = current.rows[0];
        if (!row) return undefined;
        const next: ExtensionRequest = { ...mapExtensionRow(row), ...patch };
        const { rows } = await client.query<DbRow>(
          `update extension_requests
              set status = $2, decided_by = $3, decided_at = $4, requested_days = $5,
                  reason = $6, rejection_reason = $7, admin_note = $8,
                  previous_expiry_at = $9, new_expiry_at = $10, approval_method = $11
            where id = $1
            returning ${COLUMNS}`,
          [
            id,
            next.status,
            next.decidedBy,
            next.decidedAt,
            next.requestedDays,
            next.reason,
            next.rejectionReason ?? null,
            next.adminNote ?? null,
            next.previousExpiryAt ?? null,
            next.newExpiryAt ?? null,
            next.approvalMethod ?? null,
          ],
        );
        return rows[0] ? mapExtensionRow(rows[0]) : undefined;
      });
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
