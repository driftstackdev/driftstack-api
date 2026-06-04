-- 2026-06-05 — add 'pricing.updated' to the admin_audit_action enum.
-- The owner pricing editor (pricing-as-data Phase A, master-owner
-- cockpit) records an audit row whenever the owner edits a tier's
-- monthly price. Same ALTER TYPE … ADD VALUE shape as 0057/0061/0062/
-- 0063; runs outside a transaction. The owner price-edit route that
-- writes this action lands in the following increment — this migration
-- is the enum foundation so the route can audit from day one.
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'pricing.updated';
