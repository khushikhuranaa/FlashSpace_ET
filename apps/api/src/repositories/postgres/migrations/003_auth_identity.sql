-- ============================================================================
-- FlashSpace Module 1 — Supabase Auth identity, profiles, preferences, RLS.
--
-- Runs AFTER 001_init.sql / 002_smart_storage.sql. It upgrades the existing
-- text-id `profiles` table rather than replacing it: the DataLayer hands ids
-- around as strings and every other table in 001 references profiles(id) as
-- text, so rewriting the key type would break the whole schema.
--
-- The authoritative link to Supabase Auth is `profiles.auth_user_id`
-- (uuid, unique, FK -> auth.users). `profiles.id` stays the text form of that
-- same UUID, so application code can keep using plain strings while the
-- database still guarantees referential integrity to auth.users.
--
-- Passwords are never stored here. Supabase Auth owns credentials.
-- ============================================================================

-- 1. Upgrade profiles --------------------------------------------------------
alter table public.profiles
  add column if not exists auth_user_id uuid unique references auth.users (id) on delete cascade;

alter table public.profiles
  add column if not exists preferences jsonb not null default '{}'::jsonb;

alter table public.profiles
  add column if not exists account_status text not null default 'ACTIVE';

alter table public.profiles
  add column if not exists email_verified_at timestamptz;

-- Storage path (bucket-relative), e.g. `<uid>/avatar-1730000000000.webp`.
-- `avatar_url` from 001 stays available for a derived/public URL.
alter table public.profiles
  add column if not exists avatar_path text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_account_status_check' and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_account_status_check
      check (account_status in ('ACTIVE', 'SUSPENDED', 'DELETING'));
  end if;
end $$;

create index if not exists profiles_auth_user_idx on public.profiles (auth_user_id);
create index if not exists profiles_role_idx on public.profiles (role) where role = 'ADMIN';

-- 2. Legacy account links ----------------------------------------------------
-- Existing SQLite accounts (scrypt hashes Supabase Auth cannot import) are
-- linked to a new Supabase identity only AFTER the new address is verified and
-- the user proves control of both accounts. A row here is the audit trail of
-- that link; it never rewrites the SQLite data by itself.
create table if not exists public.legacy_account_links (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  legacy_profile_id text not null,
  legacy_email text not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'VERIFIED', 'REJECTED')),
  verification_token_hash text,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists legacy_account_links_profile_idx
  on public.legacy_account_links (legacy_profile_id);

-- 3. Account audit log -------------------------------------------------------
-- Sensitive account changes (email change, password change, avatar, deletion,
-- legacy link) are recorded for the account owner and for support.
create table if not exists public.account_audit (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null,
  metadata jsonb not null default '{}'::jsonb,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists account_audit_user_idx on public.account_audit (user_id, created_at desc);

-- 4. Profile creation on signup ---------------------------------------------
-- Guarantees exactly one profile per auth user (ON CONFLICT on the unique
-- auth_user_id) and never grants ADMIN from registration metadata.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id, auth_user_id, email, display_name, role,
    preferences, account_status, email_verified_at, created_at, updated_at
  )
  values (
    new.id::text,
    new.id,
    new.email,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      split_part(new.email, '@', 1)
    ),
    'USER',
    '{}'::jsonb,
    'ACTIVE',
    new.email_confirmed_at,
    coalesce(new.created_at, now()),
    now()
  )
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 5. Keep profile email/verification in sync with Auth ----------------------
-- The email is only ever changed through Supabase Auth; this trigger mirrors
-- the result into the profile so the app never disagrees with Auth.
create or replace function public.handle_user_updated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set email = new.email,
         email_verified_at = new.email_confirmed_at,
         updated_at = now()
   where auth_user_id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of email, email_confirmed_at on auth.users
  for each row execute function public.handle_user_updated();

-- 6. Privilege-escalation guard ---------------------------------------------
-- RLS can restrict rows but not columns, so this trigger refuses any change to
-- privileged columns coming from a non-service role. `role` (USER/ADMIN) is the
-- application role; Space roles live in `members` and are unrelated.
create or replace function public.protect_profile_privileged_fields()
returns trigger
language plpgsql
as $$
declare
  as_service boolean :=
    coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
    or current_user in ('postgres', 'supabase_admin', 'service_role');
begin
  if not as_service then
    if new.role is distinct from old.role then
      raise exception 'application role cannot be changed by the account owner';
    end if;
    if new.account_status is distinct from old.account_status then
      raise exception 'account status cannot be changed by the account owner';
    end if;
    if new.email is distinct from old.email then
      raise exception 'email is managed by Supabase Auth';
    end if;
    if new.auth_user_id is distinct from old.auth_user_id then
      raise exception 'auth identity cannot be re-pointed';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_protect_privileged on public.profiles;
create trigger profiles_protect_privileged
  before update on public.profiles
  for each row execute function public.protect_profile_privileged_fields();

-- 7. Row Level Security ------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.legacy_account_links enable row level security;
alter table public.account_audit enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (auth.uid() = auth_user_id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (auth.uid() = auth_user_id)
  with check (auth.uid() = auth_user_id);

-- No INSERT/DELETE policies for `authenticated`: profile creation happens in
-- the SECURITY DEFINER trigger, deletion is a server-side account operation.

drop policy if exists legacy_links_select_own on public.legacy_account_links;
create policy legacy_links_select_own on public.legacy_account_links
  for select to authenticated
  using (auth.uid() = auth_user_id);

drop policy if exists account_audit_select_own on public.account_audit;
create policy account_audit_select_own on public.account_audit
  for select to authenticated
  using (auth.uid() = user_id);

-- 8. Avatar storage bucket + policies ---------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  false,
  2097152, -- 2 MB, mirrored by MAX_AVATAR_BYTES on the API
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Objects are scoped to a folder named after the owner's auth id:
--   avatars/<auth.uid()>/avatar-<ts>.<ext>
drop policy if exists avatars_select_own on storage.objects;
create policy avatars_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_insert_own on storage.objects;
create policy avatars_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_update_own on storage.objects;
create policy avatars_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_delete_own on storage.objects;
create policy avatars_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
