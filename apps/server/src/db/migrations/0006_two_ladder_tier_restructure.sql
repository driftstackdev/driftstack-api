-- ADR-004 / V-073 enum rewrite: account_tier goes from
-- ('free','starter','solo','builder','scale','enterprise') to
-- ('trial_pack','solo_manual','team_manual','agency_manual',
--  'api_starter','api_builder','api_scale','enterprise').
--
-- Same Postgres-safe sequence as 0001 (drop default → text-cast →
-- defensive UPDATE → drop old type → create new type → cast back →
-- restore default), with explicit old→new mapping for any pre-launch
-- test data. Pre-launch no production customers, but local dev /
-- staging databases may have rows in the old tier values; the UPDATE
-- block handles that case idempotently.
--
-- Old → new mapping (preserves semantic intent where possible;
-- arbitrary picks where no clean mapping exists):
--   'free'        → 'trial_pack'  (1 concurrent → 1 concurrent)
--   'starter'     → 'api_starter' (2 concurrent → 2 concurrent)
--   'solo'        → 'api_starter' (was 4 concurrent; nearest API tier)
--   'builder'     → 'api_builder' (8 concurrent → 8 concurrent)
--   'scale'       → 'api_scale'   (24 concurrent → 24 concurrent)
--   'enterprise'  → 'enterprise'  (unchanged)

ALTER TABLE "public"."accounts" ALTER COLUMN "tier" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."accounts" ALTER COLUMN "tier" SET DATA TYPE text;--> statement-breakpoint
UPDATE "public"."accounts" SET "tier" = 'trial_pack'  WHERE "tier" = 'free';--> statement-breakpoint
UPDATE "public"."accounts" SET "tier" = 'api_starter' WHERE "tier" = 'starter';--> statement-breakpoint
UPDATE "public"."accounts" SET "tier" = 'api_starter' WHERE "tier" = 'solo';--> statement-breakpoint
UPDATE "public"."accounts" SET "tier" = 'api_builder' WHERE "tier" = 'builder';--> statement-breakpoint
UPDATE "public"."accounts" SET "tier" = 'api_scale'   WHERE "tier" = 'scale';--> statement-breakpoint
DROP TYPE "public"."account_tier";--> statement-breakpoint
CREATE TYPE "public"."account_tier" AS ENUM('trial_pack', 'solo_manual', 'team_manual', 'agency_manual', 'api_starter', 'api_builder', 'api_scale', 'enterprise');--> statement-breakpoint
ALTER TABLE "public"."accounts" ALTER COLUMN "tier" SET DATA TYPE "public"."account_tier" USING "tier"::"public"."account_tier";--> statement-breakpoint
ALTER TABLE "public"."accounts" ALTER COLUMN "tier" SET DEFAULT 'trial_pack';
