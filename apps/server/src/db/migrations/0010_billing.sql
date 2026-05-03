-- V-082: billing flow scaffolding.
--
-- - accounts.stripe_customer_id: link to Stripe customer (set at first
--   checkout-session create; pinned across tier changes).
-- - accounts.trial_pack_*: ADR-003 trial-pack columns.
--   trial_pack_purchased_at / trial_pack_credit_cents (decrements at
--   $0.18/hr) / trial_pack_expires_at (purchase + 14 days) /
--   trial_pack_redeemed (true when subscription begins OR window
--   expires OR credit exhausts).
-- - subscriptions: local mirror of Stripe subscription state. Updated
--   by the webhook router (V-080) on customer.subscription.created /
--   updated / deleted. status enum tracks Stripe's status verbatim.

ALTER TABLE "accounts" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "trial_pack_purchased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "trial_pack_credit_cents" integer;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "trial_pack_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "trial_pack_redeemed" boolean DEFAULT false NOT NULL;--> statement-breakpoint

CREATE TYPE "public"."subscription_status" AS ENUM(
  'incomplete', 'incomplete_expired', 'trialing', 'active',
  'past_due', 'canceled', 'unpaid', 'paused'
);
--> statement-breakpoint

CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"tier" "account_tier" NOT NULL,
	"status" "subscription_status" NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_stripe_id_unique" ON "subscriptions" USING btree ("stripe_subscription_id");
--> statement-breakpoint
CREATE INDEX "subscriptions_account_idx" ON "subscriptions" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX "subscriptions_status_idx" ON "subscriptions" USING btree ("status");
