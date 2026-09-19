-- 0128 — the AI credits ledger core: each account's credit state, plan
-- overrides set by an admin, credit lots, and the ledger that is the ONLY way a
-- balance moves. Amounts are microcredits (1 credit = 1,000,000 µcr = US$0.01).
--
-- A LOT is one grant of credits with a term: a month's included credits, a
-- plan change's share of a month, goodwill, or bought credits. Its
-- `remaining_micro` is what is left of it. The LEDGER records every movement,
-- one row each: a grant into a lot, a charge or an expiry out of it, debt
-- incurred or repaid, an adjustment. Nothing reads or writes these tables yet:
-- they are inert until AI credits are switched on.
--
-- ⛔ THE DATABASE HOLDS THE RULES, NOT ONLY THE CODE THAT WRITES HERE:
--
--   · A balance moves only through a ledger row. `credit_lots.remaining_micro`
--     and `credit_accounts.debt_micro` change only when a `credit_ledger` row is
--     inserted: that row's AFTER trigger applies its deltas, and the guard
--     triggers refuse every other write to those columns. The write must carry
--     the flag the apply trigger raises (transaction-local) AND come from inside
--     a trigger (pg_trigger_depth() >= 2), so a session that raises the flag
--     itself and then UPDATEs a balance directly is refused too. (A session
--     that may run any SQL can still fire a trigger of its own on a temporary
--     table and write from depth 2; like disabling a trigger, that is closed
--     by the role the application connects as, not by these functions.)
--     `held_micro` is guarded the same way for the reservation holds, which a
--     later migration adds; until then nothing can move it.
--   · Every credit that exists is a ledger row. A lot is born empty (remaining
--     and held forced to 0 on INSERT, whatever the statement said) and an account
--     is born owing nothing (debt forced to 0), so a balance is only ever the sum
--     of its ledger rows.
--   · A ledger row cannot name another account's lot, and every ledger row
--     needs the account's credit row, which it locks (for update when it moves
--     debt, shared otherwise) until its transaction ends: the per-account lock,
--     taken before the lot's.
--   · The CHECKs keep amounts within their lot: remaining is between 0 and what
--     was granted, held never exceeds remaining. A charge or expiry larger than
--     what is left is refused, and with it the whole transaction.
--   · A lot is funded once: a second grant, proration grant or top-up row
--     naming the same lot is refused, even under a new key and even when
--     spending has left room under the ceiling.
--   · A lot's terms never change once written (every kind, with or without a
--     month window), and a revoked lot stays revoked.
--   · The ledger is append-only: UPDATE and DELETE are refused. Ledger rows,
--     lots and an account's credit row are removed only with their account
--     (the cascade of a deleted `accounts` row).
--   · The same idempotency key applies once per account (a unique index).
--     Writers insert with ON CONFLICT DO NOTHING: a second writer racing on the
--     same key waits for the first to finish, then does nothing.
--   · Ledger rows have a fixed shape per kind (a grant adds, a charge or an
--     expiry removes, debt is incurred with a reason). A task charge must name
--     its reservation, rate card and model; the reservations table and its
--     foreign key arrive in a later migration.
--   · At COMMIT, an account never holds debt beside spendable credit: a
--     deferred constraint trigger re-checks every account a new ledger row
--     touched. Spendable means started, not yet expired, not revoked, with
--     credit that no task holds — the same predicate every reader uses. Debt is
--     repaid from free credit in the transaction that creates either. The
--     check reads only what is committed, so it is the credit-row lock above
--     that makes it hold when two connections write at once: the second writer
--     waits for the first, and its check sees what the first committed.
--   · The trigger functions pin their search_path (public, then pg_temp), so a
--     session's temporary table named like a credit table cannot stand in for
--     it inside a guard.
--   · Bought credits (a top-up lot) last at most 12 months and a day, counted in
--     UTC. `timestamptz + interval` counts months and days in the SESSION time
--     zone, so the same row would pass or fail depending on who inserted it;
--     the CHECK converts to UTC first, which also makes it immutable.
--
-- `credit_lots.window_id` gains its foreign key when the month windows table
-- arrives; `credit_ledger.reservation_id` gains its foreign key with the
-- reservations table.
--
-- EXPAND ONLY. Four new tables, their indexes, five functions and five triggers.
-- Nothing existing is touched. Reversible by dropping the four tables and the
-- five functions.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "credit_accounts" (
  "account_id" uuid PRIMARY KEY REFERENCES "accounts"("id") ON DELETE CASCADE,
  "billing_mode" text NOT NULL DEFAULT 'legacy',
  "ai_source" text,
  "ai_source_set_by" text,
  "ai_source_set_at" timestamptz,
  "debt_micro" bigint NOT NULL DEFAULT 0,
  "auto_top_up_enabled" boolean NOT NULL DEFAULT false,
  "legacy_consent_at_move" boolean,
  "legacy_cap_cents_at_move" integer,
  "had_stored_key_at_move" boolean,
  "moved_to_credits_at" timestamptz,
  "moved_back_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "credit_accounts_billing_mode" CHECK ("billing_mode" IN ('legacy', 'credits')),
  -- NULL = automatic: the customer's own key when usable, else credits.
  CONSTRAINT "credit_accounts_ai_source" CHECK ("ai_source" IS NULL OR "ai_source" IN ('credits', 'own_key')),
  CONSTRAINT "credit_accounts_ai_source_set_by" CHECK (
    ("ai_source_set_by" IS NULL) = ("ai_source_set_at" IS NULL)
    AND ("ai_source_set_by" IS NULL OR "ai_source_set_by" IN ('cutover', 'customer', 'admin'))),
  CONSTRAINT "credit_accounts_debt_nonnegative" CHECK ("debt_micro" >= 0),
  CONSTRAINT "credit_accounts_move_snapshot" CHECK ("moved_to_credits_at" IS NULL OR
    ("legacy_consent_at_move" IS NOT NULL AND "legacy_cap_cents_at_move" IS NOT NULL AND "had_stored_key_at_move" IS NOT NULL))
);

