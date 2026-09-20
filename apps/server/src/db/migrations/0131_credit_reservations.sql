-- 0131 — the task reservations AI credits are spent through: one row per task,
-- the credits each task holds in each lot, and one row per model call it makes.
-- Amounts are microcredits (1 credit = 1,000,000 µcr = US$0.01).
--
-- A RESERVATION is one task. Before it runs, it sets credits aside: a row in
-- `credit_reservations` saying how much, at which rate card, in which of the
-- account's three enforced slots, and a row in `credit_reservation_holds` for
-- each lot the amount was taken from. A hold is the only thing that moves
-- `credit_lots.held_micro`, and held credit is not spendable by anything else —
-- not another task, not a clawback, not the expiry sweep. When the task ends,
-- each hold is released for exactly what the task used; the rest goes back.
-- Nothing reads or writes these tables yet: no route reserves.
--
-- ⛔ THE DATABASE HOLDS THE RULES, NOT ONLY THE CODE THAT WRITES HERE:
--
--   · AT MOST THREE ENFORCED TASKS AT ONCE, per account, counted by the
--     database: a partial unique index over (account, slot) where the row is
--     open and enforced. The service counts open reservations before it inserts
--     one, and that count is a race under concurrency; the index is what makes
--     the fourth task impossible rather than unlikely.
--   · CREDIT IS HELD, NEVER TAKEN, WHILE A TASK RUNS. A hold needs a STARTED,
--     live, unrevoked lot OF THE SAME ACCOUNT (H4: a lot whose month has not
--     begun is not spendable, so it cannot back a task either), and
--     `credit_lots_held_bounds` (0128) refuses a hold beyond what the lot has
--     left. `held_micro` moves ONLY through this table's trigger, which raises
--     the flag 0128's lot guard demands; a hold changes exactly once, by being
--     released.
--   · A RESERVATION'S TERMS NEVER CHANGE. Its account, session, request key,
--     model, rate card, mode, slot, reserved amount, lease owner, ceiling and
--     creation instant are immutable, and a settled task is final. What moves
--     is the lease, what the task has committed and spent, and the settlement.
--   · A MODEL CALL'S BOUND NEVER CHANGES, `sent` is one-way, and a settled call
--     is final — so the record of what a call was allowed to cost cannot be
--     rewritten after it ran, and a call that was sent cannot be turned into one
--     that was not (which the database would price at zero).
--   · A TASK IS PAID FOR BY WHAT IT HELD. At COMMIT a constraint trigger
--     re-checks every reservation a statement touched: an open reservation's
--     `committed_micro` equals its calls' bounds and charges, an enforced one's
--     holds sum to exactly what it reserved, and a settled one's charge equals
--     its calls, its holds and its `task_charge` ledger rows — three
--     independent records of one number.
--   · AN ACCOUNT NEVER HOLDS DEBT BESIDE SPENDABLE CREDIT, and releasing a hold
--     is now one of the ways free credit appears. 0128's
--     `credit_check_debt_vs_free` gains a second constraint trigger, on the
--     holds, so a release that frees credit for an account in debt is refused at
--     COMMIT unless the same transaction repays the debt.
--   · A TASK CHARGE NAMES A REAL TASK. `credit_ledger.reservation_id` gains its
--     foreign key here; until now a charge could name a reservation that never
--     existed.
--   · A HOLD AND A MODEL CALL NAME A TASK OF THEIR OWN ACCOUNT. Both keys are
--     (task, account) against `credit_reservations_id_account_unique`, the same
--     shape 0130 gave a lot and its window. Keyed on the task alone, a hold
--     could put ANOTHER account's credit behind this task: measured, it
--     committed, and the consequence is the frozen-credit one twice over — the
--     stranger's lot holds credit it can neither spend nor expire, and the task
--     can never settle, because `credit_ledger_apply` refuses a charge naming a
--     lot of another account, so the hold is never released and the slot is
--     never freed. A model call keyed the same way would put a stranger's call
--     into what this task committed and was charged.
--   · The trigger functions pin their search_path (public, then pg_temp), so a
--     session's temporary table named like a credit table cannot stand in for it
--     inside a guard.
--
-- 0130's `credit_windows_id_account_unique` is PROMOTED IN PLACE from a unique
-- index to a unique CONSTRAINT backed by that same index. Nothing is rewritten
-- and no index is built: `ADD CONSTRAINT … UNIQUE USING INDEX` re-labels the
-- index it is given. It matters for two reasons. `credit_lots_window_fk` (0130)
-- targets it, and PostgreSQL's documentation promises a foreign key may target
-- "a non-deferrable unique or primary key constraint" — a bare unique index is
-- accepted by the implementation but not promised by the documentation. And
-- `drizzle-kit export` emits standalone indexes AFTER foreign keys, so the
-- exported schema could not be replayed on an empty database while the target
-- was an index; as a constraint inside the table it can.
--
-- LOCKS. The foreign keys to `accounts`, `credit_rate_cards`, `credit_lots` and
-- `credit_reservations` take SHARE ROW EXCLUSIVE on those tables, and the new
-- constraint on `credit_ledger` takes it there; the promotion takes ACCESS
-- EXCLUSIVE on `credit_windows` for the instant it re-labels the index. All are
-- held until the migration batch commits. `credit_ledger` holds no task charges
-- yet (nothing writes one before this migration), so validating its new foreign
-- key reads a column that is NULL in every row. The lock timeout makes a busy
-- table fail the batch fast and whole, which is safe to retry.
--
-- EXPAND ONLY. Three new tables and their indexes, six functions, eight
-- triggers, one foreign key on `credit_ledger`, and one unique constraint
-- adopted onto an index that already exists. Nothing existing is rewritten or
-- removed. Reversible by dropping the three tables, the six functions, the
-- foreign key and the constraint.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "credit_windows" ADD CONSTRAINT "credit_windows_id_account_unique"
  UNIQUE USING INDEX "credit_windows_id_account_unique";

