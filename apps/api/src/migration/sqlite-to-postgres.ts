/**
 * SQLite → Supabase/PostgreSQL data migration (Module 15).
 *
 * Safety model:
 *  - the SQLite source is opened READ-ONLY (`readOnly: true`), so no writes,
 *    resets or schema changes are possible from this process;
 *  - the default mode is a dry run: it inventories rows, converts types, checks
 *    foreign keys and unique constraints, and reports exactly what would be
 *    inserted or skipped;
 *  - applying requires an explicit `apply: true` and writes inside a single
 *    transaction with ordered inserts;
 *  - rows that cannot be migrated safely are reported and skipped, never
 *    silently dropped or "fixed";
 *  - the target is never truncated: inserts use ON CONFLICT DO NOTHING and the
 *    resulting row counts are compared afterwards.
 *
 * IDs are preserved verbatim (text ids everywhere, bigserial activity ids are
 * inserted explicitly and the sequence is advanced afterwards).
 */
import { createRequire } from 'node:module';
import type { QueryResultLike } from '../repositories/postgres/migrate.js';

const require = createRequire(import.meta.url);
// `node:sqlite` is a prefix-only builtin, absent from module.builtinModules.
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

export interface SourceTable {
  name: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export type IssueKind = 'ORPHAN_FK' | 'DUPLICATE_KEY' | 'INVALID_JSON' | 'UNKNOWN_TARGET_TABLE';

export interface MigrationIssue {
  table: string;
  rowId: string | null;
  kind: IssueKind;
  detail: string;
}

export interface TablePlan {
  table: string;
  sourceRows: number;
  insertableRows: number;
  skippedRows: number;
  skippedUnknownTable: boolean;
  columns: string[];
  droppedColumns: string[];
  rows: Array<Record<string, unknown>>;
  issues: MigrationIssue[];
}

export interface MigrationTerminal {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>;
}

export interface DryRunReport {
  generatedAt: string;
  sourceFile: string;
  tables: Array<Omit<TablePlan, 'rows'>>;
  totals: { sourceRows: number; insertableRows: number; skippedRows: number; issues: number };
  blocking: MigrationIssue[];
  warnings: string[];
}

/** Dependency order — parents before children so FK constraints hold. */
export const TABLE_ORDER = [
  'profiles',
  'credentials',
  'spaces',
  'members',
  'folders',
  'invitations',
  'invite_links',
  'join_requests',
  'extension_requests',
  'files',
  'archives',
  'notifications',
  'jobs',
  'cleanup_runs',
  'activity',
  'scan_jobs',
  'duplicate_groups',
  'duplicate_files',
  'archive_plans',
  'archive_jobs',
  'admin_audit',
  'space_access',
  'space_favorites',
  'lifecycle_transitions',
  'email_jobs',
  'verification_tokens',
] as const;

/** Foreign keys enforced by both schemas; `nullable` references tolerate null. */
const REFERENCES: Record<string, Array<{ column: string; table: string; nullable?: boolean }>> = {
  credentials: [{ column: 'user_id', table: 'profiles' }],
  spaces: [{ column: 'owner_id', table: 'profiles' }],
  members: [
    { column: 'space_id', table: 'spaces' },
    { column: 'user_id', table: 'profiles' },
  ],
  folders: [
    { column: 'space_id', table: 'spaces' },
    { column: 'parent_id', table: 'folders', nullable: true },
  ],
  invitations: [
    { column: 'space_id', table: 'spaces' },
    { column: 'inviter_id', table: 'profiles' },
  ],
  invite_links: [
    { column: 'space_id', table: 'spaces' },
    { column: 'created_by', table: 'profiles' },
  ],
  join_requests: [
    { column: 'space_id', table: 'spaces' },
    { column: 'requester_id', table: 'profiles' },
    { column: 'invitation_id', table: 'invitations', nullable: true },
    { column: 'decided_by', table: 'profiles', nullable: true },
  ],
  extension_requests: [
    { column: 'space_id', table: 'spaces' },
    { column: 'requester_id', table: 'profiles' },
    { column: 'decided_by', table: 'profiles', nullable: true },
  ],
  files: [
    { column: 'space_id', table: 'spaces' },
    { column: 'folder_id', table: 'folders', nullable: true },
    { column: 'uploader_id', table: 'profiles' },
  ],
  archives: [
    { column: 'space_id', table: 'spaces' },
    { column: 'owner_id', table: 'profiles' },
  ],
  notifications: [
    { column: 'user_id', table: 'profiles' },
    { column: 'space_id', table: 'spaces', nullable: true },
    { column: 'invite_link_id', table: 'invite_links', nullable: true },
    { column: 'join_request_id', table: 'join_requests', nullable: true },
  ],
  jobs: [{ column: 'space_id', table: 'spaces', nullable: true }],
  cleanup_runs: [
    { column: 'space_id', table: 'spaces' },
    { column: 'archive_id', table: 'archives' },
  ],
  activity: [
    { column: 'user_id', table: 'profiles', nullable: true },
    { column: 'space_id', table: 'spaces', nullable: true },
    { column: 'file_id', table: 'files', nullable: true },
  ],
  scan_jobs: [
    { column: 'space_id', table: 'spaces' },
    { column: 'owner_id', table: 'profiles' },
  ],
  duplicate_groups: [{ column: 'scan_id', table: 'scan_jobs' }],
  duplicate_files: [
    { column: 'group_id', table: 'duplicate_groups' },
    { column: 'scan_id', table: 'scan_jobs' },
    { column: 'file_id', table: 'files' },
    { column: 'uploader_id', table: 'profiles' },
  ],
  archive_plans: [
    { column: 'space_id', table: 'spaces' },
    { column: 'owner_id', table: 'profiles' },
    { column: 'scan_id', table: 'scan_jobs', nullable: true },
  ],
  archive_jobs: [
    { column: 'plan_id', table: 'archive_plans' },
    { column: 'space_id', table: 'spaces' },
    { column: 'owner_id', table: 'profiles' },
    { column: 'archive_id', table: 'archives', nullable: true },
  ],
  admin_audit: [{ column: 'admin_id', table: 'profiles' }],
  space_access: [
    { column: 'space_id', table: 'spaces' },
    { column: 'user_id', table: 'profiles' },
  ],
  space_favorites: [
    { column: 'user_id', table: 'profiles' },
    { column: 'space_id', table: 'spaces' },
  ],
  lifecycle_transitions: [
    { column: 'space_id', table: 'spaces' },
    { column: 'actor_id', table: 'profiles', nullable: true },
  ],
  verification_tokens: [{ column: 'user_id', table: 'profiles' }],
};

/** SQLite 0/1 integer booleans become real Postgres booleans. */
const BOOLEAN_COLUMNS = new Set([
  'spaces.archived_manually',
  'spaces.invitations_enabled',
  'duplicate_files.excluded',
  'archive_plans.explained',
]);

/** JSON-encoded text columns become jsonb. */
const JSON_COLUMNS = new Set(['activity.metadata', 'admin_audit.metadata']);

/** SQLite-only column names mapped onto their Postgres equivalents. */
const RENAMED_COLUMNS: Record<string, Record<string, string>> = {
  profiles: { status: 'account_status' },
};

/** Unique constraints that must hold after migration. */
const UNIQUE_KEYS: Array<{ table: string; columns: string[]; caseInsensitive?: boolean; label: string }> = [
  { table: 'profiles', columns: ['email'], caseInsensitive: true, label: 'email' },
  { table: 'jobs', columns: ['idempotency_key'], label: 'idempotency_key' },
  { table: 'invite_links', columns: ['token'], label: 'token' },
  { table: 'files', columns: ['object_key'], label: 'object_key' },
  { table: 'duplicate_groups', columns: ['scan_id', 'content_hash'], label: 'scan_id+content_hash' },
  { table: 'duplicate_files', columns: ['group_id', 'file_id'], label: 'group_id+file_id' },
  { table: 'archive_jobs', columns: ['idempotency_key'], label: 'idempotency_key' },
  { table: 'activity', columns: ['event_key'], label: 'event_key' },
];

const ROW_ID: Record<string, string> = {
  members: 'space_id',
  space_access: 'space_id',
  space_favorites: 'user_id',
  credentials: 'user_id',
  activity: 'id',
};

/** Read every known table from a SQLite file without modifying it. */
export async function readSourceTables(
  sqliteFile: string,
  tables: readonly string[] = TABLE_ORDER,
): Promise<SourceTable[]> {
  const db = new DatabaseSync(sqliteFile, { readOnly: true });
  try {
    const out: SourceTable[] = [];
    for (const name of tables) {
      const exists = db
        .prepare("select name from sqlite_master where type = 'table' and name = ?")
        .get(name) as { name?: string } | undefined;
      if (!exists) continue;
      const rows = db.prepare(`select * from "${name}"`).all() as Array<Record<string, unknown>>;
      const columns = rows.length
        ? Object.keys(rows[0]!)
        : (db.prepare(`pragma table_info("${name}")`).all() as Array<{ name: string }>).map((c) => c.name);
      out.push({ name, columns, rows });
    }
    return out;
  } finally {
    db.close();
  }
}

function valueFor(
  table: string,
  column: string,
  value: unknown,
  issues: MigrationIssue[],
  rowId: string | null,
): unknown {
  if (value === undefined) return null;
  if (BOOLEAN_COLUMNS.has(`${table}.${column}`)) {
    if (value === null) return null;
    return value === 1 || value === true || value === '1';
  }
  if (JSON_COLUMNS.has(`${table}.${column}`)) {
    if (value === null || value === '') return {};
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(String(value));
    } catch {
      issues.push({
        table,
        rowId,
        kind: 'INVALID_JSON',
        detail: `${column} is not valid JSON; stored as {}`,
      });
      return {};
    }
  }
  if (typeof value === 'string' && value === '') {
    // Postgres timestamptz rejects ''; empty optional values were NULL in SQLite.
    return null;
  }
  return value;
}

