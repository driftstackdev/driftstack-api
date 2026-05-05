-- V-202d — generic scheduled_jobs table for time-shifted background work.
--
-- Per founder verdict (2026-05-05) on V-173-pattern extension: this is
-- THE table for any cron-shaped or run-once-at-T+N work. Trial-pack
-- expiry is the first consumer; future jobs (subscription renewal
-- reminders, end-of-month usage rollups, etc.) reuse the same table
-- by adding a job_type discriminator value + a handler.
--
-- Multi-replica safety: the worker uses SELECT ... FOR UPDATE SKIP
-- LOCKED to atomically claim a row. Two concurrent workers never
-- claim the same job. Same pattern as V-173 webhook delivery worker.
--
-- Class A migration per V-198 taxonomy: additive new table, no
-- changes to existing rows.

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Discriminator. Drives which handler the worker dispatches to.
  -- Format: '<domain>.<event>' (e.g. 'trial_pack.expired',
  -- 'subscription.renewal_reminder'). No enum so adding new job_types
  -- doesn't require a migration.
  job_type text NOT NULL,

  -- Optional account-scope. Most lifecycle jobs are account-scoped
  -- (e.g. trial-pack expiry); some future jobs may be system-scoped
  -- (e.g. nightly usage rollup). Nullable supports both.
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,

  -- Job-type-specific data. The handler defines the payload shape.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- When to execute. Worker queries `WHERE run_at <= now()`.
  run_at timestamptz NOT NULL,

  -- Set when a worker claims the row (FOR UPDATE SKIP LOCKED).
  -- Cleared on completion / failure transition.
  locked_by text,
  locked_at timestamptz,

  -- Set on successful handler return.
  completed_at timestamptz,

  -- Set when attempts >= max_attempts and the last attempt failed.
  failed_at timestamptz,
  last_error text,

  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Worker query: pending jobs whose run_at has arrived, ordered by run_at.
-- Partial index keeps it small (only unfinished rows).
CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx
  ON scheduled_jobs (run_at)
  WHERE completed_at IS NULL AND failed_at IS NULL;

-- Per-account lookup for "is this job already enqueued?" idempotency
-- checks at enqueue time. Trial-pack expiry uses this: only one
-- pending trial_pack.expired job per account at a time.
CREATE INDEX IF NOT EXISTS scheduled_jobs_account_type_pending_idx
  ON scheduled_jobs (account_id, job_type)
  WHERE completed_at IS NULL AND failed_at IS NULL;
