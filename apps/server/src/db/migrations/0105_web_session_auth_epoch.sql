-- Serialize web-session authority with password changes. Existing accounts
-- and sessions start at epoch zero, preserving their current validity. A
-- password change increments accounts.auth_epoch; session mint and auth reads
-- require the recorded web_sessions.auth_epoch to match.
ALTER TABLE "accounts"
  ADD COLUMN "auth_epoch" integer DEFAULT 0 NOT NULL;

ALTER TABLE "web_sessions"
  ADD COLUMN "auth_epoch" integer DEFAULT 0 NOT NULL;
