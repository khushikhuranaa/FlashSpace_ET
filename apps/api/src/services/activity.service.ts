import type {
  ActivityInput,
  ActivityLog,
  ActivityPage,
  ActivityQuery,
  AuthUser,
} from '@flashspace/shared';
import { ACTIVITY_ACTIONS, AppError, READ_ROLES } from '@flashspace/shared';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { SpacesService } from './spaces.service.js';

/** One CSV export is bounded so a huge table cannot exhaust memory. */
const EXPORT_MAX_ROWS = 5000;
const EXPORT_PAGE_SIZE = 500;

/** Metadata keys that must never reach an export or an API response. */
const SENSITIVE_KEY = /(password|passwd|secret|token|authorization|cookie|credential|api[-_]?key|signature|signed|url|hash|otp|session)/i;

/**
 * Central read/write surface for activity and audit records (Module 12).
 *
 * Every write goes through `record()`, which normalises actor type, outcome and
 * category, deduplicates by `eventKey`, and never lets a logging failure break
 * the business operation that produced it. Reads resolve authorisation *before*
 * touching the table, so filters can never widen a caller's scope.
 */
export class ActivityService {
  constructor(
    private readonly db: DataLayer,
    private readonly spaces: SpacesService,
  ) {}

  // -- writes ---------------------------------------------------------------

  /**
   * Persist an activity record. Retries once, then reports the failure on the
   * server log instead of surfacing it to the caller: a Space or file that was
   * written successfully must not fail its request because of analytics.
   */
  async record(input: ActivityInput): Promise<ActivityLog | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.db.activity.append(input);
      } catch (err) {
        if (attempt === 1) {
          console.error('[activity] could not persist record', {
            action: input.action,
            spaceId: input.spaceId ?? null,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      }
    }
    return null;
  }

  // -- reads ----------------------------------------------------------------

  /** Space activity, for anyone with any role on the Space (revoked users excluded). */
  async listForSpace(
    actor: AuthUser,
    spaceId: string,
    query: ActivityQuery & { q?: string } = {},
  ): Promise<ActivityPage> {
    await this.spaces.requireRole(spaceId, actor.id, READ_ROLES);
    const { q, ...rest } = query;
    const userIds = q ? await this.resolveActors(q) : undefined;
    const page = await this.db.activity.query({ ...rest, userIds, spaceId });
    return this.withActors(page);
  }

  /** The caller's own activity. There is no parameter to read somebody else's. */
  async listMine(actor: AuthUser, query: ActivityQuery & { q?: string } = {}): Promise<ActivityPage> {
    const { q: _q, ...rest } = query;
    const page = await this.db.activity.query({ ...rest, userId: actor.id });
    return this.withActors(page);
  }

  /** Platform-wide activity, ADMIN only. */
  async listPlatform(adminId: string, query: ActivityQuery & { q?: string } = {}): Promise<ActivityPage> {
    await this.requireAdmin(adminId);
    const { q, ...rest } = query;
    const userIds = q ? await this.resolveActors(q) : undefined;
    const page = await this.db.activity.query({ ...rest, userIds });
    return this.withActors(page);
  }

  /**
   * CSV export for a Space, a user's own history, or the platform (ADMIN).
   * Only rows the caller may read are exported; the export itself is recorded.
   */
  async exportCsv(
    actor: AuthUser,
    scope: { kind: 'space'; spaceId: string } | { kind: 'self' } | { kind: 'platform' },
    query: ActivityQuery = {},
  ): Promise<{ filename: string; csv: string; rows: number }> {
    let scoped: ActivityQuery;
    if (scope.kind === 'space') {
      await this.spaces.requireRole(scope.spaceId, actor.id, READ_ROLES);
      scoped = { ...query, spaceId: scope.spaceId };
    } else if (scope.kind === 'self') {
      scoped = { ...query, userId: actor.id };
    } else {
      await this.requireAdmin(actor.id);
      scoped = { ...query };
    }

    const rows: ActivityLog[] = [];
    let offset = 0;
    while (rows.length < EXPORT_MAX_ROWS) {
      const page = await this.db.activity.query({
        ...scoped,
        limit: Math.min(EXPORT_PAGE_SIZE, EXPORT_MAX_ROWS - rows.length),
        offset,
      });
      rows.push(...page.entries);
      if (page.entries.length < EXPORT_PAGE_SIZE) break;
      offset += page.entries.length;
    }

    const withActors = await this.withActors({ entries: rows, total: rows.length, limit: rows.length, offset: 0 });
    const csv = toCsv(withActors.entries);
    const stamp = new Date().toISOString().slice(0, 10);
    const label = scope.kind === 'space' ? 'space' : scope.kind === 'self' ? 'account' : 'platform';

    if (scope.kind !== 'self') {
      // Exports are themselves auditable; a self export is recorded too so a
      // user can see when their own history left the platform.
      await this.record({
        userId: actor.id,
        spaceId: scope.kind === 'space' ? scope.spaceId : null,
        action: ACTIVITY_ACTIONS.ACTIVITY_EXPORTED,
        actorType: scope.kind === 'platform' ? 'ADMIN' : 'USER',
        category: 'SECURITY',
        outcome: 'SUCCESS',
        resourceType: scope.kind === 'space' ? 'space' : 'platform',
        resourceId: scope.kind === 'space' ? scope.spaceId : null,
        metadata: { scope: scope.kind, rows: rows.length },
      });
    }

    return { filename: `flashspace-${label}-activity-${stamp}.csv`, csv, rows: rows.length };
  }

  /** Sensitive administrative audit history as CSV (ADMIN only). */
  async exportAdminAudit(adminId: string, outlet: 'ADMIN' | 'SECURITY' | 'ALL' = 'ALL'): Promise<{ filename: string; csv: string; rows: number }> {
    await this.requireAdmin(adminId);
    const rows = [] as Awaited<ReturnType<DataLayer['adminAudit']['list']>>['entries'];
    let offset = 0;
    while (rows.length < EXPORT_MAX_ROWS) {
      const page = await this.db.adminAudit.list({ outlet, limit: EXPORT_PAGE_SIZE, offset });
      rows.push(...page.entries);
      if (page.entries.length < EXPORT_PAGE_SIZE) break;
      offset += page.entries.length;
    }

    const header = ['event_id', 'timestamp', 'actor_type', 'actor_id', 'action', 'target_type', 'target_id', 'outcome', 'reason'];
    const body = rows.map((r) => [
      r.id,
      r.createdAt,
      'ADMIN',
      r.adminId,
      r.action,
      r.targetType,
      r.targetId,
      r.outcome,
      r.reason ?? '',
    ]);
    const stamp = new Date().toISOString().slice(0, 10);

    await this.record({
      userId: adminId,
      action: ACTIVITY_ACTIONS.ACTIVITY_EXPORTED,
      actorType: 'ADMIN',
      category: 'SECURITY',
      outcome: 'SUCCESS',
      resourceType: 'admin_audit',
      metadata: { outlet, rows: rows.length },
    });

    return {
      filename: `flashspace-audit-${outlet.toLowerCase()}-${stamp}.csv`,
      csv: toCsvRows(header, body),
      rows: rows.length,
    };
  }

  // -- internals ------------------------------------------------------------

  private async requireAdmin(userId: string): Promise<void> {
    const profile = await this.db.auth.findById(userId);
    if (!profile || profile.role !== 'ADMIN') {
      throw new AppError('ADMIN_REQUIRED', 'Administrator access is required');
    }
    if (profile.status === 'SUSPENDED') {
      throw new AppError('ACCOUNT_SUSPENDED', 'This account is suspended');
    }
  }

  /** Resolve an actor search term to user ids (name or email, server-side). */
  private async resolveActors(term: string): Promise<string[]> {
    const page = await this.db.auth.list({ q: term, limit: 50, offset: 0 });
    return page.users.map((u) => u.id);
  }

  /** Attach actor display name/email to a page without one query per row. */
  private async withActors(page: ActivityPage): Promise<ActivityPage> {
    const ids = [...new Set(page.entries.map((e) => e.userId).filter((id): id is string => !!id))];
    const actors = new Map<string, { name: string; email: string }>();
    for (const id of ids) {
      const profile = await this.db.auth.findById(id);
      if (profile) actors.set(id, { name: profile.displayName, email: profile.email });
    }
    return {
      ...page,
      entries: page.entries.map((entry) => ({
        ...entry,
        actorName: entry.userId ? (actors.get(entry.userId)?.name ?? null) : null,
        actorEmail: entry.userId ? (actors.get(entry.userId)?.email ?? null) : null,
      })),
    };
  }
}

