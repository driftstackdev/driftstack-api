-- 2026-05-27 — retire the one-time trial_pack tier in favour of a
-- perpetual FREE tier (founder verdict 2026-05-27; resolves findings
-- #6 [unmetered trial credit] + #10 [crypto checkout-vs-quote product
-- mismatch] by deletion).
--
-- RENAME VALUE relabels the enum element in place, so every existing
-- account row on 'trial_pack' becomes 'free' automatically (trial_pack
-- was pre-LIVE / Stripe test-mode only, so there are no real paying
-- trial purchasers to migrate). The default is dropped before the
-- rename so the column default never references the stale 'trial_pack'
-- label, then re-set to 'free'. Finally the four unused trial-pack
-- credit columns are dropped (credit was never consumed — V-541.J/K
-- usage-metering writers were deferred and the tier no longer exists).
ALTER TABLE "accounts" ALTER COLUMN "tier" DROP DEFAULT;
--> statement-breakpoint
ALTER TYPE "account_tier" RENAME VALUE 'trial_pack' TO 'free';
--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "tier" SET DEFAULT 'free';
--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "trial_pack_purchased_at";
--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "trial_pack_credit_cents";
--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "trial_pack_expires_at";
--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "trial_pack_redeemed";
