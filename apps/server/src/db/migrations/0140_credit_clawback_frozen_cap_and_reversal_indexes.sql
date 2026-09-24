-- 0140 — a reversal's clawback rows remember what the interim annual cap was
-- measured on, where in the ledger they were taken, and how much of the credit
-- a running task holds the customer may still spend before a claim on it stops
-- being owed; and the ledger gains the indexes the reversal reads use.
--
-- The fourth audit of S17 found that a won dispute re-measured the interim
-- annual cap on spending that happened AFTER the refund it undid, that a task
-- settling after a refund turned its claim into debt the cap forbids, and that
-- every reversal and every refresh read work that grew with the account's whole
-- ledger. So:
--
--   · `credit_clawbacks.cap_spent_micro` is what the payment's credit had been
--     spent — plus what running tasks held of it — across all of its windows
--     at the moment the reversal was measured. The cap uses the newest STANDING
--     reversal's figure: a later spend, a later win or a later settle does not
--     move it. NULL on every row no reversal of a payment wrote.
--   · `credit_clawbacks.ledger_mark` is the account's newest ledger row when
--     the clawback was measured: what "spent since the take" is counted from.
--   · `credit_clawbacks.claim_forgive_after_micro` is how much more of the
--     unit's credit may be spent after the take before spending it is no
--     longer the customer's to owe: when a task's claim on held credit is left
--     unpaid at its settlement, the part of it that spending beyond this
--     figure explains is not owed (the frozen cap allowed no debt for it).
--     NULL: the whole of an unpaid claim is owed, as before.
--
-- The three are facts of the clawback, so the clawbacks guard is 0139's,
-- changed ONLY by the three columns joining the facts that never change.
--
-- The ledger indexes serve reads that until now walked every ledger row of
-- the account: a clawback's collected claims (by the clawback id inside the
-- claim row's key), a credit unit's given-back rows (by the window id inside
-- the give-back key), and the account's debt movements in order. Two more
-- serve the reads a won dispute and a task's settlement make to put back
-- credit a task's hold sent elsewhere while the dispute stood: the record a
-- give-back leaves for a task still running (by the task inside
-- `hold:<task>:…`), and the account's enforced tasks in the order they
-- started. Each is partial, so it holds only the rows it serves. A key is
-- read by its PREFIX (`claim:<clawback>:`, `reinstate:window:<window>:…`,
-- `hold:<task>:`) as a byte range, so those three index the whole key with
-- `text_pattern_ops`: the database's collation does not order punctuation
-- byte by byte, and the pattern operators do. Plain columns, not
-- expressions, so the schema-against-database guard can compare them.
--
-- ADDITIVE. Nullable columns with no default rewrite no row. The CHECKs are
-- validated against a table production holds nothing in (AI credits ship dark),
-- and so are the indexes built. The lock timeout makes a busy table fail the
-- batch fast and whole, which is safe to retry.
--
-- Reversible by restoring 0139's clawbacks guard, and dropping the indexes, the
-- CHECKs and the columns.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "credit_clawbacks" ADD COLUMN IF NOT EXISTS "cap_spent_micro" bigint;

ALTER TABLE "credit_clawbacks" ADD COLUMN IF NOT EXISTS "ledger_mark" bigint;

ALTER TABLE "credit_clawbacks" ADD COLUMN IF NOT EXISTS "claim_forgive_after_micro" bigint;

ALTER TABLE "credit_clawbacks" ADD CONSTRAINT "credit_clawbacks_cap_spent"
  CHECK ("cap_spent_micro" IS NULL OR "cap_spent_micro" >= 0);

ALTER TABLE "credit_clawbacks" ADD CONSTRAINT "credit_clawbacks_ledger_mark"
  CHECK ("ledger_mark" IS NULL OR "ledger_mark" >= 0);

ALTER TABLE "credit_clawbacks" ADD CONSTRAINT "credit_clawbacks_claim_forgive_after"
  CHECK ("claim_forgive_after_micro" IS NULL OR "claim_forgive_after_micro" >= 0);

CREATE OR REPLACE FUNCTION "credit_clawbacks_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "accounts" WHERE "id" = OLD."account_id") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'credit_clawbacks rows are removed only with their account' USING ERRCODE = '55000';
  END IF;
  IF (NEW."id", NEW."account_id", NEW."source", NEW."source_ref", NEW."target_key", NEW."fraction_ppm",
      NEW."amount_micro", NEW."clawed_micro", NEW."created_at", NEW."disputed_minor",
      NEW."cap_spent_micro", NEW."ledger_mark", NEW."claim_forgive_after_micro")
     IS DISTINCT FROM
     (OLD."id", OLD."account_id", OLD."source", OLD."source_ref", OLD."target_key", OLD."fraction_ppm",
      OLD."amount_micro", OLD."clawed_micro", OLD."created_at", OLD."disputed_minor",
      OLD."cap_spent_micro", OLD."ledger_mark", OLD."claim_forgive_after_micro")
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

CREATE INDEX IF NOT EXISTS "credit_ledger_claim_clawback_idx"
  ON "credit_ledger" ("account_id", "idempotency_key" text_pattern_ops)
  WHERE starts_with("idempotency_key", 'claim:');

CREATE INDEX IF NOT EXISTS "credit_ledger_giveback_window_idx"
  ON "credit_ledger" ("account_id", "idempotency_key" text_pattern_ops)
  WHERE "kind" = 'adjustment' AND starts_with("idempotency_key", 'reinstate:');

CREATE INDEX IF NOT EXISTS "credit_ledger_debt_idx"
  ON "credit_ledger" ("account_id", "id")
  WHERE "debt_delta_micro" <> 0;

CREATE INDEX IF NOT EXISTS "credit_clawbacks_hold_idx"
  ON "credit_clawbacks" ("account_id", "source_ref" text_pattern_ops)
  WHERE starts_with("source_ref", 'hold:');

CREATE INDEX IF NOT EXISTS "credit_reservations_account_created_idx"
  ON "credit_reservations" ("account_id", "created_at")
  WHERE "mode" = 'enforce';
