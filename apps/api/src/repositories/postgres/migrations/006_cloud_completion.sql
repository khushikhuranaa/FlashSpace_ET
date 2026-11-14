-- ============================================================================
-- Module 15 — cloud schema completion.
--
-- Adds the tables/columns the local SQLite schema has had since Modules 9–12
-- but which the Postgres migrations never declared:
--   * Module 11 account suspension + last-active tracking on profiles
--   * Module 12 activity columns (outcome/category/resource/event_key)
--   * Module 11 admin audit trail
--   * Module 6/8 lifecycle transition history
--   * Module 9 transactional email delivery records
--   * Module 9 hashed verification / password-reset tokens
--
-- Everything is additive and idempotent, so it is safe to run on a database
-- that already has some of these objects. No data is dropped or rewritten.
-- ============================================================================

-- 1. profiles: suspension + activity metadata -------------------------------
alter table public.profiles add column if not exists last_active_at timestamptz;
alter table public.profiles add column if not exists suspended_at timestamptz;
alter table public.profiles add column if not exists suspended_by text;
alter table public.profiles add column if not exists suspension_reason text;

-- 2. activity: Module 12 audit fields ---------------------------------------
alter table public.activity add column if not exists actor_type text not null default 'USER';
alter table public.activity add column if not exists outcome text not null default 'SUCCESS';
alter table public.activity add column if not exists category text not null default 'OTHER';
alter table public.activity add column if not exists resource_type text;
alter table public.activity add column if not exists resource_id text;
alter table public.activity add column if not exists reason text;
alter table public.activity add column if not exists correlation_id text;
alter table public.activity add column if not exists event_key text;

create index if not exists activity_action_idx on public.activity (action, id desc);
create index if not exists activity_category_idx on public.activity (category, id desc);
create index if not exists activity_outcome_idx on public.activity (outcome, id desc);
create index if not exists activity_created_idx on public.activity (created_at);
-- Idempotent event writes: at most one row per event_key.
create unique index if not exists activity_event_key_idx
  on public.activity (event_key) where event_key is not null;

-- 3. admin audit trail (append-only) ----------------------------------------
create table if not exists public.admin_audit (
  id text primary key,
  admin_id text not null references public.profiles (id) on delete cascade,
  action text not null,
  target_type text not null,
  target_id text not null,
  outcome text not null check (outcome in ('SUCCESS', 'FAILURE')),
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null
);
create index if not exists admin_audit_created_idx on public.admin_audit (created_at desc);
create index if not exists admin_audit_admin_idx on public.admin_audit (admin_id, created_at desc);
create index if not exists admin_audit_action_idx on public.admin_audit (action, created_at desc);

-- 4. lifecycle transition history -------------------------------------------
create table if not exists public.lifecycle_transitions (
  id text primary key,
  space_id text not null references public.spaces (id) on delete cascade,
  actor_id text references public.profiles (id) on delete set null,
  previous_status text not null,
  new_status text not null,
  reason text not null,
  "timestamp" timestamptz not null
);
create index if not exists lifecycle_transitions_space_idx
  on public.lifecycle_transitions (space_id, "timestamp" desc);

-- 5. transactional email delivery records (Module 9) ------------------------
create table if not exists public.email_jobs (
  id text primary key,
  category text not null,
  template text not null,
  to_address text not null,
  subject text not null,
  entity_id text not null,
  entity_type text not null,
  status text not null check (status in ('PENDING', 'SENT', 'FAILED', 'CANCELLED')),
  attempts integer not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  error text,
  idempotency_key text
);
create index if not exists email_jobs_status_idx on public.email_jobs (status, created_at);
create index if not exists email_jobs_entity_idx on public.email_jobs (entity_type, entity_id);
create unique index if not exists email_jobs_idempotency_idx
  on public.email_jobs (idempotency_key) where idempotency_key is not null;

-- 6. hashed verification / reset tokens (Module 9) --------------------------
create table if not exists public.verification_tokens (
  id text primary key,
  user_id text not null references public.profiles (id) on delete cascade,
  token_hash text not null,
  purpose text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null
);
create index if not exists verification_tokens_hash_idx on public.verification_tokens (token_hash);
create index if not exists verification_tokens_user_idx on public.verification_tokens (user_id, purpose);

-- 7. Defence in depth: deny direct client access to the new tables ----------
-- (The API uses the service role, which bypasses RLS; these switches only stop
--  anon/authenticated PostgREST access. Policies live in sql/rls-policies.sql.)
alter table public.admin_audit enable row level security;
alter table public.lifecycle_transitions enable row level security;
alter table public.email_jobs enable row level security;
alter table public.verification_tokens enable row level security;
