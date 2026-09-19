-- 0127 — the AI credits rate card: what a customer pays per token, per model,
-- in microcredits (1 credit = 1,000,000 µcr = US$0.01).
--
-- A card is a numbered VERSION with a markup over the provider's list price and
-- one row per model it prices. A task pins the card in force when it starts, so
-- every charge of that task is priced on one card. Nothing reads these tables
-- yet: they are inert until AI credits are switched on.
--
-- ⛔ THE DATABASE HOLDS THE RULES, NOT ONLY THE CODE THAT WRITES HERE:
--
--   · A published card never changes. The one permitted change is withdrawing
--     a card BEFORE it takes effect, and that write may set `withdrawn_at` only
--     (to now()); every other UPDATE and every DELETE is refused by trigger.
--   · Notice is a database fact. `announced_at` is forced to now() on insert,
--     so it cannot be backdated, and a CHECK requires every card after the
--     first to take effect at least 720 hours (30 × 24) after it was announced.
--     Hours rather than '30 days': a day interval is added in the SESSION time
--     zone, so across a daylight-saving change '30 days' can be 719 hours, and
--     the same row would pass or fail depending on who inserted it.
--   · Both of the rules above are judged again AT COMMIT, on the clock. now()
--     is the transaction's START, but customers can only see a card, or see
--     it withdrawn, once its transaction commits. So a deferred constraint
--     trigger refuses the COMMIT of a card with less than 720 hours still to
--     run, and of a withdrawal committed after the card took effect (by then
--     readers had it in force, and a task could have been priced on it).
--     Publish with a margin: effective_at = now() + 720 hours is accepted by
--     the CHECK but refused at commit. An explicit SET CONSTRAINTS … IMMEDIATE
--     moves this check to the end of the statement instead.
--     The notice trigger fires only for cards after version 1 (its WHEN clause
--     is judged when the row is written). So the launch card below leaves no
--     check pending: the migrator applies every pending migration in ONE
--     transaction, and while a deferred event is pending on this table Postgres
--     refuses ALTER TABLE and CREATE INDEX on it ("pending trigger events"). A
--     later migration can therefore alter this table, whether it ships with
--     this one or runs after it on a database built from zero.
--   · A model's prices can be written only in the transaction that created its
--     card (the guard compares the card's announced_at with now(), which is the
--     transaction's start time). Prices are never added to a card later.
--   · No Opus-class model can ever be priced: Opus runs only on the customer's
--     own key. A CHECK refuses any model id containing "opus", in any case.
--   · Two live cards cannot take effect at the same instant, so "the card in
--     force" is always exactly one row.
--   · Every price is positive where it must be, and cache prices keep their
--     order (read ≤ input ≤ 5-minute write ≤ 1-hour write), which the upper
--     bound on a call's cost relies on.
--
-- Version 1 is the launch card: list price × 2.0, effective at once (nobody is
-- on credits yet, so there is nobody to give notice to). Its rows equal
-- CREDIT_RATE_CARD_V1 in packages/api-types/src/ai-credits.ts, and a test parses
-- the INSERT below and holds the two equal, and equal to the list-price registry
-- × the markup.
--
-- EXPAND ONLY. Two new tables, three guard functions, one index and the seed.
-- Reversible by dropping the two tables and the three functions.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "credit_rate_cards" (
  "version" integer PRIMARY KEY,
  "markup_bp" integer NOT NULL,
  "announced_at" timestamptz NOT NULL DEFAULT now(),
  "effective_at" timestamptz NOT NULL,
  "withdrawn_at" timestamptz,
  "created_by_key_id" uuid,
  "note" text NOT NULL DEFAULT '',
  CONSTRAINT "credit_rate_cards_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "credit_rate_cards_markup_range" CHECK ("markup_bp" BETWEEN 10000 AND 100000),
  CONSTRAINT "credit_rate_cards_thirty_days_notice"
    CHECK ("version" = 1 OR "effective_at" >= "announced_at" + interval '720 hours'),
  CONSTRAINT "credit_rate_cards_withdraw_before_effective"
    CHECK ("withdrawn_at" IS NULL OR "withdrawn_at" < "effective_at")
);

CREATE UNIQUE INDEX "credit_rate_cards_live_effective_unique"
  ON "credit_rate_cards" ("effective_at") WHERE "withdrawn_at" IS NULL;

CREATE TABLE "credit_rate_card_models" (
  "version" integer NOT NULL REFERENCES "credit_rate_cards"("version") ON DELETE RESTRICT,
  "model" text NOT NULL,
  "input_micro_per_token" bigint NOT NULL,
  "output_micro_per_token" bigint NOT NULL,
  "cache_read_micro_per_token" bigint NOT NULL,
  "cache_write_5m_micro_per_token" bigint NOT NULL,
  "cache_write_1h_micro_per_token" bigint NOT NULL,
  "min_start_micro" bigint NOT NULL,
  "max_reserve_micro" bigint NOT NULL,
  "list_input_microcents_per_token" bigint NOT NULL,
  "list_output_microcents_per_token" bigint NOT NULL,
  PRIMARY KEY ("version", "model"),
  CONSTRAINT "credit_rate_card_models_positive"
    CHECK ("input_micro_per_token" > 0 AND "output_micro_per_token" > 0 AND "cache_read_micro_per_token" >= 0),
  CONSTRAINT "credit_rate_card_models_cache_order"
    CHECK ("cache_read_micro_per_token" <= "input_micro_per_token"
       AND "input_micro_per_token" <= "cache_write_5m_micro_per_token"
       AND "cache_write_5m_micro_per_token" <= "cache_write_1h_micro_per_token"),
  CONSTRAINT "credit_rate_card_models_reserve"
    CHECK ("min_start_micro" > 0 AND "max_reserve_micro" >= "min_start_micro"),
  -- Opus runs only on the customer's own key. Defence in depth beside the
  -- publisher and the reservation, and wider than one prefix on purpose.
  CONSTRAINT "credit_rate_card_models_never_opus" CHECK ("model" !~* 'opus')
);

-- Insert: announced_at is now(), and a card is never born withdrawn.
-- Update: only a withdrawal, before the card takes effect, that changes nothing
-- else; withdrawn_at is then set to now() whatever the caller wrote. "Before"
-- is the clock at this statement, not now(): a transaction that began before
-- the card's date may be running long after it.
-- Delete: never.
CREATE FUNCTION "credit_rate_cards_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."announced_at" := now();
    NEW."withdrawn_at" := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."withdrawn_at" IS NULL
     AND NEW."withdrawn_at" IS NOT NULL
     AND clock_timestamp() < OLD."effective_at"
     AND (NEW."version", NEW."markup_bp", NEW."announced_at", NEW."effective_at",
          NEW."created_by_key_id", NEW."note")
         IS NOT DISTINCT FROM
         (OLD."version", OLD."markup_bp", OLD."announced_at", OLD."effective_at",
          OLD."created_by_key_id", OLD."note") THEN
    NEW."withdrawn_at" := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'credit_rate_cards rows are immutable: % refused', TG_OP USING ERRCODE = '55000';
END $$;

CREATE TRIGGER "credit_rate_cards_guard_trigger" BEFORE INSERT OR UPDATE OR DELETE
  ON "credit_rate_cards" FOR EACH ROW EXECUTE FUNCTION "credit_rate_cards_guard"();

-- At COMMIT, on the clock: notice runs from when customers can see the card,
-- and a withdrawal counts only if it is visible before the card takes effect.
-- Version 1 is the launch card, effective at once by design; the notice trigger
-- is not even queued for it (WHEN below), so the seed leaves nothing pending.
CREATE FUNCTION "credit_rate_cards_commit_clock"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     AND NEW."version" <> 1
     AND NEW."effective_at" < clock_timestamp() + interval '720 hours' THEN
    RAISE EXCEPTION 'credit_rate_cards: card % takes effect less than 720 hours after it is committed',
      NEW."version" USING ERRCODE = '23514', CONSTRAINT = TG_NAME;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."withdrawn_at" IS NULL
     AND NEW."withdrawn_at" IS NOT NULL
     AND clock_timestamp() >= NEW."effective_at" THEN
    RAISE EXCEPTION 'credit_rate_cards: card % took effect before its withdrawal committed',
      NEW."version" USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "credit_rate_cards_notice_at_commit" AFTER INSERT
  ON "credit_rate_cards" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."version" <> 1)
  EXECUTE FUNCTION "credit_rate_cards_commit_clock"();

