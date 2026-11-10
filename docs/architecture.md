# Architecture

## Monorepo layout

```
apps/api        Express + TypeScript service (the product brain)
apps/web        React 18 + Vite + Tailwind SPA (hash routing)
packages/shared Domain types, constants, error codes, zod schemas
```

## API layering

```
routes/          HTTP surface: parsing, authz guards, status codes
  ├─ auth.routes       register / login / me
  ├─ space.routes      spaces, members, invitations, folders, files, extensions, activity
  ├─ scan.routes       storage scans, duplicates, archive plans (selective archives)
  ├─ misc.routes       notifications, vault, admin extension decisions
  ├─ admin.routes      stats, users, jobs, archive retry (requireAdmin)
  ├─ jobs.routes       POST /jobs/lifecycle/run (x-job-secret)
  └─ storage.routes    local signed-URL PUT/GET endpoints (token auth)

middleware/      requestContext (request ids), requireAuth, error funnel
services/        domain logic: spaces, files, archive, archive-plan, scan,
                 duplicate, cleanup, lifecycle, extensions, admin — all rules
                 live here, not in routes
repositories/    memory/ (default) and postgres/ (migrations + runner)
storage/         StorageAdapter interface + Local and Supabase adapters
utils/           ids, HS256 JWT, scrypt passwords, streaming ZIP writer
```

Dependencies point inward only: routes → services → repositories/storage.
Services are constructed in `app.ts` (factory) and share a single data layer,
so request handling, the lifecycle worker and the admin retry path all enforce
identical rules.

## Data flow: file upload

1. `POST /spaces/:id/files/init-upload` — validates role, Space writability,
   per-file and per-Space quotas; creates a `PENDING` file row; returns a
   short-lived signed PUT URL.
2. Browser `PUT`s the bytes directly to storage (never through the API).
3. `POST …/files/:fileId/confirm-upload` — HEADs the object; missing object →
   404; present → row becomes `ACTIVE` with real size + etag.

Downloads follow the same pattern with a signed GET URL plus
`Content-Disposition`.

## Data flow: archiving

`LifecycleService` queues an idempotent `ARCHIVE` job per expired Space, then
`ArchiveService.runArchive` streams every active file through
`utils/zip.ts` (a dependency-free ZIP writer with per-entry CRC-32 and a
central directory) into the owner's Vault prefix, writes a JSON manifest, and
verifies object presence + byte count before marking `VERIFIED` and flipping
the Space to `ARCHIVED`.Counting/hashing happens inside the generator chain
 so upstream read errors propagate and fail the archive (→ `ARCHIVE_FAILED`,
 admin-retryable).

## Data flow: smart storage insights + selective archives

1. `POST /spaces/:id/scans` streams every active object through SHA-256,
   persists the hash on the file row, groups identical hashes into exact
   duplicate groups, and stores the report in `scan_jobs` /
   `duplicate_groups` / `duplicate_files`. Savings are computed from real byte
   sizes and labelled potential until a deletion succeeds.
2. The owner reviews duplicates, optionally flags files for exclusion, and
   creates an `archive_plan`. An empty exclusion list is the default and means
   *archive everything*, duplicates included.
3. `ArchivePlanService.confirmPlan` writes the ZIP (real bytes, folder paths
   from `folders`, collision-free entry names), stores it in the Vault prefix
   with a manifest, verifies size + SHA-256, and only then marks the Space
   `ARCHIVED`. Failures mark plan + job `FAILED` and leave the Space and its
   files untouched so an admin retry is safe.

`LifecycleService` sends exactly one expiry reminder per warning window
(`spaces.warning_sent_at`) and archives expired Spaces in full when the owner
has made no selection — inactivity never discards files.

## Swap-in adapters

| Concern | Interface | Memory/local impl | Cloud impl |
| --- | --- | --- | --- |
| Persistence | data layer | `repositories/memory` | `repositories/postgres` + SQL migrations |
| Objects | `StorageAdapter` | `storage/local.storage` | `storage/supabase.storage` |
| Auth identity | `AuthService` | local JWT + scrypt | Supabase Auth (verify token server-side) |

Both storage adapters implement signed upload/download URLs, server-side
`putObject` (used by the archive engine), HEAD, delete, and prefix listing
(used by cleanup).
