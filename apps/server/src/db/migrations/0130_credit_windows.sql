-- 0130 — the month windows that included AI credits are granted into, the
-- history of a window's level, and the record of credits taken back. Amounts are
-- microcredits (1 credit = 1,000,000 µcr = US$0.01).
--
-- A WINDOW is one stretch of time an account's monthly credits belong to: the
-- paid month of a subscription, one month of a paid year, a crypto payment's
-- term, or a month of a plan an admin set by hand. It records which payment it
-- came from, the month it is part of (`natural_*`), the part of that month it
-- actually covers (`window_*`, shorter when another window already covered the
-- start, or when what was paid for ends first), and the monthly level it was
-- granted at. A window's included credits are lots that name it. Nothing reads
-- or writes these tables until AI credits are switched on.
--
-- ⛔ THE DATABASE HOLDS THE RULES, NOT ONLY THE CODE THAT WRITES HERE:
--
--   · An account's windows NEVER OVERLAP (an exclusion constraint over the
--     account and the half-open range `[window_start, window_end)`), so one
--     stretch of time is granted at most once whoever asks, however many
--     payment sources cover it. Two windows may touch: one ends where the next
--     starts.
--   · One window per (account, source, payment, month): a unique index.
--     Writers insert with ON CONFLICT DO NOTHING and NO conflict target. That
--     form is the only one that also arbitrates the exclusion constraint: with
--     a target naming the unique index, an overlapping insert raises 23P01 and
--     aborts the writer's whole transaction instead of inserting nothing.
--   · A window is NEVER CREATED AHEAD OF ITS START. `created_at` is forced to
--     the database clock on insert, whatever the statement said, and a CHECK
--     requires `window_start <= created_at`. Credits of a month that has not
--     begun therefore cannot exist, so they cannot be spent early.
--   · A window lies inside its month and is not empty
--     (`natural_start <= window_start < window_end <= natural_end`), and its
--     level is a whole number of credits, never negative.
--   · A window changes ONLY ITS LEVEL, one step at a time: `level_seq` rises by
--     exactly one when `level_micro` changes and not otherwise, and every other
--     column is immutable. A window is born at step 0. Windows are removed only
--     with their account.
--   · The history of a window's level is append-only, and goes only with its
--     window. A recorded change is a real one (from <> to) of whole credits.
--   · A record of credits taken back can only pay down what it is still owed
--     from credits tasks hold, or be reversed once; its facts never change and
--     it is removed only with its account. One record per (source, reference,
--     target): the same refund or plan change is applied once. A record that
--     matched nothing (kept for a person to review) carries no amounts.
--   · An included lot (monthly or plan-change) now names a window that exists
--     AND BELONGS TO ITS OWN ACCOUNT: `credit_lots.window_id` gains a foreign
--     key over the window and the account together, the same rule
--     `credit_ledger_apply` already holds for a ledger row and its lot. A
--     window has at most one monthly lot.
--   · The trigger functions pin their search_path (public, then pg_temp), so a
--     session's temporary table named like one of these cannot stand in for it
--     inside a guard.
--
-- `btree_gist` supplies the equality operator class the exclusion constraint
-- needs for the account id. It is a trusted extension: a role with CREATE on
-- the database may install it.
--
-- LOCKS. The foreign keys to `accounts` take SHARE ROW EXCLUSIVE on it, and the
-- new constraint on `credit_lots` takes the same on `credit_lots` and
-- `credit_windows`; all are held until the migration batch commits. `credit_lots`
-- holds no included lots yet (nothing writes them before this migration), so
-- validating the new foreign key reads nothing. The lock timeout makes a busy
-- table fail the batch fast and whole, which is safe to retry.
--
-- EXPAND ONLY. One extension, three new tables and their indexes, three guard
-- functions and three triggers, one foreign key and one unique index on
-- `credit_lots`. Nothing existing is rewritten or removed. Reversible by
-- dropping the index, the constraint, the three tables and the three functions.

