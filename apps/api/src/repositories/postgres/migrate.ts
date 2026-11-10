/**
 * Minimal migration runner for postgres mode: applies every .sql file in
 * migrations/ once, tracked in a schema_migrations table. Used by
 * `npm run db:migrate -w @flashspace/api`.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const dir = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `create table if not exists schema_migrations (
         name text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const applied = await client.query('select 1 from schema_migrations where name = $1', [file]);
      if (applied.rowCount) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      console.log(`applied migration ${file}`);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
