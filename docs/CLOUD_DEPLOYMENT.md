# Cloud deployment & database migration (Module 15)

This document is the operational companion to the Module 15 report. It records
what is actually implemented, what was verified locally, and exactly what is
still blocked. Nothing here claims the app is cloud-connected: no Supabase
project has been supplied, so no live cloud verification has been performed.

## Status at a glance

| Area | Status |
| --- | --- |
| Postgres schema + migrations | IMPLEMENTED, verified on local PostgreSQL 17 |
| Migration runner (history, checksums, dry-run, fail-fast) | IMPLEMENTED, AUTOMATED_TESTED |
| SQLite → Postgres importer (dry-run + apply) | IMPLEMENTED, verified against local PG |
| RLS policies + private buckets SQL | IMPLEMENTED (prepared), NOT APPLIED |
| Supabase Storage adapter | IMPLEMENTED, AUTOMATED_TESTED (injected client) |
| Postgres DataLayer (`REPO_MODE=postgres`) | IMPLEMENTED, LIVE_VERIFIED on local PostgreSQL 17 (migrations, register, space create/list) |
| Supabase Auth | IMPLEMENTED (verification + profile mirroring), CONFIGURATION_REQUIRED |
| Local JWT auth (development) | IMPLEMENTED, LIVE_VERIFIED (existing test suite) |
| Local file storage | IMPLEMENTED, LIVE_VERIFIED |
| Hosting blueprint (Docker/Render) | IMPLEMENTED, not deployed |
| Offsite backups / PITR | CONFIGURATION_REQUIRED |

## Recommended architecture

```
Browser (React/Vite, static)
   │  HTTPS + Bearer token
   ▼
API (Node 22 + Express, long-running container)  ──► Supabase Postgres
   │  signed URLs                                   (schema + RLS prepared)
   ├──► Supabase Storage (private buckets: space-files, vault-archives, archive-temp)
   ├──► Transactional email (SMTP)
   └──► Lifecycle scheduler (Render cron → POST /jobs/lifecycle/run)
```

Why not serverless for the API: the lifecycle pass archives Spaces and deletes
objects in-process, uploads/downloads stream through Express, and the
rate limiter keeps per-process state. A function runtime would break streaming,
time out archives and multiply schedulers.

### Hosting evaluation

| Option | Node process | Free tier | Cron | Verdict |
| --- | --- | --- | --- | --- |
| Render | Yes (Docker) | Web sleeps after idle; cron is paid | Native cron | **Recommended for the API**; add a paid instance or external cron pinger for production |
| Fly.io | Yes (Machines) | Small free allowance | `fly machines`/external cron | Good alternative, more ops work |
| Railway | Yes | Trial credits | Cron | Fine, less predictable free tier |
| Vercel/Netlify | Serverless only | Generous | Scheduled functions | **Frontend only** — not for this Express API |
| Supabase | Postgres/Storage/Auth | Generous | pg_cron (paid add-on) | Use for data/storage/auth, not for the API |

Recommendation: **Render (Docker) for the API + Render cron (or GitHub Actions)
for the scheduler + Vercel/Netlify for the static frontend + Supabase for
Postgres/Storage/Auth.** Everything is free-tier compatible except always-on
compute, which the free Render web service does not guarantee.

## Supabase project setup

1. Create a project at <https://supabase.com/dashboard> (region close to users).
2. Copy from **Project Settings → API**: Project URL, `anon` key, `service_role`
   key. The service-role key is server-only and must never appear in a `VITE_`
   variable, a browser bundle or a log.
3. Copy the Postgres connection string (Session pooler) into `DATABASE_URL`.
4. **Authentication → URL configuration**: set Site URL and add
   `https://<frontend-domain>` plus `http://localhost:5173` to redirect URLs.
5. **Storage**: create three private buckets — `space-files`, `vault-archives`,
   `archive-temp` — or apply the bucket block at the end of
   `apps/api/src/repositories/postgres/rls-policies.sql`.
6. Apply migrations (below), then review and apply RLS policies.
7. Do not enable public buckets. Files are only reachable through short-lived
   signed URLs issued after an application authorisation check.