CREATE INDEX "credit_accounts_credits_mode_idx" ON "credit_accounts" ("account_id") WHERE "billing_mode" = 'credits';

CREATE TABLE "credit_plan_overrides" (
  "account_id" uuid PRIMARY KEY REFERENCES "accounts"("id") ON DELETE CASCADE,
  "monthly_credits" integer NOT NULL,
  "own_key_allowed" boolean NOT NULL DEFAULT true,
  "anchor_at" timestamptz NOT NULL,
  "ends_at" timestamptz,
  "effective_since" timestamptz NOT NULL DEFAULT now(),
  "reason" text NOT NULL,
  "set_by_key_id" uuid,
  "note" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "credit_plan_overrides_credits_range" CHECK ("monthly_credits" BETWEEN 0 AND 10000000),
  -- Never created automatically: an admin sets each one.
  CONSTRAINT "credit_plan_overrides_reason" CHECK ("reason" IN ('contract', 'admin_tier')),
  CONSTRAINT "credit_plan_overrides_ends_after_anchor" CHECK ("ends_at" IS NULL OR "ends_at" > "anchor_at")
);

CREATE TABLE "credit_lots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "spend_rank" smallint NOT NULL,
  "window_id" uuid,
  "grant_key" text NOT NULL,
  "granted_micro" bigint NOT NULL,
  "remaining_micro" bigint NOT NULL DEFAULT 0,
  "held_micro" bigint NOT NULL DEFAULT 0,
  "starts_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "credit_lots_kind" CHECK ("kind" IN ('monthly', 'proration', 'adjustment', 'top_up')),
  -- Spend order: included credits (0), then goodwill (1), then bought credits (2).
  CONSTRAINT "credit_lots_rank_matches_kind" CHECK (
       ("kind" IN ('monthly', 'proration') AND "spend_rank" = 0)
    OR ("kind" = 'adjustment' AND "spend_rank" = 1)
    OR ("kind" = 'top_up' AND "spend_rank" = 2)),
  -- Included credits (rank 0, which the CHECK above ties to the monthly and
  -- proration kinds) belong to a month window; no other lot does.
  CONSTRAINT "credit_lots_window_iff_included" CHECK (("spend_rank" = 0) = ("window_id" IS NOT NULL)),
  CONSTRAINT "credit_lots_granted_whole_credits" CHECK ("granted_micro" > 0 AND "granted_micro" % 1000000 = 0),
  CONSTRAINT "credit_lots_remaining_bounds" CHECK ("remaining_micro" >= 0 AND "remaining_micro" <= "granted_micro"),
  CONSTRAINT "credit_lots_held_bounds" CHECK ("held_micro" >= 0 AND "held_micro" <= "remaining_micro"),
  CONSTRAINT "credit_lots_term" CHECK ("starts_at" < "expires_at"),
  CONSTRAINT "credit_lots_top_up_twelve_months" CHECK ("kind" <> 'top_up' OR
    "expires_at" <= (("starts_at" AT TIME ZONE 'UTC') + interval '12 months 1 day') AT TIME ZONE 'UTC')
);

