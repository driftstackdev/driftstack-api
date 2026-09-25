-- 0144 — a crypto order records the claim to create its NowPayments payment, and
-- how many payments were created for it.
--
-- Security sweep #18 (residual). Checkouts that repeat one new Idempotency-Key
-- while its first request is still creating the provider payment all replay an
-- order that is pending with no payment bound yet, and each of them created a
-- payment: twenty concurrent same-key checkouts created twenty. The limits on
-- orders did not bound payments.
--
--   · `crypto_orders.payment_mint_claimed_at` is when a checkout last claimed the
--     right to create this order's payment. It is written under the order's row
--     lock before the provider is called. While it is fresh, a checkout on any
--     server answers without creating a payment; once it is older than the
--     provider's request timeout plus a margin and no payment is bound (the
--     server holding it died, or its payment could not be bound), one checkout
--     may claim it again and create a replacement.
--   · `crypto_orders.payment_mints` counts those claims: the payments created
--     for the order. Summed over an account's unpaid orders claimed in the last
--     24 hours, it is the account's daily mint budget.
--
-- ADDITIVE. The timestamp is nullable with no default; the count is NOT NULL
-- with a constant default, which Postgres records in the catalog, so neither
-- rewrites a row. Every existing order reads as never claimed, which is what
-- its payment_id already says: a bound order is never minted again, and an
-- unbound pending one may be claimed once. The lock timeout makes a busy table
-- fail the batch fast and whole, which is safe to retry.
--
-- Reversible: drop the two columns.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "crypto_orders" ADD COLUMN IF NOT EXISTS "payment_mint_claimed_at" timestamp with time zone;

ALTER TABLE "crypto_orders" ADD COLUMN IF NOT EXISTS "payment_mints" integer DEFAULT 0 NOT NULL;
