-- 2026-06-10 — W415 scheduled_jobs claim performance. The worker claim query
-- (scheduled-jobs-repo.ts) is
--   WHERE run_at <= now AND completed_at IS NULL AND failed_at IS NULL
--         AND (locked_by IS NULL OR locked_at < <stale>)
--   ORDER BY run_at ASC FOR UPDATE SKIP LOCKED
-- and was backed only by scheduled_jobs_due_idx(run_at). As finished jobs
-- accumulate (no retention sweep yet), that full index increasingly points at
-- completed/failed rows the claim must scan + skip. This PARTIAL index covers
-- only UNFINISHED jobs ordered by run_at, so the claim stays O(due-unfinished)
-- regardless of the finished backlog.
--
-- Partial index — drizzle's index() can't express the WHERE, so it lives here
-- as raw SQL (same pattern as the agent_sessions idempotency partial-unique in
-- 0047). IF NOT EXISTS = idempotent. Plain CREATE INDEX is instant on the
-- currently-small table; if ever rebuilt on a large (post-launch) table, switch
-- to CREATE INDEX CONCURRENTLY (outside a transaction) per the W414 note.
CREATE INDEX IF NOT EXISTS "scheduled_jobs_claim_idx"
  ON "scheduled_jobs" ("run_at")
  WHERE "completed_at" IS NULL AND "failed_at" IS NULL;
