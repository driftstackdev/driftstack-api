-- BYOK Anthropic per-customer key storage (Tier-3 verdicts LOCKED 2026-05-17).
--
-- Per docs/internal/byok-anthropic-key-storage-design.md, the customer-
-- dashboard chat UI needs to store the customer's Anthropic API key
-- per-account so subsequent chat turns don't re-prompt. The request-
-- level header `x-byok-anthropic-api-key` (SDK path, shipped commits
-- 1b97a5e0 + f2a6c603) continues to work as the per-request override.
--
-- Encryption: AES-256-GCM via the existing MFA_ENCRYPTION_KEY env var
-- (Tier-3 Q1 verdict 2026-05-17 — reuse over dedicated for operational
-- simplicity). The ciphertext bytea is the canonical encoding
-- `[12 bytes IV | 16 bytes auth tag | N bytes ciphertext]` so the
-- single bytea column self-contains the GCM parameters needed to
-- decrypt (matches the design doc shape).
--
-- NULL ciphertext means "no BYOK key set" — runtime resolution falls
-- back to the per-request header → then the deployment fallback
-- (BYOK_ANTHROPIC_FALLBACK_KEY env var; founder demo key).
--
-- set_at + last_used_at drive the dashboard UX strings:
--   - "Key configured on May 14, 2026"
--   - "Last used 3 minutes ago"
-- last_used_at is also a soft trust-indicator surface for customers
-- worried about silent leaks (any unexpected `last_used_at` bump is a
-- signal something used the key without their direct involvement).

ALTER TABLE "accounts"
  ADD COLUMN "byok_anthropic_api_key_ciphertext" bytea NULL,
  ADD COLUMN "byok_anthropic_api_key_set_at" timestamptz NULL,
  ADD COLUMN "byok_anthropic_api_key_last_used_at" timestamptz NULL;
