-- Module 2 — dashboard + global search support.
--
-- Adds the one entity the dashboard needs that did not exist yet (recently
-- accessed Spaces) and the indexes global search relies on. Nothing existing is
-- altered: no column changes, no data rewrites.

-- ---------------------------------------------------------------------------
-- Recently accessed Spaces
-- ---------------------------------------------------------------------------
-- One row per (user, space). Written by the API when a signed-in user actually
-- opens a Space; never on list/render, so the timestamps are real navigation
-- events rather than page loads.
create table if not exists public.space_access (
  user_id text not null references public.profiles(id) on delete cascade,
  space_id text not null references public.spaces(id) on delete cascade,
  last_accessed_at timestamptz not null default now(),
  primary key (user_id, space_id)
);

create index if not exists space_access_user_idx
  on public.space_access (user_id, last_accessed_at desc);

alter table public.space_access enable row level security;

-- Users may read their own access history; writes come from the API's
-- service-role client (an access stamp must not be forgeable from the browser).
drop policy if exists space_access_select_own on public.space_access;
create policy space_access_select_own on public.space_access
  for select using (user_id = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- Search indexes
-- ---------------------------------------------------------------------------
-- Dashboard search matches on partial, case-insensitive name fragments. The
-- lower(name) indexes keep those scans index-assisted instead of sequential.
create index if not exists spaces_name_lower_idx on public.spaces (lower(name));
create index if not exists spaces_owner_status_idx on public.spaces (owner_id, status);
create index if not exists files_name_lower_idx on public.files (lower(name));
create index if not exists files_space_created_idx on public.files (space_id, created_at desc);
create index if not exists folders_name_lower_idx on public.folders (lower(name));
create index if not exists folders_space_idx on public.folders (space_id);
create index if not exists activity_created_idx on public.activity (created_at desc);
create index if not exists activity_space_created_idx on public.activity (space_id, created_at desc);

-- Recent uploads and activity are read per Space the caller belongs to; these
-- composite indexes keep the dashboard aggregation off full table scans.
create index if not exists members_user_status_idx on public.members (user_id, status);
create index if not exists invitations_email_status_idx on public.invitations (lower(email), status);
