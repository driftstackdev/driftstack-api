-- V-204 — per-account email notification preferences.
--
-- Customers can opt out of "lifecycle" emails (signup-welcome,
-- session-failed-first, tier-changed, trial-pack-purchased,
-- trial-pack-expired). Security + financial emails (signup-
-- verification, password-reset, billing-failure, subscription-
-- cancellation, support-ack) are unaffected — those always send.
--
-- Schema: (account_id, event_type) primary key. Absence of a row
-- means "opted in" by default. Explicit opt-out writes a row with
-- opted_in=false. This keeps the steady-state cheap (no row per
-- account by default).

CREATE TABLE IF NOT EXISTS "account_email_preferences" (
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "opted_in" boolean NOT NULL DEFAULT true,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("account_id", "event_type")
);

CREATE INDEX IF NOT EXISTS "account_email_preferences_account_idx"
  ON "account_email_preferences" ("account_id");
