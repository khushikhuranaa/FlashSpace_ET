/** PostgreSQL implementation of `InviteLinksRepo`. */
import type { Pool } from 'pg';
import type { SpaceInviteLink } from '@flashspace/shared';
import type { InviteLinksRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { withTransaction } from '../pool.js';
import { mapInviteLinkRow, type DbRow } from './rows.js';

const COLUMNS = 'id, space_id, created_by, token, role, created_at, revoked_at';

export class PostgresInviteLinksRepo implements InviteLinksRepo {
  constructor(private readonly pool: Pool) {}

  async insert(link: SpaceInviteLink): Promise<SpaceInviteLink> {
    try {
      await this.pool.query(
        `insert into invite_links (id, space_id, created_by, token, role, created_at, revoked_at)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          link.id,
          link.spaceId,
          link.createdBy,
          link.token,
          link.role,
          link.createdAt,
          link.revokedAt,
        ],
      );
      return link;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<SpaceInviteLink | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from invite_links where id = $1`,
        [id],
      );
      return rows[0] ? mapInviteLinkRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findByToken(token: string): Promise<SpaceInviteLink | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from invite_links where token = $1`,
        [token],
      );
      return rows[0] ? mapInviteLinkRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findActiveForSpace(spaceId: string): Promise<SpaceInviteLink | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from invite_links
          where space_id = $1 and revoked_at is null
          order by created_at desc
          limit 1`,
        [spaceId],
      );
      return rows[0] ? mapInviteLinkRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForSpace(spaceId: string): Promise<SpaceInviteLink[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from invite_links
          where space_id = $1
          order by created_at desc`,
        [spaceId],
      );
      return rows.map(mapInviteLinkRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async update(
    id: string,
    patch: Partial<SpaceInviteLink>,
  ): Promise<SpaceInviteLink | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const current = await client.query<DbRow>(
          `select ${COLUMNS} from invite_links where id = $1 for update`,
          [id],
        );
        const row = current.rows[0];
        if (!row) return undefined;
        const next: SpaceInviteLink = { ...mapInviteLinkRow(row), ...patch };
        const { rows } = await client.query<DbRow>(
          `update invite_links set role = $2, revoked_at = $3
            where id = $1
            returning ${COLUMNS}`,
          [id, next.role, next.revokedAt],
        );
        return rows[0] ? mapInviteLinkRow(rows[0]) : undefined;
      });
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
