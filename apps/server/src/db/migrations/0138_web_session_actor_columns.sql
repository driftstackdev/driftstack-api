-- 0138 — an action taken from a signed-in browser is recorded against its web
-- session.
--
-- The admin panel and the customer dashboard both sign in with a web session,
-- and a web session acts with the synthetic key id `wsk_<web session uuid>`
-- (services/auth.ts). Every column below records the ACTING key and was a
-- `uuid`, most with a foreign key to `api_keys`, so a web session's id could not
-- be written into any of them:
--
--   · an audited admin write committed its change and then failed its audit
--     insert ("invalid input syntax for type uuid"), answering 500 for a change
--     that had happened (production, 2026-05-27: an account tier change);
--   · where the acting key is part of the change itself — a price, a platform
--     secret, a rate-limit override, an incident and its timeline, a rate card,
--     an AI plan override — the change failed, and the AI-credits staff tools,
--     which write their audit row inside the change's transaction, refused
--     every change;
--   · a customer's own action (an API key minted from the dashboard) succeeded
--     and its account audit row, a best-effort write, silently never existed.
--
-- Each column keeps what it holds and gains a sibling,
-- `<same prefix>_web_session_id uuid`, with NO foreign key: an audit row must
-- outlive the session it names. A session row is deleted with its account, and
-- a foreign key would then either block that deletion or erase who acted. One
-- helper (apps/server/src/lib/acting-key-columns.ts) writes exactly one of the
-- two and reads them back into the string the auth context had.
--
--   · The three columns that were NOT NULL — admin_audit_log.admin_key_id,
--     ai_credits_admin_audit_log.admin_key_id, rate_limit_overrides.set_by_key_id
--     — become nullable, and a CHECK requires EXACTLY ONE of the pair: every
--     such row names who acted. Every existing row has its key and no session.
--   · The seven that were already nullable (a system write, an auto-created
--     incident, a seeded price record no actor) get a CHECK that the pair is
--     never BOTH set.
--   · The rate-card guard (0127) is replaced with the same body and ONE change:
--     the new column joins the terms a withdrawal may not change, beside
--     `created_by_key_id`, which is already one of them.
--
-- ADDITIVE. Every new column is nullable with no default: a catalog change that
-- rewrites no row. DROP NOT NULL is a catalog change too. Each CHECK is
-- validated by one scan of its table under the table's ACCESS EXCLUSIVE lock,
-- and every existing row passes it by construction (its new column is NULL).
-- The lock timeout makes a busy table fail the batch fast and whole, which is
-- safe to retry.
--
-- Reversible: drop the ten CHECKs and the ten columns, restore 0127's guard, and
-- SET NOT NULL on the three columns — which succeeds only once every row a web
-- session wrote there has been removed or re-attributed.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "admin_audit_log" ALTER COLUMN "admin_key_id" DROP NOT NULL;
ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "admin_web_session_id" uuid;
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_one_actor"
  CHECK (num_nonnulls("admin_key_id", "admin_web_session_id") = 1);

ALTER TABLE "ai_credits_admin_audit_log" ALTER COLUMN "admin_key_id" DROP NOT NULL;
ALTER TABLE "ai_credits_admin_audit_log" ADD COLUMN IF NOT EXISTS "admin_web_session_id" uuid;
ALTER TABLE "ai_credits_admin_audit_log" ADD CONSTRAINT "ai_credits_admin_audit_log_one_actor"
  CHECK (num_nonnulls("admin_key_id", "admin_web_session_id") = 1);

ALTER TABLE "rate_limit_overrides" ALTER COLUMN "set_by_key_id" DROP NOT NULL;
ALTER TABLE "rate_limit_overrides" ADD COLUMN IF NOT EXISTS "set_by_web_session_id" uuid;
ALTER TABLE "rate_limit_overrides" ADD CONSTRAINT "rate_limit_overrides_one_actor"
  CHECK (num_nonnulls("set_by_key_id", "set_by_web_session_id") = 1);

ALTER TABLE "account_audit_log" ADD COLUMN IF NOT EXISTS "actor_web_session_id" uuid;
ALTER TABLE "account_audit_log" ADD CONSTRAINT "account_audit_log_at_most_one_actor"
  CHECK (num_nonnulls("actor_key_id", "actor_web_session_id") <= 1);

ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "created_by_admin_web_session_id" uuid;
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_at_most_one_actor"
  CHECK (num_nonnulls("created_by_admin_key_id", "created_by_admin_web_session_id") <= 1);

ALTER TABLE "incident_updates" ADD COLUMN IF NOT EXISTS "posted_by_admin_web_session_id" uuid;
ALTER TABLE "incident_updates" ADD CONSTRAINT "incident_updates_at_most_one_actor"
  CHECK (num_nonnulls("posted_by_admin_key_id", "posted_by_admin_web_session_id") <= 1);

ALTER TABLE "pricing" ADD COLUMN IF NOT EXISTS "updated_by_web_session_id" uuid;
ALTER TABLE "pricing" ADD CONSTRAINT "pricing_at_most_one_actor"
  CHECK (num_nonnulls("updated_by_key_id", "updated_by_web_session_id") <= 1);

ALTER TABLE "platform_secrets" ADD COLUMN IF NOT EXISTS "updated_by_web_session_id" uuid;
ALTER TABLE "platform_secrets" ADD CONSTRAINT "platform_secrets_at_most_one_actor"
  CHECK (num_nonnulls("updated_by_key_id", "updated_by_web_session_id") <= 1);

ALTER TABLE "credit_rate_cards" ADD COLUMN IF NOT EXISTS "created_by_web_session_id" uuid;
ALTER TABLE "credit_rate_cards" ADD CONSTRAINT "credit_rate_cards_at_most_one_actor"
  CHECK (num_nonnulls("created_by_key_id", "created_by_web_session_id") <= 1);

ALTER TABLE "credit_plan_overrides" ADD COLUMN IF NOT EXISTS "set_by_web_session_id" uuid;
ALTER TABLE "credit_plan_overrides" ADD CONSTRAINT "credit_plan_overrides_at_most_one_actor"
  CHECK (num_nonnulls("set_by_key_id", "set_by_web_session_id") <= 1);

CREATE OR REPLACE FUNCTION "credit_rate_cards_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."announced_at" := now();
    NEW."withdrawn_at" := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."withdrawn_at" IS NULL
     AND NEW."withdrawn_at" IS NOT NULL
     AND clock_timestamp() < OLD."effective_at"
     AND (NEW."version", NEW."markup_bp", NEW."announced_at", NEW."effective_at",
          NEW."created_by_key_id", NEW."created_by_web_session_id", NEW."note")
         IS NOT DISTINCT FROM
         (OLD."version", OLD."markup_bp", OLD."announced_at", OLD."effective_at",
          OLD."created_by_key_id", OLD."created_by_web_session_id", OLD."note") THEN
    NEW."withdrawn_at" := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'credit_rate_cards rows are immutable: % refused', TG_OP USING ERRCODE = '55000';
END $$;
