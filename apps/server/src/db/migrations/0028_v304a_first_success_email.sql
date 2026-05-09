-- V-304a — first-session-success email orchestration.
--
-- Mirrors the V-202c first_failure_email_sent_at column on accounts.
-- When the customer's first session completes successfully, the
-- lifecycle service races to set this column atomically; the winner
-- sends the email (one-shot, subsequent sessions don't email).
--
-- V-278.G fix: original migration referenced a non-existent
-- "account_lifecycle" table (typo at V-304a write-time; schema.ts
-- correctly placed the column on `accounts`). Caught when running
-- migrations against Neon Postgres for the first time. No prod DB
-- has applied this migration yet, so in-place correction is safe.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS first_success_email_sent_at timestamptz;