CREATE TABLE "credit_reservations" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "agent_session_id" text NOT NULL,
  "request_key" text,
  "model" text NOT NULL,
  "rate_card_version" integer NOT NULL REFERENCES "credit_rate_cards"("version"),
  "mode" text NOT NULL,
  "slot" smallint,
  "state" text NOT NULL DEFAULT 'open',
  "reserved_micro" bigint NOT NULL,
  "committed_micro" bigint NOT NULL DEFAULT 0,
  "charged_micro" bigint,
  "would_refuse_reason" text,
  "lease_owner" text NOT NULL,
  "lease_expires_at" timestamptz NOT NULL,
  "max_until" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,
  "settle_reason" text,
  CONSTRAINT "credit_reservations_mode" CHECK ("mode" IN ('enforce', 'shadow')),
  -- An enforced task holds one of three slots; a shadow one holds none.
  CONSTRAINT "credit_reservations_slot" CHECK ((("mode" = 'enforce') = ("slot" IS NOT NULL))
    AND ("slot" IS NULL OR "slot" BETWEEN 1 AND 3)),
  CONSTRAINT "credit_reservations_state" CHECK ("state" IN ('open', 'settled')),
  CONSTRAINT "credit_reservations_amounts" CHECK ("reserved_micro" > 0 AND "committed_micro" >= 0
    AND ("mode" = 'shadow' OR "committed_micro" <= "reserved_micro")),
  -- The hard ceiling (M1): a task the lease keeper never heard from again is
  -- settled at this instant, so a stuck turn cannot hold a slot for ever.
  CONSTRAINT "credit_reservations_max_until" CHECK ("max_until" > "created_at"
    AND "max_until" <= "created_at" + interval '30 minutes'),
  CONSTRAINT "credit_reservations_shadow_reason" CHECK ("mode" = 'shadow'
    OR "would_refuse_reason" IS NULL),
  CONSTRAINT "credit_reservations_would_refuse_reason" CHECK ("would_refuse_reason" IS NULL
    OR "would_refuse_reason" IN ('model', 'tasks_in_flight', 'debt', 'balance', 'call_did_not_fit')),
  CONSTRAINT "credit_reservations_settle_reason" CHECK ("settle_reason" IS NULL
    OR "settle_reason" IN ('completed', 'lease_expired', 'max_age', 'admin')),
  CONSTRAINT "credit_reservations_terminal_shape" CHECK (
       ("state" = 'open' AND "charged_micro" IS NULL AND "settled_at" IS NULL
        AND "settle_reason" IS NULL)
    OR ("state" = 'settled' AND "charged_micro" >= 0
        AND ("mode" = 'shadow' OR "charged_micro" <= "reserved_micro")
        AND "settled_at" IS NOT NULL AND "settle_reason" IS NOT NULL)),
  CONSTRAINT "credit_reservations_request_key_length" CHECK ("request_key" IS NULL
    OR length("request_key") BETWEEN 1 AND 300),
  -- What a hold and a model call point at. A task is identified by its id AND
  -- its account, so a row of either child table can only name a task of ITS OWN
  -- account. Redundant as a key — the id alone is the primary key — and there
  -- only so the two foreign keys below can carry the account, exactly as
  -- `credit_windows_id_account_unique` does for a lot and its window (0130).
  CONSTRAINT "credit_reservations_id_account_unique" UNIQUE ("id", "account_id")
);