export interface PlanOptions {
  /** Column names that exist in the target table (from information_schema). */
  targetColumns: Record<string, string[]>;
  sourceFile: string;
  tables?: readonly string[];
}

/**
 * Build the executable plan plus its human-readable report. Nothing is written
 * here: the plan is validated first, so a dry run and a real import always
 * evaluate exactly the same rules.
 */
export function buildMigrationPlan(
  source: SourceTable[],
  options: PlanOptions,
): { report: DryRunReport; plans: TablePlan[] } {
  const byTable = new Map(source.map((table) => [table.name, table]));
  const issues: MigrationIssue[] = [];
  const warnings: string[] = [];
  const plans: TablePlan[] = [];

  // Index every referenced key so orphan checks are O(1).
  const keySets = new Map<string, Set<string>>();
  const keyFor = (table: string, columns: string[], row: Record<string, unknown>, ci = false): string => {
    void table;
    return columns.map((column) => String(row[column] ?? '').toLowerCase().trim()).join('|');
  };
  for (const table of source) {
    keySets.set(table.name, new Set(table.rows.map((row) => String(row.id ?? ''))));
  }

  // Known tables in dependency order, then anything else present in the source
  // so an unexpected table is reported instead of silently ignored.
  const known = options.tables ?? TABLE_ORDER;
  const extras = source.map((table) => table.name).filter((name) => !known.includes(name));
  for (const name of [...known, ...extras]) {
    const table = byTable.get(name);
    if (!table) continue;
    const target = options.targetColumns[name];
    if (!target) {
      issues.push({
        table: name,
        rowId: null,
        kind: 'UNKNOWN_TARGET_TABLE',
        detail: `table "${name}" does not exist in the Postgres schema; all ${table.rows.length} rows will be skipped`,
      });
      plans.push({
        table: name,
        sourceRows: table.rows.length,
        insertableRows: 0,
        skippedRows: table.rows.length,
        skippedUnknownTable: true,
        columns: [],
        droppedColumns: table.columns,
        rows: [],
        issues: [],
      });
      continue;
    }

    const rename = RENAMED_COLUMNS[name] ?? {};
    const targetSet = new Set(target);
    const mappedColumns: Array<{ source: string; target: string }> = [];
    const droppedColumns: string[] = [];
    for (const column of table.columns) {
      const mapped = rename[column] ?? column;
      if (targetSet.has(mapped)) mappedColumns.push({ source: column, target: mapped });
      else droppedColumns.push(column);
    }
    if (droppedColumns.length) {
      warnings.push(`${name}: target is missing source columns [${droppedColumns.join(', ')}]; values are not migrated`);
    }

    const seen = new Map<string, string | null>();
    const rows: Array<Record<string, unknown>> = [];
    let skipped = 0;
    const tableIssues: MigrationIssue[] = [];

    for (const row of table.rows) {
      const id = String(row[ROW_ID[name] ?? 'id'] ?? row.id ?? '');
      let blocking = false;

      for (const ref of REFERENCES[name] ?? []) {
        const value = row[ref.column];
        if (value === null || value === undefined || value === '') continue;
        const targetKeys = keySets.get(ref.table);
        if (targetKeys && !targetKeys.has(String(value))) {
          tableIssues.push({
            table: name,
            rowId: id,
            kind: 'ORPHAN_FK',
            detail: `${ref.column}=${String(value)} has no row in ${ref.table}`,
          });
          blocking = true;
        }
      }

      for (const unique of UNIQUE_KEYS) {
        if (unique.table !== name) continue;
        const key = keyFor(name, unique.columns, row, unique.caseInsensitive);
        if (seen.has(key)) {
          tableIssues.push({
            table: name,
            rowId: id,
            kind: 'DUPLICATE_KEY',
            detail: `${unique.label} duplicates row ${seen.get(key) ?? '?'}`,
          });
          blocking = true;
        } else {
          seen.set(key, id);
        }
      }

      const converted: Record<string, unknown> = {};
      for (const { source: sourceColumn, target: targetColumn } of mappedColumns) {
        converted[targetColumn] = valueFor(name, sourceColumn, row[sourceColumn], tableIssues, id);
      }

      if (blocking) {
        skipped += 1;
        continue;
      }
      rows.push(converted);
    }

    issues.push(...tableIssues);
    plans.push({
      table: name,
      sourceRows: table.rows.length,
      insertableRows: rows.length,
      skippedRows: table.rows.length - rows.length,
      skippedUnknownTable: false,
      columns: mappedColumns.map((m) => m.target),
      droppedColumns,
      rows,
      issues: tableIssues,
    });
  }

  const totals = plans.reduce(
    (acc, plan) => ({
      sourceRows: acc.sourceRows + plan.sourceRows,
      insertableRows: acc.insertableRows + plan.insertableRows,
      skippedRows: acc.skippedRows + plan.skippedRows,
      issues: acc.issues + plan.issues.length,
    }),
    { sourceRows: 0, insertableRows: 0, skippedRows: 0, issues: 0 },
  );

  const report: DryRunReport = {
    generatedAt: new Date().toISOString(),
    sourceFile: options.sourceFile,
    tables: plans.map(({ rows: _rows, ...rest }) => rest),
    totals,
    blocking: issues.filter((issue) => issue.kind !== 'INVALID_JSON'),
    warnings,
  };
  return { report, plans };
}

