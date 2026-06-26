-- 2026-06-26 — crypto-checkout cross-instance idempotency (#7). The dedup for
-- duplicate Idempotency-Key submissions was process-local Maps, so two same-key
-- requests on different instances (or across a restart) each missed the cache
-- and minted separate orders / NowPayments address reservations. Back the
-- idempotency with the DB: store the scoped key (`<account_id|_anon>:<key>`) on
-- the order row + a PARTIAL UNIQUE index, so a duplicate same-key INSERT
-- conflicts (the service does INSERT ... ON CONFLICT DO NOTHING + returns the
-- existing order). Partial (WHERE NOT NULL) so the many no-key orders don't
-- collide on a shared NULL. Additive + nullable — existing rows need no backfill.
ALTER TABLE "crypto_orders" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crypto_orders_idempotency_key_unique" ON "crypto_orders" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;