CREATE UNIQUE INDEX "credit_lots_grant_key_unique" ON "credit_lots" ("grant_key");
CREATE INDEX "credit_lots_spendable_idx" ON "credit_lots" ("account_id", "spend_rank", "expires_at", "starts_at")
  WHERE "remaining_micro" > "held_micro";
CREATE INDEX "credit_lots_expiry_idx" ON "credit_lots" ("expires_at") WHERE "remaining_micro" > "held_micro";

CREATE TABLE "credit_ledger" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "lot_id" uuid REFERENCES "credit_lots"("id") ON DELETE CASCADE,
  "lot_delta_micro" bigint NOT NULL DEFAULT 0,
  "debt_delta_micro" bigint NOT NULL DEFAULT 0,
  "idempotency_key" text NOT NULL,
  "reservation_id" uuid,
  "agent_session_id" text,
  "model" text,
  "rate_card_version" integer REFERENCES "credit_rate_cards"("version"),
  "reason" text,
  "actor" text NOT NULL DEFAULT 'system',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "credit_ledger_kind" CHECK ("kind" IN ('grant', 'proration_grant', 'proration_clawback', 'task_charge', 'expiry',
    'refund_clawback', 'debt_incurred', 'debt_repayment', 'adjustment', 'top_up')),
  CONSTRAINT "credit_ledger_actor" CHECK ("actor" IN ('system', 'customer', 'admin', 'stripe', 'crypto')),
  CONSTRAINT "credit_ledger_lot_presence" CHECK (("lot_id" IS NULL) = ("lot_delta_micro" = 0)),
  CONSTRAINT "credit_ledger_shape" CHECK (
       ("kind" IN ('grant', 'proration_grant', 'top_up') AND "lot_delta_micro" > 0 AND "debt_delta_micro" = 0)
    OR ("kind" IN ('task_charge', 'expiry', 'proration_clawback', 'refund_clawback') AND "lot_delta_micro" < 0 AND "debt_delta_micro" = 0)
    OR ("kind" = 'debt_incurred' AND "lot_delta_micro" = 0 AND "debt_delta_micro" > 0)
    OR ("kind" = 'debt_repayment' AND "lot_delta_micro" < 0 AND "debt_delta_micro" = "lot_delta_micro")
    OR ("kind" = 'adjustment' AND "debt_delta_micro" <= 0 AND (("lot_delta_micro" = 0) <> ("debt_delta_micro" = 0)))),
  -- A row that raises debt says why. Only `debt_incurred` raises debt (the shape
  -- CHECK above), so this is that kind's reason, stated on the amount. The IS NOT
  -- NULL is load-bearing: `NULL IN (…)` is NULL, and a CHECK passes on NULL.
  CONSTRAINT "credit_ledger_debt_reason" CHECK ("debt_delta_micro" <= 0 OR
    ("reason" IS NOT NULL AND "reason" IN ('payment_reversed', 'plan_change'))),
  CONSTRAINT "credit_ledger_task_charge_context" CHECK ("kind" <> 'task_charge' OR
    ("reservation_id" IS NOT NULL AND "rate_card_version" IS NOT NULL AND "model" IS NOT NULL)),
  CONSTRAINT "credit_ledger_idempotency_key_length" CHECK (length("idempotency_key") BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX "credit_ledger_idempotency_unique" ON "credit_ledger" ("account_id", "idempotency_key");
CREATE INDEX "credit_ledger_account_idx" ON "credit_ledger" ("account_id", "id" DESC);
CREATE INDEX "credit_ledger_reservation_idx" ON "credit_ledger" ("reservation_id") WHERE "reservation_id" IS NOT NULL;
CREATE INDEX "credit_ledger_lot_idx" ON "credit_ledger" ("lot_id", "kind") WHERE "lot_id" IS NOT NULL;

-- Every function below pins its search_path. The guards look tables up by name,
-- and an unqualified name resolves to a session's TEMPORARY table first (pg_temp
-- is searched before everything else unless it is named): an empty temporary
-- `accounts` would make every account look deleted to the delete guards, and a
-- temporary `credit_lots` would take the apply trigger's UPDATE in place of the
-- real lot. With pg_temp named last, the real tables win.
--
-- A ledger row applies itself. An AFTER trigger, so an INSERT … ON CONFLICT DO
-- NOTHING that inserts nothing applies nothing.
--
-- It first takes the account's credit row — FOR NO KEY UPDATE when the row moves
-- debt, FOR SHARE otherwise — and refuses a row whose account has none. That is
-- the per-account lock, held to the end of the transaction, and the reason the
-- COMMIT-time debt check below holds under concurrency: that check reads only
-- committed rows, so without the lock a transaction incurring debt and another
-- adding free credit would each pass while the other's write was still
-- invisible, and both commit. With it, whichever writes second waits for the
-- first to finish, and its own check sees what the first committed. The lock
-- comes before the lot's, the order every writer uses (credit row, then lots).
--
-- A lot is FUNDED ONCE: a second grant, proration grant or top-up row naming a
-- lot is refused. `remaining_micro <= granted_micro` alone would let a partly
-- spent lot be refilled under a new key. The check runs after the lot's UPDATE,
-- which holds the lot's row lock, so a second funding row racing the first
-- waits for it and then sees it.
CREATE FUNCTION "credit_ledger_apply"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."debt_delta_micro" <> 0 THEN
    PERFORM 1 FROM "credit_accounts" WHERE "account_id" = NEW."account_id" FOR NO KEY UPDATE;
  ELSE
    PERFORM 1 FROM "credit_accounts" WHERE "account_id" = NEW."account_id" FOR SHARE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger row % has no credit account', NEW."id" USING ERRCODE = '23503';
  END IF;
  PERFORM set_config('driftstack.credit_ledger_apply', 'on', true);
  IF NEW."lot_delta_micro" <> 0 THEN
    UPDATE "credit_lots" SET "remaining_micro" = "remaining_micro" + NEW."lot_delta_micro"
     WHERE "id" = NEW."lot_id" AND "account_id" = NEW."account_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ledger row % names a lot of another account', NEW."id" USING ERRCODE = '23503';
    END IF;
    IF NEW."kind" IN ('grant', 'proration_grant', 'top_up') AND EXISTS (
         SELECT 1 FROM "credit_ledger"
          WHERE "lot_id" = NEW."lot_id" AND "kind" IN ('grant', 'proration_grant', 'top_up')
            AND "id" <> NEW."id") THEN
      RAISE EXCEPTION 'credit lot % is already funded', NEW."lot_id" USING ERRCODE = '23505';
    END IF;
  END IF;
  IF NEW."debt_delta_micro" <> 0 THEN
    UPDATE "credit_accounts" SET "debt_micro" = "debt_micro" + NEW."debt_delta_micro", "updated_at" = now()
     WHERE "account_id" = NEW."account_id";
  END IF;
  PERFORM set_config('driftstack.credit_ledger_apply', 'off', true);
  RETURN NULL;
