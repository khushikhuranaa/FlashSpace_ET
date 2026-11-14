# Security

## Authentication

- **Local mode**: HS256 access tokens signed with `LOCAL_AUTH_SECRET`, 15-minute
  expiry, verified on every request by `requireAuth` and bound to a server-side
  session id. The rotating 30-day refresh token is stored only as a SHA-256 hash.
  Reusing a rotated refresh token revokes every session for the account.
  Passwords are hashed with scrypt (per-user salt, constant-time comparison).
  Login failures return a generic `INVALID_CREDENTIALS` (no user enumeration).
- Password changes and completed password resets revoke every existing session.
  Email-verification and password-reset links are hashed, time-boxed, single-use,
  and a new request supersedes the previous link.
- Credential endpoints are rate limited both per IP+email and per email, so
  rotating source IPs does not reset the account budget.
- **Supabase mode**: tokens issued by Supabase Auth; the API verifies them
  server-side before authorization.

## Authorization (RBAC)

Two orthogonal roles:

- **Platform role** (`USER` / `ADMIN`) gates the admin console, extension
  decisions, user promotion, and archive retries.
- **Space role** (`OWNER` > `EDITOR` > `VIEWER`) gates everything per Space:
  VIEWER reads/downloads, EDITOR writes files and invites, OWNER manages
  members and deletion. All checks funnel through
  `SpacesService.requireRole`, so no route can forget them.

Membership revocation is immediate — revoked users fail `requireRole` on the
next request — and cleanup revokes every membership in one sweep.

## Object storage

- The API issues **short-lived signed URLs** (uploads 15 min, downloads 5 min)
  instead of proxying bytes; the browser never sees storage credentials.
- The service-role key (Supabase mode) exists only inside the API process.
- Local mode reproduces the guarantee with HMAC-signed tokens binding
  `{method, key, exp, filename}`; the storage endpoints accept nothing else
  and cannot list or address any key outside the token.
- Object keys are built server-side (UUIDs + sanitized names); the local
  adapter additionally strips traversal segments as defense-in-depth.

## Lifecycle as data hygiene

Expiry is enforced by the platform, not by user diligence: expired Spaces
archive automatically, cleanup revokes access and deletes temporary objects,
and everything left is the owner's verified Vault archive. Extension days are
capped and auditable.

## Error handling & quotas

- One error envelope `{ error: { code, message, requestId } }`; unknown errors
  log server-side and return a generic `INTERNAL` — no stack traces or driver
  errors reach clients.
- Quotas bound abuse: per-file and per-Space byte caps, active-Space cap, and
  extension-day cap, all env-configurable.

## Supabase Auth migration boundary

Supabase Auth is the intended single authority for Google OAuth and native
TOTP MFA. It is **not connected or implemented in this phase**. The local
provider remains the only working login path.

Before switching `AUTH_MODE=supabase`, these assumptions must be resolved:

- Disable or delegate the local `/auth/refresh`, `/auth/logout`,
  `/auth/logout-all` and `/auth/sessions` lifecycle routes. They operate on the
  local `auth_sessions` table and must not become a second session system.
- Let the Supabase SDK own refresh rotation, logout and session listing.
- Keep the API's provider-agnostic `requireAuth` path, but resolve profile roles
  and account status from Postgres, never from token claims.
- Do not migrate local password hashes or refresh tokens into Supabase. Users
  either sign in through Supabase or use the documented legacy-link flow.
- Configure Google and TOTP in Supabase; do not add a local OAuth or TOTP
  implementation.

## Known trade-offs (PRD-scoped)

- Single-process memory mode is for dev/demo only; postgres mode provides
  durability for production.
- The lifecycle secret is a shared static token — swap for mTLS/OIDC in a
  multi-tenant deployment.
- Rate-limit counters are in-process. A multi-instance deployment needs a shared
  `RateLimitStore`; each instance otherwise enforces its own budget.
- The local refresh token is persisted in browser `localStorage`, so an XSS
  compromise could read it. Access tokens stay in memory. Supabase mode uses the
  SDK's own storage instead.
- Local JWTs are scoped by signature and server-side session id, not by an
  issuer/audience pair; Supabase-mode tokens are checked against the project
  issuer and `authenticated` audience.
