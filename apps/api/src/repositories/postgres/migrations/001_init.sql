-- FlashSpace canonical PostgreSQL schema (PRD §6).
--
-- One table per persisted aggregate. This file is the PostgreSQL mirror of the
-- SQLite schema in src/repositories/sqlite/sqlite.data-layer.ts: same table
-- names, same columns (snake_case), same nullability. Two deliberate
-- differences from the SQLite file:
--   * ids are `text`, not `uuid` — the DataLayer hands ids around as plain
--     strings (newId() is a v4 uuid, but tests and seeds use readable ids too),
--     and a text column cannot fail a cast on an id it did not generate;
--   * timestamps are `timestamptz` and are read back as ISO-8601 strings, so
--     domain objects keep the exact `string` shape they have in SQLite.
--
-- Every relationship the services rely on is enforced here. Delete behaviour
-- is chosen so a Space teardown never trips over an orphan row: rows that only
-- exist inside a Space cascade, rows a user keeps (archives, activity)
-- outlive it with a null foreign key.
--
-- Run with: npm run db:migrate -w @flashspace/api   (DATABASE_URL required)

-- 1. profiles ----------------------------------------------------------------
create table if not exists profiles (
  id text primary key,
  email text not null unique,
  display_name text not null,
  role text not null default 'USER' check (role in ('USER', 'ADMIN')),
  avatar_url text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists profiles_email_idx on profiles (lower(email));

-- 2. credentials -------------------------------------------------------------
-- Local (scrypt) credentials, split from profiles so a Supabase-Auth profile
-- can exist without a password hash.
create table if not exists credentials (
  user_id text primary key references profiles (id) on delete cascade,
  password_hash text not null
);

-- 3. spaces ------------------------------------------------------------------
create table if not exists spaces (
  id text primary key,
  owner_id text not null references profiles (id) on delete cascade,
  name text not null,
  purpose text not null,
  description text not null default '',
  start_at timestamptz not null,
  expiry_at timestamptz not null,
  status text not null default 'DRAFT' check (status in (
    'DRAFT', 'ACTIVE', 'WARNING', 'ARCHIVING', 'ARCHIVED', 'ARCHIVE_FAILED', 'DELETED')),
  warning_sent_at timestamptz,
  archived_manually boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists spaces_owner_idx on spaces (owner_id);
-- The lifecycle pass scans exactly this set, so keep it cheap.
create index if not exists spaces_lifecycle_idx on spaces (expiry_at)
  where status in ('DRAFT', 'ACTIVE', 'WARNING');

-- 4. members -----------------------------------------------------------------
create table if not exists members (
  space_id text not null references spaces (id) on delete cascade,
  user_id text not null references profiles (id) on delete cascade,
  role text not null check (role in ('OWNER', 'EDITOR', 'VIEWER')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'INVITED', 'REVOKED')),
  joined_at timestamptz,
  revoked_at timestamptz,
  primary key (space_id, user_id)
);
create index if not exists members_user_idx on members (user_id);

-- 5. folders -----------------------------------------------------------------
create table if not exists folders (
  id text primary key,
  space_id text not null references spaces (id) on delete cascade,
  parent_id text references folders (id) on delete cascade,
  name text not null,
  path text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (space_id, path)
);
create index if not exists folders_space_idx on folders (space_id);

-- 6. invitations -------------------------------------------------------------
create table if not exists invitations (
  id text primary key,
  space_id text not null references spaces (id) on delete cascade,
  inviter_id text not null references profiles (id) on delete cascade,
  email text not null,
  intended_role text not null check (intended_role in ('OWNER', 'EDITOR', 'VIEWER')),
  token_hash text,
  status text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED')),
  expires_at timestamptz not null,
  created_at timestamptz not null
);
create index if not exists invitations_space_idx on invitations (space_id);
create index if not exists invitations_email_idx on invitations (space_id, lower(email));

-- 7. invite_links ------------------------------------------------------------
create table if not exists invite_links (
  id text primary key,
  space_id text not null references spaces (id) on delete cascade,
  created_by text not null references profiles (id) on delete cascade,
  token text not null unique,
  role text not null check (role in ('OWNER', 'EDITOR', 'VIEWER')),
  created_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists invite_links_space_idx on invite_links (space_id);

-- 8. join_requests -----------------------------------------------------------
create table if not exists join_requests (
  id text primary key,
  space_id text not null references spaces (id) on delete cascade,
  requester_id text not null references profiles (id) on delete cascade,
  role text not null check (role in ('OWNER', 'EDITOR', 'VIEWER')),
  source text not null check (source in ('LINK', 'EMAIL')),
  invitation_id text references invitations (id) on delete set null,
  status text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN')),
  created_at timestamptz not null,
  decided_by text references profiles (id) on delete set null,
  decided_at timestamptz
);
create index if not exists join_requests_space_idx on join_requests (space_id, status);
create index if not exists join_requests_requester_idx on join_requests (requester_id);

-- 9. extension_requests ------------------------------------------------------
create table if not exists extension_requests (
  id text primary key,
  space_id text not null references spaces (id) on delete cascade,
  requester_id text not null references profiles (id) on delete cascade,
  requested_days integer not null check (requested_days > 0),
  reason text not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  decided_by text references profiles (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null
);
create index if not exists extension_requests_space_idx on extension_requests (space_id, status);

-- 10. files ------------------------------------------------------------------
create table if not exists files (
  id text primary key,
  space_id text not null references spaces (id) on delete cascade,
  folder_id text references folders (id) on delete set null,
  uploader_id text not null references profiles (id) on delete cascade,
  name text not null,
  object_key text not null unique,
  mime_type text not null,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  etag text,
  sha256 text,
  status text not null default 'PENDING' check (status in ('PENDING', 'ACTIVE', 'DELETED')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz
);
create index if not exists files_space_idx on files (space_id);
create index if not exists files_space_status_idx on files (space_id, status);

-- 11. archives ---------------------------------------------------------------
create table if not exists archives (
  id text primary key,
  space_id text not null references spaces (id) on delete cascade,
  owner_id text not null references profiles (id) on delete cascade,
  object_key text not null,
  size_bytes bigint not null default 0,
  checksum text,
  file_count integer not null default 0,
  status text not null default 'PENDING' check (status in ('PENDING', 'CREATING', 'VERIFIED', 'FAILED')),
  created_at timestamptz not null,
  verified_at timestamptz
);
create index if not exists archives_owner_idx on archives (owner_id);
create index if not exists archives_space_idx on archives (space_id);

-- 12. notifications ----------------------------------------------------------
create table if not exists notifications (
  id text primary key,
  user_id text not null references profiles (id) on delete cascade,
  space_id text references spaces (id) on delete set null,
  type text not null,
  title text not null,
  body text not null,
  invite_link_id text references invite_links (id) on delete set null,
  join_request_id text references join_requests (id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null
);
create index if not exists notifications_user_idx on notifications (user_id, created_at desc);

-- 13. jobs (lifecycle queue) -------------------------------------------------
create table if not exists jobs (
  id text primary key,
  job_type text not null check (job_type in ('LIFECYCLE', 'ARCHIVE', 'CLEANUP')),
  space_id text references spaces (id) on delete set null,
  idempotency_key text not null unique,
  status text not null default 'PENDING' check (status in ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  attempts integer not null default 0,
  started_at timestamptz not null,
  finished_at timestamptz,
  error text
);
create index if not exists jobs_claim_idx on jobs (job_type, status, started_at);

-- 14. cleanup_runs -----------------------------------------------------------
create table if not exists cleanup_runs (
  id text primary key,
  space_id text not null references spaces (id) on delete cascade,
  archive_id text not null references archives (id) on delete cascade,
  status text not null default 'PENDING' check (status in (
    'PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL_FAILED', 'FAILED')),
  memberships_revoked integer not null default 0,
  objects_deleted integer not null default 0,
  started_at timestamptz not null,
  finished_at timestamptz,
  error text
);
create index if not exists cleanup_runs_space_idx on cleanup_runs (space_id, started_at desc);

-- 15. activity ---------------------------------------------------------------
-- Monotonic integer id: the API pages activity by id, and ids never reset.
create table if not exists activity (
  id bigserial primary key,
  user_id text references profiles (id) on delete set null,
  space_id text references spaces (id) on delete set null,
  file_id text references files (id) on delete set null,
  action text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null
);
create index if not exists activity_space_idx on activity (space_id, id desc);
create index if not exists activity_user_idx on activity (user_id, id desc);

-- 16. scan_jobs --------------------------------------------------------------
create table if not exists scan_jobs (
  id text primary key,
  space_id text not null references spaces (id) on delete cascade,
  owner_id text not null references profiles (id) on delete cascade,
  status text not null default 'PENDING' check (status in ('PENDING', 'RUNNING', 'VERIFIED', 'FAILED')),
  total_files integer not null default 0,
  total_bytes bigint not null default 0,
  duplicate_groups integer not null default 0,
  duplicate_file_count integer not null default 0,
  extra_copy_count integer not null default 0,
  potential_savings_bytes bigint not null default 0,
  large_file_count integer not null default 0,
  near_duplicate_group_count integer not null default 0,
  scanned_at timestamptz,
  failed_at timestamptz,
  error_message text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists scan_jobs_space_idx on scan_jobs (space_id, updated_at desc);

-- 17. duplicate_groups -------------------------------------------------------
create table if not exists duplicate_groups (
  id text primary key,
  scan_id text not null references scan_jobs (id) on delete cascade,
  content_hash text not null,
  file_count integer not null default 1,
  extra_copy_count integer not null default 0,
  total_bytes bigint not null default 0,
  potential_savings_bytes bigint not null default 0,
  representative_name text not null,
  unique (scan_id, content_hash)
);
create index if not exists duplicate_groups_scan_idx on duplicate_groups (scan_id);

-- 18. duplicate_files --------------------------------------------------------
create table if not exists duplicate_files (
  id text primary key,
  group_id text not null references duplicate_groups (id) on delete cascade,
  scan_id text not null references scan_jobs (id) on delete cascade,
  file_id text not null references files (id) on delete cascade,
  name text not null,
  object_key text not null,
  size_bytes bigint not null default 0,
  mime_type text not null,
  uploaded_at timestamptz not null,
  uploader_id text not null references profiles (id) on delete cascade,
  excluded boolean not null default false,
  unique (group_id, file_id)
);
create index if not exists duplicate_files_group_idx on duplicate_files (group_id);
create index if not exists duplicate_files_scan_idx on duplicate_files (scan_id);

-- 19. archive_plans ----------------------------------------------------------
-- archive_job_id is a circular reference (a job points back at its plan), so
-- the constraint is added after archive_jobs exists, below.
create table if not exists archive_plans (
  id text primary key,
  space_id text not null references spaces (id) on delete cascade,
  owner_id text not null references profiles (id) on delete cascade,
  scan_id text references scan_jobs (id) on delete set null,
  status text not null default 'PENDING' check (status in (
    'PENDING', 'CONFIRMED', 'ARCHIVING', 'VERIFIED', 'FAILED', 'CANCELLED')),
  -- Comma-separated file ids: the column predates the array support and the
  -- DataLayer contract exposes it as string[] mapped in both directions.
  excluded_file_ids text not null default '',
  will_archive_file_count integer not null default 0,
  will_archive_bytes bigint not null default 0,
  will_exclude_file_count integer not null default 0,
  will_exclude_bytes bigint not null default 0,
  potential_savings_bytes bigint not null default 0,
  explained boolean not null default false,
  confirmed_at timestamptz,
  archive_job_id text,
  error_message text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists archive_plans_space_idx on archive_plans (space_id, updated_at desc);

-- 20. archive_jobs -----------------------------------------------------------
create table if not exists archive_jobs (
  id text primary key,
  plan_id text not null references archive_plans (id) on delete cascade,
  space_id text not null references spaces (id) on delete cascade,
  owner_id text not null references profiles (id) on delete cascade,
  idempotency_key text not null unique,
  status text not null default 'PENDING' check (status in ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  attempts integer not null default 0,
  archive_id text references archives (id) on delete set null,
  started_at timestamptz not null,
  finished_at timestamptz,
  error text
);
create index if not exists archive_jobs_plan_idx on archive_jobs (plan_id);
create index if not exists archive_jobs_owner_idx on archive_jobs (owner_id);

-- Circular FK, added once both tables exist (the ordering bug fixed in 0.12).
do $$
begin
  alter table archive_plans
    add constraint archive_plans_archive_job_id_fkey
    foreign key (archive_job_id) references archive_jobs (id) on delete set null;
exception
  when duplicate_object then null;
end $$;
