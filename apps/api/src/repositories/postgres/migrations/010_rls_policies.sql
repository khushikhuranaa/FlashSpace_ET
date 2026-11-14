-- ===========================================================================
-- NEW: 010_rls_policies.sql
-- Authoritative Supabase RLS policy set for a fresh project.
--
-- This is the version-controlled RLS migration for Supabase. The previous
-- non-migration file `rls-policies.sql` remains as a local review copy; this
-- migration is what should be applied to a new Supabase project via the normal
-- migration runner once auth.users exists.
--
-- Design notes:
--  * This file is applied AFTER 003_auth_identity.sql (which adds auth triggers,
--    profiles changes and the avatar storage policies).
--  * It defines the shared helper functions and then the final policy set.
--  * It is written to be idempotent in the usual migration sense: rerunning it
--    must not change the schema for a project that already ran it.
--  * On a *fresh* Supabase project, this is the first place the final policies
--    are created, so the `drop policy if exists` guards are still valuable.
--
-- Safety:
--  * Keep the self-only profiles SELECT policy and the corrected members SELECT
--    policy from Step 9.
--  * Keep existing avatar storage policies that migration 003 already created.
--  * Do not weaken RLS; preserve all other permissions and application behavior.
-- ===========================================================================
-- ---------------------------------------------------------------- helpers ---
create or replace function public.is_space_member(target_space text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.members m
     where m.space_id = target_space
       and m.user_id = auth.uid()::text
       and m.status = 'ACTIVE'
  )
$$;

create or replace function public.is_space_writer(target_space text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.members m
     where m.space_id = target_space
       and m.user_id = auth.uid()::text
       and m.status = 'ACTIVE'
       and m.role in ('OWNER', 'EDITOR')
  )
$$;

create or replace function public.is_space_owner(target_space text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.spaces s
     where s.id = target_space and s.owner_id = auth.uid()::text
  )
$$;

create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()::text and p.role = 'ADMIN'
  )
$$;

-- --------------------------------------------------------------- profiles ---
alter table public.profiles enable row level security;

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid()::text);

-- Role/email changes never come from a client session: ADMIN promotion and
-- suspension are service-role operations in the API.
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid()::text)
  with check (id = auth.uid()::text and role = (select role from public.profiles where id = auth.uid()::text));

-- Credentials are never readable/writable by clients.
alter table public.credentials enable row level security;

-- ----------------------------------------------------------------- spaces ---
alter table public.spaces enable row level security;

drop policy if exists spaces_select_member on public.spaces;
create policy spaces_select_member on public.spaces
  for select to authenticated
  using (owner_id = auth.uid()::text or public.is_space_member(id) or public.is_app_admin());

drop policy if exists spaces_insert_owner on public.spaces;
create policy spaces_insert_owner on public.spaces
  for insert to authenticated
  with check (owner_id = auth.uid()::text);

drop policy if exists spaces_update_owner on public.spaces;
create policy spaces_update_owner on public.spaces
  for update to authenticated
  using (owner_id = auth.uid()::text)
  with check (owner_id = auth.uid()::text);

drop policy if exists spaces_delete_owner on public.spaces;
create policy spaces_delete_owner on public.spaces
  for delete to authenticated
  using (owner_id = auth.uid()::text);

-- ---------------------------------------------------------------- members ---
alter table public.members enable row level security;

drop policy if exists members_select_member on public.members;
create policy members_select_member on public.members
  for select to authenticated
  using (user_id = auth.uid()::text or public.is_app_admin());

-- ------------------------------------------------------- files & folders ---
alter table public.files enable row level security;
drop policy if exists files_select_member on public.files;
create policy files_select_member on public.files
  for select to authenticated
  using (public.is_space_member(space_id) or public.is_app_admin());

drop policy if exists files_write_editor on public.files;
create policy files_write_editor on public.files
  for all to authenticated
  using (public.is_space_writer(space_id))
  with check (public.is_space_writer(space_id));

alter table public.folders enable row level security;
drop policy if exists folders_select_member on public.folders;
create policy folders_select_member on public.folders
  for select to authenticated
  using (public.is_space_member(space_id));