// -- CSV helpers --------------------------------------------------------------

const CSV_HEADER = [
  'event_id',
  'timestamp',
  'actor_type',
  'actor_id',
  'actor_name',
  'actor_email',
  'category',
  'action',
  'outcome',
  'space_id',
  'resource_type',
  'resource_id',
  'reason',
  'details',
];

function toCsv(entries: ActivityLog[]): string {
  const rows = entries.map((e) => [
    String(e.id),
    e.createdAt,
    e.actorType,
    e.userId ?? '',
    e.actorName ?? '',
    e.actorEmail ?? '',
    e.category,
    e.action,
    e.outcome,
    e.spaceId ?? '',
    e.resourceType ?? '',
    e.resourceId ?? '',
    e.reason ?? '',
    safeDetails(e.metadata),
  ]);
  return toCsvRows(CSV_HEADER, rows);
}

/** Scalar, non-sensitive metadata only; never whole payloads or secrets. */
function safeDetails(metadata: Record<string, unknown>): string {
  const kept: string[] = [];
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    const text = String(value);
    kept.push(`${key}=${text.length > 120 ? `${text.slice(0, 120)}…` : text}`);
  }
  return kept.join('; ');
}

/**
 * RFC 4180 escaping plus spreadsheet formula-injection protection: a value that
 * would be interpreted as a formula is prefixed with a single quote.
 */
function csvCell(value: string): string {
  let cell = value ?? '';
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  if (/[",\n\r]/.test(cell)) cell = `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

function toCsvRows(header: string[], rows: string[][]): string {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
