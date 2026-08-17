-- 2026-08-17 — index the columns the retention sweeps actually filter on.
--
-- Every retention sweep selects by a timestamp cutoff: the audit archive runs
-- `WHERE <ts> < now - 90d ORDER BY <ts>, id` per table, and the V-295c3
-- subscriber purge runs `WHERE unsubscribed_at < cutoff AND email IS NOT NULL`.
-- None of those columns led an index, so each sweep was a sequential scan of the
-- whole table. Verified against the migrated database rather than inferred:
--
--   session_events        (session_id) and (session_id, created_at)
--   webhook_deliveries    (status, next_attempt_at), (webhook_id, created_at),
--                         (event_id)
--   admin_audit_log       (admin_account_id|target_account_id|action, timestamp)
--   legal_acceptances     (account_id, document), (account_id), (doc, version)
--   status_subscribers    (confirmed_at, unsubscribed_at) + the two token idxs
--
-- In each case the retention column exists in a composite but never leading, so
-- a predicate on it alone cannot use the index.
--
-- The pattern is already established and was simply not extended: 0109 added
-- `accounts_deleted_purge_idx` for the deletion purge, and
-- `processed_stripe_events_received_idx` covers the one archive table that IS
-- indexed. This brings the other four archive tables and the subscriber purge in
-- line with them.
--
-- This matters most on session_events, which AUDIT_TABLES documents as growing
-- without bound (sessions are marked-destroyed, never row-deleted) — so it is
-- both the largest table and the one whose sweep is least affordable to have
-- scanning end to end.
--
-- Built non-concurrently, for the same reason 0109 records: the drizzle
-- postgres-js migrator wraps each file in a transaction and CREATE INDEX
-- CONCURRENTLY cannot run inside one. At present scale these builds are
-- sub-second. If any of these tables grows to where a brief write lock during
-- deploy is unacceptable, the statement needs to move out of the migrator and
-- run standalone as CONCURRENTLY. IF NOT EXISTS keeps that path idempotent.

CREATE INDEX IF NOT EXISTS "session_events_created_idx"
  ON "session_events" ("created_at");

CREATE INDEX IF NOT EXISTS "webhook_deliveries_created_idx"
  ON "webhook_deliveries" ("created_at");

CREATE INDEX IF NOT EXISTS "admin_audit_log_timestamp_idx"
  ON "admin_audit_log" ("timestamp");

CREATE INDEX IF NOT EXISTS "legal_acceptances_accepted_idx"
  ON "legal_acceptances" ("accepted_at");

-- Partial, matching the purge predicate: rows whose email has already been
-- erased are exactly the ones the sweep never needs to look at again, and they
-- accumulate permanently. Same shape as 0109's partial purge index.
CREATE INDEX IF NOT EXISTS "status_subscribers_unsubscribed_purge_idx"
  ON "status_subscribers" ("unsubscribed_at")
  WHERE "email" IS NOT NULL;
