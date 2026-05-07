-- V-281 — extend admin_audit_action enum with 'audit_note.added' +
-- 'refund.recorded' for the customer-support tooling.
--
-- Both are audit-only actions:
--   - 'audit_note.added' = operator attached a free-form support note
--     to a customer account.
--   - 'refund.recorded' = operator manually issued a Stripe refund via
--     the dashboard and recorded the action here. Money movement
--     happens out-of-band; this row is the receipt.
--
-- ADD VALUE IF NOT EXISTS so re-running on a partially-migrated
-- environment is safe.

ALTER TYPE "public"."admin_audit_action" ADD VALUE IF NOT EXISTS 'audit_note.added';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE IF NOT EXISTS 'refund.recorded';
