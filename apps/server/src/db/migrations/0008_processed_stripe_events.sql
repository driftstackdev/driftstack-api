-- V-080: idempotency ledger for inbound Stripe webhook events.
--
-- Stripe `event.id` is unique per Stripe account for the lifetime of
-- the account; recording it on first successful handling and rejecting
-- duplicates with a 200 OK no-op gives us at-least-once delivery
-- semantics matching Stripe's retry behaviour (3-day re-delivery window).
--
-- Append-only: there is no UPDATE or DELETE path on this table at the
-- service layer. Old rows are reaped by a periodic sweep (not yet
-- implemented; lazy retention is fine while volume is low).

CREATE TABLE "processed_stripe_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"result" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "processed_stripe_events_received_idx" ON "processed_stripe_events" USING btree ("received_at");
--> statement-breakpoint
CREATE INDEX "processed_stripe_events_type_idx" ON "processed_stripe_events" USING btree ("event_type","received_at");
