# Lifecycle

## State machine

| From | Trigger | To | Side effects |
| --- | --- | --- | --- |
| DRAFT | `startAt` reached | ACTIVE | — |
| ACTIVE / DRAFT | `expiry − warningWindow ≤ now < expiry` | WARNING | notify owner + members (`SPACE_WARNING`) |
| ACTIVE / WARNING | `expiry ≤ now` | (queue ARCHIVE job) | idempotency key `archive:{spaceId}:{YYYY-MM-DD}` |
| — | ARCHIVE job runs | ARCHIVING → ARCHIVED | ZIP + manifest stored & verified; `SPACE_ARCHIVED` notification |
| — | ARCHIVE job fails | ARCHIVE_FAILED | `ARCHIVE_FAILED` notification; admin retry endpoint available |
| ARCHIVED | `verifiedAt + 7d ≤ now` | DELETED | memberships revoked, objects deleted, rows soft-deleted, `SPACE_DELETED` notification |

Spaces become `ACTIVE` immediately at creation when `startAt ≤ now`, otherwise
`DRAFT` until the start date.

## Jobs & idempotency

`POST /jobs/lifecycle/run` (header `x-job-secret: $JOB_SECRET`) performs one
full pass over every non-deleted Space:

1. Warn upcoming expiries (never double-notifies; status flip is the guard).
2. Queue an ARCHIVE job per expired Space — keyed by day, so repeated cron
   invocations within the same day are no-ops.
3. Run pending archive jobs to completion within the same pass (queue →
   archive → verify converge in one cron tick).
4. For `ARCHIVED` Spaces past the retention window, run cleanup (again keyed
   by day; partial failures are recorded on the job row).

The job secret also protects the endpoint from unauthorized triggers. Dev
convenience: the API self-triggers a pass every 5 minutes; production schedules
`.github/workflows/lifecycle-cron.yml` every 30 minutes.

## Extensions

- Members request 1…`MAX_EXTENSION_DAYS` days (default 14) with a reason.
- One `PENDING` request per Space at a time.
- Policy `ADMIN` (default): decision endpoint is admin-only; approval shifts
  `expiryAt` and returns the Space to `ACTIVE`.
- Policy `AUTO`: approval is instant on request (still capped by the max).
- Requests are impossible once archiving has started.

## Retention & cleanup

Cleanup refuses to run without a `VERIFIED` archive (data-loss guard). It
revokes all memberships, hard-deletes every object under `spaces/{id}/`, and
soft-deletes file rows — the Vault archive (`users/{owner}/vault/archives/…`)
is deliberately outside that prefix and survives.
