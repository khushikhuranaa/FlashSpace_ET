-- 008: server-side auth sessions.
--
-- The session/refresh-token model exists in the local SQLite schema and the
-- AuthService, but the PostgreSQL schema never declared the table. Without it a
-- Postgres deployment cannot issue or revoke sessions at all.
--
-- Refresh tokens are stored as SHA-256 hashes only. `refresh_hash` is unique so
-- two sessions can never share a token, and `user_id` cascades on account
-- deletion so a deleted profile cannot leave live sessions behind.

create table if not exists public.auth_sessions (
  id text primary key,
  user_id text not null references public.profiles (id) on delete cascade,
  refresh_hash text not null unique,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz not null,
  user_agent text,
  ip text
);

create index if not exists auth_sessions_user_idx
  on public.auth_sessions (user_id, created_at desc);
create index if not exists auth_sessions_refresh_idx
  on public.auth_sessions (refresh_hash);

-- The API uses the service role, which bypasses RLS. Enabling it only blocks
-- accidental PostgREST access; session rows must never be client-readable.
alter table public.auth_sessions enable row level security;
