-- 2026-08-01 (V-726) — record which account minted each API key, so removing a
-- team member can revoke the credentials they created.
--
-- A team member with the `admin` role can mint API keys on the OWNER's account
-- (POST /v1/api-keys with X-Driftstack-Account). The key is stored with
-- account_id = the owner, and authentication resolves the account straight from
-- account_id without ever re-checking the minter's membership. So deleting the
-- membership did nothing to the key: an offboarded member kept a live
-- credential carrying full owner authority, for as long as the key existed.
--
-- Nothing linked a key to the member who created it, so the owner could not
-- even identify which keys to revoke by hand — the gap was both unclosed and
-- invisible.
--
-- ON DELETE SET NULL rather than CASCADE, deliberately: if the member's account
-- is later deleted the key must SURVIVE (the owner's integrations may depend on
-- it) and only lose its attribution. Dropping keys on account deletion would
-- turn an unrelated account closure into an outage on someone else's workspace.
--
-- Additive + nullable + not backfilled: existing rows have no recorded minter
-- and NULL means "unknown", never "minted by the owner". Removal therefore
-- revokes only keys it can positively attribute to the departing member; a
-- pre-migration key is left alone rather than guessed at.
ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "created_by_account_id" uuid REFERENCES "accounts" ("id") ON DELETE SET NULL;
--> statement-breakpoint
-- Supports the removal sweep: keys on one owner minted by one member.
CREATE INDEX IF NOT EXISTS "api_keys_account_created_by_idx"
  ON "api_keys" ("account_id", "created_by_account_id")
  WHERE "created_by_account_id" IS NOT NULL AND "revoked_at" IS NULL;
