-- D-025 audit-gap fix — admin_audit_action enum gains 6 values for the
-- two admin route files that had zero audit wiring: admin-crypto-orders.ts
-- (sweep-expired / apply-ipn / internal-note) and
-- admin-validation-harness.ts (upsert / remove / trigger).
--
-- Every /v1/admin/* endpoint is supposed to write one admin_audit_log row
-- before returning (D-025, enforced by code in AdminAuditService.record()).
-- These 6 mutating endpoints predated that convention being applied to
-- their route files, so an operator (or a misused admin API key) could
-- sweep/advance/annotate crypto orders or edit the validation-harness
-- schedule with zero forensic record. This migration only widens the
-- closed vocabulary; apps/server/src/routes/admin-crypto-orders.ts +
-- admin-validation-harness.ts now call audit.record(...) on both the
-- success and failure path of each mutation.
--
-- Pure additive enum extension; same shape as 0084's mac_node.control
-- addition. IF NOT EXISTS guard so reapplying after a rollback stays safe.

ALTER TYPE "public"."admin_audit_action"
  ADD VALUE IF NOT EXISTS 'crypto_order.swept';
ALTER TYPE "public"."admin_audit_action"
  ADD VALUE IF NOT EXISTS 'crypto_order.ipn_applied';
ALTER TYPE "public"."admin_audit_action"
  ADD VALUE IF NOT EXISTS 'crypto_order.note_updated';
ALTER TYPE "public"."admin_audit_action"
  ADD VALUE IF NOT EXISTS 'validation_schedule.upserted';
ALTER TYPE "public"."admin_audit_action"
  ADD VALUE IF NOT EXISTS 'validation_schedule.removed';
ALTER TYPE "public"."admin_audit_action"
  ADD VALUE IF NOT EXISTS 'validation_schedule.triggered';
