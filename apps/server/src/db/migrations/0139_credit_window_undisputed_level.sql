-- 0139 — a credit window carries the level its paid coverage earns with the
-- standing disputes left out, and a level change records it beside the level
-- it shows, together with what its payment still paid.
--
-- The third audit of S17 found that a plan change made while a dispute stood
-- was measured from the level the dispute had lowered, and a month drawn while
-- a dispute stood was drawn at that lowered level. Once the dispute was won the
-- account ended somewhere its twin without the dispute never went, and no pass
-- afterwards could recover the difference exactly: a proration measured from
-- the wrong level is rounded on the wrong amount. A won dispute must leave the
-- account exactly where it would have been had the dispute never happened, so
-- every amount a plan change or a new month grants or takes is now measured on
-- the UNDISPUTED level — the level the coverage earns with refunds taken off
-- and standing disputes left out — and a dispute takes its share afterwards,
-- as a reversal of its own. The level a window SHOWS is unchanged: disputes
-- still lower it, as a refund does.
--
--   · `credit_windows.undisputed_level_micro` is the window's undisputed
--     level. NULL means "the same as `level_micro`", which is what every
--     window written before this migration has. It moves only with a level
--     change, like the level itself.
--   · `credit_window_level_changes.undisputed_from_micro` and
--     `undisputed_to_micro` record that level's move with each change (both
--     NULL, or both set). A change may now move only the undisputed level: a
--     plan change made while a dispute takes all of a month leaves the level
--     shown at nothing and still changes what the month is worth.
--   · `credit_window_level_changes.still_paid_minor` is what the payment the
--     change is attributed to still paid when it was made, refunds taken off,
--     in its minor units: what a later refund measures the change's own grant
--     or take against. NULL for a change that names no Stripe invoice, and for
--     every change written before this migration ("the whole payment").
--
-- The window guard is 0130's, changed ONLY in what counts as a level change:
-- the pair of the level and the undisputed level, so the step counter rises by
-- exactly one when either moves and not otherwise. Every other term of a window
-- stays immutable.
--
--   · `credit_clawbacks.disputed_minor` is the amount a dispute took from its
--     payment, in the payment's minor units, on every row the dispute writes
--     under its own id. What a payment has disputed is the SUM of its standing
--     disputes, each by its id (a win takes its own amount off, once), and that
--     sum can pass what was paid — two disputes of one charge — which the
--     payment row's own column may not hold. So each dispute's amount is kept
--     here, and the payment row holds the sum capped at what was paid. NULL on
--     every other row. The clawbacks guard is 0132's, changed ONLY by the new
--     column joining the facts that never change.
--
-- ADDITIVE, plus one CHECK replaced and two guards widened. Nullable columns
-- with no default rewrite no row. The CHECKs are validated against tables that
-- production holds nothing in (AI credits ship dark). The lock timeout makes a
-- busy table fail the batch fast and whole, which is safe to retry.
--
-- Reversible by restoring 0130's window guard and CHECK and 0132's clawbacks
-- guard, and dropping the columns and their CHECKs.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "credit_windows" ADD COLUMN IF NOT EXISTS "undisputed_level_micro" bigint;

ALTER TABLE "credit_windows" ADD CONSTRAINT "credit_windows_undisputed_level"
  CHECK ("undisputed_level_micro" IS NULL
         OR ("undisputed_level_micro" >= 0 AND "undisputed_level_micro" % 1000000 = 0));

ALTER TABLE "credit_window_level_changes" ADD COLUMN IF NOT EXISTS "undisputed_from_micro" bigint;

ALTER TABLE "credit_window_level_changes" ADD COLUMN IF NOT EXISTS "undisputed_to_micro" bigint;

ALTER TABLE "credit_window_level_changes" ADD COLUMN IF NOT EXISTS "still_paid_minor" bigint;

ALTER TABLE "credit_window_level_changes" ADD CONSTRAINT "credit_window_level_changes_undisputed"
  CHECK (("undisputed_from_micro" IS NULL AND "undisputed_to_micro" IS NULL)
         OR ("undisputed_from_micro" >= 0 AND "undisputed_from_micro" % 1000000 = 0
             AND "undisputed_to_micro" >= 0 AND "undisputed_to_micro" % 1000000 = 0));

ALTER TABLE "credit_window_level_changes" ADD CONSTRAINT "credit_window_level_changes_still_paid"
  CHECK ("still_paid_minor" IS NULL OR "still_paid_minor" >= 0);

ALTER TABLE "credit_window_level_changes" DROP CONSTRAINT "credit_window_level_changes_real";

ALTER TABLE "credit_window_level_changes" ADD CONSTRAINT "credit_window_level_changes_real"
  CHECK ("from_level_micro" <> "to_level_micro"
         OR "undisputed_from_micro" IS DISTINCT FROM "undisputed_to_micro");

CREATE OR REPLACE FUNCTION "credit_windows_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."created_at" := now();
    NEW."level_seq" := 0;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "accounts" WHERE "id" = OLD."account_id") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'credit_windows rows are removed only with their account' USING ERRCODE = '55000';
  END IF;
  IF (NEW."id", NEW."account_id", NEW."source", NEW."source_ref", NEW."natural_start", NEW."natural_end",
      NEW."window_start", NEW."window_end", NEW."tier", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."account_id", OLD."source", OLD."source_ref", OLD."natural_start", OLD."natural_end",
      OLD."window_start", OLD."window_end", OLD."tier", OLD."created_at")
     OR NEW."level_seq" <> OLD."level_seq"
          + (CASE WHEN (NEW."level_micro", COALESCE(NEW."undisputed_level_micro", NEW."level_micro"))
                       IS DISTINCT FROM
                       (OLD."level_micro", COALESCE(OLD."undisputed_level_micro", OLD."level_micro"))
                  THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'a credit window changes only its level, one step at a time' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE "credit_clawbacks" ADD COLUMN IF NOT EXISTS "disputed_minor" bigint;

ALTER TABLE "credit_clawbacks" ADD CONSTRAINT "credit_clawbacks_disputed"
  CHECK ("disputed_minor" IS NULL OR "disputed_minor" >= 0);

CREATE OR REPLACE FUNCTION "credit_clawbacks_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "accounts" WHERE "id" = OLD."account_id") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'credit_clawbacks rows are removed only with their account' USING ERRCODE = '55000';
  END IF;
  IF (NEW."id", NEW."account_id", NEW."source", NEW."source_ref", NEW."target_key", NEW."fraction_ppm",
      NEW."amount_micro", NEW."clawed_micro", NEW."created_at", NEW."disputed_minor")
     IS DISTINCT FROM
     (OLD."id", OLD."account_id", OLD."source", OLD."source_ref", OLD."target_key", OLD."fraction_ppm",
      OLD."amount_micro", OLD."clawed_micro", OLD."created_at", OLD."disputed_minor")
     OR NEW."pending_micro" > OLD."pending_micro"
     OR (NEW."debt_micro" IS DISTINCT FROM OLD."debt_micro"
         AND NOT (NEW."pending_micro" < OLD."pending_micro"
                  AND NEW."debt_micro" IS NOT NULL AND OLD."debt_micro" IS NOT NULL
                  AND NEW."debt_micro"
                      = OLD."debt_micro" + (OLD."pending_micro" - NEW."pending_micro")))
     OR (NEW."state" <> OLD."state" AND NOT (OLD."state" = 'applied' AND NEW."state" = 'reversed')) THEN
    RAISE EXCEPTION 'a clawback only pays down its pending claim, takes that claim as debt, or is reversed once'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
