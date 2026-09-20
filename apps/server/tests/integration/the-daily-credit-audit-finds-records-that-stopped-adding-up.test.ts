// The daily audit asks whether the credit records still agree with themselves,
// and tells a person when they do not (§5.3, "Daily invariant audit").
//
// ⛔ EVERY RULE HERE IS ALREADY ENFORCED — by a CHECK, a trigger, or a
// COMMIT-time constraint trigger. THAT IS WHY THE AUDIT EXISTS, and it is also
// why these arms have to switch the enforcement off to seed a breach at all.
// `session_replication_role = replica` is not a trick to get round a guard: it
// IS the failure being modelled. A guard dropped by a migration that meant to
// drop something else, a `COPY` from a restore, a superuser session during an
// incident and a backup taken mid-transaction all reach the database with the
// triggers not firing, and all leave the same trace — records that no longer
// add up and nothing that ever asks.
//
// So the claim of this file is not "the database refuses these rows"; other
// files prove that. It is: WHEN THE ROWS EXIST ANYWAY, THE AUDIT SEES THEM.
//
// ⛔ EACH ARM ASSERTS WHAT MOVED, NOT WHAT IS. `whatMoved` counts EVERY rule in
// `CREDIT_INVARIANT_CHECKS` before and after its seed and reports the
// difference, so every arm proves two things at once: the rule it aimed at
// fired, and NO OTHER RULE DID. It walks the declared list rather than a number
// written here, so a rule added later is covered by every arm on the day it
// lands.
// A check whose SQL is too broad — one that counts every lot rather than the
// broken one — passes an "is it ≥ 1" assertion and fails here.
//
// ⛔ AND THE CLEAN ARM IS NOT VACUOUS. A check that can never fire is silent on
// a clean database too, which is the one failure mode an audit cannot survive:
// it looks exactly like an audit that keeps finding nothing. So the clean arm
// seeds the HEALTHY shape of the rules that could otherwise be trivially zero —
// a correctly priced shadow call, an active subscription with the invoice that
// covers it, and a task a minute past its ceiling that the keeper is about to
// settle — and requires zero from each.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import {
  CREDIT_AUDIT_MAX_UNTIL_GRACE_MINUTES,
  CREDIT_INVARIANT_CHECKS,
  DrizzleCreditInvariantAuditRepo,
  type CreditInvariantCheck,
  type CreditInvariantCounts,
} from '../../src/db/credit-invariant-audit-repo.js';
import {
  auditCreditInvariants,
  breachesIn,
  reportCreditInvariantBreaches,
} from '../../src/services/credit-invariant-audit.js';
import { MICRO, openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  ON_CREDITS_MODEL,
  fundedTaskLot,
  lotState,
  newTaskAccount,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_invariant_audit';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

/**
 * The launch card (0127's seed), which every arm prices against: markup 2.0 as
 * basis points, and Sonnet 5's two list prices in microcents per token. Read
 * back from the database in the reachability arm rather than trusted — a card
 * reseeded at other numbers would make the shadow arms prove nothing.
 */
const MARKUP_BP = 20_000;
const LIST_INPUT_MICROCENTS = 200;
const LIST_OUTPUT_MICROCENTS = 1_000;

/** The one shadow call every shadow arm writes: 1,000 input tokens and 500 output. */
const SHADOW_INPUT_TOKENS = 1_000;
const SHADOW_OUTPUT_TOKENS = 500;

/** What that call SHOULD cost: (tokens × list) × markup. 1.4 credits. */
const SHADOW_CORRECT_MICRO =
  ((SHADOW_INPUT_TOKENS * LIST_INPUT_MICROCENTS + SHADOW_OUTPUT_TOKENS * LIST_OUTPUT_MICROCENTS) *
    MARKUP_BP) /
  10_000;

let client: postgres.Sql | null = null;
let database: Database | null = null;
/** Every account any arm created, so the alert arm can prove none of them is named. */
const seededAccounts: string[] = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 4);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 4 });
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await database?.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function audit(): DrizzleCreditInvariantAuditRepo {
  if (database === null) throw new Error('isolated database unreachable');
  return new DrizzleCreditInvariantAuditRepo(database);
}

