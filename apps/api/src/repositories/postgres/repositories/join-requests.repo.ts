/** PostgreSQL implementation of `JoinRequestsRepo`. */
import type { Pool } from 'pg';
import type { JoinRequest } from '@flashspace/shared';
import type { JoinRequestsRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { withTransaction } from '../pool.js';
import { mapJoinRequestRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, space_id, requester_id, role, source, invitation_id, status, created_at, decided_by, decided_at';

export class PostgresJoinRequestsRepo implements JoinRequestsRepo {
  constructor(private readonly pool: Pool) {}

  async insert(request: JoinRequest): Promise<JoinRequest> {
    try {
      await this.pool.query(
        `insert into join_requests
           (id, space_id, requester_id, role, source, invitation_id, status, created_at, decided_by, decided_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          request.id,
          request.spaceId,
          request.requesterId,
          request.role,
          request.source,
          request.invitationId,
          request.status,
          request.createdAt,
          request.decidedBy,
          request.decidedAt,
        ],
      );
      return request;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<JoinRequest | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from join_requests where id = $1`,
        [id],
      );
      return rows[0] ? mapJoinRequestRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForSpace(spaceId: string, status?: JoinRequest['status']): Promise<JoinRequest[]> {
    try {
      const { rows } = status
        ? await this.pool.query<DbRow>(
            `select ${COLUMNS} from join_requests
              where space_id = $1 and status = $2
              order by created_at desc`,
            [spaceId, status],
          )
        : await this.pool.query<DbRow>(
            `select ${COLUMNS} from join_requests
              where space_id = $1
              order by created_at desc`,
            [spaceId],
          );
      return rows.map(mapJoinRequestRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForRequester(requesterId: string): Promise<JoinRequest[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from join_requests
          where requester_id = $1
          order by created_at desc`,
        [requesterId],
      );
      return rows.map(mapJoinRequestRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findPendingForUser(
    spaceId: string,
    requesterId: string,
  ): Promise<JoinRequest | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from join_requests
          where space_id = $1 and requester_id = $2 and status = 'PENDING'
          limit 1`,
        [spaceId, requesterId],
      );
      return rows[0] ? mapJoinRequestRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findOpenForInvitation(invitationId: string): Promise<JoinRequest | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from join_requests
          where invitation_id = $1 and status = 'PENDING'
          limit 1`,
        [invitationId],
      );
      return rows[0] ? mapJoinRequestRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listAll(): Promise<JoinRequest[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from join_requests order by created_at desc`,
      );
      return rows.map(mapJoinRequestRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async update(id: string, patch: Partial<JoinRequest>): Promise<JoinRequest | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const current = await client.query<DbRow>(
          `select ${COLUMNS} from join_requests where id = $1 for update`,
          [id],
        );
        const row = current.rows[0];
        if (!row) return undefined;
        const next: JoinRequest = { ...mapJoinRequestRow(row), ...patch };
        const { rows } = await client.query<DbRow>(
          `update join_requests
              set role = $2, status = $3, decided_by = $4, decided_at = $5
            where id = $1
            returning ${COLUMNS}`,
          [id, next.role, next.status, next.decidedBy, next.decidedAt],
        );
        return rows[0] ? mapJoinRequestRow(rows[0]) : undefined;
      });
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
