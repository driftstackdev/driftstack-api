-- V-081: profiles — persistent customer-defined identity slots that
-- sessions are created against. The Manual ladder caps profile count
-- as the tier-defining metric; the API ladder also caps profiles to
-- prevent unbounded growth at lower tiers. (See PROFILES_PER_TIER in
-- apps/server/src/services/sessions.ts for the tier→limit map.)
--
-- Uniqueness on (account_id, name) — profile names are human-meaningful
-- within an account, not opaque IDs.

CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archetype" text DEFAULT 'iphone16pro_ios26_4_1' NOT NULL,
	"description" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_account_name_unique" ON "profiles" USING btree ("account_id","name");
--> statement-breakpoint
CREATE INDEX "profiles_account_idx" ON "profiles" USING btree ("account_id");
