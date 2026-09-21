// The shadow charge is twice what the turn really cost — and the report is what
// says so.
//
// §8 step 3 will not let an account move to enforce until the shadow numbers
// show, among other things, "shadow charge = 2x list price". That is not a
// property of the rate card alone: the card is list price x 2.0 by construction,
// so a ratio computed over the card would be 2.0 whatever the code did. It is a
// property of the JOIN — the charge the reservation recorded against the cost
// the same turn's usage rows recorded — and the only thing saying the two sides
// are the same turn is the reservation id S11 writes onto the usage row.
//
// So the arms here are about the join and the units:
//
//   · a measured turn reads 2.0, and reads it out of two tables that were
//     written independently — one by the credits service, one by the usage
//     recorder;
//   · an unrelated turn's usage row (no reservation id, or another task's) does
//     NOT move the ratio, which is what "the join is the point" means in
//     practice;
//   · a call that cost MORE than the bound it was admitted under is counted,
//     because that is the other exit criterion and the charge itself is capped
//     at the bound, so the charge alone cannot show it;
//   · the would-refuse histogram covers every shadow task, including the ones
//     enforcement would have run.
//
// ⛔ UNITS ARE THE FAILURE THIS FILE IS MOST LIKELY TO CATCH. One credit is one
// cent; the reservation records microcredits and the usage row records
// millicents, so the two sides differ by a factor of 1,000 before the markup.
// A ratio of 2,000 or 0.002 is the shape of that mistake, and both are ruled out
// by asserting the exact number rather than a range.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CREDIT_RATE_CARD_V1,
  listPriceCostMillicents,
  type ModelCallTokens,
} from '@driftstack/api-types';
import type { Database } from '../../src/db/client.js';
import type { CreditCallBound } from '../../src/db/credit-reservations-repo.js';
import { DrizzleAiCreditsReportRepo } from '../../src/db/ai-credits-report-repo.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  ON_CREDITS_MODEL,
  fundedTaskLot,
  newTaskAccount,
  reservationsHarness,
  type ReservationsHarness,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_report';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const BOOT = 'boot-report';

const RATES = CREDIT_RATE_CARD_V1.models[ON_CREDITS_MODEL];

/** One model per arm — see `measuredTurn`. All three are priced by the launch card. */
const RATIO_MODEL = ON_CREDITS_MODEL;
const OVER_BOUND_MODEL = 'claude-haiku-4-5';
const UNPRICED_MODEL = 'claude-sonnet-4-6';

/** One call's regions: 1,000 bytes cached for an hour, 500 uncached, plus framing. */
const INPUT_MICRO = 1_000 * 800 + 500 * 400 + 2_048 * 800;
const BOUND: CreditCallBound = {
  inputBoundTokens: 1_000 + 500 + 2_048,
  inputBoundMicro: INPUT_MICRO,
  maxOutputTokens: 8_192,
  boundMicro: INPUT_MICRO + 8_192 * 2_000,
  basis: 'region_bytes',
};

/** What the provider reported. Priced by the card at 3,880,000 µcr. */
const REPORTED: ModelCallTokens = {
  uncachedInput: 1_000,
  output: 500,
  cacheRead: 2_000,
  cacheWrite5m: 0,
  cacheWrite1h: 3_000,
};
/** …and by the provider's own list price at 1,940 millicents. Exactly half. */
const REPORTED_LIST_MILLICENTS = listPriceCostMillicents(ON_CREDITS_MODEL, REPORTED);

let client: postgres.Sql | null = null;
let url: string | null = null;
const opened: Database[] = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const db = await openLedgerDatabase(ISOLATED_DB_NAME, 6);
  if (db === null) return;
  client = db.sql;
  url = db.url;
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await Promise.all(opened.map((d) => d.close().catch(() => {})));
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function harness(): ReservationsHarness {
  if (url === null) throw new Error('isolated database unreachable');
  const h = reservationsHarness(url, { max: 3 });
  opened.push(h.database);
  return h;
}

/** A window wide enough to hold everything this file writes. */
function window(): { since: Date; until: Date } {
  const until = new Date(Date.now() + 60 * 60 * 1000);
  return { since: new Date(until.getTime() - 3 * 24 * 60 * 60 * 1000), until };
}

