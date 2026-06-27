-- 2026-06-27 — crypto-denominated amount reconciliation (#1). The IPN's
-- `actually_paid` is denominated in the order's pay_currency (e.g. 0.0015 BTC),
-- NOT the fiat price_amount — so reconciling actually_paid against the FIAT
-- price (the prior behaviour) compared incompatible units and left every full
-- crypto payment stuck 'partial'. Persist the crypto-denominated quote
-- (pay_amount + pay_currency) NowPayments mints at createPayment so the first
-- IPN reconciles actually_paid against the right unit. Additive + nullable —
-- the stub provider + existing rows have no minted quote and need no backfill.
ALTER TABLE "crypto_orders" ADD COLUMN IF NOT EXISTS "pay_amount" numeric(38, 18);
--> statement-breakpoint
ALTER TABLE "crypto_orders" ADD COLUMN IF NOT EXISTS "pay_currency" text;
