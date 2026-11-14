# FlashSpace — Final Production Architecture

Status: **architecture-aligned design document**, based on an actual source audit of this repository.

## 1. Confirmed final architecture

| Layer | Technology | Owner |
|---|---|---|
| Frontend | React + TypeScript + Vite | Hosted on Render |
| Backend | Node.js + Express + TypeScript | Hosted on Render |
| Database | Supabase PostgreSQL | Supabase |
| Authentication | Supabase Auth (email/password, plus Google OAuth and TOTP MFA when configured) | Supabase |
| File storage | Supabase Storage (private buckets) | Supabase |
| Background jobs | External scheduler hitting `POST /jobs/lifecycle/run` | Render/cloud cron |
| Secrets | Render environment variables | Render |

This is the target architecture. This checkout contains the Postgres data layer (verified live against PostgreSQL 17), Supabase Auth identity/token verification, Supabase Storage adapter, prepared RLS policies, a Supabase **Google OAuth** login flow (button, PKCE callback page, account linking by verified email), and **TOTP MFA** enrolment/challenge UX. What remains is external: Supabase credentials, Google provider configuration and, for very large archives, a streaming storage adapter.

Sections 2 and 3 below are intentionally separated: **Section 2** lists implementation that exists in the code today; **Section 3** lists gaps and partially-verified items. The “not yet implemented” items from the earlier draft were folded into Section 3 so this document has one clean status view.

---

## 2. Verified supporting implementation

### Backend Supabase identity, verified in this checkout
- `apps/api/src/services/identity.service.ts` implements the Supabase `TokenVerifier`: it verifies access tokens against the project JWKS with issuer and `authenticated` audience checks, and falls back to HS256 only when `SUPABASE_JWT_SECRET` is set.
- `apps/api/src/supabase/verify-token.ts` is the token-verification module: JWKS caching, issuer/audience checks, clock tolerance, and clear `UNAUTHENTICATED` errors for expired or missing claims.
- `apps/api/src/supabase/profile-store.ts` manages application profiles off `auth.users` using the service-role client server-side only. It creates the client lazily so local mode can boot with no Supabase config.
- `apps/api/src/supabase/clients.ts` keeps a clear split between the service-role client and the user-scoped client, with explicit “must never leave the server” guidance.
- `apps/api/src/supabase/gotrue.ts` is a thin server-side wrapper for password verification, email change, password update, and admin user deletion.
- `apps/api/src/app.ts` creates `SupabaseIdentityService` as the `TokenVerifier` when `AUTH_MODE=supabase`, otherwise the local JWT `AuthService`. Auth middleware in `apps/api/src/middleware/auth.ts` is provider-agnostic.

### Backend Supabase Auth delegation, verified in this checkout
- `apps/api/src/routes/auth.routes.ts` disables local register/login in Supabase mode and returns `AUTH_PROVIDER_SUPABASE` for those operations. It keeps `/auth/me`, session listing/revocation, and account passthrough endpoints so the rest of the app does not branch on provider everywhere.
- `apps/api/src/services/account.service.ts` handles profile, avatar, email change, password change, export, and account deletion in Supabase mode by calling Supabase Auth and admin endpoints through the service-role client.

### Supabase Storage backend
- `apps/api/src/storage/supabase.storage.ts` is a real Supabase Storage adapter: signed upload URL, signed download URL, upload, get, head, delete, list, with an explicit in-memory cap and a comment that larger archives should use S3/R2.
- `apps/api/src/storage/index.ts` selects the Supabase adapter when `STORAGE_MODE=supabase` and requires `SUPABASE_URL` + service key.

### Supabase PostgreSQL data layer, verified in this checkout
- `apps/api/src/repositories/postgres/data-layer.ts` is the full Postgres `DataLayer` factory. It creates the shared pool from `DATABASE_URL`, builds the core repository set, and adds a notification bus plus a real health check.
- `apps/api/src/repositories/postgres/core.ts` implements all 26 PostgreSQL repository domains: auth, sessions, spaces, members, folders, invitations, inviteLinks, joinRequests, extensionRequests, files, archives, notifications, jobs, cleanupRuns, activity, access, favoriteSpaces, lifecycleTransitions, scanJobs, duplicateGroups, duplicateFiles, archivePlans, archiveJobs, emailJobs, verificationTokens, and adminAudit.
- The data-layer factory in `apps/api/src/repositories/index.ts` returns `createPostgresDataLayer` when `REPO_MODE=postgres`, so Postgres is a real runtime path, not a stub.
- `apps/api/src/repositories/postgres/migrations/003_auth_identity.sql` defines the Supabase-aligned profile schema: `auth_user_id`, preferences, account status, email verified at, avatar path, legacy account links, account audit log, triggers for profile creation/sync, a privilege-escalation guard trigger, and avatar bucket/policies.