/**
 * One shadow task with one settled call on it, as a turn would leave it.
 *
 * ⛔ EACH ARM BELOW OWNS A MODEL, because the report groups by DAY and MODEL and
 * every arm in this file writes on the same day into the same database. Two arms
 * sharing a model share one row, and each would then be asserting the other's
 * sums — which reads as a bug in the report the first time somebody reorders the
 * file. `created_at` is immutable by trigger, so the day cannot be varied
 * instead; the model can.
 */
async function measuredTurn(
  h: ReservationsHarness,
  model: string,
  opts: { bound?: CreditCallBound; usage?: ModelCallTokens } = {},
): Promise<{ accountId: string; reservationId: string; chargedMicro: number }> {
  const accountId = await newTaskAccount(db());
  await fundedTaskLot(db(), accountId, { credits: 100 });
  const reservationId = randomUUID();
  const reserved = await h.service.reserve({
    accountId,
    reservationId,
    agentSessionId: `as_${reservationId}`,
    idempotencyKey: null,
    model,
    mode: 'shadow',
    bootId: BOOT,
  });
  if (reserved.outcome !== 'shadowed') {
    throw new Error(`the fixture could not measure: ${JSON.stringify(reserved)}`);
  }
  const callId = randomUUID();
  const admitted = await h.service.admitCall({
    reservationId,
    purpose: 'plan',
    model,
    bound: opts.bound ?? BOUND,
    callId,
  });
  if (admitted.outcome !== 'admitted') {
    throw new Error(`the fixture could not admit: ${JSON.stringify(admitted)}`);
  }
  await h.service.markSent(callId);
  const settled = await h.service.settleCall({
    callId,
    basis: 'provider_usage',
    usage: opts.usage ?? REPORTED,
  });
  await h.service.settle(reservationId, 'completed');
  return { accountId, reservationId, chargedMicro: settled.chargedMicro };
}

/**
 * The usage row a turn leaves behind, with the credit id the recorder writes.
 *
 * Raw SQL on purpose: what is being proved is that the REPORT joins on the
 * field, and routing through the recorder would prove the recorder instead —
 * which `a-usage-row-records-what-the-call-cost-at-list-price` already does.
 *
 * ⛔ `::text::jsonb`, NOT `::jsonb`. The driver binds a JS string as a JSON
 * STRING, so a single cast stores `"{\"a\":1}"` — a jsonb scalar whose every
 * `->>` is NULL — and the report then joins nothing and reads a list price of
 * zero, which looks exactly like a turn that cost nothing. (Measured: the first
 * version of this fixture did that, and the ratio arm failed as `0`.) The
 * production recorder writes through a typed jsonb column and is unaffected.
 */
async function usageRow(accountId: string, metadata: Record<string, unknown>): Promise<void> {
  await db()`
    INSERT INTO usage_records (account_id, record_type, quantity, metadata, recorded_at)
    VALUES (${accountId}::uuid, 'agent_decomposer_bundled', 1,
            ${JSON.stringify(metadata)}::text::jsonb, now())`;
}