async function account(): Promise<string> {
  const id = await newTaskAccount(db());
  seededAccounts.push(id);
  return id;
}

/**
 * Run `body` with the tables' own guards not firing, which is the only way to
 * produce the rows this audit exists to find (see the file header).
 *
 * ⛔ CHECK CONSTRAINTS STILL APPLY — `session_replication_role` silences
 * triggers, not CHECKs — so every row these arms write is still a row the
 * column rules accept. The breach is always ACROSS rows, which is exactly the
 * kind no single-row rule can catch and the kind a daily audit is for.
 */
async function withGuardsOff(body: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
  await db().begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await body(tx);
  });
}

/**
 * Count every rule, run `seed`, count again, and report only the rules whose
 * count changed. An arm that expects `{ lot_held_vs_holds: 1 }` is therefore
 * also asserting that NO OTHER rule moved — including the ones a seed touches
 * by accident, which is how a rule whose SQL is too broad fails here while it
 * would pass an "is it at least one?" assertion.
 */
async function whatMoved(seed: () => Promise<void>): Promise<Record<string, number>> {
  const before = await audit().countAll();
  await seed();
  const after = await audit().countAll();
  const moved: Record<string, number> = {};
  for (const check of CREDIT_INVARIANT_CHECKS) {
    const delta = after[check] - before[check];
    if (delta !== 0) moved[check] = delta;
  }
  return moved;
}

/** Every rule, as the clean database must answer it. */
function allClear(): CreditInvariantCounts {
  return Object.fromEntries(
    CREDIT_INVARIANT_CHECKS.map((c) => [c, 0]),
  ) as unknown as CreditInvariantCounts;
}

/** An OPEN enforced task with a real hold behind it, at whatever age the arm needs. */
async function openTask(input: {
  readonly accountId: string;
  readonly lotId: string;
  readonly reservedMicro: number;
  /** SQL for created_at. */
  readonly createdAt: string;
  /** SQL for max_until; `credit_reservations_max_until` keeps it within 30 minutes of the above. */
  readonly maxUntil: string;
  /** SQL for lease_expires_at. */
  readonly lease: string;
}): Promise<string> {
  const id = randomUUID();
  await db().begin(async (tx) => {
    await tx.unsafe(
      `INSERT INTO credit_reservations (id, account_id, agent_session_id, model, rate_card_version,
                                        mode, slot, reserved_micro, lease_owner,
                                        lease_expires_at, max_until, created_at)
       SELECT $1::uuid, $2::uuid, $3, $4, 1, 'enforce',
              (SELECT s FROM generate_series(1, 3) s
                WHERE NOT EXISTS (SELECT 1 FROM credit_reservations o
                                   WHERE o.account_id = $2::uuid AND o.state = 'open'
                                     AND o.mode = 'enforce' AND o.slot = s)
                ORDER BY s LIMIT 1),
              $5::bigint, 'audit-fixture-boot',
              ${input.lease}, ${input.maxUntil}, ${input.createdAt}`,
      [id, input.accountId, `as_${id}`, ON_CREDITS_MODEL, String(input.reservedMicro)],
    );
    await tx`
      INSERT INTO credit_reservation_holds (reservation_id, lot_id, account_id, held_micro)
      VALUES (${id}::uuid, ${input.lotId}::uuid, ${input.accountId}::uuid,
              ${String(input.reservedMicro)}::bigint)`;
  });
  return id;
}

/**
 * A finished SHADOW measurement of one Sonnet call, charged whatever this arm
 * says. A shadow task holds nothing and takes no slot, so the whole shape is
 * the reservation and its one settled call.
 */
