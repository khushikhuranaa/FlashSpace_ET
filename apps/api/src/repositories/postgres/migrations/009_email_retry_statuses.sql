-- 009: allow the email queue's real status set.
--
-- Migration 006 constrained email_jobs.status to PENDING/SENT/FAILED/CANCELLED,
-- but the EmailService has always written PROCESSING before an attempt and
-- RETRY_SCHEDULED between retries. Without this migration every retry write
-- fails the check constraint on PostgreSQL.
--
-- The constraint replacement is additive in behaviour; no rows are rewritten.

alter table public.email_jobs
  drop constraint if exists email_jobs_status_check;

alter table public.email_jobs
  add constraint email_jobs_status_check
  check (status in ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'RETRY_SCHEDULED', 'CANCELLED'));
