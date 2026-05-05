-- V-174 — extend api_key_scope enum with 'account_owner' +
-- 'driftstack_internal_admin'. The pre-V-174 'admin' value stays as
-- a compat alias during the migration window (handled at service
-- layer via lib/errors-helpers.ts::requireScope).
--
-- After this migration:
--   - New API keys + web sessions can be issued with the new values.
--   - Existing 'admin'-scoped keys continue to work (compat path
--     in requireScope treats 'admin' as covering both new scopes).
--   - Founder-driven migration script (separate V-NNN) re-scopes
--     existing rows to the explicit new values; 'admin' deprecates
--     after that.

ALTER TYPE "public"."api_key_scope" ADD VALUE IF NOT EXISTS 'account_owner';--> statement-breakpoint
ALTER TYPE "public"."api_key_scope" ADD VALUE IF NOT EXISTS 'driftstack_internal_admin';