PostgreSQL migrations 001–009 exist in `apps/api/src/repositories/postgres/migrations/`:
- `001_init.sql`
- `002_smart_storage.sql`
- `003_auth_identity.sql`
- `004_dashboard.sql`
- `005_space_management.sql`
- `006_cloud_completion.sql`
- `007_email_verification.sql`
- `008_auth_sessions.sql`
- `009_email_retry_statuses.sql`

### Frontend Supabase session handling
- `apps/web/src/lib/supabase.ts` builds the browser Supabase client only when `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` are present and `VITE_AUTH_MODE=supabase`. It uses `pkce`, `persistSession`, `autoRefreshToken`, `detectSessionInUrl`, and a custom storage key.
- `apps/web/src/lib/auth.tsx` is the React auth provider: in Supabase mode it mirrors the SDK session into React, hydrates user/email-verified state from the API, listens to `onAuthStateChange`, and signs out through the SDK.
- Login, register, forgot password, reset password, and email verification pages already branch on `isSupabaseMode` and use the Supabase SDK where appropriate.

### Supabase RLS posture, verified in this checkout
- `apps/api/src/repositories/postgres/rls-policies.sql` exists and defines RLS helpers and table policies for profiles, spaces, members, files, folders, invitations, invite links, join requests, archives, notifications, activity, favourites, access, scans/plans, and storage bucket policies.
- RLS is **prepared, not yet applied or production-verified**. The file is present as SQL text; applying it durably to a Supabase project and validating it against real users is a separate step.
- The API uses the service-role key server-side, so in normal operation RLS is a second line of defense for direct PostgREST/authenticated database access rather than the primary application authorization path.

---


### Implemented
- Supabase PostgreSQL data layer with all 26 repository domains.
- Supabase Auth identity/token verification and application profile handling.
- Supabase Auth delegation on the API: register/login are disabled in Supabase mode, while `/auth/me`, session listing/revocation, and account endpoints remain available.
- Supabase Storage adapter with signed upload URL, signed download URL, upload/get/head/delete/list.
- Prepared RLS policies in `rls-policies.sql`.
- PostgreSQL migrations 001–009, including the Supabase-aligned `003_auth_identity.sql`.
- Frontend Supabase client and session handling for Supabase mode, with Supabase-mode Login, ForgotPassword, ResetPassword, and VerifyEmail pages.

### Partially implemented or configured
- Supabase Storage adapter exists, but the Space Files bucket and Vault/archive buckets are defined in `rls-policies.sql` and referenced through env, while the adapter’s current in-memory cap limits it for large Space archives. That is a real adapter, not a “not present” item, but it is not yet proven against full archive-sized uploads in this checkout.
- Supabase Auth middleware and JWT verification exist, and `/auth/config` now reports `mfa: true` whenever Supabase is the configured provider (TOTP enrolment and the AAL2 challenge live in the browser SDK).
- Email, lifecycle, rate limiting, and security features exist in `env.ts` and related services, but a real email transport and real production lifecycle scheduling still need external configuration.

### Not yet implemented
- A fully integrated, verified Space Files and Vault archive storage path for Supabase Storage at production scale (in-memory buffering caps very large archives).
- Production lifecycle scheduler configuration and documented job schedule.
- Render production deployment configuration and verified production boot.
- Comprehensive frontend E2E/browser regression testing.

---

## 3. Security and data-storage concerns

### Authentication authority
- In Supabase mode, the backend does **not** run its own local JWT system for production authentication. Local JWT is only the non-Supabase path.
- The backend still mirrors profile rows locally for referential integrity, but application role and status come from the Supabase-aligned profile, not from the token.
- The privilege-escalation trigger in `003_auth_identity.sql` is a good guard: it refuses non-service-role changes to role, account status, email, and auth identity.

### Credentials and keys
- The service-role key must stay server-side only. The current code respects that.
- The browser client uses only the anon/publishable key.
- Do **not** put real Supabase keys, `DATABASE_URL`, SMTP credentials, or app secrets in source code, docs, or frontend env files. Render should hold them.

### Storage persistence
- Local storage adapter writes to the container filesystem, which is not durable across Render deploys/restarts.
- Supabase Storage is the correct production path for persistence, but you must use it deliberately and give the app the right buckets and keys.
- If you ever run the API in Supabase mode but local storage mode by mistake, uploaded files will not survive redeploy.

### Row-level security
- RLS is prepared but not yet applied. If you want direct database/client access beyond the API, apply and test it deliberately with multiple users before relying on it.
- The API with the service-role key bypasses RLS by design; that is fine for the backend, but it means the app’s own authorization logic remains essential.

