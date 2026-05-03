-- V-079 / Workstream F (onboarding flow): user-facing auth surface.
--
-- Adds password + email-verification fields to `accounts`, plus four
-- token tables backing signup-verify / magic-link / password-reset
-- flows and the long-lived web-session cookie used by the customer
-- dashboard and admin panel.
--
-- All tokens are sha256-hashed at rest (the plaintext is sent once
-- via Postmark / returned on login and never stored). Each table has
-- a unique index on `token_hash` for O(1) verify-by-presentation,
-- plus an account index for "list active tokens for account" admin
-- queries and an expires_at index for the periodic cleanup sweep
-- (not implemented yet — lazy expiry at the service layer for now).

ALTER TABLE "accounts" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint

CREATE TABLE "email_verify_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"requested_from_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_verify_tokens" ADD CONSTRAINT "email_verify_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "email_verify_tokens_hash_unique" ON "email_verify_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "email_verify_tokens_account_idx" ON "email_verify_tokens" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX "email_verify_tokens_expires_idx" ON "email_verify_tokens" USING btree ("expires_at");
--> statement-breakpoint

CREATE TABLE "magic_link_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"requested_from_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD CONSTRAINT "magic_link_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "magic_link_tokens_hash_unique" ON "magic_link_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "magic_link_tokens_account_idx" ON "magic_link_tokens" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX "magic_link_tokens_expires_idx" ON "magic_link_tokens" USING btree ("expires_at");
--> statement-breakpoint

CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"requested_from_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_hash_unique" ON "password_reset_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "password_reset_tokens_account_idx" ON "password_reset_tokens" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX "password_reset_tokens_expires_idx" ON "password_reset_tokens" USING btree ("expires_at");
--> statement-breakpoint

CREATE TABLE "web_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_from_ip" text,
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "web_sessions_hash_unique" ON "web_sessions" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "web_sessions_account_idx" ON "web_sessions" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX "web_sessions_expires_idx" ON "web_sessions" USING btree ("expires_at");