describe.skipIf(!RUN_DB_TESTS)('the shadow charge is twice what the turn really cost', () => {
  async function rowFor(h: ReservationsHarness, model: string) {
    const report = new DrizzleAiCreditsReportRepo(h.database);
    return (await report.shadowReport(window())).rows.find((r) => r.model === model);
  }

  it('CRITICAL the list price and the card really are 1:2 before any of this runs. Every ratio below would read 2.0 from a bug that compared the card with itself; this is the independent half.', () => {
    expect(RATES).toBeDefined();
    expect(REPORTED_LIST_MILLICENTS).toBe(1_940);
    // 1 credit = 1 cent, so a millicent is 1,000 microcredits.
    expect((REPORTED_LIST_MILLICENTS ?? 0) * 1_000 * 2).toBe(3_880_000);
  });

  it('CRITICAL a measured turn reads exactly 2.0, joined from two tables written independently — the charge from credit_model_calls, the cost from the turn’s own usage row — and usage rows belonging to NO task do not move it. Without the join they would: an own-key turn writes a row here and no call there, and the ratio would drift toward whatever the window happened to hold.', async () => {
    const h = harness();
    const turn = await measuredTurn(h, RATIO_MODEL);
    expect(turn.chargedMicro).toBe(3_880_000);
    await usageRow(turn.accountId, {
      credit_reservation_id: turn.reservationId,
      list_price_cost_millicents: REPORTED_LIST_MILLICENTS,
      model: RATIO_MODEL,
    });
    // A turn on the customer's own key: same account, same window, no task.
    await usageRow(turn.accountId, { list_price_cost_millicents: 5_000_000 });
    // And a row naming a task that is not in this report at all.
    await usageRow(turn.accountId, {
      credit_reservation_id: randomUUID(),
      list_price_cost_millicents: 5_000_000,
    });

    const mine = await rowFor(h, RATIO_MODEL);

    expect(mine).toBeDefined();
    expect(mine?.tasks).toBe(1);
    expect(mine?.shadowCalls).toBe(1);
    expect(mine?.shadowChargeMicro).toBe(3_880_000);
    expect(mine?.listPriceMicro).toBe(1_940_000);
    // The exit criterion, exactly — not "about 2".
    expect(mine?.ratio).toBe(2);
    expect(mine?.callsOverBound).toBe(0);
    expect(mine?.usageRowsWithNoListPrice).toBe(0);
    expect(mine?.callsNeverSettled).toBe(0);
    expect(mine?.tasksNotClosedByTheTurn).toBe(0);
  });

  it('CRITICAL a call that cost MORE than its bound is counted. The charge is capped at the bound, so the money never moves — which is exactly why the charge alone cannot show it, and why the count is its own column.', async () => {
    const h = harness();
    // A bound priced for a much smaller call than the provider then reported.
    const tight: CreditCallBound = {
      inputBoundTokens: 64,
      inputBoundMicro: 64 * 400,
      maxOutputTokens: 16,
      boundMicro: 64 * 400 + 16 * 2_000,
      basis: 'region_bytes',
    };
    const turn = await measuredTurn(h, OVER_BOUND_MODEL, { bound: tight });

    // Capped: the charge is the bound, not the 1,940,000 the call really cost.
    expect(turn.chargedMicro).toBe(tight.boundMicro);
    // And the service raised the counter's event for it.
    expect(h.boundExceeded).toHaveLength(1);
    expect(h.boundExceeded[0]?.actualMicro).toBe(1_940_000);

    expect((await rowFor(h, OVER_BOUND_MODEL))?.callsOverBound).toBe(1);
  });

  it('CRITICAL an unpriced usage row is counted as unpriced, never as free. "Unknown" read as zero would pull the ratio up and read as an overcharge.', async () => {
    const h = harness();
    const turn = await measuredTurn(h, UNPRICED_MODEL);
    await usageRow(turn.accountId, {
      credit_reservation_id: turn.reservationId,
      list_price_cost_millicents: null,
    });

    const mine = await rowFor(h, UNPRICED_MODEL);

    expect(mine?.usageRowsWithNoListPrice).toBe(1);
    expect(mine?.listPriceMicro).toBe(0);
    // A rate over nothing is null, not zero, and not Infinity.
    expect(mine?.ratio).toBeNull();
  });

  it('CRITICAL every shadow task is in the would-refuse histogram, including the ones enforcement would have run. A histogram over refusals only would make the refusal rate unreadable — there would be no denominator.', async () => {
    const h = harness();
    await measuredTurn(h, OVER_BOUND_MODEL);

    const wouldRefuse = (await new DrizzleAiCreditsReportRepo(h.database).shadowReport(window()))
      .wouldRefuse;

    const total = wouldRefuse.reduce((n, r) => n + r.tasks, 0);
    expect(total).toBeGreaterThan(0);
    // These accounts were funded, so enforcement would have run them: `none`.
    expect(wouldRefuse.find((r) => r.reason === 'none')?.tasks).toBeGreaterThan(0);
  });

  it('CRITICAL the window really bounds the report: a task outside it is not counted', async () => {
    const h = harness();
    await measuredTurn(h, RATIO_MODEL);
    const past = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const empty = await new DrizzleAiCreditsReportRepo(h.database).shadowReport({
      since: new Date(past.getTime() - 24 * 60 * 60 * 1000),
      until: past,
    });

    expect(empty.rows).toEqual([]);
    expect(empty.wouldRefuse).toEqual([]);
    expect(empty.markup).toBe(2);
  });
});