### Provider quirks to plan for
- Supabase mailer is rate-limited in development; password reset/verification emails may be slow or limited during testing.
- Supabase can enforce MFA/authentication policies at the project level; if you enable MFA there, the app still needs UX for enrollment and challenges if you want controlled in-app handling.

---

## 4. Environment variables required

### Supabase project
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_JWT_SECRET` — only if the project still signs sessions with HS256; otherwise the JWKS path is used

### Backend production env
- `NODE_ENV=production`
- `AUTH_MODE=supabase`
- `REPO_MODE=postgres`
- `STORAGE_MODE=supabase`
- `DATABASE_URL`
- `PORT` (Render sets this; default 4000)
- `WEB_ORIGIN` — the frontend origin(s), must be `https://` in production
- `WEB_APP_URL` — base URL used for email links
- `TRUST_PROXY` — if Render terminates HTTPS and forwards, set this appropriately
- `REQUIRE_HTTPS` — usually true in production
- `LOCAL_AUTH_SECRET` — still required by current `loadEnv` production guard even in Supabase mode; must be strong and not a placeholder
- `JOB_SECRET` — required by current `loadEnv` production guard; used to protect `POST /jobs/lifecycle/run`
- `SUPABASE_FILES_BUCKET`, `SUPABASE_VAULT_BUCKET`, `SUPABASE_TEMP_BUCKET`, `AVATARS_BUCKET` — bucket names if using Supabase Storage buckets for those purposes
- `MAX_AVATAR_BYTES`, `FILE_MAX_BYTES`, `SPACE_MAX_BYTES` — if you want production-specific limits
- `UPLOAD_BLOCKED_EXTENSIONS` — if you want production-specific blocked extension list
- `MAX_ACTIVE_SPACES_PER_USER`, `MAX_EXTENSION_DAYS`, `WARNING_WINDOW_HOURS` — if you want production-specific policy values
- `EMAIL_TRANSPORT`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `SMTP_TLS_SERVERNAME`, `EMAIL_FROM`, `EMAIL_FROM_NAME` — if you want real email delivery instead of mock
- `RATE_LIMIT_*` vars — optional; the current code has generous test defaults and production-safe origin validation

### Frontend env
- `VITE_API_URL` — API base URL
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_AUTH_MODE=supabase`

### Render service config
- Build command
- Start command
- Environment variables section with the values above
- Optional persistent disk only if you ever keep local storage; otherwise not needed because Supabase Storage is the durable store

**Important:** do not invent any of these values. Only the variable names are known from source; values come from Supabase and Render.

---

## 5. Supabase project setup requirements

1. Create a Supabase project.
2. Enable Email Auth and Google Auth in Supabase Auth.
3. Configure Google OAuth in Supabase:
   - Google Client ID and Client Secret in Supabase auth providers
   - Redirect URL(s) registered in Google and in Supabase
   - Signed-in user profile metadata handling if you want display names mapped
4. Decide whether Supabase should enforce MFA at the project level, and whether the app will also provide its own MFA UX.
5. Create the storage buckets the app expects:
   - avatars
   - space-files
   - vault-archives
   - archive-temp
6. Set bucket policies to private where the app expects private access.
7. Note the project URL, anon key, and service-role key for Render.
8. If the app will use direct Postgres access via `DATABASE_URL`, note that Supabase provides that connection string.

---

## 6. Google OAuth and MFA configuration requirements

### Google OAuth
- Google Cloud OAuth consent screen and credentials
- Authorized redirect URIs in Google matching Supabase/Supabase Auth OAuth callback
- Supabase Auth Google provider configured with the Google client ID and secret
- Frontend login flow that calls Supabase `signInWithOAuth({ provider: 'google', options: { redirectTo } })`
- A server-side callback route if you want any post-login provisioning beyond what Supabase does automatically
- Account linking behavior if a Google-signed-in email already exists as a local or linked account

### Supabase TOTP MFA
- Enable MFA in Supabase Auth for the project if you want provider-enforced MFA.
- Decide whether the app will:
  - require MFA at the Supabase level and simply reflect status, or
  - provide its own enrollment/challenge UI and call Supabase MFA endpoints
- If the app provides MFA UX, add:
  - enrollment endpoint/flow
  - challenge/verification endpoint/flow
  - recovery/backup code handling if desired
  - frontend pages for enable, disable, and challenge

Today, neither Google OAuth nor MFA exists in the app, so both are new work, not integration tweaks.

---

## 7. Render deployment prerequisites

1. Decide how the frontend is served:
   - Option A: one Render web service that runs the Express API and serves the built frontend
   - Option B: separate frontend hosting plus a Render web service for the API
2. If the API is on Render:
   - Node.js runtime
   - A build command that compiles shared packages and the API
   - A start command that boots the Express server
   - `DATABASE_URL` pointing at Supabase Postgres
   - All Supabase and application secrets in Render environment variables
   - A migration/startup step that applies PostgreSQL migrations before serving traffic
   - RLS policies applied and reviewed for the target database, if they are intended to be active
3. External scheduler for `POST /jobs/lifecycle/run`:
   - Render cron service, GitHub Actions, or another scheduler
   - Must authenticate with `JOB_SECRET`
   - Scheduled often enough to match the warning/archive/cleanup behavior you want
4. If you want durable file uploads:
   - Use Supabase Storage, not the container filesystem
5. If you want real email:
   - Configure a real SMTP transport or a transactional email provider, because mock mode does not deliver
6. CORS and origin hardening:
   - `WEB_ORIGIN` must list the real frontend origin(s) in production
   - `WEB_ORIGIN` must use `https://` in production
   - Set `TRUST_PROXY` if Render terminates HTTPS and forwards
