/** PostgreSQL implementation of `ActivityRepo`. */
import type { Pool } from 'pg';
import {
  activityCategoryFor,
  type ActivityInput,
  type ActivityLog,
  type ActivityPage,
  type ActivityQuery,
} from '@flashspace/shared';
import type { ActivityRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { mapActivityRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, user_id, space_id, file_id, action, metadata, created_at, actor_type, outcome, ' +
  'category, resource_type, resource_id, reason, correlation_id, event_key';

function orderFor(sort: ActivityQuery['sort']): 'asc' | 'desc' {
  return sort === 'oldest' ? 'asc' : 'desc';
}

export class PostgresActivityRepo implements ActivityRepo {
  constructor(private readonly pool: Pool) {}

  async append(input: ActivityInput): Promise<ActivityLog> {
    const createdAt = new Date().toISOString();
    const actorType = input.actorType ?? (input.userId ? 'USER' : 'SYSTEM');
    const resourceType =
      input.resourceType ?? (input.fileId ? 'file' : input.spaceId ? 'space' : null);
    const resourceId = input.resourceId ?? input.fileId ?? input.spaceId ?? null;
    try {
      // event_key is a partial unique index, so the conflict target must repeat
      // the predicate. ON CONFLICT ... DO NOTHING makes concurrent duplicates
      // safe, then the existing row is returned.
      const inserted = await this.pool.query<DbRow>(
        `insert into activity
           (user_id, space_id, file_id, action, metadata, created_at, actor_type, outcome,
            category, resource_type, resource_id, reason, correlation_id, event_key)
         values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         on conflict (event_key) where event_key is not null do nothing
         returning ${COLUMNS}`,
        [
          input.userId ?? null,
          input.spaceId ?? null,
          input.fileId ?? null,
          input.action,
          JSON.stringify(input.metadata ?? {}),
          createdAt,
          actorType,
          input.outcome ?? 'SUCCESS',
          input.category ?? activityCategoryFor(input.action),
          resourceType,
          resourceId,
          input.reason ?? null,
          input.correlationId ?? null,
          input.eventKey ?? null,
        ],
      );
      if (inserted.rows[0]) return mapActivityRow(inserted.rows[0]);

      if (input.eventKey) {
        const existing = await this.pool.query<DbRow>(
          `select ${COLUMNS} from activity where event_key = $1`,
          [input.eventKey],
        );
        if (existing.rows[0]) return mapActivityRow(existing.rows[0]);
      }
      throw new Error('Activity insert returned no row');
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async findById(id: number): Promise<ActivityLog | undefined> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from activity where id = $1`,
        [id],
      );
      return rows[0] ? mapActivityRow(rows[0]) : undefined;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForSpace(spaceId: string, limit = 100): Promise<ActivityLog[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from activity
          where space_id = $1
          order by id desc
          limit $2`,
        [spaceId, limit],
      );
      return rows.map(mapActivityRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForUser(userId: string, limit = 100): Promise<ActivityLog[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from activity
          where user_id = $1
          order by id desc
          limit $2`,
        [userId, limit],
      );
      return rows.map(mapActivityRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listAll(limit = 200): Promise<ActivityLog[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from activity order by id desc limit $1`,
        [limit],
      );
      return rows.map(mapActivityRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async query(q: ActivityQuery): Promise<ActivityPage> {
    const limit = Math.min(Math.max(q.limit ?? 25, 1), 200);
    const offset = Math.max(q.offset ?? 0, 0);
    const where: string[] = [];
    const params: unknown[] = [];

    const add = (sql: (placeholder: string) => string, value: unknown) => {
      params.push(value);
      where.push(sql(`$${params.length}`));
    };

    if (q.spaceId) {
      add((p) => `space_id = ${p}`, q.spaceId);
    } else if (q.spaceIds) {
      if (q.spaceIds.length === 0) return { entries: [], total: 0, limit, offset };
      const placeholders = q.spaceIds.map((id) => {
        params.push(id);
        return `$${params.length}`;
      });
      where.push(`space_id in (${placeholders.join(',')})`);
    }
    if (q.userId) {
      add((p) => `user_id = ${p}`, q.userId);
    } else if (q.userIds) {
      if (q.userIds.length === 0) return { entries: [], total: 0, limit, offset };
      const placeholders = q.userIds.map((id) => {
        params.push(id);
        return `$${params.length}`;
      });
      where.push(`user_id in (${placeholders.join(',')})`);
    }
    if (q.actorType) add((p) => `actor_type = ${p}`, q.actorType);
    if (q.category) add((p) => `category = ${p}`, q.category);
    if (q.action) add((p) => `action = ${p}`, q.action);
    if (q.outcome) add((p) => `outcome = ${p}`, q.outcome);
    if (q.resourceType) add((p) => `resource_type = ${p}`, q.resourceType);
    if (q.resourceId) add((p) => `resource_id = ${p}`, q.resourceId);
    if (q.from) add((p) => `created_at >= ${p}`, q.from);
    if (q.to) add((p) => `created_at <= ${p}`, q.to);

    const clause = where.length ? `where ${where.join(' and ')}` : '';
    try {
      const totalResult = await this.pool.query<{ count: string }>(
        `select count(*)::text as count from activity ${clause}`,
        params,
      );
      const pageParams = [...params, limit, offset];
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from activity ${clause}
          order by id ${orderFor(q.sort)}
          limit $${pageParams.length - 1} offset $${pageParams.length}`,
        pageParams,
      );
      return {
        entries: rows.map(mapActivityRow),
        total: Number(totalResult.rows[0]?.count ?? 0),
        limit,
        offset,
      };
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
