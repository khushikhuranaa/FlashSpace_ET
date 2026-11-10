-- FlashSpace initial schema (PRD §6). Run via `npm run db:migrate`.
-- Extension for idempotency-key uniqueness.

create table if not exists profiles (
  id uuid primary key,
  email text not null unique,
  display_name text not null,
  role text not null default 'USER' check (role in ('USER','ADMIN')),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists spaces (
  id uuid primary key,
  owner_id uuid not null references profiles(id),
  name text not null,
  purpose text not null,
  description text not null default '',
  start_at timestamptz not null,
  expiry_at timestamptz not null,
  status text not null default 'DRAFT' check (status in (
    'DRAFT','ACTIVE','WARNING','ARCHIVING','ARCHIVED','ARCHIVE_FAILED','DELETED')),
  warning_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists spaces_expiry_idx on spaces (expiry_at) where status in ('DRAFT','ACTIVE','WARNING');
create index if not exists spaces_owner_idx on spaces (owner_id);

create table if not exists space_members (
  space_id uuid not null references spaces(id) on delete cascade,
  user_id uuid not null references profiles(id),
  role text not null check (role in ('OWNER','EDITOR','VIEWER')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','INVITED','REVOKED')),
  joined_at timestamptz,
  revoked_at timestamptz,
  primary key (space_id, user_id)
);

create table if not exists space_invitations (
  id uuid primary key,
  space_id uuid not null references spaces(id) on delete cascade,
  inviter_id uuid not null references profiles(id),
  email text not null,
  intended_role text not null check (intended_role in ('OWNER','EDITOR','VIEWER')),
  token_hash text,
  status text not null default 'PENDING' check (status in ('PENDING','ACCEPTED','EXPIRED','REVOKED')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists invitations_email_idx on space_invitations (email);

create table if not exists folders (
  id uuid primary key,
  space_id uuid not null references spaces(id) on delete cascade,
  parent_id uuid references folders(id),
  name text not null,
  path text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (space_id, path)
);

create table if not exists files (
  id uuid primary key,
  space_id uuid not null references spaces(id) on delete cascade,
  folder_id uuid references folders(id),
  uploader_id uuid not null references profiles(id),
  name text not null,
  object_key text not null unique,
  mime_type text not null,
  size_bytes bigint not null default 0,
  etag text,
  sha256 text,
  status text not null default 'PENDING' check (status in ('PENDING','ACTIVE','DELETED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists files_space_idx on files (space_id) where status <> 'DELETED';

create table if not exists archives (
  id uuid primary key,
  space_id uuid not null references spaces(id),
  owner_id uuid not null references profiles(id),
  object_key text not null unique,
  size_bytes bigint not null default 0,
  checksum text,
  file_count int not null default 0,
  status text not null default 'PENDING' check (status in ('PENDING','CREATING','VERIFIED','FAILED')),
  created_at timestamptz not null default now(),
  verified_at timestamptz
);
create index if not exists archives_owner_idx on archives (owner_id);

create table if not exists extension_requests (
  id uuid primary key,
  space_id uuid not null references spaces(id) on delete cascade,
  requester_id uuid not null references profiles(id),
  requested_days int not null,
  reason text not null,
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED')),
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  space_id uuid references spaces(id) on delete set null,
  type text not null,
  title text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on notifications (user_id, created_at desc);

create table if not exists activity_logs (
  id bigserial primary key,
  user_id uuid references profiles(id),
  space_id uuid,
  file_id uuid,
  action text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists activity_space_idx on activity_logs (space_id, id desc);

create table if not exists lifecycle_jobs (
  id uuid primary key,
  job_type text not null check (job_type in ('LIFECYCLE','ARCHIVE','CLEANUP')),
  space_id uuid,
  idempotency_key text not null unique,
  status text not null default 'PENDING' check (status in ('PENDING','RUNNING','SUCCEEDED','FAILED')),
  attempts int not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text
);

create table if not exists cleanup_runs (
  id uuid primary key,
  space_id uuid not null,
  archive_id uuid not null,
  status text not null default 'PENDING' check (status in ('PENDING','RUNNING','SUCCEEDED','PARTIAL_FAILED','FAILED')),
  memberships_revoked int not null default 0,
  objects_deleted int not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text
);

create table if not exists local_accounts (
  user_id uuid primary key references profiles(id) on delete cascade,
  password_hash text not null
);
