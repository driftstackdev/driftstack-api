-- V-359 — webhook signing-secret rotation with grace period.
-- Adds the previous-secret slot + its expiry. Worker dual-signs
-- outbound deliveries while `secret_prev` is non-null and within
-- `secret_prev_expires_at`; emits a single `v1=` HMAC otherwise.
ALTER TABLE "webhook_endpoints"
  ADD COLUMN "secret_prev" text,
  ADD COLUMN "secret_prev_expires_at" timestamp with time zone;