drop policy if exists folders_write_editor on public.folders;
create policy folders_write_editor on public.folders
  for all to authenticated
  using (public.is_space_writer(space_id))
  with check (public.is_space_writer(space_id));

-- --------------------------------------------------- invitations & links ---
alter table public.invitations enable row level security;
drop policy if exists invitations_owner on public.invitations;
create policy invitations_owner on public.invitations
  for all to authenticated
  using (public.is_space_owner(space_id))
  with check (public.is_space_owner(space_id));

alter table public.invite_links enable row level security;
drop policy if exists invite_links_owner on public.invite_links;
create policy invite_links_owner on public.invite_links
  for all to authenticated
  using (public.is_space_owner(space_id))
  with check (public.is_space_owner(space_id));

alter table public.join_requests enable row level security;
drop policy if exists join_requests_self_or_owner on public.join_requests;
create policy join_requests_self_or_owner on public.join_requests
  for select to authenticated
  using (requester_id = auth.uid()::text or public.is_space_owner(space_id));

-- ---------------------------------------------------------------- archives ---
alter table public.archives enable row level security;
drop policy if exists archives_owner_read on public.archives;
create policy archives_owner_read on public.archives
  for select to authenticated
  using (owner_id = auth.uid()::text or public.is_app_admin());

-- ----------------------------------------------------------- notifications ---
alter table public.notifications enable row level security;
drop policy if exists notifications_self on public.notifications;
create policy notifications_self on public.notifications
  for all to authenticated
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

-- -------------------------------------------------------------- activity ---
alter table public.activity enable row level security;
drop policy if exists activity_member_read on public.activity;
create policy activity_member_read on public.activity
  for select to authenticated
  using (
    user_id = auth.uid()::text
    or (space_id is not null and public.is_space_member(space_id))
    or public.is_app_admin()
  );

-- ------------------------------------------- favourites / recent access ---
alter table public.space_favorites enable row level security;
drop policy if exists space_favorites_self on public.space_favorites;
create policy space_favorites_self on public.space_favorites
  for all to authenticated
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

alter table public.space_access enable row level security;
drop policy if exists space_access_self on public.space_access;
create policy space_access_self on public.space_access
  for all to authenticated
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

-- ------------------------------------------------------ scans & plans ------
alter table public.scan_jobs enable row level security;
drop policy if exists scan_jobs_owner on public.scan_jobs;
create policy scan_jobs_owner on public.scan_jobs
  for all to authenticated
  using (public.is_space_owner(space_id))
  with check (public.is_space_owner(space_id));

alter table public.archive_plans enable row level security;
drop policy if exists archive_plans_owner on public.archive_plans;
create policy archive_plans_owner on public.archive_plans
  for all to authenticated
  using (public.is_space_owner(space_id))
  with check (public.is_space_owner(space_id));

-- ------------------------------------------------ admin-only read access ---
alter table public.admin_audit enable row level security;
drop policy if exists admin_audit_admin_read on public.admin_audit;
create policy admin_audit_admin_read on public.admin_audit
  for select to authenticated
  using (public.is_app_admin());

-- ---------------------------------------------------- default deny (rest) ---
-- email_jobs, verification_tokens, lifecycle_transitions, jobs, cleanup_runs,
-- duplicate_* and archive_jobs are operational tables: they stay RLS-enabled
-- with no client policy, i.e. service-role only.
alter table public.email_jobs enable row level security;
alter table public.verification_tokens enable row level security;
alter table public.lifecycle_transitions enable row level security;
alter table public.jobs enable row level security;
alter table public.cleanup_runs enable row level security;
alter table public.archive_jobs enable row level security;
alter table public.duplicate_groups enable row level security;
alter table public.duplicate_files enable row level security;
alter table public.extension_requests enable row level security;

-- ------------------------------------------------------- storage buckets ---
-- Only ensure the shared buckets exist. The avatar storage policies are already
-- created by migration 003 on a fresh Supabase project, so this migration does
-- not redefine avatar object policies here.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('space-files', 'space-files', false, 52428800, null),
  ('vault-archives', 'vault-archives', false, 104857600, array['application/zip']),
  ('archive-temp', 'archive-temp', false, 104857600, array['application/zip'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