-- At most three enforced tasks in flight per account, enforced by the database.
CREATE UNIQUE INDEX "credit_reservations_open_slot_unique" ON "credit_reservations" ("account_id", "slot")
  WHERE "state" = 'open' AND "mode" = 'enforce';
-- Only the idempotent lane sets a request key (M2): the inbound x-request-id is
-- client-controlled and reusing one must not refuse a task.
CREATE UNIQUE INDEX "credit_reservations_request_unique" ON "credit_reservations" ("account_id", "request_key")
  WHERE "request_key" IS NOT NULL;
CREATE INDEX "credit_reservations_lease_idx" ON "credit_reservations" ("lease_expires_at")
  WHERE "state" = 'open';
CREATE INDEX "credit_reservations_max_until_idx" ON "credit_reservations" ("max_until")
  WHERE "state" = 'open';
CREATE INDEX "credit_reservations_session_idx" ON "credit_reservations" ("agent_session_id", "created_at");

CREATE TABLE "credit_reservation_holds" (
  "reservation_id" uuid NOT NULL,
  "lot_id" uuid NOT NULL REFERENCES "credit_lots"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "held_micro" bigint NOT NULL,
  "charged_micro" bigint,
  "released_at" timestamptz,
  PRIMARY KEY ("reservation_id", "lot_id"),
  -- The account is part of the key, so a hold can only back a task of the same
  -- account as the lot it is taken from. See the header.
  CONSTRAINT "credit_reservation_holds_reservation_fk"
    FOREIGN KEY ("reservation_id", "account_id")
    REFERENCES "credit_reservations"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "credit_reservation_holds_positive" CHECK ("held_micro" > 0),
  CONSTRAINT "credit_reservation_holds_release_shape" CHECK (
    ("released_at" IS NULL) = ("charged_micro" IS NULL)
    AND ("charged_micro" IS NULL OR "charged_micro" BETWEEN 0 AND "held_micro"))
);

