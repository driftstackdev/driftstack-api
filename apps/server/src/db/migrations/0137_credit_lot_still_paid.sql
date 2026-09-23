-- 0137 — a lot remembers how much of its payment was still paid when it was
-- granted.
--
-- The re-audit of S17 found that a second partial refund of an annual invoice
-- took the first refund's share twice. A month granted AFTER a 50% refund is
-- granted at half the level; when the refund then reaches 75%, the month must
-- keep half of what it was granted (still paid 25% of 50%), not a quarter of
-- it. What a lot keeps on a reversal is therefore measured against the share
-- of the payment still paid WHEN THE LOT WAS GRANTED:
--
--   keep = floor_whole(granted × still paid now / still paid when granted)
--
-- and nothing else in the database records the second number: the payment row
-- holds only the cumulative refunded and disputed amounts as they stand now.
--
-- `still_paid_minor` records it, in the paying invoice's minor units: the
-- invoice's amount paid less what had been refunded or disputed at the moment
-- the lot was written. It is written once, with the lot, by the windows
-- repository (a month's lot from the invoice the window was drawn from, a
-- plan-change step's lot from the invoice the step names) and is NULL for
-- every other lot and for every lot written before this migration, which every
-- reader treats as "the whole payment" — the rule before this change.
-- Production holds no lots (AI credits ship dark), so nothing is left
-- measured the old way there.
--
-- ADDITIVE, plus one guard widened. A nullable column with no default rewrites
-- no row. The CHECK is validated against a table production holds nothing in.
-- The lot guard is replaced with the same body and ONE change: the new column
-- joins the terms that never change after insert, because it is the basis of
-- `granted_micro`, which is already one of them. The lock timeout makes a busy
-- table fail the batch fast and whole, which is safe to retry.
--
-- Reversible by restoring 0128's guard and dropping the column and its check.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "credit_lots" ADD COLUMN IF NOT EXISTS "still_paid_minor" bigint;

ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_still_paid_nonnegative"
  CHECK ("still_paid_minor" IS NULL OR "still_paid_minor" >= 0);

CREATE OR REPLACE FUNCTION "credit_lots_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."remaining_micro" := 0;
    NEW."held_micro" := 0;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "accounts" WHERE "id" = OLD."account_id") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'credit_lots rows are removed only with their account' USING ERRCODE = '55000';
  END IF;
  IF (NEW."id", NEW."account_id", NEW."kind", NEW."spend_rank", NEW."window_id", NEW."grant_key",
      NEW."granted_micro", NEW."starts_at", NEW."expires_at", NEW."created_at", NEW."still_paid_minor")
     IS DISTINCT FROM
     (OLD."id", OLD."account_id", OLD."kind", OLD."spend_rank", OLD."window_id", OLD."grant_key",
      OLD."granted_micro", OLD."starts_at", OLD."expires_at", OLD."created_at", OLD."still_paid_minor") THEN
    RAISE EXCEPTION 'credit_lots terms are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."remaining_micro" IS DISTINCT FROM OLD."remaining_micro"
     AND (pg_trigger_depth() < 2
          OR current_setting('driftstack.credit_ledger_apply', true) IS DISTINCT FROM 'on') THEN
    RAISE EXCEPTION 'credit_lots.remaining_micro moves only through credit_ledger' USING ERRCODE = '55000';
  END IF;
  IF NEW."held_micro" IS DISTINCT FROM OLD."held_micro"
     AND (pg_trigger_depth() < 2
          OR current_setting('driftstack.credit_hold_apply', true) IS DISTINCT FROM 'on') THEN
    RAISE EXCEPTION 'credit_lots.held_micro moves only through credit_reservation_holds' USING ERRCODE = '55000';
  END IF;
  IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
    RAISE EXCEPTION 'a revoked lot stays revoked' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