async function shadowMeasurementCharged(accountId: string, actualMicro: number): Promise<void> {
  const reservationId = randomUUID();
  await db().begin(async (tx) => {
    await tx`
      INSERT INTO credit_reservations (id, account_id, agent_session_id, model, rate_card_version,
                                       mode, reserved_micro, committed_micro, lease_owner,
                                       lease_expires_at, max_until, created_at)
      VALUES (${reservationId}::uuid, ${accountId}::uuid, ${`as_${reservationId}`},
              ${ON_CREDITS_MODEL}, 1, 'shadow', ${String(60 * MICRO)}::bigint,
              ${String(actualMicro)}::bigint, 'audit-fixture-boot',
              now() + interval '90 seconds', now() + interval '25 minutes', now())`;
    await tx`
      INSERT INTO credit_model_calls (id, reservation_id, account_id, seq, purpose, model,
                                      input_bound_tokens, input_bound_basis, input_bound_micro,
                                      max_output_tokens, bound_micro, sent, state, settle_basis,
                                      uncached_input_tokens, output_tokens, cache_read_tokens,
                                      cache_write_5m_tokens, cache_write_1h_tokens,
                                      actual_micro, charged_micro, settled_at)
      VALUES (${randomUUID()}::uuid, ${reservationId}::uuid, ${accountId}::uuid, 1, 'plan',
              ${ON_CREDITS_MODEL}, 1000, 'region_bytes', ${String(MICRO)}::bigint, 4096,
              ${String(60 * MICRO)}::bigint, true, 'settled', 'provider_usage',
              ${SHADOW_INPUT_TOKENS}, ${SHADOW_OUTPUT_TOKENS}, 0, 0, 0,
              ${String(actualMicro)}::bigint, ${String(actualMicro)}::bigint, now())`;
  });
}

/**
 * A hold left behind by a task that has ALREADY ENDED, which is the shape that
 * freezes credit for ever.
 *
 * ⛔ NOTHING IS SWITCHED OFF FOR THIS ONE, and that is the finding. A statement
 * that touches only `credit_reservation_holds` fires no COMMIT-time reservation
 * check — `credit_model_calls_balance` and `credit_reservations_balance` hang
 * off the other two tables — so the database accepts a hold against a task that
 * is already final, and `credit_reservations_guard` then refuses to let that
 * task change again. The settlement that would have walked the hold has run.
 * The credit it holds is spendable by nobody: every spendable predicate is
 * `remaining − held`, and so is the expiry sweep's.
 *
 * Both shapes reach it. A SETTLED task can never release anything again; a
 * SHADOW task never could — `settleIn` returns before the holds walk for a
 * measurement, because a measurement is not supposed to hold anything at all.
 */