## Environment variables

Development (`apps/api/.env`): `NODE_ENV=development`, `AUTH_MODE=local`,
`REPO_MODE=sqlite`, `STORAGE_MODE=local`, `WEB_ORIGIN=http://localhost:5173`.
The dev-only secrets are rejected automatically when `NODE_ENV=production`.

Test: `NODE_ENV=test`, `REPO_MODE=memory` (the suite never touches real data).

Production (minimum):

```
NODE_ENV=production
PORT=4000
TRUST_PROXY=1                 # exactly the number of proxies in front of the API
REQUIRE_HTTPS=true
WEB_ORIGIN=https://app.example.com   # comma-separated, https only
WEB_APP_URL=https://app.example.com
AUTH_MODE=supabase
REPO_MODE=postgres                # production refuses sqlite unless ALLOW_SQLITE_IN_PRODUCTION=true
RUN_MIGRATIONS_ON_BOOT=true       # advisory-locked, transactional, idempotent on restart
STORAGE_MODE=supabase
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
DATABASE_URL=postgres://...
SUPABASE_FILES_BUCKET=space-files
SUPABASE_VAULT_BUCKET=vault-archives
SUPABASE_TEMP_BUCKET=archive-temp
LOCAL_AUTH_SECRET=<32+ random chars>   # required by startup validation
JOB_SECRET=<32+ random chars, different value>
EMAIL_TRANSPORT=smtp
SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASSWORD=... EMAIL_FROM=...
```

Frontend (`apps/web/.env` production): `VITE_API_URL=https://api.example.com`
(or leave empty when the API is reverse-proxied under `/api`),
`VITE_AUTH_MODE=supabase`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
Never place the service-role key in the web env.

## Database migrations

The runner is `apps/api/src/repositories/postgres/migrate.ts`:

```bash
DATABASE_URL=... npm run db:status  -w @flashspace/api   # applied / pending / missing / drifted
DATABASE_URL=... npm run db:dry-run -w @flashspace/api   # list what would run
DATABASE_URL=... npm run db:migrate -w @flashspace/api   # apply, one transaction per file
```

Guarantees: ordered execution, SHA-256 checksums, per-file transactions,
fail-fast (a failed migration aborts with its filename and rolls back), and an
edit to an already-applied migration is reported as drift instead of ignored.

Schema notes:
- `002`, `004` and `005` declared `uuid` columns that referenced `text` ids, so
  PostgreSQL rejected their foreign keys. They were corrected to `text`; this is
  safe because the invalid migrations could never have been applied anywhere.
- `006_cloud_completion.sql` adds the Module 9/11/12 tables and columns that the
  local SQLite schema already had (suspension fields, activity audit columns,
  `admin_audit`, `lifecycle_transitions`, `email_jobs`, `verification_tokens`).
- `local-supabase-shim.sql` creates the minimal `auth`/`storage` schemas so the
  migrations can be verified against a plain PostgreSQL. **Never run it on
  Supabase.**

## Moving existing data

The importer opens SQLite read-only and refuses to write unless explicitly told:

```bash
# 1. Back up first (Module 14 tooling, local):
cd apps/api && npm run backup

# 2. Review: row counts, FK orphans, duplicate keys, conversions
DATABASE_URL=... SQLITE_FILE=./data/flashspace.db npm run db:import -w @flashspace/api

# 3. Only after the report has zero blocking issues:
DATABASE_URL=... SQLITE_FILE=./data/flashspace.db MIGRATION_CONFIRM=yes \
  npm run db:import -w @flashspace/api -- --apply
```

What it does: preserves ids, inserts parents before children, converts SQLite
`0/1` to booleans, parses JSON text into `jsonb`, maps `profiles.status` →
`account_status`, inserts activity rows with their original ids and advances the
sequence, and reports every skipped row with a reason. It never truncates or
updates the target; a second run inserts nothing and reports the existing rows.

Rollback: the import is a single transaction, so a failure leaves the target
untouched. To undo a completed import, restore the pre-import backup or delete
only the imported ids (`on conflict do nothing` means a re-run is safe).

## Authentication decision

**Recommendation: Supabase Auth in production; keep local JWT for development.**

