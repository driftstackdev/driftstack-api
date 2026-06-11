-- 2026-06-11 — launch-archetype cutover. The v1.0 launch DEFAULT archetype
-- moves from 'iphone16pro_ios18_7_safari26_4' to 'iphone17_ios18_7_safari26_4',
-- which is the single real-device-verified ("validator-PASS") archetype per
-- Agent-1's atlas catalog (operations/archetype-catalog.json: status=ready).
-- iphone16pro is now a scaffolded (coming_soon) reference baseline; minting it
-- as the column default would serve a detectably-wrong fingerprint to any
-- profile/session created without an explicit archetype.
--
-- This only changes the DEFAULT for NEW rows where archetype is omitted —
-- existing profiles/sessions keep their pinned archetype (profile-archetype-pin
-- stability contract). Safe, non-breaking: no data rewrite, no constraint change.
ALTER TABLE "profiles" ALTER COLUMN "archetype" SET DEFAULT 'iphone17_ios18_7_safari26_4';--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "archetype" SET DEFAULT 'iphone17_ios18_7_safari26_4';
