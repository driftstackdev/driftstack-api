-- v2-#10: webhook signing-secret rotation policy.
--
-- Adds two columns to webhook_endpoints that drive the 90d-rotation
-- nag behavior:
--
--   - secret_created_at: when the active secret was minted. Set on
--     create + reset on rotate (V-359 rotate path). NOT NULL with
--     default now() so backfilled rows look fresh — we don't fire a
--     wave of "rotate now" emails at migration time.
--
--   - last_reminder_sent_at: dedupe column for the daily reminder
--     job. Null = never sent. Job sets to now() when the email fires.
--
-- Default 90d active-secret TTL; SDK enforces 300s replay window per
-- existing verifier defaults. Two open verdicts (TTL configurable
-- per-endpoint vs fixed; replay-window account-level configurable vs
-- per-call) surfaced in docs/internal/webhook-secret-rotation-design.md
-- — both default to "fixed" pending founder verdict.

ALTER TABLE "webhook_endpoints"
  ADD COLUMN "secret_created_at" timestamptz NOT NULL DEFAULT now();

ALTER TABLE "webhook_endpoints"
  ADD COLUMN "last_reminder_sent_at" timestamptz;