CREATE TABLE "credit_model_calls" (
  "id" uuid PRIMARY KEY,
  "reservation_id" uuid NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "purpose" text NOT NULL,
  "model" text NOT NULL,
  "input_bound_tokens" integer NOT NULL,
  "input_bound_basis" text NOT NULL,
  "input_bound_micro" bigint NOT NULL,
  "max_output_tokens" integer NOT NULL,
  "bound_micro" bigint NOT NULL,
  "shadow_over_reservation" boolean NOT NULL DEFAULT false,
  "state" text NOT NULL DEFAULT 'started',
  "sent" boolean NOT NULL DEFAULT false,
  "settle_basis" text,
  "uncached_input_tokens" integer,
  "output_tokens" integer,
  "cache_read_tokens" integer,
  "cache_write_5m_tokens" integer,
  "cache_write_1h_tokens" integer,
  "actual_micro" bigint,
  "charged_micro" bigint,
  "usage_record_id" uuid,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,
  -- As on the holds: a call can only belong to a task of its own account.
  CONSTRAINT "credit_model_calls_reservation_fk"
    FOREIGN KEY ("reservation_id", "account_id")
    REFERENCES "credit_reservations"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "credit_model_calls_seq_unique" UNIQUE ("reservation_id", "seq"),
  CONSTRAINT "credit_model_calls_purpose" CHECK ("purpose" IN ('plan', 'answer')),
  CONSTRAINT "credit_model_calls_basis" CHECK ("input_bound_basis" IN ('region_bytes', 'token_count')),
  CONSTRAINT "credit_model_calls_bound" CHECK ("seq" >= 1 AND "input_bound_tokens" > 0
    AND "max_output_tokens" > 0 AND "input_bound_micro" > 0 AND "bound_micro" > "input_bound_micro"),
  CONSTRAINT "credit_model_calls_state" CHECK ("state" IN ('started', 'settled')),
  CONSTRAINT "credit_model_calls_settle_basis" CHECK ("settle_basis" IS NULL
    OR "settle_basis" IN ('provider_usage', 'provider_rejected', 'never_sent', 'partial_usage', 'no_record')),
  CONSTRAINT "credit_model_calls_charge_le_bound" CHECK ("charged_micro" IS NULL
    OR ("charged_micro" >= 0 AND "charged_micro" <= "bound_micro")),
  -- A call the provider refused, or one that was never sent, costs nothing.
  CONSTRAINT "credit_model_calls_unbilled" CHECK ("settle_basis" NOT IN ('provider_rejected', 'never_sent')
    OR "charged_micro" = 0),
  CONSTRAINT "credit_model_calls_never_sent_really" CHECK ("settle_basis" <> 'never_sent' OR NOT "sent"),
  -- A call that was sent and left no record is charged its whole bound.
  CONSTRAINT "credit_model_calls_no_record_pays_bound" CHECK ("settle_basis" <> 'no_record'
    OR "charged_micro" = "bound_micro"),
  CONSTRAINT "credit_model_calls_terminal_shape" CHECK (
       ("state" = 'started' AND "charged_micro" IS NULL AND "settled_at" IS NULL
        AND "settle_basis" IS NULL)
    OR ("state" = 'settled' AND "charged_micro" IS NOT NULL AND "settled_at" IS NOT NULL
        AND "settle_basis" IS NOT NULL))
);

CREATE INDEX "credit_model_calls_open_idx" ON "credit_model_calls" ("reservation_id")
  WHERE "state" = 'started';

ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_reservation_fk"
  FOREIGN KEY ("reservation_id") REFERENCES "credit_reservations"("id") ON DELETE CASCADE;

-- A hold applies itself to its lot, and is the ONLY thing that may move
-- `held_micro` (0128's lot guard demands the flag this raises AND a trigger
-- depth of 2, so a session that raises the flag itself is still refused).
--
-- ⛔ THE INSERT REQUIRES A STARTED LOT (H4). Every other spendable predicate in
-- the system says `starts_at <= now() AND expires_at > now() AND revoked_at IS
-- NULL`; without the start here a task could hold — and then spend — credits of
-- a month that has not begun, which a refund before that month would take back
-- after they were gone. The lot must also belong to the SAME account as the
-- hold, so a task cannot hold a stranger's credit.
--
-- A hold changes exactly once, by being released: the amount, the lot, the
-- account and the task are immutable, `released_at` goes from NULL to an instant
-- and never back, and any other update is refused.
--
-- ⛔ A HOLD IS BORN UNRELEASED. The INSERT branch adds the hold to its lot, and
-- the release branch is the only thing that takes it off — and that branch needs
-- `OLD."released_at" IS NULL`. A row inserted with its release already filled in
-- would therefore raise `held_micro` with no path back, and those credits would
-- be gone: not spendable (every spendable predicate is `remaining − held`), not
-- expirable (`expireDueLots` expires `remaining − held` too), never charged.
--
-- ⛔ THE RELEASE KEEPS THE HOLD'S ACCOUNT AND ITS TASK. `credit_check_debt_vs_free`
-- asks about NEW."account_id", so a release that re-pointed the row at an account
-- owing nothing would free credit beside debt and the COMMIT-time check would
-- read the wrong account and pass. Re-pointing the reservation is the same shape
-- one table over: no COMMIT-time check runs on a statement that touches only
-- holds, so both reservations would be left disagreeing with what they reserved.
CREATE FUNCTION "credit_holds_apply"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM set_config('driftstack.credit_hold_apply', 'on', true);
  IF TG_OP = 'INSERT' THEN
    IF NEW."released_at" IS NOT NULL OR NEW."charged_micro" IS NOT NULL THEN
      RAISE EXCEPTION 'a hold is born unreleased' USING ERRCODE = '23514';
    END IF;
    UPDATE "credit_lots" SET "held_micro" = "held_micro" + NEW."held_micro"
     WHERE "id" = NEW."lot_id" AND "account_id" = NEW."account_id" AND "revoked_at" IS NULL
       AND "starts_at" <= now() AND "expires_at" > now();
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a hold needs a started, live, unrevoked lot of the same account'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD."released_at" IS NULL AND NEW."released_at" IS NOT NULL
        AND NEW."held_micro" = OLD."held_micro" AND NEW."lot_id" = OLD."lot_id"
        AND NEW."account_id" = OLD."account_id"
        AND NEW."reservation_id" = OLD."reservation_id" THEN
    UPDATE "credit_lots" SET "held_micro" = "held_micro" - OLD."held_micro"
     WHERE "id" = OLD."lot_id";
  ELSE
    RAISE EXCEPTION 'a hold changes only by being released once' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('driftstack.credit_hold_apply', 'off', true);
  RETURN NULL;
