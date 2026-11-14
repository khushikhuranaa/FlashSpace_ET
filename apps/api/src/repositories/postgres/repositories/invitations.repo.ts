/** PostgreSQL implementation of `InvitationsRepo`. */
import type { Pool } from 'pg';
import type { SpaceInvitation } from '@flashspace/shared';
import type { InvitationsRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { withTransaction } from '../pool.js';
import { mapInvitationRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, space_id, inviter_id, email, intended_role, token_hash, status, expires_at, created_at';

export class PostgresInvitationsRepo implements InvitationsRepo {
  constructor(private readonly pool: Pool) {}

  async insert(inv: SpaceInvitation): Promise<SpaceInvitation> {
    try {
      await this.pool.query(
        `insert into invitations
           (id, space_id, inviter_id, email, intended_role, token_hash, status, expires_at, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          inv.id,
          inv.spaceId,
          inv.inviterId,
          inv.email.toLowerCase(),
          inv.intendedRole,
          inv.tokenHash,
          inv.status,
          inv.expiresAt,
          inv.createdAt,
        ],
      );
      return inv;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<SpaceInvitation | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from invitations where id = $1`,
        [id],
      );
      return rows[0] ? mapInvitationRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForSpace(spaceId: string): Promise<SpaceInvitation[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from invitations
          where space_id = $1
          order by created_at desc`,
        [spaceId],
      );
      return rows.map(mapInvitationRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listAll(): Promise<SpaceInvitation[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from invitations order by created_at desc`,
      );
      return rows.map(mapInvitationRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findBySpaceAndEmail(
    spaceId: string,
    email: string,
  ): Promise<SpaceInvitation | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from invitations
          where space_id = $1 and lower(email) = lower($2) and status = 'PENDING'
          order by created_at desc
          limit 1`,
        [spaceId, email],
      );
      return rows[0] ? mapInvitationRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async update(
    id: string,
    patch: Partial<SpaceInvitation>,
  ): Promise<SpaceInvitation | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const current = await client.query<DbRow>(
          `select ${COLUMNS} from invitations where id = $1 for update`,
          [id],
        );
        const row = current.rows[0];
        if (!row) return undefined;
        // Email, Space and inviter are immutable after creation, matching SQLite.
        const next: SpaceInvitation = { ...mapInvitationRow(row), ...patch };
        const { rows } = await client.query<DbRow>(
          `update invitations
              set intended_role = $2, token_hash = $3, status = $4, expires_at = $5
            where id = $1
            returning ${COLUMNS}`,
          [id, next.intendedRole, next.tokenHash, next.status, next.expiresAt],
        );
        return rows[0] ? mapInvitationRow(rows[0]) : undefined;
      });
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
