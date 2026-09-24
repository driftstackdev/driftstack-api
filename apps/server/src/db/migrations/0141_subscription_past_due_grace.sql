-- 0141 — a subscription remembers when it fell into past_due, so a failed
-- renewal keeps the paid plan for seven days instead of ending it at once.
--
-- The live-billing audit (#3) found that the first failed renewal dropped the
-- account to the free plan the moment Stripe marked the subscription past_due.
-- The published terms (8.5) promise at least seven days' written notice before
-- a suspension for non-payment, and the payment-failure email is that notice.
-- When a retry succeeded three days later the customer had paid the full month
-- having spent part of it on the free plan. So:
--
--   · `subscriptions.past_due_since` is the event time at which the
--     subscription last moved INTO past_due. The subscription webhook sets it on
--     that move, keeps it while the subscription stays past_due, and clears it
--     when the subscription leaves past_due. While it is less than seven days
--     old the subscription still counts toward the account's plan.
--   · `subscriptions.past_due_grace_ended_at` is when the past-due sweep took the
--     plan away because that spell outlasted the seven days. It is the sweep's
--     done-mark, so a spell is processed once; it is cleared with
--     `past_due_since`.
--
-- Two CHECKs hold the pair to that shape whoever writes: a start is recorded
-- only on a past_due row, and a done-mark only beside a start.
--
-- ADDITIVE. Both columns are nullable with no default, a catalog change that
-- rewrites no row. Every existing row passes both CHECKs (its new columns are
-- NULL); each is validated by one scan of the table under its ACCESS EXCLUSIVE
-- lock. A row already past_due keeps NULL: when it fell behind is unknown, and
-- it was downgraded at its first failure, which it stays until it recovers or
-- ends. The lock timeout makes a busy table fail the batch fast and whole,
-- which is safe to retry.
--
-- Reversible: drop the two CHECKs and the two columns.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "past_due_since" timestamp with time zone;

ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "past_due_grace_ended_at" timestamp with time zone;

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_past_due_since"
  CHECK ("past_due_since" IS NULL OR "status" = 'past_due');

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_past_due_grace_ended"
  CHECK ("past_due_grace_ended_at" IS NULL OR "past_due_since" IS NOT NULL);
