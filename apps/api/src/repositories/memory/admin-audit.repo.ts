import type { AdminAuditQuery, AdminAuditRepo, AdminAuditRow } from '../data-layer.interface.js';

/**
 * Append-only in-memory audit trail.
 *
 * There is deliberately no update or delete method: the admin console can read
 * and append, never rewrite history.
 */
export class MemoryAdminAuditRepo implements AdminAuditRepo {
  private seq = 0;
  private readonly entries: AdminAuditRow[] = [];

  append(entry: Omit<AdminAuditRow, 'id' | 'createdAt'>): AdminAuditRow {
    const row: AdminAuditRow = {
      ...entry,
      id: `audit-${++this.seq}`,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(row);
    return row;
  }

  list(query: AdminAuditQuery): { entries: AdminAuditRow[]; total: number } {
    const outlet = query.outlet ?? 'ALL';
    const matches = this.entries
      .filter((e) => {
        if (query.action && e.action !== query.action) return false;
        if (query.adminId && e.adminId !== query.adminId) return false;
        if (outlet === 'SECURITY') return e.action.startsWith('SECURITY_');
        if (outlet === 'ADMIN') return !e.action.startsWith('SECURITY_');
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      total: matches.length,
      entries: matches.slice(query.offset, query.offset + query.limit),
    };
  }
}
