-- 0135 — S16 widens the AI-credits admin audit trail (0134) with the two
-- actions the per-account cutover and rollback write: moving one account onto
-- credits, and rolling one back to legacy.
--
-- Same table, same shape, same reason 0134 gives in full for a CHECK-backed
-- text column rather than six (now eight) more values on the PUBLISHED
-- `admin_audit_action` enum: those two words describe a feature that ships
-- dark, and `admin.ts` ships to npm unconditionally while `ai-credits.ts`
-- does not.
--
-- ADDITIVE. Every value 0134 already accepts stays accepted, so no existing
-- row could violate the widened CHECK (there are none in production yet —
-- AI credits ship dark). DROP + re-ADD keeps the file re-runnable, the same
-- shape a plain model-CHECK widening already uses elsewhere in this history.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "ai_credits_admin_audit_log"
  DROP CONSTRAINT IF EXISTS "ai_credits_admin_audit_log_action_check";

ALTER TABLE "ai_credits_admin_audit_log" ADD CONSTRAINT "ai_credits_admin_audit_log_action_check"
  CHECK ("action" IN (
    'credits.goodwill_granted',
    'credits.debt_forgiven',
    'credits.plan_override_set',
    'credits.plan_override_cleared',
    'rate_card.published',
    'rate_card.withdrawn',
    'credits.cutover_moved',
    'credits.cutover_rolled_back'
  ));
