-- 0132 — the four database gaps the S7/S8/S9 reviews proved but could not take
-- inside their own slice, plus the two small widenings the code above needs.
-- Amounts are microcredits (1 credit = 1,000,000 µcr = US$0.01).
--
-- Every rule here was already true in TypeScript and NOT true in Postgres, which
-- is the whole reason this file exists: the database is the last line, and a
-- rule that lives only in the process that writes the row is a rule a second
-- writer, a psql session or a restore does not have.
--
-- ⛔ WHAT IT ADDS, AND WHY EACH ONE IS A MONEY BUG UNTIL IT IS HERE:
--
--   1. `credit_model_calls_no_record_really` — the MIRROR of
--      `credit_model_calls_never_sent_really` (0131). That one refuses
--      `never_sent` on a row that says the request WENT OUT; this one refuses
--      `no_record` — the basis that charges the FULL BOUND — on a row that says
--      it never did. S8's `basisTheRowAgreesWith` already corrects in both
--      directions; only one direction was backed by the database, so a writer
--      that skipped that helper could bill a customer the ceiling of a request
--      that never left the process.
--
--   2. A HOLD NEEDS AN OPEN, ENFORCED TASK. `credit_holds_apply` checked the
--      LOT — started, live, unrevoked, same account — and never the RESERVATION,
--      and no COMMIT-time check fires on a statement touching only holds
--      (`credit_check_reservation` hangs off `credit_model_calls` and
--      `credit_reservations`, and it RETURNS EARLY for a shadow reservation).
--      So a hold inserted against a SETTLED task, or against a SHADOW one,
--      committed — and the credit it raised is then frozen for ever: not
--      spendable (every spendable predicate is `remaining − held`), not
--      expirable (`expireDueLots` expires `remaining − held` too), and never
--      released, because the settlement that would have walked it has already
--      run and a settled task is final, while a shadow task never walks holds at
--      all. The audit's `hold_open_past_its_task` SEES this state; from here the
--      database refuses to enter it.
--
--   3. NOTHING RE-CHECKED A RESERVATION FROM `credit_ledger`. A `task_charge`
--      row written after a task settled moves credit off a lot with nothing
--      asking whether the task's calls, its holds and the ledger still agree —
--      three independent records of one number, and only two of them were
--      guarded. `credit_ledger_reservation_balance` is the third leg, wired
--      exactly as 0131 wires the other two: a DEFERRABLE INITIALLY DEFERRED
--      constraint trigger calling `credit_check_reservation`.
--
--   4. THE AUDIT'S HOLDS RULES HAD NO INDEX TO STAND ON. `credit_reservation_holds`
--      carried exactly one index, its primary key `(reservation_id, lot_id)`, so
--      every rule that starts from `released_at IS NULL` read the whole table.
--      MEASURED on 40,000 holds of which 200 were open (local 16.14, ANALYZEd):
--      `hold_open_past_its_task` Seq Scan, 39,800 rows removed by filter,
--      `Buffers: shared hit=500`; `claim_pending_with_no_open_hold` the same scan
--      inside its anti-join, `hit=515`; `lot_held_vs_holds` the same again,
--      `hit=537`. With the partial index below all three take
--      `Bitmap Index Scan on credit_reservation_holds_open_idx` and read 12, 27
--      and 49 buffers. The table grows with every enforced task for ever, and the
--      open set stays small, which is exactly the shape a partial index is for.
--      `account_id` leads because `claim_pending_with_no_open_hold` correlates on
--      it; `reservation_id` follows for the anti-join in the other two.
--
--   5. A SHADOW MEASUREMENT MAY RESERVE NOTHING WHEN ITS MODEL HAS NO PRICE.
--      `would_refuse_reason = 'model'` was a value the CHECK accepted and nothing
--      could ever write: the shadow path returned `shadow_lost` when `priceModel`
--      came back null, so model refusals were invisible to the census AND M3's
--      "a lost rate of 0" shadow exit criterion was unreachable for any
--      deployment whose customers use an own-key-only model. Recording the
--      measurement needs a row, and the row needs an amount; the honest amount is
--      ZERO, because a model with no rate-card row has no `max_reserve` to
--      measure against. `credit_reservations_amounts` is re-stated to accept
--      exactly that one new shape and nothing else — every row it accepted
--      before, it still accepts.
--
--   6. A CLAWBACK'S OWN RECORD MAY FINALLY SAY WHAT IT COST. 0130's
--      `credit_clawbacks_guard` listed `debt_micro` among the immutable facts, so
--      when a pending claim turned into debt (`claimsLeftBecomeDebt`) the ledger
--      recorded the debt and the clawback that caused it did not. M6's "forgive
--      the unrepaid debt it created", read off that row, would forgive too
--      little. The guard now permits ONE new movement and no other: `debt_micro`
--      may RISE by exactly the amount `pending_micro` FALLS in the same
--      statement. Credit that was owed becomes debt that is owed; the sum of the
--      two is unchanged, which is what makes this safe to allow at all.
--
-- ⛔ THIS ONE DOES NOT ONLY ADD, AND SAYS SO. Two guard functions are REPLACED
-- (`credit_holds_apply`, `credit_clawbacks_guard`) and one CHECK is dropped and
-- re-stated (`credit_reservations_amounts`). Every replacement is strictly
-- WIDER or strictly STRICTER in one named direction, never a rewrite:
--   · `credit_holds_apply` gains one lookup and changes nothing else;
--   · `credit_clawbacks_guard` moves `debt_micro` out of the immutable tuple and
--     immediately pins it to one permitted movement, so the set of accepted
--     updates grows by exactly that movement;
--   · `credit_reservations_amounts` gains one disjunct.
-- `CREATE OR REPLACE FUNCTION` keeps the OID, so the eight triggers that already
-- point at these two functions are untouched and no trigger is re-created.
--
-- LOCKS. `ADD CONSTRAINT … CHECK` and `DROP CONSTRAINT` take ACCESS EXCLUSIVE on
-- their table for the moment they run, and the new CHECK is validated against
-- every existing row. `credit_model_calls` and `credit_reservations` hold ZERO
-- rows in production (AI credits are off and nothing reserves), so both
-- validations read an empty table. `CREATE INDEX` (not CONCURRENTLY — this runs
-- inside the migrator's single transaction, where CONCURRENTLY is not allowed)
-- takes SHARE on `credit_reservation_holds`, also empty. The lock timeout makes
-- a busy table fail the batch fast and whole, which is safe to retry.
--
-- Reversible by dropping the two new constraints, the index, the new function
-- and its trigger, and restoring 0131's and 0130's function bodies.

SET LOCAL lock_timeout = '5s';

-- ── 1. a call that never went out cannot be charged its bound ───────────────
ALTER TABLE "credit_model_calls" ADD CONSTRAINT "credit_model_calls_no_record_really"
  CHECK ("settle_basis" <> 'no_record' OR "sent");

-- ── 5. a shadow measurement of an unpriceable model reserves nothing ────────
--
-- ⛔ `IS NOT DISTINCT FROM 'model'`, NOT `= 'model'`, AND THE DIFFERENCE IS A
-- SECOND ROW SHAPE. A CHECK passes when its expression is NULL, and
-- `would_refuse_reason` is nullable. Written as `= 'model'`, a row with
-- `reserved_micro = 0`, `mode = 'shadow'` and NO reason at all evaluates the new
-- disjunct to NULL, so `FALSE OR NULL` is NULL and the whole conjunction is NULL
-- — which the constraint ACCEPTS. Measured on a database migrated to 0132: that
-- row inserted cleanly, while 0131 (`reserved_micro > 0 AND …`) refused it,
-- because FALSE short-circuits where NULL does not. `IS NOT DISTINCT FROM`
-- returns FALSE for NULL, so the disjunct is total and the widening really is
-- the ONE shape named above. A shadow row reserving nothing with no reason
-- recorded is not a measurement of anything: S11's census reads
-- `would_refuse_reason` to tell a refusal from a reading, so such a row would
-- count as a reading of zero and drag its cohort's mean reserve down with
-- nothing on the row to say why.
ALTER TABLE "credit_reservations" DROP CONSTRAINT "credit_reservations_amounts";
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_amounts"
  CHECK (("reserved_micro" > 0
          OR ("reserved_micro" = 0 AND "mode" = 'shadow'
              AND "would_refuse_reason" IS NOT DISTINCT FROM 'model'))
     AND "committed_micro" >= 0
     AND ("mode" = 'shadow' OR "committed_micro" <= "reserved_micro"));

-- ── 4. the index the daily audit's holds rules read ─────────────────────────
CREATE INDEX "credit_reservation_holds_open_idx" ON "credit_reservation_holds"
  ("account_id", "reservation_id") WHERE "released_at" IS NULL;

-- ── 2. a hold needs an OPEN, ENFORCED task ──────────────────────────────────
-- 0131's function with ONE lookup added, between the born-unreleased check and
-- the lot. Everything else is byte-for-byte what 0131 installed.
--
-- ⛔ THE TASK IS ASKED ABOUT BY ID ALONE, never (id, account). Whether the hold
-- names a task of its OWN account is the composite foreign key's job
-- (`credit_reservation_holds_reservation_fk` → `credit_reservations_id_account_unique`),
-- and that key reports 23503 naming itself. Repeating the account here would
-- make this trigger answer first with a different code for a question the key
-- already answers, and the integration arm that proves the key would then be
-- proving this instead.
--
-- `state` and `mode` are closed CHECK domains (`open|settled`, `enforce|shadow`),
-- so the predicate is total: every reservation that exists is either accepted or
-- refused, and a hold naming a reservation that does not exist is refused here
-- as well as by the key.
--
-- ⛔ THE LOOKUP TAKES `FOR SHARE`, AND WITHOUT IT THE GUARD DOES NOT HOLD
-- AGAINST THE SECOND WRITER IT EXISTS FOR. An unlocked read answers from this
-- transaction's snapshot, and nothing re-asks: a statement touching only
-- `credit_reservation_holds` queues no COMMIT-time check (that is the very gap
-- above). MEASURED, two psql sessions on a database at 0132: A inserts a hold
-- while the task is open and waits; B settles the task and commits; A then
-- commits — and the hold lands on a SETTLED task, `held_micro` raised with no
-- path back, which is precisely the frozen credit this rule was added to make
-- impossible. The row lock closes it from both sides. If the hold gets there
-- first, the settle's own `SELECT … FOR UPDATE` waits behind this SHARE and then
-- meets the COMMIT-time balance check; if the settle gets there first, this
-- lookup waits, re-evaluates its predicate against the settled row under READ
-- COMMITTED, finds nothing, and refuses. `FOR SHARE`, not `FOR UPDATE`: two
-- holds of the same task must not serialise against each other, and the
-- foreign-key check has already taken `FOR KEY SHARE` on this very row — which
-- is not enough by itself, because KEY SHARE does not block an UPDATE of a
-- non-key column and `state` is one. Lock order is unchanged: every path that
-- reaches here already holds `credit_accounts` (reserve) or takes it first
-- (settle), so accounts-then-reservation is the only order in the system.
CREATE OR REPLACE FUNCTION "credit_holds_apply"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM set_config('driftstack.credit_hold_apply', 'on', true);
  IF TG_OP = 'INSERT' THEN
    IF NEW."released_at" IS NOT NULL OR NEW."charged_micro" IS NOT NULL THEN
      RAISE EXCEPTION 'a hold is born unreleased' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM "credit_reservations"
      WHERE "id" = NEW."reservation_id"
        AND "state" = 'open' AND "mode" = 'enforce'
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a hold needs an open, enforced task' USING ERRCODE = '23514';
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

-- ── 3. the ledger re-checks the task it names ───────────────────────────────
-- The third leg of the COMMIT-time balance, wired as 0131 wires the other two.
-- `credit_ledger` is append-only (0128's `credit_ledger_append_only_trigger`
-- refuses UPDATE and DELETE), so INSERT is the only event there is.
--
-- The WHEN clause keeps the ordinary ledger row — a grant, an expiry, a
-- top-up — from queueing a check it would spend on nothing:
-- `credit_check_reservation(NULL)` finds no reservation and returns, which is
-- correct and still costs a queued event and a lookup per row.
CREATE FUNCTION "credit_check_reservation_from_ledger"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN PERFORM "credit_check_reservation"(NEW."reservation_id"); RETURN NULL; END $$;

CREATE CONSTRAINT TRIGGER "credit_ledger_reservation_balance" AFTER INSERT ON "credit_ledger"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."reservation_id" IS NOT NULL)
  EXECUTE FUNCTION "credit_check_reservation_from_ledger"();