CREATE CONSTRAINT TRIGGER "credit_rate_cards_withdrawal_at_commit" AFTER UPDATE
  ON "credit_rate_cards" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "credit_rate_cards_commit_clock"();

-- A model row may be inserted only by the transaction that created its card,
-- and is never updated or deleted.
CREATE FUNCTION "credit_rate_card_models_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM "credit_rate_cards" c
                WHERE c."version" = NEW."version" AND c."announced_at" = now()) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'credit_rate_card_models rows are written once, with their card'
      USING ERRCODE = '55000';
  END IF;
  RAISE EXCEPTION 'credit_rate_card_models rows are immutable: % refused', TG_OP USING ERRCODE = '55000';
END $$;

CREATE TRIGGER "credit_rate_card_models_guard_trigger" BEFORE INSERT OR UPDATE OR DELETE
  ON "credit_rate_card_models" FOR EACH ROW EXECUTE FUNCTION "credit_rate_card_models_guard"();

-- Version 1: list price × 2.0 (markup 20,000 basis points), effective now.
INSERT INTO "credit_rate_cards" ("version", "markup_bp", "effective_at", "note")
VALUES (1, 20000, now(), 'Launch card: list price x 2.0');

-- Per token, in microcredits; min/max per task in microcredits; list prices in
-- microcents per token, kept for the record of what each row was priced from.
INSERT INTO "credit_rate_card_models" (
  "version",
  "model",
  "input_micro_per_token",
  "output_micro_per_token",
  "cache_read_micro_per_token",
  "cache_write_5m_micro_per_token",
  "cache_write_1h_micro_per_token",
  "min_start_micro",
  "max_reserve_micro",
  "list_input_microcents_per_token",
  "list_output_microcents_per_token"
) VALUES
  (1, 'claude-sonnet-5',   400, 2000, 40, 500,  800, 6000000, 60000000, 200, 1000),
  (1, 'claude-sonnet-4-6', 600, 3000, 60, 750, 1200, 9000000, 90000000, 300, 1500),
  (1, 'claude-haiku-4-5',  200, 1000, 20, 250,  400, 3000000, 30000000, 100,  500);
