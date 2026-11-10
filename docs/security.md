# Security

## Authentication

- **Local mode**: HS256 JWTs signed with `LOCAL_AUTH_SECRET`, 7-day expiry,
  verified on every request by `requireAuth`. Passwords hashed with scrypt
  (per-user salt, constant-time comparison). Login failures return a generic
  `INVALID_CREDENTIALS` (no user enumeration).
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

## Known trade-offs (PRD-scoped)

- Single-process memory mode is for dev/demo only; postgres mode provides
  durability for production.
- The lifecycle secret is a shared static token — swap for mTLS/OIDC in a
  multi-tenant deployment.
- No rate limiting yet; the quota system is the first backstop.
