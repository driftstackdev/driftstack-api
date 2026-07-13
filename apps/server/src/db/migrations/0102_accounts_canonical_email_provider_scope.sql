-- 2026-07-13 account-recovery security correction. Migration 0096
-- incorrectly treated RFC 5233 `+tag` subaddressing as universal and
-- stripped it for every email provider. RFC 5233 leaves subaddress handling
-- to the receiving system: outside providers with an explicit alias contract,
-- `alice@example.com` and `alice+tag@example.com` may be different mailboxes.
--
-- The application now folds both `+tag` and dots only for gmail.com and
-- googlemail.com. Bring already-populated canonical_email values into that
-- same contract so a legacy row cannot still resolve an anonymous recovery
-- request for a different non-Gmail mailbox.
--
-- Existing accounts.email values are normalized to lowercase on every real
-- creation path. lower() is retained here for defensive parity. The update is
-- idempotent and cannot introduce a new unique collision: 0096's stricter
-- canonical form already prevented two non-Gmail values that differed only by
-- a plus suffix from coexisting. This migration only expands each affected
-- canonical value back to its already-unique literal email.
UPDATE "accounts"
SET "canonical_email" = lower("email")
WHERE lower(split_part("email", '@', 2)) NOT IN ('gmail.com', 'googlemail.com')
  AND "canonical_email" IS DISTINCT FROM lower("email");
