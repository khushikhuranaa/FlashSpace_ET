# Smart Storage Insights + Duplicate Detection — Implementation Plan

## Existing architecture (audit summary)

- Frontend: React 18 + Vite + Tailwind, hash router in `apps/web/src/App.tsx`.
  Pages: Landing, Login, Dashboard, SpaceDetail, Vault, Notifications, Admin, JoinPage.
  API client: single `apps/web/src/api.ts` using `fetch` to proxied `/api`.
- Backend: Express in `apps/api/src`. Local JWT auth (`requireAuth`, `requireAdmin`).
  Services: auth, spaces, files, archive, cleanup, extensions, lifecycle, admin, membership,
  storage. Route modules: auth, space, misc, storage, admin, jobs.
- DB: SQLite via Node built-in `node:sqlite`, WAL, FK on. Schema lives in
  `apps/api/src/repositories/sqlite/sqlite.data-layer.ts` `SCHEMA` (IF NOT EXISTS).
  There is also a Postgres migration file
  `apps/api/src/repositories/postgres/migrations/001_init.sql` for cloud parity.
  New tables/columns are added to `SCHEMA` and mirrored into the Postgres migration.
- Storage: `StorageAdapter` interface. Local adapter streams files and already computes
  SHA-256 at `putObject` time (returns etag = sha256 hex), but it is NOT persisted to
  `files.sha256`. The column `files.sha256` and `archives.checksum` already exist.
- Archive engine: `ArchiveService` already creates full-space ZIPs via `zipStream`,
  stores `users/{owner}/vault/archives/{space}/{id}.zip` + manifest, verifies size,
  marks VERIFIED, notifies. Reuse for the final selective archive ZIP.
- Lifecycle: `LifecycleService.runLifecyclePass` handles ACTIVE→WARNING→ARCHIVING→
  ARCHIVED→DELETED with per-(space,date) idempotency keys. Cron hits `POST /jobs/lifecycle/run`.
  Dev runs it every 5 min in-process.

## Decisions

1. Reuse the existing archive engine + `zipStream` for the final selective/archive ZIP.
   Selective archive = ZIP of the owner-selected file set; default selection = all active
   files (full archive fallback). Selection is modeled as an explicit *exclude* list; an
   empty exclude list means archive everything, including duplicates.
2. Populate `files.sha256` from actual stored bytes at scan time (streaming SHA-256) and
   persist. Populate `archives.checksum` (SHA-256 of the ZIP bytes) at verify time.
   Exact duplicates = identical sha256. Near-duplicates = filename similarity heuristic,
   clearly labeled, never treated as duplicates.
3. New domain entities: `scan_jobs`, `duplicate_groups`, `duplicate_files`,
   `archive_plans`, `archive_jobs` (for safe retry/idempotency of selective archives),
   plus reuse `activity` for audit and `archives` for the resulting vault archive.
4. New notification types: `SCAN_READY`, `SCAN_FAILED`, `ARCHIVE_PLAN_CONFIRMED`,
   `ARCHIVE_PLAN_FAILED`, `DUPLICATE_FILES_REMOVED`, `EXTENSION_REQUESTED`,
   `EXTENSION_APPROVED`, `EXTENSION_REJECTED`, `REMINDER_SENT` (for expiry reminder dedup
   audit). Reminder dedup: the once-per-warning-window reminder is gated by `warningSentAt`
   and only fires when the space *enters* WARNING.
5. New API module `scan.routes.ts` under `requireAuth`. Frontend page
   `StorageInsights.tsx` at route `#/spaces/:id/insights`. Extend `api.ts`.
6. No emojis anywhere: replace the three remaining `←` literals with the existing SVG
   back button; ensure all new UI, notifications, empty states use inline SVG icons.

## Files created

- `packages/shared/src/types/storage.ts` — new domain types (scan, duplicate, plan, archive job).
- `packages/shared/src/constants/storage.ts` — status enums + activity actions + notification types.
- `apps/api/src/services/scan.service.ts` — scan + duplicate detection + storage calc.
- `apps/api/src/services/archive-plan.service.ts` — selective archive plans + ZIP + verify.
- `apps/api/src/services/duplicate.service.ts` — duplicate group/removal operations.
- `apps/api/src/services/reminder.service.ts` — expiry reminder once-per-window.
- `apps/api/src/routes/scan.routes.ts` — new API endpoints.
- `apps/api/src/repositories/sqlite/migrations/002_smart_storage.sql` — SQLite migration
  (new tables + columns + backfills), applied by `migrateDb`.
- `apps/api/src/repositories/postgres/migrations/002_smart_storage.sql` — Postgres parity.
- `apps/web/src/pages/StorageInsights.tsx` — Smart Storage Insights dashboard + duplicate
  review + archive plan selection/confirmation.
- `apps/web/src/pages/ExtensionRequest.tsx` (small) — extension request UI if not inline.
- `apps/api/tests/smart-storage.test.ts` — acceptance tests.

## Files modified

- `packages/shared/src/types.ts` — re-export new types.
- `packages/shared/src/constants.ts` — re-export new constants + extend ACTIVITY_ACTIONS/
  NOTIFICATION_TYPES.
- `apps/api/src/repositories/data-layer.interface.ts` — new repo interfaces.
- `apps/api/src/repositories/sqlite/sqlite.data-layer.ts` — new repo impls + migrateDb.
- `apps/api/src/app.ts` — mount scan routes; wire new services.
- `apps/api/src/server.ts` — (optional) schedule reminder/scan checks if desired; not required.
- `apps/api/src/services/spaces.service.ts` — small additions (extension request method if not present, reminder helper).
- `apps/api/src/services/archive.service.ts` — extend to support selective archive ZIP + checksum.
- `apps/api/src/services/lifecycle.service.ts` — reminder dedup gate.
- `apps/web/src/api.ts` — new endpoints.
- `apps/web/src/App.tsx` — route for `/spaces/:id/insights`.
- `apps/web/src/pages/SpaceDetail.tsx` — Insights tab + expiry display + extension action + fix `←`.
- `apps/web/src/pages/JoinPage.tsx` — fix `←`.
- `apps/web/src/index.css` — any new utilities if needed.

## Acceptance test mapping

1. Identical content / different names → same sha256 → same duplicate group. (Test: upload two files with different names same bytes, scan, assert one group.)
2. Same name / different content → different sha256 → not duplicates. (Test: two files named `report.pdf` with different bytes.)
3. Storage calc: 3 × 2MB identical → group files=3, extra=2, savings=4MB.
4. Failed scan → report with error files, no fabricated results.
5. Owner selects exclude list → plan reflects exclusions.
6. No selection → plan includes all active files → full ZIP.
7. Duplicates included in full archive (default plan includes them).
8. ZIP contains actual file bytes + nested folder paths.
9. ZIP verified (checksum + openable) before space transition.
10. Archive stored under `users/{owner}/vault/archives/...` and downloadable by owner.
11. Failed archive → space stays intact, archive job marked failed.
12. Cleanup/membership revoke only after verified archive persisted.
13. Non-owner / non-member → 403 on scan/plan/confirm/delete.
14. Reminder fires once per warning-window entry (warningSentAt gate).
15. Failed archive job retryable via admin retry endpoint.
16. Dashboard insights values come from real scan DB rows.
17. No emoji anywhere (automated scan + manual snapshot).
18. Existing flows (create space, upload, download, archive, vault) still work.
