-- Audit-1 C1 — persisted crypto tier entitlement with a term. Crypto tier
-- activation wrote only accounts.tier (no mirror row, no expiry), so a routine
-- Stripe reconcile (computed from the Stripe subscriptions table only) silently
-- wiped a non-refundable crypto-paid tier. One row per paid crypto order records
-- the entitled tier + its 31-day window; the reconcile floors against the
-- highest-ranked UNEXPIRED entitlement and a sweeper downgrades on expiry.
-- Purely additive; the backfill is ON CONFLICT-idempotent (re-run safe).
CREATE TABLE "crypto_entitlements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "order_id" text NOT NULL,
  "tier" "account_tier" NOT NULL,
  "starts_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "expired_processed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "crypto_entitlements_order_id_unique" ON "crypto_entitlements" ("order_id");
CREATE INDEX "crypto_entitlements_account_idx" ON "crypto_entitlements" ("account_id");
CREATE INDEX "crypto_entitlements_expiry_sweep_idx" ON "crypto_entitlements" ("expires_at") WHERE "expired_processed_at" IS NULL;

-- Backfill entitlements for orders already paid (crypto activation went live
-- 2026-07-07, so all are recent). paid_at = the first 'paid' event timestamp
-- (events.at is Unix ms) or updated_at as a fallback. The 14-day floor via
-- GREATEST guarantees no existing paid customer is cut off abruptly by the new
-- expiry semantics. Only paid, account-bound, self-serve-priced orders qualify.
INSERT INTO "crypto_entitlements" ("account_id", "order_id", "tier", "starts_at", "expires_at")
SELECT
  o."account_id",
  o."order_id",
  o."product"::"account_tier",
  p.paid_at,
  GREATEST(p.paid_at + interval '31 days', now() + interval '14 days')
FROM "crypto_orders" o
CROSS JOIN LATERAL (
  SELECT COALESCE(
    to_timestamp(
      (
        SELECT min((e->>'at')::bigint)
        FROM jsonb_array_elements(o."events") AS e
        WHERE e->>'status' = 'paid'
      ) / 1000.0
    ),
    o."updated_at"
  ) AS paid_at
) p
WHERE o."status" = 'paid'
  AND o."account_id" IS NOT NULL
  AND o."product" IN ('solo_manual', 'team_manual', 'agency_manual', 'api_starter', 'api_builder', 'api_scale')
ON CONFLICT ("order_id") DO NOTHING;