END $$;

CREATE TRIGGER "credit_ledger_apply_trigger" AFTER INSERT ON "credit_ledger"
  FOR EACH ROW EXECUTE FUNCTION "credit_ledger_apply"();

-- Append-only. A row may be removed only by the cascade of its account's
-- deletion; by then the account row is gone.
CREATE FUNCTION "credit_rows_die_only_with_their_account"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "accounts" WHERE "id" = OLD."account_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END $$;

CREATE TRIGGER "credit_ledger_append_only_trigger" BEFORE UPDATE OR DELETE ON "credit_ledger"
  FOR EACH ROW EXECUTE FUNCTION "credit_rows_die_only_with_their_account"();

-- Insert: born empty. Delete: only with the account. Update: terms never
-- change; remaining moves only from the ledger's apply trigger, held only from
-- the holds' apply trigger; a revoked lot stays revoked.
CREATE FUNCTION "credit_lots_guard"() RETURNS trigger LANGUAGE plpgsql
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
      NEW."granted_micro", NEW."starts_at", NEW."expires_at", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."account_id", OLD."kind", OLD."spend_rank", OLD."window_id", OLD."grant_key",
      OLD."granted_micro", OLD."starts_at", OLD."expires_at", OLD."created_at") THEN
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

CREATE TRIGGER "credit_lots_guard_trigger" BEFORE INSERT OR UPDATE OR DELETE ON "credit_lots"
  FOR EACH ROW EXECUTE FUNCTION "credit_lots_guard"();