END $$;

CREATE TRIGGER "credit_holds_apply_trigger" AFTER INSERT OR UPDATE ON "credit_reservation_holds"
  FOR EACH ROW EXECUTE FUNCTION "credit_holds_apply"();
CREATE TRIGGER "credit_holds_delete_guard" BEFORE DELETE ON "credit_reservation_holds"
  FOR EACH ROW EXECUTE FUNCTION "credit_rows_die_only_with_their_account"();
CREATE TRIGGER "credit_model_calls_delete_guard" BEFORE DELETE ON "credit_model_calls"
  FOR EACH ROW EXECUTE FUNCTION "credit_rows_die_only_with_their_account"();
CREATE TRIGGER "credit_reservations_delete_guard" BEFORE DELETE ON "credit_reservations"
  FOR EACH ROW EXECUTE FUNCTION "credit_rows_die_only_with_their_account"();

-- A reservation's terms are what the customer was told the task would cost at
-- most. They never change, and a settled task is final.
CREATE FUNCTION "credit_reservations_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW."id", NEW."account_id", NEW."agent_session_id", NEW."request_key", NEW."model",
      NEW."rate_card_version", NEW."mode", NEW."slot", NEW."reserved_micro", NEW."lease_owner",
      NEW."max_until", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."account_id", OLD."agent_session_id", OLD."request_key", OLD."model",
      OLD."rate_card_version", OLD."mode", OLD."slot", OLD."reserved_micro", OLD."lease_owner",
      OLD."max_until", OLD."created_at") THEN
    RAISE EXCEPTION 'a reservation''s terms are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."state" = 'settled' THEN
    RAISE EXCEPTION 'a settled task is final' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "credit_reservations_guard_trigger" BEFORE UPDATE ON "credit_reservations"
  FOR EACH ROW EXECUTE FUNCTION "credit_reservations_guard"();

-- A call's bound is the ceiling it was admitted under, `sent` is one-way (a call
-- that went out cannot be re-recorded as one that never did, which the database
-- prices at zero), and a settled call is final.
CREATE FUNCTION "credit_model_calls_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW."id", NEW."reservation_id", NEW."account_id", NEW."seq", NEW."model",
      NEW."input_bound_tokens", NEW."input_bound_micro", NEW."max_output_tokens",
      NEW."bound_micro", NEW."started_at")
     IS DISTINCT FROM
     (OLD."id", OLD."reservation_id", OLD."account_id", OLD."seq", OLD."model",
      OLD."input_bound_tokens", OLD."input_bound_micro", OLD."max_output_tokens",
      OLD."bound_micro", OLD."started_at")
     OR OLD."state" = 'settled' OR (OLD."sent" AND NOT NEW."sent") THEN
    RAISE EXCEPTION 'a model call''s bound is immutable, sent is one-way, and a settled call is final'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "credit_model_calls_guard_trigger" BEFORE UPDATE ON "credit_model_calls"
  FOR EACH ROW EXECUTE FUNCTION "credit_model_calls_guard"();