async function holdStrandedOnATaskThatEnded(input: {
  readonly accountId: string;
  readonly micro: number;
  readonly on: 'settled' | 'shadow';
}): Promise<{ reservationId: string; lotId: string }> {
  const { accountId, micro } = input;
  // The lot the stranded hold lands on. Its own, so the arm's count is about
  // this hold and not about credit some other fixture put beside it.
  const lotId = await fundedTaskLot(db(), accountId, { credits: 50 });
  let reservationId: string = randomUUID();
  if (input.on === 'shadow') {
    await db()`
      INSERT INTO credit_reservations (id, account_id, agent_session_id, model, rate_card_version,
                                       mode, reserved_micro, lease_owner, lease_expires_at, max_until)
      VALUES (${reservationId}::uuid, ${accountId}::uuid, ${`as_${reservationId}`},
              ${ON_CREDITS_MODEL}, 1, 'shadow', ${String(60 * MICRO)}::bigint, 'audit-fixture-boot',
              now() + interval '90 seconds', now() + interval '25 minutes')`;
  } else {
    // An ordinary task that reserved, made no call and was settled for nothing:
    // every hold released, every COMMIT-time check satisfied. It is FINAL now.
    const own = await fundedTaskLot(db(), accountId, { credits: 50 });
    reservationId = await openTask({
      accountId,
      lotId: own,
      reservedMicro: micro,
      createdAt: "now() - interval '2 minutes'",
      maxUntil: "now() + interval '28 minutes'",
      lease: "now() + interval '90 seconds'",
    });
    await db().begin(async (tx) => {
      await tx`
        UPDATE credit_reservation_holds SET released_at = now(), charged_micro = 0
         WHERE reservation_id = ${reservationId}::uuid`;
      await tx`
        UPDATE credit_reservations SET state = 'settled', charged_micro = 0, settled_at = now(),
                                       settle_reason = 'lease_expired'
         WHERE id = ${reservationId}::uuid`;
    });
  }
  // The hold arrives after the task ended, in a statement that touches only
  // holds — so no COMMIT-time reservation check runs, and the database takes it.
  await db()`
    INSERT INTO credit_reservation_holds (reservation_id, lot_id, account_id, held_micro)
    VALUES (${reservationId}::uuid, ${lotId}::uuid, ${accountId}::uuid,
            ${String(micro)}::bigint)`;
  return { reservationId, lotId };
}

/** An active subscription, with or without the paid invoice that covers this instant. */
async function activeSubscription(accountId: string, withPaidInvoice: boolean): Promise<void> {
  const stripeId = `sub_${randomUUID()}`;
  await db()`
    INSERT INTO subscriptions (account_id, stripe_subscription_id, stripe_price_id, tier, status,
                               current_period_start, current_period_end)
    VALUES (${accountId}::uuid, ${stripeId}, 'price_audit_fixture', 'team_manual'::account_tier,
            'active', now() - interval '3 days', now() + interval '27 days')`;
  if (!withPaidInvoice) return;
  await db()`
    INSERT INTO billing_invoice_payments (stripe_invoice_id, account_id, stripe_subscription_id,
                                          amount_paid_minor, currency, paid_at, line_kind,
                                          line_tier, line_period_start, line_period_end)
    VALUES (${`in_${randomUUID()}`}, ${accountId}::uuid, ${stripeId}, 4900, 'usd',
            now() - interval '3 days', 'period', 'team_manual'::account_tier,
            now() - interval '3 days', now() + interval '27 days')`;
}

