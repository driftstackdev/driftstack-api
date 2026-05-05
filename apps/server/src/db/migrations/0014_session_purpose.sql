-- V-169 — sessions.purpose column for AFP harness-config split.
-- Drives WebKit driver harness selection per Agent 1 Phase 3 work
-- (see docs/architecture/afp-harness-configuration.md once Agent 1
-- lands the cross-reference).
--
-- 'production_customer' is the default — every paying-customer session
-- created without explicit purpose lands here. Existing rows get the
-- default backfilled. The other two values
-- ('cumulative_rig_validation', 'test_domain_probe') are reserved
-- for internal validation tools, not customer-facing.

CREATE TYPE "public"."session_purpose" AS ENUM (
	'production_customer',
	'cumulative_rig_validation',
	'test_domain_probe'
);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "purpose" "session_purpose" NOT NULL DEFAULT 'production_customer';