-- Insert: owes nothing. Delete: only with the account (removing the row would
-- forgive its debt with no ledger row). Update: the row keeps its account, and
-- debt moves only from the ledger's apply trigger.
CREATE FUNCTION "credit_accounts_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."debt_micro" := 0;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "accounts" WHERE "id" = OLD."account_id") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'credit_accounts rows are removed only with their account' USING ERRCODE = '55000';
  END IF;
  IF NEW."account_id" IS DISTINCT FROM OLD."account_id" THEN
    RAISE EXCEPTION 'a credit account keeps its account' USING ERRCODE = '55000';
  END IF;
  IF NEW."debt_micro" IS DISTINCT FROM OLD."debt_micro"
     AND (pg_trigger_depth() < 2
          OR current_setting('driftstack.credit_ledger_apply', true) IS DISTINCT FROM 'on') THEN
    RAISE EXCEPTION 'credit_accounts.debt_micro moves only through credit_ledger' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "credit_accounts_guard_trigger" BEFORE INSERT OR UPDATE OR DELETE ON "credit_accounts"
  FOR EACH ROW EXECUTE FUNCTION "credit_accounts_guard"();

-- Checked at COMMIT: debt and spendable credit never exist together. The holds
-- table (a later migration) adds a second constraint trigger on this function.
--
-- It holds the account's credit row FOR SHARE while it reads. A ledger row has
-- already taken that row (see credit_ledger_apply), so for the ledger this
-- changes nothing; it is what makes the check sound for a caller that frees
-- credit WITHOUT a ledger row — a released hold — racing a transaction that
-- incurs debt: the check then waits for that transaction and reads its debt,
-- instead of reading around it.
CREATE FUNCTION "credit_check_debt_vs_free"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
DECLARE
  d bigint;
  f bigint;
BEGIN
  SELECT "debt_micro" INTO d FROM "credit_accounts" WHERE "account_id" = NEW."account_id" FOR SHARE;
  IF COALESCE(d, 0) = 0 THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM("remaining_micro" - "held_micro"), 0) INTO f FROM "credit_lots"
   WHERE "account_id" = NEW."account_id" AND "starts_at" <= now() AND "expires_at" > now()
     AND "revoked_at" IS NULL;
  IF f > 0 THEN
    RAISE EXCEPTION 'account % has debt % and % spendable credit', NEW."account_id", d, f
      USING ERRCODE = '23514', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "credit_ledger_debt_vs_free" AFTER INSERT ON "credit_ledger"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "credit_check_debt_vs_free"();
