-- 007: local email verification timestamp.
-- Additive only: local accounts created before this migration stay unverified
-- until they follow a verification link, which is the correct default.
alter table public.profiles
  add column if not exists email_verified_at timestamptz;
