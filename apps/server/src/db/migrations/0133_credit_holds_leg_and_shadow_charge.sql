-- 0133 — the two remaining database gaps the money review MEASURED against a
-- database already at 0132, and could not take inside the slice that found them.
-- Amounts are microcredits (1 credit = 1,000,000 µcr = US$0.01).
--
-- Both are the same shape as 0132's: a rule that was true in TypeScript and not
-- true in Postgres. The difference here is that both were measured with raw SQL
-- on a database at 0132 before a line of this file was written, and the exact
-- states they let through are recorded below.
--
-- ⛔ WHAT IT ADDS, AND WHAT EACH ONE LET THROUGH:
--
--   1. THE FOURTH LEG. `credit_check_reservation` is queued from three places —
--      `credit_model_calls` (0131), `credit_reservations` (0131) and
--      `credit_ledger` (0132) — and from NOWHERE on a statement that touches
--      only `credit_reservation_holds`. So the one rule that is ABOUT the holds
--      ("an enforced task's holds sum to exactly what it reserved") was the one
--      rule no holds statement re-asked.
--
--      MEASURED, on a database at 0132, three statements in three transactions:
--      an enforced task reserving 50,000,000 µcr with one hold of 50,000,000
--      committed; a second hold of 10,000,000 µcr on a second lot, inserted BY
--      ITSELF, also committed; the task then read `reserved_micro` 50,000,000
--      against holds of 60,000,000. The control is what makes this a wiring gap
--      and not a missing rule: an UPDATE of that same task's
--      `lease_expires_at` — touching nothing but the reservation row — then
--      failed at COMMIT with 0131's own message, `reservation … reserves
--      50000000 but holds 60000000`. The rule was there the whole time and no
--      holds statement could reach it.
--
--      The 10,000,000 µcr is the damage, and it is the frozen-credit one again:
--      the lot's `held_micro` is raised, the settlement walks
--      `openHoldsInSpendOrder` and releases what it finds — so this hold IS
--      walked — but the task is charged what its CALLS say and the holds must
--      already sum to `reserved_micro` for the settle to commit at all. The
--      extra hold makes the task unsettleable: every settlement of it now fails
--      the same check, the slot is never freed, and the credit is held for ever.
--
--      Fixed by wiring the fourth leg exactly as 0131 wires the first two — a
--      DEFERRABLE INITIALLY DEFERRED constraint trigger over
--      `credit_check_reservation` — so the check is queued from every table that
--      can change either side of it.
--
--   2. A MEASUREMENT CANNOT BE CHARGED. `credit_check_reservation` returns as
--      soon as it sees `mode = 'shadow'`: a shadow task holds nothing, so there
--      is no holds leg and no ledger leg to check. But the return happens BEFORE
--      anything asks whether the ledger has charged it anyway, and a
--      `task_charge` row moves real credit off a real lot through
--      `credit_ledger_apply` regardless of which task it names.
--
--      MEASURED, same database: a shadow reservation, then one `task_charge`
--      row naming it for 7,000,000 µcr against a funded lot. It committed, and
--      the lot's `remaining_micro` fell from 100,000,000 to 93,000,000. Shadow
--      is the mode every turn runs in for the whole measurement era (S11), so
--      this is not a theoretical row: it is one mis-set mode, or one settle
--      helper called with the wrong reservation id, away from a customer paying
--      for a measurement that was supposed to cost them nothing.
--
--      Fixed inside `credit_check_reservation`, where the early return is: a
--      shadow task with a `task_charge` row naming it is refused at COMMIT. The
--      check reaches it through the trigger 0132 already installed on
--      `credit_ledger`, so no trigger is added for it.
--
--      ⛔ SCOPED TO `task_charge`, WHICH IS THE ONLY KIND THAT CAN NAME A TASK
--      AND THE ONLY KIND MEASURED TO MOVE CREDIT IN ONE'S NAME.
--      `creditLedgerRowFor` sets `reservation_id` on exactly one branch (the
--      `task_charge` case; every other branch inherits `reservationId: null`
--      from `common`), and `credit_ledger_task_charge_context` requires that
--      branch to carry one. A wider rule — "no ledger row of any kind names a
--      shadow task" — would refuse rows nothing writes, on a defect nobody has
--      measured, and is recorded as an open item instead of guessed at here.
--
--   3. DOCUMENTATION ONLY, NO DDL: 0132's relaxed `credit_clawbacks_guard`
--      permits pending → debt in the SAME statement as applied → reversed. The
--      guard judges the debt movement and the state move as two independent
--      permissions, so an UPDATE doing both passes both. MEASURED on the same
--      database: one UPDATE took a clawback from (applied, pending 6,000,000,
--      debt 0) to (reversed, pending 0, debt 6,000,000) and was accepted. It is
--      permitted and harmless today — nothing in the server writes `state =
--      'reversed'` at all (M6's reversal is a later slice), and the pair still
--      sums to the same amount owed, which is what M6 reads. The sentence lives
--      beside the guard in `schema.ts`, where the triggers are documented; it is
--      written down rather than closed because there is no defect to close.
--
-- ⛔ ADDITIVE, AND RE-RUNNABLE. Nothing is dropped, retyped or renamed: one
-- function is REPLACED (`credit_check_reservation`, 0131's body plus the one
-- check above), one is created, and one constraint trigger is installed.
-- `CREATE OR REPLACE FUNCTION` keeps the OID, so the three triggers that already
-- point at `credit_check_reservation` are untouched and none is re-created. The
-- trigger is written `DROP TRIGGER IF EXISTS` then `CREATE`, so that a database
-- which ran an EARLIER DRAFT of this file converges on the final text instead of
-- keeping the draft's object while reporting 134 of 134 applied — the failure
-- mode the wave-3 hand-over recorded for 0132.
--
-- LOCKS. `CREATE OR REPLACE FUNCTION` locks only its `pg_proc` row.
-- `DROP TRIGGER IF EXISTS` takes ACCESS EXCLUSIVE on
-- `credit_reservation_holds` for the instant it runs (and finds nothing to drop
-- on every database that has not run a draft), and `CREATE CONSTRAINT TRIGGER`
-- takes SHARE ROW EXCLUSIVE on it; both are held until the migration batch
-- commits. That table holds ZERO rows in production (AI credits are off and
-- nothing reserves), and neither statement reads or rewrites a row in any case.
-- The lock timeout makes a busy table fail the batch fast and whole, which is
-- safe to retry.
--
-- COST. The new leg adds one `credit_check_reservation` call per hold row
-- written, at COMMIT. The shadow rule adds one `credit_ledger` lookup per
-- shadow reservation checked; `credit_ledger_reservation_idx` (0128, partial on
-- `reservation_id IS NOT NULL`) already covers it — MEASURED on a ledger of
-- 40,001 rows, `Index Scan using credit_ledger_reservation_idx`, `Buffers:
-- shared hit=2`, which is why this migration adds no index.
--
-- Reversible by dropping the new trigger and the new function and restoring
-- 0131's body for `credit_check_reservation`.

SET LOCAL lock_timeout = '5s';

-- ── 2. a shadow measurement is never charged by the ledger ──────────────────
-- 0131's function with ONE test added, in place of the bare shadow return.
-- Everything else is byte-for-byte what 0131 installed.
--
-- ⛔ IT SITS WHERE THE EARLY RETURN WAS, SO EVERY SHADOW TASK IS ASKED. Put
-- after the return it would be dead code; put before the calls check it would
-- answer for a row whose own counters have not been checked yet. Here it runs
-- for every shadow reservation any of the four legs queues a check for — and
-- the ledger leg (0132) is the one that queues it for the offending row itself,
-- because `task_charge` requires a `reservation_id` and that trigger fires
-- exactly WHEN one is present.
--
-- The message says "measured, not charged" rather than naming a constraint: the
-- offending row is in `credit_ledger` and the refusal is about the reservation,
-- so there is no single constraint name that would be true of it.
CREATE OR REPLACE FUNCTION "credit_check_reservation"(rid uuid) RETURNS void LANGUAGE plpgsql
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
  IF r."mode" = 'shadow' THEN
    IF EXISTS (SELECT 1 FROM "credit_ledger"
                WHERE "reservation_id" = rid AND "kind" = 'task_charge') THEN
      RAISE EXCEPTION 'shadow reservation % is measured, not charged: the ledger charges it', rid
        USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
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

-- ── 1. the fourth leg: a holds statement re-checks the task it names ────────
-- The same one-line body as `credit_check_reservation_from_call` (0131) and
-- `credit_check_reservation_from_ledger` (0132), and a function of its own for
-- the same reason those two are separate: the trigger that fails names the
-- function in its CONTEXT line, and one shared function would make the three
-- legs indistinguishable in a database error.
CREATE OR REPLACE FUNCTION "credit_check_reservation_from_hold"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN PERFORM "credit_check_reservation"(NEW."reservation_id"); RETURN NULL; END $$;

-- ⛔ INSERT **OR UPDATE**, THE SHAPE 0131 GIVES THE OTHER TWO LEGS, AND THE
-- UPDATE HALF CANNOT REFUSE ANYTHING THE INSERT HALF WOULD NOT. The measured
-- defect is an INSERT; a release is the only UPDATE a hold may take, and it
-- moves neither `held_micro` nor `reserved_micro`, so on an open task it changes
-- nothing this check reads. It is wired anyway because the leg is about the
-- STATEMENT SHAPE — "a statement touching only holds re-asks its task" — and a
-- leg that covered half the statements would have to be re-read to know which
-- half. `credit_ledger`'s leg is INSERT-only for the opposite reason: that table
-- is append-only, so INSERT is the only event it has.
--
-- ⛔ DEFERRABLE INITIALLY DEFERRED, for 0131's reason and one more of its own. A
-- reservation and the holds that back it are written by separate statements of
-- one transaction, so an immediate check would refuse every reserve halfway
-- through — and a settlement releases its holds, writes its ledger rows and
-- marks the reservation in that order, so an immediate check would refuse every
-- settle at the release.
--
-- ⛔ NAMED SO IT SORTS AFTER `credit_holds_debt_vs_free`. Postgres fires row
-- triggers in name order, and deferred events fire at COMMIT in the order they
-- were queued, so the debt-beside-free-credit refusal still gets there first on
-- a release that frees credit beside debt — which is the refusal that file's
-- arms pin by constraint name.
DROP TRIGGER IF EXISTS "credit_holds_reservation_balance" ON "credit_reservation_holds";
CREATE CONSTRAINT TRIGGER "credit_holds_reservation_balance"
  AFTER INSERT OR UPDATE ON "credit_reservation_holds"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "credit_check_reservation_from_hold"();
