-- Module 3 — Space management.
--
-- Additive only: two owner-controlled invitation columns on `spaces` plus a
-- per-user favourites table. Existing rows keep working unchanged because both
-- columns have defaults matching the previous (implicit) behaviour.

-- ---------------------------------------------------------------------------
-- Invitation settings
-- ---------------------------------------------------------------------------
alter table public.spaces
  add column if not exists invitations_enabled boolean not null default true;

alter table public.spaces
  add column if not exists default_invite_role text not null default 'VIEWER';

-- A Space can hand out EDITOR or VIEWER, never OWNER.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'spaces_default_invite_role_check'
  ) then
    alter table public.spaces
      add constraint spaces_default_invite_role_check
      check (default_invite_role in ('EDITOR', 'VIEWER'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Favourite Spaces
-- ---------------------------------------------------------------------------
-- One row per (user, space). Starring is a personal preference only: it never
-- grants access, so every read of a starred Space still goes through membership.
create table if not exists public.space_favorites (
  user_id text not null references public.profiles(id) on delete cascade,
  space_id text not null references public.spaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, space_id)
);

create index if not exists space_favorites_user_idx
  on public.space_favorites (user_id, created_at desc);

alter table public.space_favorites enable row level security;

drop policy if exists space_favorites_select_own on public.space_favorites;
create policy space_favorites_select_own on public.space_favorites
  for select using (user_id = auth.uid()::text);

-- A user may only star a Space they can already open. The exists() check is the
-- database-level guard against starring someone else's Space.
drop policy if exists space_favorites_insert_own on public.space_favorites;
create policy space_favorites_insert_own on public.space_favorites
  for insert with check (
    user_id = auth.uid()::text
    and exists (
      select 1 from public.members m
      where m.space_id = space_favorites.space_id
        and m.user_id = auth.uid()::text
        and m.status = 'ACTIVE'
    )
  );

drop policy if exists space_favorites_delete_own on public.space_favorites;
create policy space_favorites_delete_own on public.space_favorites
  for delete using (user_id = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- Management query indexes
-- ---------------------------------------------------------------------------
-- Expiry filters and the "expiring soon" tab sort by deadline within a status.
create index if not exists spaces_status_expiry_idx on public.spaces (status, expiry_at);
create index if not exists spaces_purpose_idx on public.spaces (lower(purpose));
