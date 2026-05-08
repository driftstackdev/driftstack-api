-- V-304a — first-session-success email orchestration.
--
-- Mirrors the V-202c first_failure_email_sent_at column. When the
-- customer's first session completes successfully, the lifecycle
-- service races to set this column atomically; the winner sends the
-- email (one-shot, subsequent sessions don't email).

ALTER TABLE "account_lifecycle"
  ADD COLUMN IF NOT EXISTS "first_success_email_sent_at" timestamp with time zone;