SET LOCAL lock_timeout = '5s';

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE "credit_windows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "source" text NOT NULL,
  -- The payment this window came from: a Stripe invoice id, a crypto order id,
  -- or 'override' for a plan set by an admin.
  "source_ref" text NOT NULL,
  "natural_start" timestamptz NOT NULL,
  "natural_end" timestamptz NOT NULL,
  "window_start" timestamptz NOT NULL,
  "window_end" timestamptz NOT NULL,
  "tier" "account_tier" NOT NULL,
  "level_micro" bigint NOT NULL,
  "level_seq" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "credit_windows_source" CHECK ("source" IN ('stripe_invoice', 'crypto_entitlement', 'plan_override')),
  CONSTRAINT "credit_windows_source_ref_length" CHECK (length("source_ref") BETWEEN 1 AND 200),
  CONSTRAINT "credit_windows_order" CHECK (
    "natural_start" <= "window_start" AND "window_start" < "window_end" AND "window_end" <= "natural_end"),
  -- Never granted ahead of its start. `created_at` is forced to now() on insert.
  CONSTRAINT "credit_windows_started" CHECK ("window_start" <= "created_at"),
  CONSTRAINT "credit_windows_level" CHECK ("level_micro" >= 0 AND "level_micro" % 1000000 = 0),
  CONSTRAINT "credit_windows_level_seq" CHECK ("level_seq" >= 0),
  CONSTRAINT "credit_windows_no_overlap" EXCLUDE USING gist (
    "account_id" WITH =,
    tstzrange("window_start", "window_end", '[)') WITH &&)
);

CREATE UNIQUE INDEX "credit_windows_source_month_unique"
  ON "credit_windows" ("account_id", "source", "source_ref", "natural_start");
CREATE INDEX "credit_windows_account_end_idx" ON "credit_windows" ("account_id", "window_end" DESC);
-- What `credit_lots_window_fk` at the foot of this file points at: a window is
-- identified by its id AND its account, so an included lot can only name a
-- window of ITS OWN account. Redundant as a key (the id alone is the primary
-- key); it exists so the foreign key can carry the account.
CREATE UNIQUE INDEX "credit_windows_id_account_unique" ON "credit_windows" ("id", "account_id");

-- Insert: born now, at step 0. Delete: only with the account. Update: only the
-- level, one step at a time.
CREATE FUNCTION "credit_windows_guard"() RETURNS trigger LANGUAGE plpgsql
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
          + (CASE WHEN NEW."level_micro" <> OLD."level_micro" THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'a credit window changes only its level, one step at a time' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "credit_windows_guard_trigger" BEFORE INSERT OR UPDATE OR DELETE ON "credit_windows"
  FOR EACH ROW EXECUTE FUNCTION "credit_windows_guard"();

CREATE TABLE "credit_window_level_changes" (
  "window_id" uuid NOT NULL REFERENCES "credit_windows"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "reason" text NOT NULL,
  "from_level_micro" bigint NOT NULL,
  "to_level_micro" bigint NOT NULL,
  "effective_at" timestamptz NOT NULL,
  "delta_micro" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("window_id", "seq"),
  CONSTRAINT "credit_window_level_changes_seq" CHECK ("seq" >= 1),
  CONSTRAINT "credit_window_level_changes_reason" CHECK (
    "reason" IN ('plan_change', 'refund', 'dispute', 'dispute_reinstated')),
  CONSTRAINT "credit_window_level_changes_levels" CHECK (
    "from_level_micro" >= 0 AND "from_level_micro" % 1000000 = 0
    AND "to_level_micro" >= 0 AND "to_level_micro" % 1000000 = 0),
  CONSTRAINT "credit_window_level_changes_real" CHECK ("from_level_micro" <> "to_level_micro"),
  CONSTRAINT "credit_window_level_changes_whole" CHECK ("delta_micro" % 1000000 = 0)
);

-- Append-only. A row goes only with its window, and a window only with its
-- account; by the time the cascade reaches this table the window row is gone.
CREATE FUNCTION "credit_window_level_changes_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "credit_windows" WHERE "id" = OLD."window_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'credit_window_level_changes is append-only: % refused', TG_OP USING ERRCODE = '55000';
END $$;

CREATE TRIGGER "credit_window_level_changes_guard_trigger" BEFORE UPDATE OR DELETE
  ON "credit_window_level_changes"
  FOR EACH ROW EXECUTE FUNCTION "credit_window_level_changes_guard"();

CREATE TABLE "credit_clawbacks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "source" text NOT NULL,
  "source_ref" text NOT NULL,
  "target_key" text NOT NULL,
  "fraction_ppm" integer,
  "amount_micro" bigint,
  "state" text NOT NULL,
  "clawed_micro" bigint,
  -- The part of a shortfall that credits held by running tasks cover; paid from
  -- those credits when they are released.
  "pending_micro" bigint NOT NULL DEFAULT 0,
  "debt_micro" bigint,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "credit_clawbacks_source" CHECK (
    "source" IN ('plan_change', 'stripe_refund', 'stripe_dispute', 'crypto_refund', 'admin')),
  CONSTRAINT "credit_clawbacks_state" CHECK ("state" IN ('applied', 'unmatched', 'reversed')),
  CONSTRAINT "credit_clawbacks_one_measure" CHECK (("fraction_ppm" IS NULL) <> ("amount_micro" IS NULL)),
  CONSTRAINT "credit_clawbacks_fraction" CHECK ("fraction_ppm" IS NULL OR "fraction_ppm" BETWEEN 1 AND 1000000),
  CONSTRAINT "credit_clawbacks_amount" CHECK ("amount_micro" IS NULL OR "amount_micro" > 0),
  CONSTRAINT "credit_clawbacks_pending" CHECK ("pending_micro" >= 0),
  CONSTRAINT "credit_clawbacks_applied_shape" CHECK (("state" IN ('applied', 'reversed')) =
    ("clawed_micro" IS NOT NULL AND "debt_micro" IS NOT NULL AND "target_key" <> 'unmatched')),
  -- The shape above is satisfied by an unmatched record that still carries
  -- amounts, so long as its target says 'unmatched'. Nothing was taken for a
  -- refund that matched nothing: such a record carries no amounts at all.
  CONSTRAINT "credit_clawbacks_unmatched_shape" CHECK ("state" <> 'unmatched' OR
    ("clawed_micro" IS NULL AND "debt_micro" IS NULL AND "pending_micro" = 0))
);