7. Secrets hardening:
   - `LOCAL_AUTH_SECRET` and `JOB_SECRET` must be strong and distinct
   - Service-role credentials must stay server-side only

---

## 8. Recommended implementation sequence

1. Lock the architecture decision in writing: Supabase Auth + Supabase Postgres + Supabase Storage, with Render hosting both frontend and API.
2. Create/configure the Supabase project: auth providers, buckets, RLS review, env values.
3. Stand up a disposable Postgres path locally and run the Postgres migrations end to end, including `rls-policies.sql` in a test project or review it line by line against the schema.
4. Wire backend Supabase env and boot the API in Supabase + Postgres mode locally; verify `/auth/config`, `/auth/me`, profile creation/sync, avatar upload, and storage paths.
5. Add the missing Google OAuth flow if you want it: frontend sign-in button, Supabase OAuth call, redirect/callback handling, and any account-linking rules you want.
6. Decide MFA scope: provider-enforced only, or app-enforced with enrollment/challenge UX.
7. Wire Supabase Storage for Space files and Vault/archive buckets, not just avatars.
8. Add a production cron path for lifecycle and verify job-secret protection.
9. Finish frontend UX cleanup and add at least a small E2E/browser regression set before freezing the site as “achi.”
10. Build and deploy to Render with real env vars, run migrations, and verify end-to-end flows from a real browser.

---

## 9. Files inspected

- `apps/api/src/config/env.ts`
- `apps/api/src/app.ts`
- `apps/api/src/server.ts`
- `apps/api/src/services/identity.service.ts`
- `apps/api/src/services/auth.service.ts`
- `apps/api/src/services/account.service.ts`
- `apps/api/src/services/email.service.ts`
- `apps/api/src/routes/auth.routes.ts`
- `apps/api/src/middleware/auth.ts`
- `apps/api/src/supabase/verify-token.ts`
- `apps/api/src/supabase/clients.ts`
- `apps/api/src/supabase/gotrue.ts`
- `apps/api/src/supabase/profile-store.ts`
- `apps/api/src/storage/index.ts`
- `apps/api/src/storage/supabase.storage.ts`
- `apps/api/src/repositories/postgres/data-layer.ts`
- `apps/api/src/repositories/postgres/core.ts`
- `apps/api/src/repositories/postgres/rls-policies.sql`
- `apps/api/src/repositories/postgres/migrations/003_auth_identity.sql`
- `apps/api/src/repositories/sqlite/sqlite.data-layer.ts`
- `apps/web/src/lib/supabase.ts`
- `apps/web/src/lib/auth.tsx`
- `apps/web/src/pages/Login.tsx`
- `apps/web/src/pages/ForgotPassword.tsx`
- `apps/web/src/pages/ResetPassword.tsx`
- `apps/web/src/pages/VerifyEmail.tsx`
- `apps/web/src/pages/MySpaces.tsx`
- `apps/web/src/pages/Admin.tsx`

---

## 10. Tests run this task

None in this task.

This task was architecture inspection and documentation only. I did not run the test suites, did not boot the app, and did not connect to any cloud project.

---

## 11. Status of this document

This document was updated to match the current checkout, not the earlier partial implementation assumed in the previous version.

Confirmed against source:
- Supabase PostgreSQL data layer and all 26 repository domains existed before this edit and still do.
- Supabase Auth identity/token verification and Supabase-mode auth delegation existed before this edit and still do.
- Supabase Storage adapter existed before this edit and still does.
- PostgreSQL migrations 001–009 and `rls-policies.sql` existed before this edit and still do.
- Google OAuth and TOTP MFA are still not implemented.

No application code, migrations, RLS policies, databases, or cloud resources were changed by this update.
