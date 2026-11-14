/** PostgreSQL implementation of `NotificationsRepo`. */
import type { Pool } from 'pg';
import type { Notification } from '@flashspace/shared';
import type { NotificationsRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { mapNotificationRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, user_id, space_id, type, title, body, invite_link_id, join_request_id, read_at, created_at';

export class PostgresNotificationsRepo implements NotificationsRepo {
  constructor(private readonly pool: Pool) {}

  async insert(n: Notification): Promise<Notification> {
    try {
      await this.pool.query(
        `insert into notifications
           (id, user_id, space_id, type, title, body, invite_link_id, join_request_id, read_at, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          n.id,
          n.userId,
          n.spaceId,
          n.type,
          n.title,
          n.body,
          n.inviteLinkId,
          n.joinRequestId,
          n.readAt,
          n.createdAt,
        ],
      );
      return n;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForUser(userId: string): Promise<Notification[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from notifications
          where user_id = $1
          order by created_at desc`,
        [userId],
      );
      return rows.map(mapNotificationRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<Notification | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from notifications where id = $1`,
        [id],
      );
      return rows[0] ? mapNotificationRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async markRead(id: string): Promise<Notification | undefined> {
    try {
      // Idempotent: an already-read notification keeps its original read_at.
      const { rows } = await this.pool.query<DbRow>(
        `update notifications
            set read_at = coalesce(read_at, $2)
          where id = $1
          returning ${COLUMNS}`,
        [id, new Date().toISOString()],
      );
      return rows[0] ? mapNotificationRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async markAllRead(userId: string): Promise<number> {
    try {
      const { rowCount } = await this.pool.query(
        `update notifications
            set read_at = $2
          where user_id = $1 and read_at is null`,
        [userId, new Date().toISOString()],
      );
      return rowCount ?? 0;
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
