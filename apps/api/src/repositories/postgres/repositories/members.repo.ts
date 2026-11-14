/** PostgreSQL implementation of `MembersRepo`. */
import type { Pool } from 'pg';
import type { MemberRole, SpaceMember } from '@flashspace/shared';
import type { MembersRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { withTransaction } from '../pool.js';
import { mapMemberRow, type DbRow } from './rows.js';

const COLUMNS = 'space_id, user_id, role, status, joined_at, revoked_at';

export class PostgresMembersRepo implements MembersRepo {
  constructor(private readonly pool: Pool) {}

  async insert(member: SpaceMember): Promise<SpaceMember> {
    try {
      await this.pool.query(
        `insert into members (space_id, user_id, role, status, joined_at, revoked_at)
         values ($1,$2,$3,$4,$5,$6)`,
        [
          member.spaceId,
          member.userId,
          member.role,
          member.status,
          member.joinedAt,
          member.revokedAt,
        ],
      );
      return member;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async find(spaceId: string, userId: string): Promise<SpaceMember | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from members where space_id = $1 and user_id = $2`,
        [spaceId, userId],
      );
      return rows[0] ? mapMemberRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForSpace(spaceId: string): Promise<SpaceMember[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from members
          where space_id = $1
          order by joined_at asc nulls first, user_id asc`,
        [spaceId],
      );
      return rows.map(mapMemberRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForUser(userId: string): Promise<SpaceMember[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from members
          where user_id = $1 and status <> 'REVOKED'`,
        [userId],
      );
      return rows.map(mapMemberRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async update(
    spaceId: string,
    userId: string,
    patch: Partial<SpaceMember>,
  ): Promise<SpaceMember | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const current = await client.query<DbRow>(
          `select ${COLUMNS} from members
            where space_id = $1 and user_id = $2
            for update`,
          [spaceId, userId],
        );
        const row = current.rows[0];
        if (!row) return undefined;
        const next: SpaceMember = { ...mapMemberRow(row), ...patch };
        await client.query(
          `update members
              set role = $3, status = $4, joined_at = $5, revoked_at = $6
            where space_id = $1 and user_id = $2`,
          [spaceId, userId, next.role, next.status, next.joinedAt, next.revokedAt],
        );
        return next;
      });
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async revokeAllForSpace(spaceId: string): Promise<number> {
    try {
      const { rowCount } = await this.pool.query(
        `update members
            set status = 'REVOKED', revoked_at = $2
          where space_id = $1 and status <> 'REVOKED'`,
        [spaceId, new Date().toISOString()],
      );
      return rowCount ?? 0;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async countByRole(spaceId: string, role: MemberRole): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ count: string }>(
        `select count(*)::text as count from members
          where space_id = $1 and role = $2 and status = 'ACTIVE'`,
        [spaceId, role],
      );
      return Number(rows[0]?.count ?? 0);
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
