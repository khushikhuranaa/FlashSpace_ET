/** PostgreSQL implementation of `SessionsRepo` (refresh-token sessions). */
import type { Pool } from 'pg';
import type { AuthSession, SessionsRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { mapSessionRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, user_id, refresh_hash, created_at, expires_at, revoked_at, last_used_at, user_agent, ip';

export class PostgresSessionsRepo implements SessionsRepo {
  constructor(private readonly pool: Pool) {}

  async insert(session: AuthSession): Promise<AuthSession> {
    try {
      await this.pool.query(
        `insert into auth_sessions
           (id, user_id, refresh_hash, created_at, expires_at, revoked_at, last_used_at, user_agent, ip)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          session.id,
          session.userId,
          session.refreshTokenHash,
          session.createdAt,
          session.expiresAt,
          session.revokedAt,
          session.lastUsedAt,
          session.userAgent,
          session.ip,
        ],
      );
      return session;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: string): Promise<AuthSession | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from auth_sessions where id = $1`,
        [id],
      );
      return rows[0] ? mapSessionRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findByRefreshHash(hash: string): Promise<AuthSession | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from auth_sessions where refresh_hash = $1`,
        [hash],
      );
      return rows[0] ? mapSessionRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async update(id: string, patch: Partial<AuthSession>): Promise<AuthSession | undefined> {
    try {
      const current = await this.findById(id);
      if (!current) return undefined;
      const next: AuthSession = { ...current, ...patch };
      await this.pool.query(
        `update auth_sessions
            set revoked_at = $2, last_used_at = $3, expires_at = $4, refresh_hash = $5
          where id = $1`,
        [id, next.revokedAt, next.lastUsedAt, next.expiresAt, next.refreshTokenHash],
      );
      return next;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForUser(userId: string): Promise<AuthSession[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from auth_sessions
          where user_id = $1
          order by created_at desc`,
        [userId],
      );
      return rows.map(mapSessionRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async revokeAllForUser(userId: string, at: string, exceptId?: string): Promise<number> {
    try {
      const { rowCount } = await this.pool.query(
        `update auth_sessions
            set revoked_at = $2
          where user_id = $1
            and revoked_at is null
            and ($3::text is null or id <> $3)`,
        [userId, at, exceptId ?? null],
      );
      return rowCount ?? 0;
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