describe.skipIf(!RUN_DB_TESTS)(
  'the daily credit audit finds records that stopped adding up',
  () => {
    it('CRITICAL the isolated database is reachable and carries the launch rate card this file prices against. Every shadow arm re-derives money from the card’s list prices, so a card reseeded at other numbers would leave those arms proving nothing while still passing.', async () => {
      const [card] = await db()<Array<{ markup_bp: number; li: string; lo: string }>>`
        SELECT c.markup_bp, m.list_input_microcents_per_token::text AS li,
               m.list_output_microcents_per_token::text AS lo
          FROM credit_rate_cards c
          JOIN credit_rate_card_models m ON m.version = c.version
         WHERE c.version = 1 AND m.model = ${ON_CREDITS_MODEL}`;
      expect(card).toBeDefined();
      expect({ markup: card?.markup_bp, li: Number(card?.li), lo: Number(card?.lo) }).toEqual({
        markup: MARKUP_BP,
        li: LIST_INPUT_MICROCENTS,
        lo: LIST_OUTPUT_MICROCENTS,
      });
      expect(SHADOW_CORRECT_MICRO, 'a Sonnet call of 1,000 in and 500 out costs 1.4 credits').toBe(
        1.4 * MICRO,
      );
    });

    it('CRITICAL a HEALTHY database is silent on every one of the nine rules — including the three that a check unable to ever fire would also answer with zero. A funded lot, a live task holding its credit, a task a minute past its ceiling that the keeper is about to settle, a correctly priced shadow measurement and an active subscription with the invoice that covers it: all of it, and nothing to report.', async () => {
      const healthy = await account();
      const lotId = await fundedTaskLot(db(), healthy, { credits: 100 });
      await openTask({
        accountId: healthy,
        lotId,
        reservedMicro: 20 * MICRO,
        createdAt: "now() - interval '2 minutes'",
        maxUntil: "now() + interval '28 minutes'",
        lease: "now() + interval '90 seconds'",
      });
      // A minute past its ceiling is the keeper WORKING, not a breach: it
      // settles within one 15-second tick, and an audit that alerted on the
      // ordinary case would teach its reader to ignore the next alert.
      await openTask({
        accountId: healthy,
        lotId,
        reservedMicro: 5 * MICRO,
        createdAt: "now() - interval '26 minutes'",
        maxUntil: "now() - interval '1 minute'",
        lease: "now() - interval '1 minute'",
      });
      await shadowMeasurementCharged(await account(), SHADOW_CORRECT_MICRO);
      await activeSubscription(await account(), true);

      const report = await auditCreditInvariants(audit());
      expect(report.counts, 'every rule holds').toEqual(allClear());
      expect(report.breaches).toEqual([]);

      const said: unknown[] = [];
      reportCreditInvariantBreaches(report, {
        logger: { error: (o: unknown) => said.push(o) } as never,
        sentry: { captureMessage: (m: unknown) => said.push(m) },
      });
      expect(said, 'a clean audit tells nobody anything').toEqual([]);
    });

    it('CRITICAL a lot whose balance no longer matches the ledger rows that moved it is found. `credit_ledger_apply` writes the two together, so they can only part company if that trigger stops firing — and then credit the customer paid for has gone with nothing that records where.', async () => {
      const accountId = await account();
      const lotId = await fundedTaskLot(db(), accountId, { credits: 50 });
      expect(
        await whatMoved(async () => {
          await withGuardsOff(async (tx) => {
            // ⛔ DOWNWARDS, BECAUSE `credit_lots_remaining_bounds` IS A CHECK
            // AND CHECKS STILL FIRE HERE. That rules out inventing credit and
            // leaves losing it, which is the direction that costs the customer
            // anyway: seven credits that are simply not there any more, and no
            // ledger row that says who took them.
            await tx`UPDATE credit_lots SET remaining_micro = remaining_micro - ${String(7 * MICRO)}::bigint
                      WHERE id = ${lotId}::uuid`;
          });
        }),
      ).toEqual({ lot_balance_vs_ledger: 1 });
    });

    it('CRITICAL an account whose debt no longer matches its ledger’s debt movements is found. Debt is what a customer owes; a figure nothing wrote is a figure nothing can explain, and the customer is refused new tasks on it.', async () => {
      const accountId = await account();
      expect(
        await whatMoved(async () => {
          await withGuardsOff(async (tx) => {
            await tx`UPDATE credit_accounts SET debt_micro = ${String(3 * MICRO)}::bigint
                      WHERE account_id = ${accountId}::uuid`;
          });
        }),
      ).toEqual({ account_debt_vs_ledger: 1 });
    });

    it('CRITICAL a lot holding more than its unreleased holds say is found. Held credit is spendable by nobody — not another task, not a clawback, not the expiry sweep — so a lot holding credit no hold accounts for is credit the customer paid for and can never use, and a settlement would never notice: it walks the holds that exist.', async () => {
      const accountId = await account();
      const lotId = await fundedTaskLot(db(), accountId, { credits: 50 });
      expect(
        await whatMoved(async () => {
          await withGuardsOff(async (tx) => {
            await tx`UPDATE credit_lots SET held_micro = held_micro + ${String(2 * MICRO)}::bigint
                      WHERE id = ${lotId}::uuid`;
          });
        }),
      ).toEqual({ lot_held_vs_holds: 1 });
    });

    it('CRITICAL a task still open well past its hard ceiling is found — which is the lease keeper’s own liveness asked from the other side. The keeper settles at `max_until` within a tick, so a task minutes past it means the keeper is not running, and every abandoned task’s slot and credit are leaking with nothing else to say so.', async () => {
      const accountId = await account();
      const lotId = await fundedTaskLot(db(), accountId, { credits: 50 });
      // Beyond the grace the clean arm proved is honoured, and no trigger is
      // switched off for this one: the database is perfectly happy with a task
      // nobody settled, which is precisely why it needs asking about.
      expect(CREDIT_AUDIT_MAX_UNTIL_GRACE_MINUTES).toBe(5);
      expect(
        await whatMoved(async () => {
          await openTask({
            accountId,
            lotId,
            reservedMicro: 10 * MICRO,
            createdAt: "now() - interval '35 minutes'",
            maxUntil: "now() - interval '10 minutes'",
            lease: "now() - interval '10 minutes'",
          });
        }),
      ).toEqual({ reservation_open_past_max_until: 1 });
    });

    it('CRITICAL a clawback still waiting on credit that no running task holds is found. A pending claim is paid out of what a running task releases; with no open hold on the account there is no task left to release anything, so the claim waits for ever — it can never be paid and can never become debt either, and the customer’s balance silently overstates what they may spend.', async () => {
      const accountId = await account();
      expect(
        await whatMoved(async () => {
          await db()`
            INSERT INTO credit_clawbacks (account_id, source, source_ref, target_key, amount_micro,
                                          state, clawed_micro, debt_micro, pending_micro)
            VALUES (${accountId}::uuid, 'plan_change', ${`ref-${randomUUID()}`},
                    ${`window:${randomUUID()}`}, ${String(6 * MICRO)}::bigint, 'applied',
                    0::bigint, 0::bigint, ${String(6 * MICRO)}::bigint)`;
        }),
      ).toEqual({ claim_pending_with_no_open_hold: 1 });
    });

    it('CRITICAL a shadow measurement that does not cost about the card’s markup over the provider’s list price is found. This is the one rule that re-derives money from FIRST PRINCIPLES rather than comparing two records of one write — the charge is recomputed in SQL from the tokens the provider reported and the list prices the card recorded — and its agreement is what makes shadow mode evidence for switching enforcement on.', async () => {
      const accountId = await account();
      const wrong = 2 * MICRO;
      expect(
        Math.abs(wrong - SHADOW_CORRECT_MICRO),
        'and it is wrong by far more than the one percent the rule tolerates',
      ).toBeGreaterThan(wrong * 0.01);
      expect(
        await whatMoved(async () => {
          await shadowMeasurementCharged(accountId, wrong);
        }),
      ).toEqual({ shadow_charge_vs_list_price: 1 });
    });

    it('CRITICAL a published card charging something other than its own markup over the list price it recorded is found. The owner’s promise is a number — list price times two — and the rates a task is charged are separate columns written when the card was published; a card published with one rate mistyped overcharges every task on that model for as long as it is in force, and every other record agrees with itself perfectly.', async () => {
      expect(
        await whatMoved(async () => {
          // A card and its models are written together, in one transaction, by
          // the only path `credit_rate_card_models_guard` permits. Nothing here
          // is switched off: the database has no opinion about whether the rate
          // matches the list price, which is the gap this rule stands in.
          await db().begin(async (tx) => {
            await tx`
              INSERT INTO credit_rate_cards (version, markup_bp, effective_at, note)
              VALUES (2, ${MARKUP_BP}, now() + interval '31 days', 'audit fixture')`;
            await tx`
              INSERT INTO credit_rate_card_models
                (version, model, input_micro_per_token, output_micro_per_token,
                 cache_read_micro_per_token, cache_write_5m_micro_per_token,
                 cache_write_1h_micro_per_token, min_start_micro, max_reserve_micro,
                 list_input_microcents_per_token, list_output_microcents_per_token)
              VALUES (2, ${ON_CREDITS_MODEL}, 500, 2000, 40, 500, 800,
                      ${String(6 * MICRO)}::bigint, ${String(60 * MICRO)}::bigint,
                      ${LIST_INPUT_MICROCENTS}, ${LIST_OUTPUT_MICROCENTS})`;
          });
        }),
      ).toEqual({ rate_card_rate_vs_list_price: 1 });
    });

    it('CRITICAL H1 an active subscription with no paid invoice covering this instant is found. Credits are granted from PAID coverage and never from the subscription mirror, which turns active before a renewal’s payment is even attempted — so this is a renewal whose payment failed unnoticed, or a webhook that never arrived, and everything reading the mirror is treating the account as a paying customer.', async () => {
      const accountId = await account();
      expect(
        await whatMoved(async () => {
          await activeSubscription(accountId, false);
        }),
      ).toEqual({ active_subscription_without_paid_invoice: 1 });
    });

    it('⛔ CRITICAL a hold left behind by a task that has ALREADY ENDED is found, in both shapes it takes. The credit it holds is spendable by nobody — every spendable predicate is `remaining − held`, and so is the expiry sweep’s — and no settlement will ever walk it: a settled task is final, and a shadow measurement never walks holds at all. Nothing else in the system would notice, because the lot and the hold agree with each other perfectly.', async () => {
      const accountId = await account();
      expect(
        await whatMoved(async () => {
          const frozen = await holdStrandedOnATaskThatEnded({
            accountId,
            micro: 4 * MICRO,
            on: 'settled',
          });
          await holdStrandedOnATaskThatEnded({ accountId, micro: 5 * MICRO, on: 'shadow' });
          // MEASURED, not argued: the database really does hold this credit and
          // really does agree with itself about it.
          expect((await lotState(db(), frozen.lotId)).held, 'the credit is held').toBe(4 * MICRO);
        }),
      ).toEqual({ hold_open_past_its_task: 2 });
    });

    it('⛔ CRITICAL a pending claim is still found when the only thing holding the account’s credit is a hold whose task has ENDED. The rule’s subject is a RUNNING TASK — a claim is paid out of what one releases — and an unreleased hold row is not that: the task that would have released it is final, so the claim can never be paid and can never become debt either. Asking merely “is there an unreleased hold?” reports this account healthy.', async () => {
      const accountId = await account();
      expect(
        await whatMoved(async () => {
          await holdStrandedOnATaskThatEnded({ accountId, micro: 3 * MICRO, on: 'settled' });
          await db()`
            INSERT INTO credit_clawbacks (account_id, source, source_ref, target_key, amount_micro,
                                          state, clawed_micro, debt_micro, pending_micro)
            VALUES (${accountId}::uuid, 'plan_change', ${`ref-${randomUUID()}`},
                    ${`window:${randomUUID()}`}, ${String(3 * MICRO)}::bigint, 'applied',
                    0::bigint, 0::bigint, ${String(3 * MICRO)}::bigint)`;
        }),
      ).toEqual({ hold_open_past_its_task: 1, claim_pending_with_no_open_hold: 1 });
    });

    it('CRITICAL a pending claim beside a hold of a task that IS still running is NOT a breach — that task may yet release the credit that pays it, which is the whole mechanism, and an audit that alerted on the ordinary case would teach its reader to ignore the next alert.', async () => {
      const accountId = await account();
      const lotId = await fundedTaskLot(db(), accountId, { credits: 50 });
      expect(
        await whatMoved(async () => {
          await openTask({
            accountId,
            lotId,
            reservedMicro: 9 * MICRO,
            createdAt: "now() - interval '1 minute'",
            maxUntil: "now() + interval '29 minutes'",
            lease: "now() + interval '90 seconds'",
          });
          await db()`
            INSERT INTO credit_clawbacks (account_id, source, source_ref, target_key, amount_micro,
                                          state, clawed_micro, debt_micro, pending_micro)
            VALUES (${accountId}::uuid, 'plan_change', ${`ref-${randomUUID()}`},
                    ${`window:${randomUUID()}`}, ${String(2 * MICRO)}::bigint, 'applied',
                    0::bigint, 0::bigint, ${String(2 * MICRO)}::bigint)`;
        }),
      ).toEqual({});
    });

    it('⛔ CRITICAL a hold stranded on a task that has ENDED is found even while the ACCOUNT still has a task RUNNING. The rule’s subject is the hold’s OWN task and never the account: asked per account, a stranded hold would hide behind any live turn — which is to say it would be invisible for exactly the customers who are still using the product, and visible only for the ones who had stopped.', async () => {
      const accountId = await account();
      const lotId = await fundedTaskLot(db(), accountId, { credits: 50 });
      expect(
        await whatMoved(async () => {
          await openTask({
            accountId,
            lotId,
            reservedMicro: 7 * MICRO,
            createdAt: "now() - interval '1 minute'",
            maxUntil: "now() + interval '29 minutes'",
            lease: "now() + interval '90 seconds'",
          });
          await holdStrandedOnATaskThatEnded({ accountId, micro: 2 * MICRO, on: 'settled' });
        }),
      ).toEqual({ hold_open_past_its_task: 1 });
    });

    it('CRITICAL the alert a person actually receives names the rules and their counts and NOTHING ELSE — no account, no email, no model, no amount. A breach means somebody opens the database; it does not mean customer data is copied into an inbox or an error reporter on the way to telling them.', async () => {
      const report = await auditCreditInvariants(audit());
      expect(
        report.breaches.map((b) => b.check).sort(),
        'every rule seeded above is still breached',
      ).toEqual([...CREDIT_INVARIANT_CHECKS].sort());

      const logged: Record<string, unknown>[] = [];
      const alerted: { message: string; extra?: unknown }[] = [];
      reportCreditInvariantBreaches(report, {
        logger: { error: (o: unknown) => logged.push(o as Record<string, unknown>) } as never,
        sentry: { captureMessage: (m: unknown) => alerted.push(m as { message: string }) },
      });
      expect(logged).toHaveLength(1);
      expect(alerted).toHaveLength(1);
      expect(alerted[0]?.message).toContain('lot_balance_vs_ledger=1');
      expect(alerted[0]?.message).toContain('open the database');

      const everythingSaid = JSON.stringify({ logged, alerted });
      for (const accountId of seededAccounts) {
        expect(everythingSaid, 'no account id reaches the alert').not.toContain(accountId);
      }
      expect(everythingSaid, 'no customer email reaches the alert').not.toContain('@example.test');
      expect(everythingSaid, 'no model name reaches the alert').not.toContain(ON_CREDITS_MODEL);
      expect(everythingSaid, 'and no amount — every value in it is a count of rows').not.toContain(
        String(SHADOW_CORRECT_MICRO),
      );
    });
  },
);

describe('the audit walks the rules it declares, not the keys it is handed', () => {
  it('CRITICAL a rule the repository stopped answering is reported as -1, not skipped. `breachesIn` walks the closed declared list rather than the object’s keys, because a check added to the repository and forgotten in the alert path would otherwise be invisible — which is the same silence the whole audit exists to break, one level down.', () => {
    const complete = Object.fromEntries(
      CREDIT_INVARIANT_CHECKS.map((c) => [c, 0]),
    ) as unknown as CreditInvariantCounts;
    expect(breachesIn(complete)).toEqual([]);

    const missing = { ...complete } as Record<string, number>;
    const dropped: CreditInvariantCheck = 'lot_held_vs_holds';
    delete missing[dropped];
    expect(breachesIn(missing as unknown as CreditInvariantCounts)).toEqual([
      { check: dropped, count: -1 },
    ]);
  });
});