- Supabase Auth gives verified email handling, refresh-token rotation, revocation
  and MFA without rebuilding them.
- The API already verifies Supabase tokens server-side (JWKS with issuer and
  `authenticated` audience, HS256 only when explicitly configured) and re-reads
  the application role from Postgres — a client-supplied role is never trusted.
- Existing scrypt hashes **cannot** be imported into Supabase Auth. Password
  hashes stay in SQLite/`credentials`; users link accounts through the existing
  `legacy_account_links` flow (verify the new address, then prove control of the
  old account) or a password reset. Ownership, memberships and files are
  preserved because profile ids are unchanged.
- Do not run both providers for the same user population. `AUTH_MODE` is a
  deployment-wide switch.

## RLS and storage policies

`apps/api/src/repositories/postgres/rls-policies.sql` is prepared but **not
applied**. It covers profile self-access, Space membership (read) vs ownership
(write), file/folder access, invitations, favourites, recent access, scans,
admin-only audit reads and default-deny for operational tables. Test it with an
owner, a member, and a non-member before enabling it in production.

## Background jobs and scheduling

- Job records are persistent (`jobs`, `archive_jobs`, `email_jobs`) with
  idempotency keys; the lifecycle pass is safe to re-run.
- Local development runs a 5-minute in-process timer (`server.ts`).
- Production uses an external scheduler: Render cron runs
  `apps/api/scripts/run-lifecycle.mjs`, which POSTs to `/jobs/lifecycle/run`
  with `JOB_SECRET`. The endpoint rejects a missing/incorrect secret and the
  pass is idempotent per `(date, space, phase)`.
- The admin panel already exposes job status, retries and cleanup runs.

## Backups and recovery

- Local: `npm run backup -w @flashspace/api` writes a checksummed manifest plus
  the SQLite file and storage directory; `verify` proves integrity and `restore`
  writes into an isolated directory (Module 14 tooling).
- Cloud (CONFIGURATION_REQUIRED): Supabase takes daily database backups on paid
  plans; free projects have none. Add `pg_dump "$DATABASE_URL" -Fc` on a schedule
  plus a Storage export (`supabase storage cp -r`) to an offsite bucket, and test
  a restore into a staging project before launch.

## Deployment steps

1. Push the repo to your Git host (this module does not push).
2. Create the Render blueprint from `render.yaml`, set the `sync: false`
   variables, then apply the schema **before** the first start:
   `DATABASE_URL=... npm run db:migrate -w @flashspace/api`
   (`npm run db:status -w @flashspace/api` shows applied/pending/drifted
   migrations). Deploy the API and confirm `GET /health` returns `ok: true`
   with `database.status: healthy`.
3. Build the frontend (`npm run build --workspace @flashspace/web`), deploy
   `apps/web/dist` to Vercel/Netlify with SPA fallback to `index.html`, and set
   `VITE_API_URL` to the API origin.
4. Add the frontend domain to `WEB_ORIGIN` and to Supabase redirect URLs; enable
   HTTPS. HSTS is only sent on secure requests in production.
5. Create the cron job with `API_BASE_URL` and `JOB_SECRET`.
6. Verify: sign in, create a Space, upload a file, download it, run a scan,
   archive to the Vault, trigger `/jobs/lifecycle/run`, check the admin panel.

## Google OAuth and TOTP MFA

Both flows are implemented in the application; only provider configuration
remains.

1. **Supabase → Authentication → Providers → Google**: paste the Google Client
   ID and Client Secret, and enable the provider.
2. **Google Cloud Console → APIs & Services → Credentials**: create an OAuth
   client of type *Web application* and add the callback Supabase shows you
   (`https://<project-ref>.supabase.co/auth/v1/callback`) as an authorised
   redirect URI. Add your app origin under *Authorised JavaScript origins*.
3. **Supabase → Authentication → URL configuration**: add
   `https://<frontend-domain>` and `http://localhost:5173` as redirect URLs.
   The app returns Google users to `#/auth/callback` and then forwards them to
   the dashboard.