/** Report-only view (the default for CLI/dry-run callers). */
export function buildPlan(source: SourceTable[], options: PlanOptions): DryRunReport {
  return buildMigrationPlan(source, options).report;
}

/** Executable plans, in dependency order, ready for `applyPlan`. */
export function buildExecutablePlan(source: SourceTable[], options: PlanOptions): TablePlan[] {
  return buildMigrationPlan(source, options).plans;
}

export interface ApplyResult {
  inserted: number;
  skippedExisting: number;
  perTable: Array<{ table: string; inserted: number; skippedExisting: number; targetCount: number | null }>;
}

/** Insert the plan in FK order, inside one transaction. */
export async function applyPlan(
  client: MigrationTerminal,
  plans: TablePlan[],
  options: { batchSize?: number } = {},
): Promise<ApplyResult> {
  const batchSize = Math.max(1, options.batchSize ?? 250);
  const result: ApplyResult = { inserted: 0, skippedExisting: 0, perTable: [] };
  await client.query('begin');
  try {
    for (const plan of plans) {
      if (plan.skippedUnknownTable || plan.rows.length === 0) {
        result.perTable.push({ table: plan.table, inserted: 0, skippedExisting: 0, targetCount: null });
        continue;
      }
      let inserted = 0;
      let skippedExisting = 0;
      for (let offset = 0; offset < plan.rows.length; offset += batchSize) {
        const batch = plan.rows.slice(offset, offset + batchSize);
        const columns = plan.columns;
        const values: unknown[] = [];
        const tuples = batch.map((row, rowIndex) => {
          const placeholders = columns.map((column, columnIndex) => {
            values.push(row[column]);
            return `$${rowIndex * columns.length + columnIndex + 1}`;
          });
          return `(${placeholders.join(', ')})`;
        });
        // Identifiers are quoted: some migrated column names (e.g. `timestamp`)
        // collide with SQL type keywords.
        const columnList = columns.map((column) => `"${column}"`).join(', ');
        const sql =
          `insert into "${plan.table}" (${columnList}) values ${tuples.join(', ')} ` +
          'on conflict do nothing';
        const response = await client.query(sql, values);
        const affected = response.rowCount ?? 0;
        inserted += affected;
        skippedExisting += batch.length - affected;
      }
      result.inserted += inserted;
      result.skippedExisting += skippedExisting;
      const count = await client.query(`select count(*)::int as count from "${plan.table}"`);
      result.perTable.push({
        table: plan.table,
        inserted,
        skippedExisting,
        targetCount: Number(count.rows[0]?.count ?? 0),
      });
    }

    // Preserve explicit bigserial ids, then move the sequence past them.
    await client.query(
      `select setval(pg_get_serial_sequence('activity', 'id'),
         coalesce((select max(id) from activity), 0) + 1, false)
       where exists (select 1 from activity)`,
    );
    await client.query('commit');
    // Totals are derived from the per-table results so they can never drift
    // from what was actually reported.
    result.inserted = result.perTable.reduce((sum, entry) => sum + entry.inserted, 0);
    result.skippedExisting = result.perTable.reduce((sum, entry) => sum + entry.skippedExisting, 0);
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  }
}

/** Table-level parity check between the SQLite source and the target schema. */
export function checkTableParity(
  source: SourceTable[],
  targetTables: string[],
): { missingInTarget: string[]; missingInSource: string[] } {
  const target = new Set(targetTables);
  const sourceNames = new Set(source.map((table) => table.name));
  return {
    missingInTarget: source.map((table) => table.name).filter((name) => !target.has(name)),
    missingInSource: targetTables.filter((name) => !sourceNames.has(name)),
  };
}
