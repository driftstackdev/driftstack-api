-- v2-#11: BYOK Anthropic key TTL + rotation reminder dedupe.
--
-- Adds one dedupe column to accounts mirroring the v2-#10 webhook
-- secret rotation pattern. The recommendation is 90d (consistent
-- with the webhook secret policy in v2-#10).
--
-- accounts.byok_anthropic_api_key_set_at already exists (V-481
-- granular scopes migration), so we just need the reminder dedupe
-- column. The daily reminder job (v2-#11.5 follow-up) queries
-- `byok_anthropic_api_key_set_at < now() - 60d` plus the dedupe
-- guard.

ALTER TABLE "accounts"
  ADD COLUMN "byok_anthropic_api_key_last_reminder_sent_at" timestamptz;