4. **MFA**: enable TOTP under Supabase → Authentication → Multi-Factor Auth.
   Users enrol and disable factors in **Settings → Two-factor authentication**,
   and sign-in asks for the six-digit code when a verified factor exists.

Account linking: Supabase links a Google identity to an existing account when
the verified email matches, so no duplicate profile is created. Accounts created
before Supabase existed are linked explicitly in **Settings → Existing
FlashSpace account**.

## Render blueprint (exact settings)

`render.yaml` defines two services; the frontend is published to GitHub Pages
instead of being hosted here.

| Service | Type | Build | Start / publish | Health check |
| --- | --- | --- | --- | --- |
| `flashspace-api` | Web (Docker) | `apps/api/Dockerfile`, build context = repo root | image `CMD node apps/api/dist/server.js` | `/health` |
| `flashspace-lifecycle` | Cron, `*/10 * * * *` | none | `node apps/api/scripts/run-lifecycle.mjs` | — |

Environment: the production block above, with `WEB_ORIGIN` listing every browser
origin, including the Pages one once the frontend is live.

Deployment order: (1) Supabase project, migrations and buckets, (2) API service,
(3) GitHub Pages frontend, (4) cron job. After the first API boot run
`DATABASE_URL=... npm run db:status -w @flashspace/api` and expect
`pending: []`, `drifted: []`. A restart logs `applied 0, already applied 10`.

## Frontend on GitHub Pages

`.github/workflows/deploy-web-pages.yml` builds `apps/web` and publishes it to
`https://<owner>.github.io/<repo>/` on every push to `main` that touches the web
app, `packages/shared` or the workflow itself.

One-time setup:

1. Repository **Settings → Pages → Source: GitHub Actions**.
2. Repository **Settings → Secrets and variables → Actions → Variables**:
   `VITE_API_URL` (the Render API origin), `VITE_AUTH_MODE=supabase`,
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. The anon key is public by
   design (it ships in the bundle); never put the service-role key here.
3. On the API, add the Pages origin to `WEB_ORIGIN`, e.g.
   `WEB_ORIGIN=https://app.example.com,https://<owner>.github.io`, then
   redeploy — otherwise browser requests fail the CORS check.

The workflow sets `VITE_BASE=/<repo>/` because a project site is served from a
subpath. Hash routing keeps every in-app route on `index.html`, so no server
rewrite is needed. Local dev, Docker and root-hosted builds still use `base: '/'`.

## First administrator (Supabase mode)

Supabase mode never grants ADMIN at sign-up: the profile trigger rejects role
changes from client sessions. Register your account, verify its email, then run
this once in the Supabase SQL editor:

```sql
update public.profiles set role = 'ADMIN' where email = 'you@example.com';
```

Sign in again to see the Admin panel. Do not add a client-side or sign-up
metadata path for this — the trigger would (correctly) reject it.

## Legal pages (Google OAuth verification)

`#/privacy` and `#/terms` are public hash routes, linked from the landing footer
and every auth page. Before submitting the consent screen for verification,
replace the bracketed placeholders in `apps/web/src/pages/Legal.tsx`
(`[OPERATOR / LEGAL ENTITY]`, `[CONTACT EMAIL]`, `[POSTAL ADDRESS]`,
`[EFFECTIVE DATE]`, `[MINIMUM AGE]`, `[GOVERNING LAW / JURISDICTION]`) and use the
deployed, publicly reachable URLs in the Google Cloud console.

## Known blockers

1. **No Supabase credentials**, so Storage/Auth/RLS/Google OAuth are
   CONFIGURATION_REQUIRED and unverified live. Everything else is ready; see
   the migration and runtime checks in this document.
2. **Files stored via Supabase Storage are buffered in memory** (64 MB cap); large
   Vault archives need an S3/R2 streaming adapter or a background upload job.
3. **Free Render web services sleep**, which pauses the in-process timer; the
   external cron keeps lifecycle work running, but requests after idle are slow.
4. **No offsite backup destination** configured; database backup/restore on
   Supabase is plan-dependent.
5. **Supabase password/email changes** are delegated to Supabase Auth, so the
   API's local reset endpoints answer with a delegation message in that mode by
   design (the browser uses the Supabase SDK instead).