-- Checked at COMMIT: a reservation's counters equal its rows, and a settled
-- enforced task balances across its calls, its holds and the ledger.
--
-- Deferred because a reservation and the holds that back it are written by
-- separate statements in one transaction, and so are a settlement's charge, its
-- releases and its ledger rows. An immediate check would refuse every one of
-- them halfway through.
CREATE FUNCTION "credit_check_reservation"(rid uuid) RETURNS void LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  c_commit bigint;
  c_charged bigint;
  c_open int;
  h_total bigint;
  h_charged bigint;
  h_open int;
  l_charged bigint;
BEGIN
  SELECT * INTO r FROM "credit_reservations" WHERE "id" = rid;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COALESCE(SUM(CASE WHEN "state" = 'started' THEN "bound_micro" ELSE "charged_micro" END), 0),
         COALESCE(SUM("charged_micro"), 0), COUNT(*) FILTER (WHERE "state" = 'started')
    INTO c_commit, c_charged, c_open FROM "credit_model_calls" WHERE "reservation_id" = rid;
  IF c_commit <> r."committed_micro" THEN
    RAISE EXCEPTION 'reservation % commits % but its calls commit %', rid, r."committed_micro", c_commit
      USING ERRCODE = '23514';
  END IF;
  IF r."state" = 'settled' AND (c_open > 0 OR c_charged <> r."charged_micro") THEN
    RAISE EXCEPTION 'settled reservation % does not equal its calls', rid USING ERRCODE = '23514';
  END IF;
  IF r."mode" = 'shadow' THEN RETURN; END IF;
  SELECT COALESCE(SUM("held_micro"), 0), COALESCE(SUM("charged_micro"), 0),
         COUNT(*) FILTER (WHERE "released_at" IS NULL)
    INTO h_total, h_charged, h_open FROM "credit_reservation_holds" WHERE "reservation_id" = rid;
  IF h_total <> r."reserved_micro" THEN
    RAISE EXCEPTION 'reservation % reserves % but holds %', rid, r."reserved_micro", h_total
      USING ERRCODE = '23514';
  END IF;
  IF r."state" = 'settled' THEN
    SELECT COALESCE(-SUM("lot_delta_micro"), 0) INTO l_charged FROM "credit_ledger"
     WHERE "reservation_id" = rid AND "kind" = 'task_charge';
    IF h_open > 0 OR h_charged <> r."charged_micro" OR l_charged <> r."charged_micro" THEN
      RAISE EXCEPTION 'settled reservation % does not balance', rid USING ERRCODE = '23514';
    END IF;
  END IF;
END $$;

CREATE FUNCTION "credit_check_reservation_from_call"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN PERFORM "credit_check_reservation"(NEW."reservation_id"); RETURN NULL; END $$;

CREATE FUNCTION "credit_check_reservation_from_row"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN PERFORM "credit_check_reservation"(NEW."id"); RETURN NULL; END $$;

CREATE CONSTRAINT TRIGGER "credit_model_calls_balance" AFTER INSERT OR UPDATE ON "credit_model_calls"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "credit_check_reservation_from_call"();
CREATE CONSTRAINT TRIGGER "credit_reservations_balance" AFTER INSERT OR UPDATE ON "credit_reservations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "credit_check_reservation_from_row"();

-- Releasing a hold frees credit WITHOUT a ledger row, so it is the second way an
-- account can end a transaction holding debt beside spendable credit. 0128's
-- function is reused unchanged: it reads the debt holding the account's credit
-- row FOR SHARE, which is what makes the check sound when a release races a
-- transaction that incurs debt.
CREATE CONSTRAINT TRIGGER "credit_holds_debt_vs_free" AFTER UPDATE ON "credit_reservation_holds"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "credit_check_debt_vs_free"();
