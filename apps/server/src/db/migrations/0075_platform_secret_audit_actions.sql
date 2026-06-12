-- 2026-06-12 — admin-cockpit secrets Phase A slice 2: per-action audit values
-- for the owner secrets-management routes. `secret.revealed` is the load-
-- bearing one (every decrypt is an audited event); created/updated/deleted
-- complete the lifecycle. Same ALTER TYPE ADD VALUE pattern as 0068/0070.
-- Runs outside a transaction; idempotent via IF NOT EXISTS.
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'secret.created';
--> statement-breakpoint
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'secret.updated';
--> statement-breakpoint
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'secret.deleted';
--> statement-breakpoint
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'secret.revealed';
