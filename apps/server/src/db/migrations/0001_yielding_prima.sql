-- D-019 enum rename: account_tier goes from ('free','starter','pro','enterprise')
-- to ('free','starter','solo','builder','scale','enterprise'). The auto-generated
-- migration that drizzle-kit emits is incorrect for Postgres because
-- accounts.tier carries a DEFAULT that depends on the enum type — DROP TYPE
-- without first dropping the default fails with "default value for column tier
-- of table accounts depends on type account_tier" (V-008 captures this finding).
--
-- Correct sequence: drop default → text-cast column → defensive UPDATE → drop
-- old type → create new type → cast column back → restore default.

ALTER TABLE "public"."accounts" ALTER COLUMN "tier" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."accounts" ALTER COLUMN "tier" SET DATA TYPE text;--> statement-breakpoint
-- Map any pre-rename rows. Pre-launch no-op; kept for idempotency.
UPDATE "public"."accounts" SET "tier" = 'builder' WHERE "tier" = 'pro';--> statement-breakpoint
DROP TYPE "public"."account_tier";--> statement-breakpoint
CREATE TYPE "public"."account_tier" AS ENUM('free', 'starter', 'solo', 'builder', 'scale', 'enterprise');--> statement-breakpoint
ALTER TABLE "public"."accounts" ALTER COLUMN "tier" SET DATA TYPE "public"."account_tier" USING "tier"::"public"."account_tier";--> statement-breakpoint
ALTER TABLE "public"."accounts" ALTER COLUMN "tier" SET DEFAULT 'free';
