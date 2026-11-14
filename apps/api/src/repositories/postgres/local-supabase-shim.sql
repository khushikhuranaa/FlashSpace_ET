-- ============================================================================
-- LOCAL VERIFICATION SHIM — never run this against Supabase.
--
-- Supabase provides `auth.users` and `auth.uid()`. A plain local PostgreSQL
-- (used to verify the schema and the data-migration tooling in Module 15) does
-- not, so this file creates the minimal compatible surface:
--   * auth.users with the columns the migrations reference
--   * auth.uid() reading the same `request.jwt.claims` setting Supabase uses
--
-- Run once before the migrations when testing locally:
--   psql "$LOCAL_PG_URL" -f local-supabase-shim.sql
-- ============================================================================

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

-- Supabase Storage schema (buckets/objects + foldername helper).
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select string_to_array(name, '/') as path
$$;

-- Supabase ships these roles; RLS policies grant to them by name.
-- Roles are cluster-wide, so parallel test databases can race between the
-- existence check and CREATE ROLE. Catch the duplicate on either error code
-- instead of failing the whole migration for a role another run just created.
do $$
begin
  begin
    create role anon nologin noinherit;
  exception when duplicate_object or unique_violation then null;
  end;
  begin
    create role authenticated nologin noinherit;
  exception when duplicate_object or unique_violation then null;
  end;
  begin
    create role service_role nologin noinherit bypassrls;
  exception when duplicate_object or unique_violation then null;
  end;
end $$;
