-- 2026-05-22 — V-666 crypto-order webhook events. Adds two values
-- to the existing webhook_event_type enum so the bootstrap can
-- wire CryptoOrdersService's emitter intent to the WebhooksService
-- without hitting the "22P02 invalid input value for enum" insert
-- error that previously kept the wire deferred.
--
-- Same ALTER TYPE ADD VALUE pattern as 0055 (egress_capability_
-- changed). Runs outside a transaction; idempotent via IF NOT EXISTS.
ALTER TYPE "webhook_event_type" ADD VALUE IF NOT EXISTS 'crypto.order.paid';--> statement-breakpoint
ALTER TYPE "webhook_event_type" ADD VALUE IF NOT EXISTS 'crypto.order.failed';
