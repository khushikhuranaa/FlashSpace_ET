/**
 * SQLite → Postgres/Supabase data import CLI (Module 15).
 *
 *   npm run db:import -w @flashspace/api                 # dry run (default)
 *   npm run db:import -w @flashspace/api -- --apply      # real import
 *
 * A real import additionally requires MIGRATION_CONFIRM=yes, so automation can
 * never start writing to a cloud database by accident. The SQLite source is
 * opened read-only; the target is never truncated and existing rows are never
 * updated.
 */
import { Client } from 'pg';
import { loadEnv } from '../src/config/env.js';
import {
  applyPlan,
  buildMigrationPlan,
  checkTableParity,
  readSourceTables,
  TABLE_ORDER,
} from '../src/migration/sqlite-to-postgres.js';

async function targetSchema(client: Client): Promise<{ tables: string[]; columns: Record<string, string[]> }> {
  const { rows } = await client.query(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position`,
  );
  const columns: Record<string, string[]> = {};
  for (const row of rows as Array<{ table_name: string; column_name: string }>) {
    (columns[row.table_name] ??= []).push(row.column_name);
  }
  return { tables: Object.keys(columns).sort(), columns };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required (Postgres/Supabase connection string).');
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');
  if (apply && process.env.MIGRATION_CONFIRM !== 'yes') {
    console.error(
      'Refusing to write: set MIGRATION_CONFIRM=yes to authorise a real import. ' +
        'Run without --apply first to review the dry-run report.',
    );
    process.exit(1);
  }

  const source = await readSourceTables(env.sqliteFile, TABLE_ORDER);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const target = await targetSchema(client);
    const parity = checkTableParity(source, target.tables);
    const { report, plans } = buildMigrationPlan(source, {
      sourceFile: env.sqliteFile,
      targetColumns: target.columns,
    });

    console.log(JSON.stringify({ parity, ...report }, null, 2));

    if (!apply) {
      console.log('\nDry run only. Re-run with --apply and MIGRATION_CONFIRM=yes to import.');
      return;
    }
    if (report.blocking.length) {
      console.error(
        `\nAborting: ${report.blocking.length} blocking issue(s). Fix or exclude them first — nothing was written.`,
      );
      process.exit(2);
    }

    const result = await applyPlan(client, plans);
    const verification = await client.query(
      `select (select count(*) from profiles)::int as profiles,
              (select count(*) from spaces)::int as spaces,
              (select count(*) from members)::int as members,
              (select count(*) from files)::int as files,
              (select count(*) from archives)::int as archives,
              (select count(*) from activity)::int as activity`,
    );
    console.log(JSON.stringify({ imported: result, verification: verification.rows[0] }, null, 2));
  } finally {
    await client.end();
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
