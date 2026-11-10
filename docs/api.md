# API reference

Base URL: `http://localhost:4000` (dev). All bodies are JSON. Every response
carries `X-Request-Id`. Errors use one envelope:

```json
{ "error": { "code": "FORBIDDEN_ROLE", "message": "Requires one of: OWNER, EDITOR", "requestId": "…" } }
```

Auth: `Authorization: Bearer <token>` from `/auth/register` or `/auth/login`.
Job endpoint: `x-job-secret` header instead of a Bearer token.

## Auth

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/register` | `{ email, password (min 8), displayName }` → `{ user, token }`. First user on a fresh store becomes ADMIN. |
| POST | `/auth/login` | `{ email, password }` → `{ user, token }` |
| GET | `/auth/me` | current user |
| PATCH | `/auth/me` | `{ displayName?, avatarUrl? }` |

## Spaces & membership

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/spaces` | member | Spaces the caller belongs to (deleted excluded) |
| POST | `/spaces` | any | `{ name, purpose, description?, startAt, expiryAt }`; `expiryAt > startAt` enforced |
| GET | `/spaces/:id` | member | detail incl. members + storage usage |
| PATCH | `/spaces/:id` | OWNER, EDITOR | rename / re-purpose / extend expiry |
| DELETE | `/spaces/:id` | OWNER | soft-delete immediately |
| GET | `/spaces/:id/members` | member | |
| POST | `/spaces/:id/invitations` | OWNER, EDITOR | `{ email, role: EDITOR \| VIEWER }` — existing users join instantly; unknown emails create a pending invitation |
| PATCH | `/spaces/:id/members/:userId` | OWNER | `{ role }` |
| DELETE | `/spaces/:id/members/:userId` | OWNER, EDITOR | revoke |
| GET | `/spaces/:id/activity` | member | audit trail |

## Folders

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/spaces/:id/folders` | member | Folder tree with `parentId` + `path` (`docs/reports/`) |
| POST | `/spaces/:id/folders` | OWNER, EDITOR | `{ name, parentId? }`; sibling names are unique; path is what preserves hierarchy in the archive ZIP |

## Files

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/spaces/:id/files` | member | Each row carries `folderId`; the archive path is the folder path + name |
| POST | `/spaces/:id/files/init-upload` | OWNER, EDITOR | `{ name, mimeType?, sizeBytes, folderId? }` → `{ fileId, url, expiresAt }` (signed PUT); enforces quotas |
| POST | `/spaces/:id/files/:fileId/confirm-upload` | OWNER, EDITOR | HEADs the object; 404 if never uploaded |
| POST | `/spaces/:id/files/:fileId/download` | member | → signed GET URL |
| PATCH | `/spaces/:id/files/:fileId` | OWNER, EDITOR | `{ name }` |
| DELETE | `/spaces/:id/files/:fileId` | OWNER, EDITOR | soft delete |

Writability is refused once a Space leaves `DRAFT`/`ACTIVE`/`WARNING`;
archived Spaces expose their content only through the Vault ZIP.

## Extensions

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| POST | `/spaces/:id/extensions` | member | `{ requestedDays, reason }`; one PENDING per Space; max `MAX_EXTENSION_DAYS` |
| GET | `/spaces/:id/extensions` | member | |
| GET | `/admin/extensions/pending` | ADMIN | |
| POST | `/admin/extensions/:id/decision` | ADMIN | `{ decision: APPROVED \| REJECTED }` |

## Smart Storage Insights (scan + duplicate detection)

All endpoints require auth; ownership/role checks run server-side.

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| POST | `/spaces/:id/scans` | OWNER | Streams every stored object through SHA-256, persists `files.sha256`, groups exact duplicates by content hash, computes extra copies + potential savings, flags large files and possible versions by filename. Persists `scan_jobs`, `duplicate_groups`, `duplicate_files`. |
| GET | `/spaces/:id/insights` | member | Latest stored report (never fabricated: `PENDING` before the first scan, `FAILED` with errors after an unreadable scan) |
| GET | `/spaces/:id/duplicates` | member | Duplicate + near-duplicate view for the latest VERIFIED scan |
| POST | `/spaces/:id/duplicates/:fileId/exclusion` | OWNER | Toggles the per-file exclusion flag (exclusion means "keep out of the ZIP", never deletion) |

## Archive plans (selective / full archives)

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| POST | `/spaces/:id/plans` | OWNER | `{ scanId?, excludedFileIds, explained }`. Empty exclusions ⇒ full archive of every active file, duplicates included. `explained` must be true before a plan can be confirmed. |
| GET | `/spaces/:id/plans` | member | Plan history |
| GET | `/plans/:planId` | OWNER | Plan + scan + archive job review payload |
| POST | `/plans/:planId/confirm` | OWNER | Builds the ZIP (real bytes, folder paths, unique entry names), stores it under `users/{owner}/vault/archives/{space}/…`, verifies size + SHA-256, persists the `archives` row, then marks the Space `ARCHIVED`. On failure the plan/job become `FAILED` and the Space + files are preserved. |
| POST | `/plans/:planId/cancel` | OWNER | Cancel a PENDING/CONFIRMED plan (no archive created) |
| POST | `/plans/:planId/retry` | ADMIN | Revive a FAILED plan and rerun it (idempotent by plan id) |

## Notifications & Vault

| Method | Path | Who |
| --- | --- | --- |
| GET | `/notifications` | authenticated |
| POST | `/notifications/:id/read` | owner of the notification |
| POST | `/notifications/read-all` | authenticated |
| GET | `/vault/archives` | authenticated (own archives) |
| POST | `/vault/archives/:id/download` | owner (or ADMIN) → signed URL |

## Admin

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/stats` | users, spaces by status, files, failed archives, pending extensions |
| GET | `/admin/users` · POST `/admin/users/:id/promote` | user management |
| GET | `/admin/jobs` | job history incl. errors |
| GET | `/admin/extensions` | all requests |
| POST | `/admin/archives/:id/retry` | re-run a FAILED archive |

## Jobs

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/jobs/lifecycle/run` | `x-job-secret` | `{ scanned, warned, queuedArchives, archived, finalized, failures }`. Entering the warning window sends exactly one reminder (`spaces.warning_sent_at` gate); an expired Space with no owner selection is archived in full: every active file, duplicates included. Repeated passes are idempotent. |

## Signed storage endpoints (local mode)

`PUT /storage-upload?token=…` and `GET /storage-download?token=…` validate an
HMAC token binding method + object key + expiry (+ filename), mirroring
provider signed URLs.