-- ── 6. a clawback's debt may rise by what its pending claim gives up ────────
-- 0130's function with `debt_micro` moved out of the immutable tuple and pinned
-- to ONE movement in its place. Everything else is byte-for-byte 0130's.
--
-- The permitted movement is a TRANSFER, not an increase: credit the account
-- still owed (`pending_micro`) becoming debt the account owes (`debt_micro`),
-- by the same amount, in the same statement. `pending_micro` may still only
-- fall, so the pair can never both rise, and `debt_micro` alone can never move.
CREATE OR REPLACE FUNCTION "credit_clawbacks_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "accounts" WHERE "id" = OLD."account_id") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'credit_clawbacks rows are removed only with their account' USING ERRCODE = '55000';
  END IF;
  IF (NEW."id", NEW."account_id", NEW."source", NEW."source_ref", NEW."target_key", NEW."fraction_ppm",
      NEW."amount_micro", NEW."clawed_micro", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."account_id", OLD."source", OLD."source_ref", OLD."target_key", OLD."fraction_ppm",
      OLD."amount_micro", OLD."clawed_micro", OLD."created_at")
     OR NEW."pending_micro" > OLD."pending_micro"
     -- ⛔ EVERY LEG OF THE PERMITTED MOVEMENT IS SPELLED OUT, NULLS INCLUDED.
     -- `debt_micro` is nullable (an unmatched clawback carries none), and a
     -- three-valued comparison that came back NULL would make the whole IF
     -- false — i.e. ACCEPT the update. The two IS NOT NULL tests are what stop
     -- "set debt_micro to NULL" from passing through the arithmetic as unknown.
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
