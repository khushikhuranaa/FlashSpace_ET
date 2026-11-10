# ⚡ FlashSpace

**Ephemeral, purpose-based cloud workspaces with lifecycle-aware storage.**
Every Space has a *purpose* and an *expiry*. When a project ends, FlashSpace
archives everything into the owner's **Vault** (verified ZIP + manifest), then
finalizes the Space: memberships are revoked and temporary storage is wiped.
No zombie docs, no forgotten drives.

> Built from the FlashSpace PRD. Monorepo: `apps/api` (Express + TypeScript),
> `apps/web` (React + Vite + Tailwind), `packages/shared` (domain contract).

---

## Quick start (zero external services)

```bash
npm install
npm run build --workspace @flashspace/shared
npm run dev          # API on :4000, web on :5173 (proxies /api)
```

Open **http://localhost:5173**. The first account you register becomes an
**admin** (bootstrap rule). Everything runs on in-memory repositories and a
local filesystem storage adapter — no database or object storage required.

### Scripted demo

```bash
npm run seed:demo                       # seeds users/spaces/files on :4000
curl -X POST http://localhost:4000/jobs/lifecycle/run \
     -H "x-job-secret: dev-only-job-secret"
```

The expired demo Space ("Retro Sprint 12") archives; check the owner's
**Vault** tab and the admin console's job history.

## The lifecycle (PRD §8)

```
DRAFT ──start──▶ ACTIVE ──expiry−24h──▶ WARNING ──expiry──▶ ARCHIVING
                                                         │ (ZIP + manifest + verify)
                                                   ARCHIVED ──7d──▶ DELETED (cleanup)
                                                       ↘ failure: ARCHIVE_FAILED (admin retry)
```

- **Warning** — owner and members are notified before expiry.
- **Extension requests** — members request extra days; admins approve/reject
  (policy `EXTENSION_POLICY=ADMIN`; `AUTO` grants up to the max automatically).
- **Archiving** — a streaming ZIP writer (store method, streaming data
  descriptors) packages every file; the archive is verified by size + SHA-256
  checksum + file count before status flips.
- **Cleanup** — 7 days after verification: memberships revoked, Space objects
  hard-deleted, rows soft-deleted for audit; the Vault archive is retained.
- **Idempotency** — every job is keyed `(type, space, day)`, so cron runs are
  safe to repeat. Driven by `POST /jobs/lifecycle/run` (`x-job-secret`) —
  in dev the API also self-triggers every 5 minutes; in prod a GitHub Actions
  cron (`.github/workflows/lifecycle-cron.yml`) does it.

## Security model (PRD §13)

- Bearer-token auth (HS256, local mode) with scrypt password hashing.
- RBAC: `OWNER > EDITOR > VIEWER` per Space; platform `ADMIN` for the console.
- Short-lived **signed URLs** for all object traffic — the API never proxies
  bytes, and browsers never hold credentials. Local mode implements provider-
  style signed URLs via HMAC tokens served by `/storage-upload` and
  `/storage-download`.
- Structured error envelope `{ error: { code, message, requestId } }`; internals
  never leak (details go to server logs only).
- Quotas: per-file 50 MB, per-Space 250 MB, 20 active Spaces per user, max 14
  extension days (all configurable via env).

## Swapping the backing services

| Concern | Default (zero-config) | PRD cloud mode |
| --- | --- | --- |
| Auth | `AUTH_MODE=local` (JWT + scrypt) | `AUTH_MODE=supabase` (Supabase Auth) |
| Database | `REPO_MODE=memory` | `REPO_MODE=postgres` (`DATABASE_URL`, `docker compose up db`, `npm run db:migrate`) |
| Objects | `STORAGE_MODE=local` | `STORAGE_MODE=supabase` (Supabase Storage, service key server-side only) |

Copy `.env.example` → `.env` and fill in the pieces you enable. All storage and
persistence code sits behind interfaces (`StorageAdapter`, data layer), so the
domain logic does not change.

## Testing & CI

```bash
npm test             # 27 integration tests through the real Express app
npm run typecheck    # all workspaces
```

The suite covers auth, RBAC (invitation → role change → revocation), the full
signed-upload → confirm → download → delete flow, quota enforcement, the whole
lifecycle (warning → archive → verified ZIP bytes → cleanup retention), archive
failure + admin retry, extension policy, notifications, and the error envelope.

## Docs

- [`docs/architecture.md`](docs/architecture.md) — components, data flow, swap-in adapters
- [`docs/lifecycle.md`](docs/lifecycle.md) — state machine, jobs, idempotency
- [`docs/api.md`](docs/api.md) — endpoint reference with examples
- [`docs/security.md`](docs/security.md) — authn/z, signed URLs, threat model
- [`docs/demo-script.md`](docs/demo-script.md) — 5-minute demo walkthrough

Generated with Codebuff 🤖
