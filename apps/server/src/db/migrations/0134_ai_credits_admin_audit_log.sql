-- S15 — a SEPARATE, DARK audit trail for the AI-credits admin tools: contract
-- credits (plan override), goodwill grants and debt forgiveness, and rate-card
-- publishing.
--
-- ⛔ WHY A NEW TABLE, NOT SIX NEW `admin_audit_action` VALUES. The obvious move
-- — `ALTER TYPE "admin_audit_action" ADD VALUE 'credits.goodwill_granted'` —
-- was tried first and reverted. `admin_audit_action` is a PUBLISHED contract:
-- `admin-audit-action-cross-source-invariant.test.ts` (W862) pins
-- `AdminAuditActionSchema` in `packages/api-types/src/admin.ts` and this
-- table's pgEnum to the SAME exact 33-value set, and `admin.ts` ships to npm
-- unconditionally (unlike `ai-credits.ts`, which `package.json`'s `files`
-- withholds via `!dist/ai-*`). Any value containing the word "credit" added
-- there would ship in `dist/admin.js`/`dist/admin.d.ts` the next publish —
-- exactly the leak `the-published-api-types-withholds-the-unreleased-pricing
-- .test.ts`'s word-level shipped-file scan exists to catch (its own
-- KNOWN_LEAK_HANDOFF note records the same failure mode once already, for
-- `monthly_credits` on `ChangeTierRequest`). `AI_CREDITS_PROBLEM_TYPES` in
-- `ai-credits.ts` is this exact codebase's own precedent for the fix: a
-- SEPARATE roster for a dark-until-launch vocabulary, not a shared one with an
-- exemption. This table is that pattern applied to the admin audit trail.
--
-- Same shape as `admin_audit_log` (0003) — actor, target, free-form payload,
-- result, IP, timestamp — except `action` is a plain `text` column with a
-- CHECK instead of a Postgres enum. A CHECK needs no published mirror (unlike
-- an enum type, nothing reads its allowed-value list from outside this
-- database), so the vocabulary can live entirely here. Append-only by
-- convention, same as `admin_audit_log`: the repo exposes insert + list only.

CREATE TABLE "ai_credits_admin_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "admin_account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE RESTRICT,
  "admin_key_id" uuid NOT NULL REFERENCES "api_keys"("id") ON DELETE RESTRICT,
  "action" text NOT NULL,
  "target_account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "target_resource_id" text,
  "input_payload" jsonb,
  "result" text NOT NULL,
  "ip_address" text,
  "timestamp" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_credits_admin_audit_log_action_check" CHECK ("action" IN (
    'credits.goodwill_granted',
    'credits.debt_forgiven',
    'credits.plan_override_set',
    'credits.plan_override_cleared',
    'rate_card.published',
    'rate_card.withdrawn'
  ))
);
--> statement-breakpoint
CREATE INDEX "ai_credits_admin_audit_log_admin_idx"
  ON "ai_credits_admin_audit_log" USING btree ("admin_account_id", "timestamp");
--> statement-breakpoint
CREATE INDEX "ai_credits_admin_audit_log_target_idx"
  ON "ai_credits_admin_audit_log" USING btree ("target_account_id", "timestamp");
--> statement-breakpoint
CREATE INDEX "ai_credits_admin_audit_log_action_idx"
  ON "ai_credits_admin_audit_log" USING btree ("action", "timestamp");
