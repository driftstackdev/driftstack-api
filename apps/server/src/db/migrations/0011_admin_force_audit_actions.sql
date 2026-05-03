-- V-100: extend admin_audit_action enum with two force-actions
-- backing the admin panel's manual session termination + API key
-- revocation operations.

ALTER TYPE "public"."admin_audit_action" ADD VALUE IF NOT EXISTS 'session.destroyed_by_admin';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE IF NOT EXISTS 'api_key.revoked_by_admin';
