-- Migration 002: Smart Storage Insights + Duplicate Detection (PRD §4).
-- Run after 001_init.sql. Idempotent (create table if not exists).

-- Column present in the SQLite schema since manual archiving shipped; add it
-- here so both backends expose the same Space shape.
alter table spaces add column if not exists archived_manually boolean not null default false;

create table if not exists scan_jobs (
  id uuid primary key,
  space_id uuid not null references spaces(id) on delete cascade,
  owner_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'PENDING' check (status in ('PENDING','RUNNING','VERIFIED','FAILED')),
  total_files int not null default 0,
  total_bytes bigint not null default 0,
  duplicate_groups int not null default 0,
  duplicate_file_count int not null default 0,
  extra_copy_count int not null default 0,
  potential_savings_bytes bigint not null default 0,
  large_file_count int not null default 0,
  near_duplicate_group_count int not null default 0,
  scanned_at timestamptz,
  failed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists scan_jobs_space_idx on scan_jobs(space_id);
create index if not exists scan_jobs_owner_idx on scan_jobs(owner_id);

create table if not exists duplicate_groups (
  id uuid primary key,
  scan_id uuid not null references scan_jobs(id) on delete cascade,
  content_hash text not null,
  file_count int not null default 1,
  extra_copy_count int not null default 0,
  total_bytes bigint not null default 0,
  potential_savings_bytes bigint not null default 0,
  representative_name text not null,
  unique(scan_id, content_hash)
);
create index if not exists duplicate_groups_scan_idx on duplicate_groups(scan_id);

create table if not exists duplicate_files (
  id uuid primary key,
  group_id uuid not null references duplicate_groups(id) on delete cascade,
  scan_id uuid not null references scan_jobs(id) on delete cascade,
  file_id uuid not null references files(id) on delete cascade,
  name text not null,
  object_key text not null,
  size_bytes bigint not null,
  mime_type text not null,
  uploaded_at timestamptz not null,
  uploader_id uuid not null references profiles(id) on delete cascade,
  excluded boolean not null default false,
  unique(group_id, file_id)
);
create index if not exists duplicate_files_group_idx on duplicate_files(group_id);
create index if not exists duplicate_files_scan_idx on duplicate_files(scan_id);

create table if not exists archive_plans (
  id uuid primary key,
  space_id uuid not null references spaces(id) on delete cascade,
  owner_id uuid not null references profiles(id) on delete cascade,
  scan_id uuid references scan_jobs(id) on delete set null,
  status text not null default 'PENDING' check (status in ('PENDING','CONFIRMED','ARCHIVING','VERIFIED','FAILED','CANCELLED')),
  excluded_file_ids text not null default '',
  will_archive_file_count int not null default 0,
  will_archive_bytes bigint not null default 0,
  will_exclude_file_count int not null default 0,
  will_exclude_bytes bigint not null default 0,
  potential_savings_bytes bigint not null default 0,
  explained boolean not null default false,
  confirmed_at timestamptz,
  archive_job_id uuid references archive_jobs(id) on delete set null,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists archive_plans_space_idx on archive_plans(space_id);
create index if not exists archive_plans_owner_idx on archive_plans(owner_id);

create table if not exists archive_jobs (
  id uuid primary key,
  plan_id uuid not null references archive_plans(id) on delete cascade,
  space_id uuid not null references spaces(id) on delete cascade,
  owner_id uuid not null references profiles(id) on delete cascade,
  idempotency_key text not null unique,
  status text not null default 'PENDING' check (status in ('PENDING','RUNNING','SUCCEEDED','FAILED')),
  attempts int not null default 0,
  archive_id uuid references archives(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text
);
create index if not exists archive_jobs_plan_idx on archive_jobs(plan_id);
create index if not exists archive_jobs_owner_idx on archive_jobs(owner_id);
