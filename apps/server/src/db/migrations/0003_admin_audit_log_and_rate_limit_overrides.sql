CREATE TYPE "public"."admin_audit_action" AS ENUM('account.tier_changed', 'account.suspended', 'account.unsuspended', 'webhook_delivery.replayed', 'webhook_delivery.requeued', 'rate_limit_override.set', 'rate_limit_override.cleared');--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_account_id" uuid NOT NULL,
	"admin_key_id" uuid NOT NULL,
	"action" "admin_audit_action" NOT NULL,
	"target_account_id" uuid,
	"target_resource_id" text,
	"input_payload" jsonb,
	"result" text NOT NULL,
	"ip_address" text,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"bucket_key" text NOT NULL,
	"capacity" integer NOT NULL,
	"refill_per_second_centi" integer NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"set_by_key_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_account_id_accounts_id_fk" FOREIGN KEY ("admin_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_key_id_api_keys_id_fk" FOREIGN KEY ("admin_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_target_account_id_accounts_id_fk" FOREIGN KEY ("target_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_overrides" ADD CONSTRAINT "rate_limit_overrides_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_overrides" ADD CONSTRAINT "rate_limit_overrides_set_by_key_id_api_keys_id_fk" FOREIGN KEY ("set_by_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_log_admin_idx" ON "admin_audit_log" USING btree ("admin_account_id","timestamp");--> statement-breakpoint
CREATE INDEX "admin_audit_log_target_idx" ON "admin_audit_log" USING btree ("target_account_id","timestamp");--> statement-breakpoint
CREATE INDEX "admin_audit_log_action_idx" ON "admin_audit_log" USING btree ("action","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limit_overrides_account_bucket_unique" ON "rate_limit_overrides" USING btree ("account_id","bucket_key");--> statement-breakpoint
CREATE INDEX "rate_limit_overrides_account_idx" ON "rate_limit_overrides" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "rate_limit_overrides_expires_idx" ON "rate_limit_overrides" USING btree ("expires_at");