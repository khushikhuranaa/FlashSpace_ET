/** PostgreSQL implementation of `AdminAuditRepo` (append-only). */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  AdminAuditQuery,
  AdminAuditRepo,
  AdminAuditRow,
} from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { mapAdminAuditRow, type DbRow } from './rows.js';

const COLUMNS =
  'id, admin_id, action, target_type, target_id, outcome, reason, metadata, created_at';

export class PostgresAdminAuditRepo implements AdminAuditRepo {
  constructor(private readonly pool: Pool) {}

  async append(entry: Omit<AdminAuditRow, 'id' | 'createdAt'>): Promise<AdminAuditRow> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    try {
      const { rows } = await this.pool.query<DbRow>(
        `insert into admin_audit
           (id, admin_id, action, target_type, target_id, outcome, reason, metadata, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
         returning ${COLUMNS}`,
        [
          id,
          entry.adminId,
          entry.action,
          entry.targetType,
          entry.targetId,
          entry.outcome,
          entry.reason,
          JSON.stringify(entry.metadata ?? {}),
          createdAt,
        ],
      );
      // The mapper normalises jsonb back to an object, so the returned shape is
      // identical to the caller's input plus id/createdAt (as in SQLite).
      return rows[0] ? mapAdminAuditRow(rows[0]) : { ...entry, id, createdAt };
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async list(query: AdminAuditQuery): Promise<{ entries: AdminAuditRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.action) {
      params.push(query.action);
      where.push(`action = $${params.length}`);
    }
    if (query.adminId) {
      params.push(query.adminId);
      where.push(`admin_id = $${params.length}`);
    }
    const outlet = query.outlet ?? 'ALL';
    if (outlet === 'SECURITY') where.push("action like 'SECURITY_%'");
    if (outlet === 'ADMIN') where.push("action not like 'SECURITY_%'");
    const clause = where.length ? `where ${where.join(' and ')}` : '';

    try {
      const totalResult = await this.pool.query<{ count: string }>(
        `select count(*)::text as count from admin_audit ${clause}`,
        params,
      );
      const pageParams = [...params, query.limit, query.offset];
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from admin_audit ${clause}
          order by created_at desc, id desc
          limit $${pageParams.length - 1} offset $${pageParams.length}`,
        pageParams,
      );
      return {
        entries: rows.map(mapAdminAuditRow),
        total: Number(totalResult.rows[0]?.count ?? 0),
      };
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
