/** PostgreSQL implementation of `VerificationTokensRepo` (hashed tokens only). */
import type { Pool } from 'pg';
import type { HashedTokenRow, VerificationTokensRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { mapHashedTokenRow, type DbRow } from './rows.js';

const COLUMNS = 'id, user_id, token_hash, purpose, expires_at, used_at, created_at';

export class PostgresVerificationTokensRepo implements VerificationTokensRepo {
  constructor(private readonly pool: Pool) {}

  async insert(row: HashedTokenRow): Promise<HashedTokenRow> {
    try {
      await this.pool.query(
        `insert into verification_tokens
           (id, user_id, token_hash, purpose, expires_at, used_at, created_at)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          row.id,
          row.userId,
          row.tokenHash,
          row.purpose,
          row.expiresAt,
          row.usedAt,
          row.createdAt,
        ],
      );
      return row;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findByPurposeAndUserId(
    purpose: string,
    userId: string,
  ): Promise<HashedTokenRow | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from verification_tokens
          where purpose = $1 and user_id = $2 and used_at is null
          order by created_at desc
          limit 1`,
        [purpose, userId],
      );
      return rows[0] ? mapHashedTokenRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findByTokenHash(tokenHash: string, purpose: string): Promise<HashedTokenRow | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from verification_tokens
          where token_hash = $1 and purpose = $2
          limit 1`,
        [tokenHash, purpose],
      );
      return rows[0] ? mapHashedTokenRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async markUsed(id: string): Promise<HashedTokenRow | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        // Conditional update makes single-use atomic under concurrent confirms.
        `update verification_tokens set used_at = $2
          where id = $1 and used_at is null
          returning ${COLUMNS}`,
        [id, new Date().toISOString()],
      );
      return rows[0] ? mapHashedTokenRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async destroy(id: string): Promise<boolean> {
    try {
      const { rowCount } = await this.pool.query(
        'delete from verification_tokens where id = $1',
        [id],
      );
      return (rowCount ?? 0) > 0;
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
