# 5-minute demo script

## Setup (once)

```bash
npm install
npm run build --workspace @flashspace/shared
npm run dev            # two processes: API :4000, web :5173
```

## 1. First run & admin bootstrap (1 min)

Open http://localhost:5173 → **Sign in → Create account**
`admin@demo.dev / demopassword`. Fresh installs make the first account an
admin — the Admin nav item appears.

## 2. Seed the demo (30s)

```bash
npm run seed:demo
```

Creates Olive (owner), Eli (editor), Vera (viewer), the active
"Q3 Marketing Site" with two files, and "Retro Sprint 12" which **expired
yesterday**.

## 3. The happy Space (1 min)

Sign in as `owner@demo.dev / demopassword`. Dashboard shows both Spaces.
Open **Q3 Marketing Site**:

- Files tab: download, rename — everything works while it's alive.
- Members tab: change Vera to EDITOR and back; invite someone new.
- Extensions tab: request 3 extra days (goes to PENDING).
- Watch the **days-to-expiry** counter — this is the product's whole point.

## 4. The lifecycle moment (1 min)

```bash
curl -X POST http://localhost:4000/jobs/lifecycle/run \
     -H "x-job-secret: dev-only-job-secret"
```

Response shows `queuedArchives ≥ 1, archived ≥ 1`. Now:

- **Vault** tab (as Olive): "Retro Sprint 12" archive — VERIFIED, file count,
  SHA-256. Download the ZIP; it contains `retro-notes.md`.
- **Notifications** (as Olive): `SPACE_ARCHIVED` arrived.
- The archived Space is now read-only; uploading is refused.

## 5. Governance in action (1 min)

Sign in as `admin@demo.dev`:

- **Admin → Extensions**: approve Olive's request — her Space's expiry moves
  out and returns to ACTIVE.
- **Admin → Jobs**: the ARCHIVE job is SUCCEEDED with its idempotency key.
- Re-run the curl from step 4: `archived: 0` — the day-keyed job makes cron
  runs idempotent.

## 6. Failure path (optional, 30s)

Delete a file's object from `apps/api/data/local-storage/spaces/…`, mark its
Space expired, run the lifecycle pass → the archive FAILS, the Space shows
`ARCHIVE_FAILED`, Olive gets a failure notification, and
**Admin → retry** re-runs it once the object is restored.

## What to say while it runs

> "Every Space carries its own clock. The platform — not the users — enforces
> the end: verified archive into the owner's Vault, then teardown. Extensions
> are deliberate decisions, not forgotten checkboxes."
