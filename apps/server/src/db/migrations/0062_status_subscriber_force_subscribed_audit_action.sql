-- 2026-05-22 — add 'status_subscriber.force_subscribed' to the
-- admin_audit_action enum. The admin status-subscribers page gains
-- a "Add subscriber" form that bypasses the public double-opt-in
-- flow when staff has out-of-band consent (sales handoff,
-- customer-support ticket). Same ALTER TYPE … ADD VALUE shape as
-- 0061; runs outside a transaction.
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'status_subscriber.force_subscribed';
