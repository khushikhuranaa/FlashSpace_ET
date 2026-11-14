/** PostgreSQL implementation of `SpacesRepo`. */
import type { Pool } from 'pg';
import type { Space } from '@flashspace/shared';
import type { SpacesRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { withTransaction } from '../pool.js';
import { mapSpaceRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, owner_id, name, purpose, description, start_at, expiry_at, status, warning_sent_at, ' +
  'archived_manually, invitations_enabled, default_invite_role, created_at, updated_at';

export class PostgresSpacesRepo implements SpacesRepo {
  constructor(private readonly pool: Pool) {}

  async insert(space: Space): Promise<Space> {
    try {
      await this.pool.query(
        `insert into spaces
           (id, owner_id, name, purpose, description, start_at, expiry_at, status,
            warning_sent_at, archived_manually, invitations_enabled, default_invite_role,
            created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          space.id,
          space.ownerId,
          space.name,
          space.purpose,
          space.description,
          space.startAt,
          space.expiryAt,
          space.status,
          space.warningSentAt,
          space.archivedManually,
          space.invitationsEnabled !== false,
          space.defaultInviteRole ?? 'VIEWER',
          space.createdAt,
          space.updatedAt,
        ],
      );
      return space;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<Space | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from spaces where id = $1`,
        [id],
      );
      return rows[0] ? mapSpaceRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async update(id: string, patch: Partial<Space>): Promise<Space | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        // Lock the row so concurrent lifecycle passes cannot interleave a
        // read-modify-write and lose each other's changes.
        const current = await client.query<DbRow>(
          `select ${COLUMNS} from spaces where id = $1 for update`,
          [id],
        );
        const row = current.rows[0];
        if (!row) return undefined;
        const next: Space = {
          ...mapSpaceRow(row),
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        await client.query(
          `update spaces
              set owner_id = $2, name = $3, purpose = $4, description = $5,
                  start_at = $6, expiry_at = $7, status = $8, warning_sent_at = $9,
                  archived_manually = $10, invitations_enabled = $11,
                  default_invite_role = $12, updated_at = $13
            where id = $1`,
          [
            id,
            next.ownerId,
            next.name,
            next.purpose,
            next.description,
            next.startAt,
            next.expiryAt,
            next.status,
            next.warningSentAt,
            next.archivedManually,
            next.invitationsEnabled !== false,
            next.defaultInviteRole ?? 'VIEWER',
            next.updatedAt,
          ],
        );
        return next;
      });
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async list(): Promise<Space[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from spaces order by created_at desc`,
      );
      return rows.map(mapSpaceRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForUser(userId: string): Promise<Space[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select distinct ${COLUMNS.split(', ').map((c) => `s.${c}`).join(', ')}
           from spaces s
           left join members m on m.space_id = s.id
          where s.owner_id = $1
             or (m.user_id = $1 and m.status <> 'REVOKED')
          order by s.created_at desc`,
        [userId],
      );
      return rows.map(mapSpaceRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
