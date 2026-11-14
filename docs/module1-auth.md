# Module 1 — Authentication & User Account Management

Status: **implemented against Supabase, pending live verification.** Everything
that can be proven without a Supabase project is covered by automated tests
(57 passing). Features that only a real project can prove are marked
`BLOCKED BY EXTERNAL CONFIGURATION` in the report and in this file — nothing is
claimed as verified that has not run against real infrastructure.

---

## 1. Configuration required (exact variables per file)

### `apps/api/.env`

| Variable | Purpose |
|---|---|
| `AUTH_MODE=supabase` | Switches the API from the local dev adapter to Supabase token verification |
| `SUPABASE_URL` | Project URL — used to derive the JWKS endpoint and issuer |
| `SUPABASE_ANON_KEY` | User-scoped Supabase calls (GoTrue `/auth/v1/user`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server only.** Profile administration, Storage, Auth admin API |
| `SUPABASE_JWT_SECRET` | Only for projects still on legacy HS256 signing; leave empty for asymmetric keys |
| `DATABASE_URL` | Session-pooler URI used by `npm run db:migrate` |
| `AVATARS_BUCKET` | Storage bucket name (default `avatars`) |
| `MAX_AVATAR_BYTES` | Server-side avatar cap (default 2 MB) |

### `apps/web/.env`

| Variable | Purpose |
|---|---|
| `VITE_AUTH_MODE=supabase` | Turns on the Supabase browser client and Supabase auth screens |
| `VITE_SUPABASE_URL` | Project URL (public) |
| `VITE_SUPABASE_ANON_KEY` | Publishable key (public, RLS-enforced) |
| `VITE_API_URL` | Empty for the dev proxy, or the API origin in production |

**Never** put `SUPABASE_SERVICE_ROLE_KEY` (or any secret) in a `VITE_*` variable:
Vite inlines those into the browser bundle.

The full template lives in [`.env.example`](../.env.example).

---

## 2. Supabase dashboard checklist

1. **Project**: create one; copy URL, anon key, service-role key, DB password.
2. **Authentication → Providers → Email**: enable. Decide whether "Confirm
   email" is on. With it on, registration returns no session until the address
   is confirmed — the UI handles both cases.
3. **Authentication → URL Configuration**:
   - Site URL: `http://localhost:5173`
   - Redirect URLs: `http://localhost:5173/**`, plus your production origin.
4. **Authentication → Email Templates**: paste the four files from
   [`supabase/email-templates/`](../supabase/email-templates) (mapping table in
   [`supabase/README.md`](../supabase/README.md)).
5. **Storage**: bucket `avatars`, **private** (the migration creates it with the
   right limits and policies).
6. **Migrations**: `npm run db:migrate -w @flashspace/api` with `DATABASE_URL`
   set. Applies `003_auth_identity.sql`.

### Email delivery

The built-in Supabase mailer is development-grade: a few messages per hour and
unreliable delivery to arbitrary addresses. The UI says so instead of pretending
an email arrived. For production, add **Resend** (or any SMTP) under
Authentication → SMTP Settings; no application code changes — the templates and
flows stay identical, only the transport differs.

---

## 3. What was built

### Backend (`apps/api`)

| File | Responsibility |
|---|---|
| `src/supabase/verify-token.ts` | Verify Supabase access tokens: remote JWKS (ES256/RS256/EdDSA) + issuer + `authenticated` audience; explicit legacy HS256 path; expired/forged → 401 |
| `src/supabase/clients.ts` | Service-role client (server only) and user-scoped client |
| `src/supabase/profile-store.ts` | `profiles` CRUD, preferences, audit log, legacy links; lazy client so local mode boots without keys |
| `src/supabase/gotrue.ts` | Real Supabase Auth calls: password re-auth, email-change request, password update, account deletion |
| `src/services/identity.service.ts` | Token → profile → `AuthUser`; mirrors identity into the local data layer; blocks duplicate profiles |
| `src/services/account.service.ts` | Profile/avatar/email/password/export/deletion/legacy-link |
| `src/routes/account.routes.ts` | `/users/me` endpoints (no id ever accepted from the client) |
| `src/routes/auth.routes.ts` | `/auth/config`; disables local register/login in Supabase mode |
| `src/middleware/auth.ts` | `requireAuth(identity)` — provider-agnostic |
| `src/utils/password-policy.ts` | Shared policy (length, letter+digit, not the email, ≤72) |
| `src/repositories/postgres/migrations/003_auth_identity.sql` | Profiles upgrade, triggers, audit, legacy links, RLS, avatar policies |

### Frontend (`apps/web`)

| File | Responsibility |
|---|---|
| `src/lib/supabase.ts` | Browser client (PKCE, auto-refresh, session persistence, remember-me storage) |
| `src/lib/auth.tsx` | Auth context: session restore, auth-state listener, token provider for the API |
| `src/lib/password.ts` | Strength meter + email validation |
| `src/components/PasswordField.tsx` | Show/hide + strength, accessible |
| `src/pages/Register.tsx`, `Login.tsx`, `ForgotPassword.tsx`, `ResetPassword.tsx`, `VerifyEmail.tsx` | Auth flows |
| `src/pages/Settings.tsx` | Profile, avatar, preferences, password, email, legacy link, export, deletion |
| `src/App.tsx` | Public auth routes, protected app routes, provider wiring |

---

## 4. Session architecture

- Supabase SDK owns the session (`persistSession`, `autoRefreshToken`,
  `detectSessionInUrl`, PKCE). No hand-rolled token storage.
- "Keep me signed in" chooses localStorage vs sessionStorage for the SDK's own
  record; the format and rotation remain Supabase's.
- `api.ts` resolves the bearer token asynchronously from
  `supabase.auth.getSession()` per request, so a refreshed token is always used.
- The API re-resolves the user from the verified token on every request; the
  application role is read from Postgres, **never** from the token.
- Logout calls `supabase.auth.signOut()` (revokes the refresh token) and clears
  local state.

**Provider limitation:** deleting an account (admin API) revokes all refresh
tokens. Already-issued access tokens remain valid until they expire (Supabase
default: 1 hour) — the API cannot revoke a JWT early without a denylist. Local
JWT mode has the same limitation.

---

## 5. Roles

Global: `USER`, `ADMIN` (`profiles.role`, protected from self-change by a
trigger and by RLS).
Space-level: `OWNER`, `EDITOR`, `VIEWER` (`members` table, unchanged).

| Permission | USER | ADMIN | OWNER | EDITOR | VIEWER |
|---|---|---|---|---|---|
| Own account | ✅ | ✅ | ✅ | ✅ | ✅ |
| Admin panel | ❌ | ✅ | ❌ | ❌ | ❌ |
| Create Space | ✅ | ✅ | — | — | — |
| Manage Space settings | ❌ | policy | ✅ | ❌ | ❌ |
| Invite members | ❌ | policy | ✅ | ✅ | ❌ |
| Upload / edit files | ❌ | policy | ✅ | ✅ | ❌ |
| View permitted files | ❌ | policy | ✅ | ✅ | ✅ |
| Delete Space | ❌ | policy | ✅ | ❌ | ❌ |
| Manage member roles | ❌ | policy | ✅ | ❌ | ❌ |

Enforced by the existing services (`requireRole`) and by RLS for direct database
access; the frontend only hides controls.

---

## 6. RLS policies

| Table | Policy | Rule |
|---|---|---|
| `profiles` | `profiles_select_own` | `auth.uid() = auth_user_id` |
| `profiles` | `profiles_update_own` | own row, WITH CHECK own row (privileged columns blocked by trigger) |
| `legacy_account_links` | `legacy_links_select_own` | own link only; writes are service-role only |
| `account_audit` | `account_audit_select_own` | own events only; inserts are service-role only |
| `storage.objects` | `avatars_*_own` | object path must start with `auth.uid()/` |

No INSERT/DELETE policy exists for `profiles`: creation happens in the
`SECURITY DEFINER` signup trigger, deletion is a server operation.

---

## 7. Existing SQLite data (preserved)

- `.backups/module1-20261112/` holds source, database + WAL/SHM, local storage,
  repo bundle and the working-tree status at Module 1 start.
- SQLite remains the live store for Spaces/files/archives. Nothing was deleted
  or rewritten.
- `legacy_account_links` records a verified mapping between a Supabase identity
  and an existing SQLite profile. Linking requires **both** a verified Supabase
  email **and** the legacy password (`POST /users/me/link-legacy`), so a typo can
  never capture another account.
- Actual ownership re-keying (moving `spaces.owner_id`, `members.user_id`, … from
  the legacy id to the Supabase UUID) is **not** done automatically. It is a
  reviewed migration step driven by the link table, in the migration module —
  deliberately out of Module 1 to avoid rewriting live data.
- Existing users can therefore sign up with Supabase, verify, link, and later
  have their Spaces moved; new users start clean.

---

## 8. Tests

Local (no credentials needed): `npm test` → **57 passing**.

- `tests/module1-auth.test.ts` (17): token verification (valid, expired,
  wrong issuer, wrong audience, wrong secret, missing secret, missing URL,
  malformed), provider switching, `/auth/config` leaks no keys, forged token
  rejected on account endpoints, local-mode account endpoints return 503
  `SUPABASE_NOT_CONFIGURED`, password policy.
- Existing 40 tests still pass (Spaces, files, archives, RBAC, lifecycle).

Live (needs a real project): `apps/api/tests/live/supabase-live.test.ts`.

```bash
SUPABASE_TEST_LIVE=1 SUPABASE_URL=... SUPABASE_ANON_KEY=... \
SUPABASE_SERVICE_ROLE_KEY=... npx vitest run tests/live
```

Covers: profile creation from `auth.users`, real token acceptance, 401 without a
token, RLS blocking cross-user reads, RLS blocking self-promotion to ADMIN,
profile update persistence, avatar upload + Storage object, non-image rejection,
export contents, password change with re-authentication, deletion + session
revocation.

---

## 9. Not implemented in Module 1 (by scope)

- Automatic Space ownership migration for legacy accounts (linking only).
- Custom SMTP provider wiring (dashboard step, see §2).
- Email-change *confirmation callback* page beyond the Supabase template — the
  change is confirmed by Supabase's link and mirrored by DB trigger.
- MFA/TOTP, social providers, passkeys.
