-- V-216 — customer-facing audit log.
--
-- Mirrors admin_audit_log shape but scoped to a single customer
-- account: customer-initiated actions on their own account
-- (mints / revokes / session creates / profile changes / etc.) plus
-- system-initiated events on the account (subscription updated by
-- Stripe webhook, etc.) and any staff-initiated actions that touched
-- the account.
--
-- Append-only: the service exposes only an insert path and a paginated
-- read. No UPDATE / DELETE methods. Same posture as admin_audit_log
-- per D-025.
--
-- `actor_type` distinguishes:
--   - 'customer' — the account holder via API key or web session.
--   - 'system' — Driftstack-internal automation (Stripe webhook
--                handlers, scheduled jobs, etc.).
--   - 'staff' — driftstack_internal_admin scope action against this
--               account. Mirror of an entry in admin_audit_log.

CREATE TABLE IF NOT EXISTS "account_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "actor_type" text NOT NULL,
  "actor_account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "actor_key_id" uuid REFERENCES "api_keys"("id") ON DELETE SET NULL,
  "action" text NOT NULL,
  "target_resource_id" text,
  "payload" jsonb,
  "ip_address" text,
  "user_agent" text,
  "timestamp" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "account_audit_log_account_idx"
  ON "account_audit_log" ("account_id", "timestamp");
CREATE INDEX IF NOT EXISTS "account_audit_log_action_idx"
  ON "account_audit_log" ("account_id", "action", "timestamp");