CREATE UNIQUE INDEX "credit_clawbacks_idempotency_unique"
  ON "credit_clawbacks" ("source", "source_ref", "target_key");
CREATE INDEX "credit_clawbacks_pending_idx" ON "credit_clawbacks" ("account_id", "created_at")
  WHERE "pending_micro" > 0;

-- Delete: only with the account. Update: the facts never change; the pending
-- claim only falls; the state moves only from applied to reversed.
CREATE FUNCTION "credit_clawbacks_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "accounts" WHERE "id" = OLD."account_id") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'credit_clawbacks rows are removed only with their account' USING ERRCODE = '55000';
  END IF;
  IF (NEW."id", NEW."account_id", NEW."source", NEW."source_ref", NEW."target_key", NEW."fraction_ppm",
      NEW."amount_micro", NEW."clawed_micro", NEW."debt_micro", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."account_id", OLD."source", OLD."source_ref", OLD."target_key", OLD."fraction_ppm",
      OLD."amount_micro", OLD."clawed_micro", OLD."debt_micro", OLD."created_at")
     OR NEW."pending_micro" > OLD."pending_micro"
     OR (NEW."state" <> OLD."state" AND NOT (OLD."state" = 'applied' AND NEW."state" = 'reversed')) THEN
    RAISE EXCEPTION 'a clawback only pays down its pending claim or is reversed once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "credit_clawbacks_guard_trigger" BEFORE UPDATE OR DELETE ON "credit_clawbacks"
  FOR EACH ROW EXECUTE FUNCTION "credit_clawbacks_guard"();

-- Over the window AND the account: an included lot names a window of its own
-- account, never another's. `credit_ledger_apply` (0128) already refuses a
-- ledger row naming another account's lot; this is the same rule one table up.
-- Without the account in the key, a lot could draw a month of credits from a
-- window nobody sold to that account — and, because a window is removed only
-- with ITS account, deleting the OTHER account would raise inside the cascade
-- and that account could never be removed.
--
-- MATCH SIMPLE (the default): a lot with no window (a top-up, an adjustment)
-- satisfies it, as `credit_lots_window_iff_included` intends.
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_window_fk"
  FOREIGN KEY ("window_id", "account_id") REFERENCES "credit_windows"("id", "account_id")
  ON DELETE CASCADE;
CREATE UNIQUE INDEX "credit_lots_one_monthly_per_window" ON "credit_lots" ("window_id")
  WHERE "kind" = 'monthly';
