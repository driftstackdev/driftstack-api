-- 0142 — a session's GUI control key remembers who minted it.
--
-- Security sweep #2 found that the per-session GUI control key
-- (`gui_control_key_ciphertext`) was bound only to its session and a 24-hour
-- expiry. The key skips every scope and ownership check on the session's control
-- and read routes, so it kept working after the credential or the team
-- membership that minted it was taken away: a removed team admin, a revoked API
-- key and a revoked desktop device key all went on driving the session until the
-- key expired, and the owner could not rotate it, because the mint route handed
-- every caller the same key.
--
-- The key now records its minting principal, and every use of the key re-checks
-- that principal against the live rows:
--
--   · `gui_control_key_minted_by_account_id` — the calling account: the session
--     owner, or the team member acting on the owner's behalf;
--   · `gui_control_key_minted_by_api_key_id` — the API key (a desktop device key
--     or an OAuth grant is an API key too) that called the mint, when the caller
--     used one;
--   · `gui_control_key_minted_by_web_session_id` — the signed-in browser session
--     that called the mint, when the caller used one;
--   · `gui_control_key_minted_by_membership_id` — the team membership the member
--     acted through; NULL when the owner minted it.
--
-- A CHECK keeps a key to at most one minting credential. No foreign keys: the
-- use-time check reads the live key, web session and membership rows and refuses
-- a key whose row is missing, so a dangling id fails closed on its own, and a
-- foreign key would add a lock and a scan to every team-membership delete.
--
-- ADDITIVE. Every new column is nullable with no default: a catalog change that
-- rewrites no row. The CHECK is validated by one scan of the table under its
-- ACCESS EXCLUSIVE lock, and every existing row passes it (its new columns are
-- NULL). An existing key has no recorded minter, so the use-time check refuses
-- it: a desktop Simulator window open across the deploy loses control once, and
-- gets it back when the session is reopened from the app (on Windows and Linux,
-- after that window is closed), whose mint then issues a fresh, recorded key.
-- The lock timeout makes a busy table fail the batch fast and whole, which is
-- safe to retry.
--
-- Reversible: drop the CHECK and the four columns.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "gui_control_key_minted_by_account_id" uuid;

ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "gui_control_key_minted_by_api_key_id" uuid;

ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "gui_control_key_minted_by_web_session_id" uuid;

ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "gui_control_key_minted_by_membership_id" uuid;

ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_gui_control_key_one_minter_credential"
  CHECK (num_nonnulls("gui_control_key_minted_by_api_key_id", "gui_control_key_minted_by_web_session_id") <= 1);
