/** PostgreSQL implementation of `AuthRepo` (profiles + local credentials). */
import type { Pool } from 'pg';
import type { Profile } from '@flashspace/shared';
import type { AuthRepo, LocalAccount, UserPage, UserQuery } from '../../data-layer.interface.js';
import { mapPostgresError, PostgresRepositoryError } from '../errors.js';
import { withTransaction } from '../pool.js';
import { mapProfileRow, type DbRow } from './rows.js';

const PROFILE_COLUMNS =
  'id, email, display_name, role, avatar_url, created_at, updated_at, account_status, ' +
  'suspended_at, suspended_by, suspension_reason, last_active_at, email_verified_at';

function orderBy(sort: UserQuery['sort']): string {
  switch (sort) {
    case 'created-asc':
      return 'created_at asc';
    case 'name-asc':
      return 'lower(display_name) asc';
    case 'name-desc':
      return 'lower(display_name) desc';
    case 'activity-desc':
      return 'coalesce(last_active_at, created_at) desc';
    case 'created-desc':
    default:
      return 'created_at desc';
  }
}

export class PostgresAuthRepo implements AuthRepo {
  constructor(private readonly pool: Pool) {}

  async create(profile: Profile, passwordHash: string): Promise<Profile> {
    try {
      await withTransaction(this.pool, async (client) => {
        // Match SQLite: registration always creates an ACTIVE profile; status
        // changes go through setStatus, never through create.
        await client.query(
          `insert into profiles
             (id, email, display_name, role, avatar_url, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            profile.id,
            profile.email.toLowerCase(),
            profile.displayName,
            profile.role,
            profile.avatarUrl,
            profile.createdAt,
            profile.updatedAt,
          ],
        );
        await client.query(
          'insert into credentials (user_id, password_hash) values ($1,$2)',
          [profile.id, passwordHash],
        );
      });
      return profile;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async ensureProfile(profile: Profile): Promise<Profile> {
    // Idempotent by id, like SQLite's INSERT OR IGNORE followed by a read.
    // A conflicting email on a different id must still fail loudly.
    try {
      await this.pool.query(
        `insert into profiles
           (id, email, display_name, role, avatar_url, created_at, updated_at, account_status)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (id) do nothing`,
        [
          profile.id,
          profile.email.toLowerCase(),
          profile.displayName,
          profile.role,
          profile.avatarUrl,
          profile.createdAt,
          profile.updatedAt,
          profile.status ?? 'ACTIVE',
        ],
      );
    } catch (err) {
      return mapPostgresError(err);
    }
    const existing = await this.findById(profile.id);
    if (!existing) {
      throw new PostgresRepositoryError(
        'DUPLICATE',
        'A profile with this email already exists under another id',
      );
    }
    return existing;
  }

  async findById(id: string): Promise<Profile | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${PROFILE_COLUMNS} from profiles where id = $1`,
        [id],
      );
      return rows[0] ? mapProfileRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findByEmail(email: string): Promise<Profile | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${PROFILE_COLUMNS} from profiles where lower(email) = lower($1)`,
        [email],
      );
      return rows[0] ? mapProfileRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async getCredentials(id: string): Promise<LocalAccount | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${PROFILE_COLUMNS.split(', ').map((c) => `p.${c}`).join(', ')}, c.password_hash
           from profiles p
           join credentials c on c.user_id = p.id
          where p.id = $1`,
        [id],
      );
      const row = rows[0];
      if (!row) return undefined;
      return { profile: mapProfileRow(row), passwordHash: row.password_hash as string };
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async update(
    id: string,
    patch: Partial<Pick<Profile, 'displayName' | 'avatarUrl'>>,
  ): Promise<Profile | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `update profiles
            set display_name = coalesce($2, display_name),
                avatar_url = case when $3 then $4 else avatar_url end,
                updated_at = $5
          where id = $1
          returning ${PROFILE_COLUMNS}`,
        [
          id,
          patch.displayName ?? null,
          patch.avatarUrl !== undefined,
          patch.avatarUrl ?? null,
          new Date().toISOString(),
        ],
      );
      return rows[0] ? mapProfileRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async promoteToAdmin(id: string): Promise<void> {
    try {
      await this.pool.query(
        'update profiles set role = $2, updated_at = $3 where id = $1',
        [id, 'ADMIN', new Date().toISOString()],
      );
    } catch (err) {
      mapPostgresError(err);
    }
  }

  async count(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      'select count(*)::text as count from profiles',
    );
    return Number(rows[0]?.count ?? 0);
  }

  async all(): Promise<Profile[]> {
    const { rows } = await this.pool.query<DbRow>(
      `select ${PROFILE_COLUMNS} from profiles order by created_at asc`,
    );
    return rows.map(mapProfileRow);
  }

  async setPasswordHash(id: string, passwordHash: string): Promise<void> {
    try {
      await this.pool.query(
        `insert into credentials (user_id, password_hash) values ($1,$2)
         on conflict (user_id) do update set password_hash = excluded.password_hash`,
        [id, passwordHash],
      );
    } catch (err) {
      mapPostgresError(err);
    }
  }

  async markEmailVerified(id: string, at: string): Promise<void> {
    try {
      await this.pool.query(
        'update profiles set email_verified_at = $2, updated_at = $3 where id = $1',
        [id, at, new Date().toISOString()],
      );
    } catch (err) {
      mapPostgresError(err);
    }
  }

  async updateEmail(id: string, email: string): Promise<Profile | undefined> {
    const normalized = email.toLowerCase();
    try {
      return await withTransaction(this.pool, async (client) => {
        const taken = await client.query(
          'select 1 from profiles where lower(email) = $1 and id <> $2',
          [normalized, id],
        );
        if (taken.rowCount) return undefined;
        const { rows } = await client.query<DbRow>(
          `update profiles
              set email = $2, email_verified_at = null, updated_at = $3
            where id = $1
            returning ${PROFILE_COLUMNS}`,
          [id, normalized, new Date().toISOString()],
        );
        return rows[0] ? mapProfileRow(rows[0]) : undefined;
      });
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      // credentials and auth_sessions cascade from profiles.
      await this.pool.query('delete from profiles where id = $1', [id]);
    } catch (err) {
      mapPostgresError(err);
    }
  }

  async list(query: UserQuery): Promise<UserPage> {
    const where: string[] = [];
    const params: unknown[] = [];
    const needle = query.q?.trim().toLowerCase();
    if (needle) {
      params.push(`%${needle}%`);
      where.push(
        `(lower(display_name) like $${params.length} or lower(email) like $${params.length} or lower(id) like $${params.length})`,
      );
    }
    if (query.role) {
      params.push(query.role);
      where.push(`role = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      where.push(`coalesce(account_status, 'ACTIVE') = $${params.length}`);
    }
    const clause = where.length ? `where ${where.join(' and ')}` : '';

    try {
      const totalResult = await this.pool.query<{ count: string }>(
        `select count(*)::text as count from profiles ${clause}`,
        params,
      );
      const pageParams = [...params, query.limit, query.offset];
      const { rows } = await this.pool.query<DbRow>(
        `select ${PROFILE_COLUMNS} from profiles ${clause}
          order by ${orderBy(query.sort)}
          limit $${pageParams.length - 1} offset $${pageParams.length}`,
        pageParams,
      );
      return { users: rows.map(mapProfileRow), total: Number(totalResult.rows[0]?.count ?? 0) };
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async setRole(id: string, role: Profile['role']): Promise<Profile | undefined> {
    try {
      await this.pool.query(
        'update profiles set role = $2, updated_at = $3 where id = $1',
        [id, role, new Date().toISOString()],
      );
      return await this.findById(id);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async setStatus(
    id: string,
    patch: {
      status: Profile['status'];
      suspendedAt: string | null;
      suspendedBy: string | null;
      suspensionReason: string | null;
    },
  ): Promise<Profile | undefined> {
    try {
      await this.pool.query(
        `update profiles
            set account_status = $2, suspended_at = $3, suspended_by = $4,
                suspension_reason = $5, updated_at = $6
          where id = $1`,
        [
          id,
          patch.status ?? 'ACTIVE',
          patch.suspendedAt,
          patch.suspendedBy,
          patch.suspensionReason,
          new Date().toISOString(),
        ],
      );
      return await this.findById(id);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async countAdmins(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "select count(*)::text as count from profiles where role = 'ADMIN'",
    );
    return Number(rows[0]?.count ?? 0);
  }

  async touchLastActive(id: string, at: string): Promise<void> {
    try {
      await this.pool.query('update profiles set last_active_at = $2 where id = $1', [id, at]);
    } catch (err) {
      mapPostgresError(err);
    }
  }
}
