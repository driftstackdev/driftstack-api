-- V-173 — webhook_delivery_attempts table for the per-attempt log.
-- The existing webhook_deliveries.attempts column is a COUNT (integer);
-- @driftstack/webhook-delivery's DeliveryRecord.attempts is the full
-- HISTORY (DeliveryAttempt[]). V-173 lands the per-attempt log so the
-- new DurableWebhookDeliveryService can satisfy the package contract.
--
-- Existing apps/server/src/services/webhooks.ts continues to NOT write
-- this table (existing behavior unchanged). DurableWebhookDeliveryService
-- (V-173) writes one row per attempt. When the codebase migrates fully
-- to Durable*, the existing webhooks.ts gets removed; until then, both
-- coexist (different deliveries owned by different services).
--
-- delivery_id FK with ON DELETE CASCADE so deleting a delivery row
-- (e.g., DLQ discard) cleans up its attempt log too.

CREATE TABLE "webhook_delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"completed_at_ms" bigint NOT NULL,
	"response_status" integer,
	"response_excerpt" text,
	"duration_ms" integer NOT NULL,
	"outcome" text NOT NULL,
	"error_message" text
);--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_delivery_id_webhook_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."webhook_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_delivery_attempts_delivery_idx" ON "webhook_delivery_attempts" USING btree ("delivery_id","attempt_number");
