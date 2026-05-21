-- 2026-05-22 — add 'webhook_delivery.discarded' to the
-- admin_audit_action enum. The admin DLQ surface gains a "Discard"
-- button that hard-deletes the row (irrecoverable; payload gone).
-- The audit log entry is the only post-discard forensic trace.
--
-- Postgres enum-value addition is an ALTER TYPE … ADD VALUE — must
-- run OUTSIDE a transaction. The drizzle migrate harness already
-- splits statements at the ;--> breakpoints; this single ADD VALUE
-- is safe as a one-shot.
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'webhook_delivery.discarded';
