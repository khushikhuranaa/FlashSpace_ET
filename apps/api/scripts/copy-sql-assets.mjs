#!/usr/bin/env node
/**
 * Copies runtime SQL assets into the compiled output.
 *
 * `tsc` only emits .js, but the migration runner reads
 * `migrations/*.sql` and `local-supabase-shim.sql` relative to its own file.
 * Without this step `node dist/server.js` (the container CMD) breaks as soon as
 * migrations run or the local Supabase shim is needed.
 */
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(here, '..');
const from = join(apiRoot, 'src/repositories/postgres');
const to = join(apiRoot, 'dist/repositories/postgres');

await mkdir(join(to, 'migrations'), { recursive: true });
await cp(join(from, 'migrations'), join(to, 'migrations'), { recursive: true });
await cp(join(from, 'local-supabase-shim.sql'), join(to, 'local-supabase-shim.sql'));
// Kept in sync for operators who apply RLS by hand instead of via migrations.
await cp(join(from, 'rls-policies.sql'), join(to, 'rls-policies.sql'));

console.log('[build] copied SQL assets into dist/repositories/postgres');
