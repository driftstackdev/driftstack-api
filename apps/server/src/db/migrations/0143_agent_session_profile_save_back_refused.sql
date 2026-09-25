-- 0143 — a session that did not start from its profile's stored state may not
-- save the profile back.
--
-- A profile-backed session is dispatched with the profile's restore URL when a
-- stored state exists, and the device saves the state back at teardown. When the
-- dispatch cannot give the device that stored state — the restore/save-back URLs
-- could not be minted, the profile's key could not be unwrapped, or private
-- storage is not configured — the session still runs, but it starts from an EMPTY
-- profile. Its teardown save used to be accepted and written over the stored
-- profile, replacing the customer's cookies, logins and site data with a profile
-- that started empty.
--
-- `profile_save_back_refused` records that refusal on the session row, in the
-- same active-only UPDATE that claims the session for its device, so it is
-- durable before the device is told to start: a server restart between
-- dispatch and save-back does not lose it. The save-back consumer reads it and
-- refuses the save.
--
-- ADDITIVE. One `boolean NOT NULL DEFAULT false` column. The default is a
-- constant, so Postgres 11+ records it in the catalog without rewriting a row,
-- and every existing session reads as "not refused" — the behaviour it had
-- before this migration. No index (it is read only with the row it belongs to),
-- no constraint, no other table. The lock timeout makes a busy table fail the
-- batch fast and whole, which is safe to retry.
--
-- Reversible: drop the column.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "profile_save_back_refused" boolean DEFAULT false NOT NULL;
