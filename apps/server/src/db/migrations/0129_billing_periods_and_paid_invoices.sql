-- 0129 — what a subscription's billing period is, and which invoices were PAID.
--
-- Two additions, both inert until AI credits are switched on: nothing reads
-- them to decide anything a customer can see.
--
-- 1. `subscriptions` learns when its current period STARTED, whether it bills
--    by the month or the year, where the start came from, and when the mirrored
--    plan last changed. Until now the mirror stored only the period's end.
--
--      · `current_period_start`  read from the subscription event; NULL when the
--                                event carried none.
--      · `billing_interval`      'month' | 'year', from the configured price ids;
--                                NULL for a price the configuration does not name
--                                (a custom contract).
--      · `period_start_source`   'stripe' when the start was read from Stripe,
--                                'derived' when the backfill computed it from the
--                                period's end and the interval; NULL with no start.
--      · `tier_since`            the event time the row's plan last CHANGED. Left
--                                NULL on rows that predate this migration until
--                                their plan next changes: when they began is not
--                                known, and a guess would read as a fact.
--
-- 2. `billing_invoice_payments` — one row per PAID invoice. A subscription that
--    says "active" has not necessarily been paid for: the renewal's payment is
--    attempted after the period rolls over, and a plan change may be billed
--    later. A paid invoice is the only evidence that a period was paid, so it is
--    recorded here, from the invoice itself, keyed on the invoice id.
--
--      · The PERIOD is the invoice LINE's, never the invoice's own top-level
--        period (on a renewal those describe the period that just ended).
--      · `line_kind` says which line was read: 'period' is the subscription's
--        ordinary (non-proration) line; 'proration_up' is the positive
--        proration line of a paid plan-change invoice. NULL means the invoice
--        could not be tied to a subscription line: the payment is still
--        recorded, with no period, and it covers nothing.
--      · `line_tier` is NULL for a price the configuration does not name.
--      · A $0 invoice (a 100% discount, a plan change that nets to nothing) is
--        recorded like any other: it was paid.
--      · `refunded_minor` and `disputed_minor` start at 0. Nothing moves them yet.
--
-- ⛔ THE DATABASE HOLDS THE SHAPE, NOT ONLY THE CODE THAT WRITES HERE:
--
--   · amounts: paid is never negative; refunded and disputed each stay between
--     0 and what was paid;
--   · a row either names a line (its kind, and the line's period) or names
--     none of it: a kind with no period, or a period with no kind, is refused;
--   · a line's period ends after it starts;
--   · the interval is 'month' or 'year' or unknown, on both tables;
--   · a subscription's period starts before it ends, when both are known.
--
-- LOCKS. The ALTERs take ACCESS EXCLUSIVE on `subscriptions` and the foreign
-- key takes SHARE ROW EXCLUSIVE on `accounts`, both held until the migration
-- batch commits. The new columns are nullable with no default, so nothing is
-- rewritten, and each new CHECK passes every existing row trivially (its new
-- column is NULL). The lock timeout makes a busy table fail the batch fast and
-- whole, which is safe to retry, rather than queue every writer behind it.
--
-- EXPAND ONLY. Four nullable columns, three CHECKs, one new table and its three
-- indexes. Nothing existing is rewritten or removed. Reversible by dropping the
-- table, the three constraints and the four columns.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "subscriptions" ADD COLUMN "current_period_start" timestamptz;
ALTER TABLE "subscriptions" ADD COLUMN "billing_interval" text;
ALTER TABLE "subscriptions" ADD COLUMN "period_start_source" text;
ALTER TABLE "subscriptions" ADD COLUMN "tier_since" timestamptz;

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_billing_interval"
  CHECK ("billing_interval" IS NULL OR "billing_interval" IN ('month', 'year'));
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_period_start_source"
  CHECK ("period_start_source" IS NULL OR "period_start_source" IN ('stripe', 'derived'));
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_period_order"
  CHECK (
    "current_period_start" IS NULL
    OR "current_period_end" IS NULL
    OR "current_period_start" < "current_period_end"
  );

CREATE TABLE "billing_invoice_payments" (
  "stripe_invoice_id" text PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "stripe_subscription_id" text,
  "billing_reason" text,
  "amount_paid_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "stripe_payment_intent_id" text,
  "stripe_charge_id" text,
  "line_kind" text,
  "line_stripe_price_id" text,
  "line_tier" "account_tier",
  "line_interval" text,
  "line_period_start" timestamptz,
  "line_period_end" timestamptz,
  "paid_at" timestamptz NOT NULL,
  "refunded_minor" bigint NOT NULL DEFAULT 0,
  "disputed_minor" bigint NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "billing_invoice_payments_amounts" CHECK (
    "amount_paid_minor" >= 0
    AND "refunded_minor" BETWEEN 0 AND "amount_paid_minor"
    AND "disputed_minor" BETWEEN 0 AND "amount_paid_minor"
  ),
  CONSTRAINT "billing_invoice_payments_line_kind" CHECK (
    "line_kind" IS NULL OR "line_kind" IN ('period', 'proration_up')
  ),
  CONSTRAINT "billing_invoice_payments_line_shape" CHECK (
    ("line_kind" IS NULL) = (
      "line_tier" IS NULL AND "line_period_start" IS NULL AND "line_period_end" IS NULL
    )
  ),
  CONSTRAINT "billing_invoice_payments_line_period_known" CHECK (
    "line_kind" IS NULL
    OR ("line_period_start" IS NOT NULL AND "line_period_end" IS NOT NULL)
  ),
  CONSTRAINT "billing_invoice_payments_line_interval" CHECK (
    "line_interval" IS NULL OR "line_interval" IN ('month', 'year')
  ),
  CONSTRAINT "billing_invoice_payments_period" CHECK (
    "line_period_start" IS NULL OR "line_period_end" > "line_period_start"
  )
);

CREATE INDEX "billing_invoice_payments_coverage_idx"
  ON "billing_invoice_payments" ("account_id", "line_period_start", "line_period_end")
  WHERE "line_kind" IS NOT NULL;
CREATE INDEX "billing_invoice_payments_pi_idx"
  ON "billing_invoice_payments" ("stripe_payment_intent_id")
  WHERE "stripe_payment_intent_id" IS NOT NULL;
CREATE INDEX "billing_invoice_payments_charge_idx"
  ON "billing_invoice_payments" ("stripe_charge_id")
  WHERE "stripe_charge_id" IS NOT NULL;
