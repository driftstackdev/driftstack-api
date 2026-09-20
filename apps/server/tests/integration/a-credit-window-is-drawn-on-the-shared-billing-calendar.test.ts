// A credit window is drawn on the shared billing calendar, and holds its share
// of the month.
//
// The database draws every window boundary itself (a JavaScript Date would lose
// the microseconds the no-overlap constraint compares), while the server and the
// clients show and check those same months with `naturalMonthContaining` and
// `windowShareMicro` from @driftstack/api-types. If the two drew different
// months — on the 31st, on Feb 29, a second before midnight — a customer would be
// shown a reset date the database does not keep. So the windows the service
// really writes are compared with the shared calendar, instant for instant, and
// the credits in each with the shared share rule.
//
// Four things are decided here rather than inherited, and each has its arm:
//
//   · a YEARLY plan gets its credits one month at a time, month k counted from
//     the paid line's start (never chained from the month before);
//   · a MONTHLY line is its own month. Stripe draws a monthly period with its own
//     calendar — Feb 28 → Mar 31 for a subscription anchored on the 31st — so the
//     paid period is the month, not `start + 1 month` (which would end on Mar 28
//     and leave three days to be granted a second time);
//   · but a month is never SHORTER than a calendar month from its start: a paid
//     line of three days is the window, and gets three days' share, not the
//     whole month's credits;
//   · a window that starts late, because an earlier window already covered the
//     start of the month, gets its share of the month, floored to whole credits.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { naturalMonthContaining, windowShareMicro } from '@driftstack/api-types';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  grantsHarness,
  insertWindow,
  lotsOf,
  newAccountOn,
  paidLine,
  planOverride,
  subscription,
  windowsOf,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_window_calendar';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
let harness: GrantsHarness | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  harness = grantsHarness(opened.url);
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await harness?.database.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function h(): GrantsHarness {
  if (harness === null) throw new Error('isolated database unreachable');
  return harness;
}

async function databaseNow(): Promise<Date> {
  const [row] = await db()<Array<{ t: Date }>>`SELECT clock_timestamp() AS t`;
  if (row === undefined) throw new Error('no clock row');
  return row.t;
}

/** `'<iso>'::timestamptz`, for a fixture time that must be an exact instant. */
function at(d: Date): string {
  return `'${d.toISOString()}'::timestamptz`;
}

/**
 * Anchors in the last eleven months, on the days where month arithmetic is
 * interesting: the last three days of each month, at midnight and a breath
 * before the next day. Whole milliseconds, so the shared calendar (which works
 * in milliseconds) can be compared exactly.
 */
function recentAnchors(now: Date): Date[] {
  const out: Date[] = [];
  for (let back = 1; back <= 11; back += 1) {
    for (let fromEnd = 0; fromEnd <= 2; fromEnd += 1) {
      for (const [hh, mm, ss, ms] of [
        [0, 0, 0, 0],
        [23, 59, 59, 999],
      ] as const) {
        // Day 0 of month m+1 is the last day of month m.
        const d = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back + 1, 0 - fromEnd, hh, mm, ss, ms),
        );
        out.push(d);
      }
    }
  }
  return out;
}

describe.skipIf(!RUN_DB_TESTS)('a credit window is drawn on the shared billing calendar', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
  });

  it('CRITICAL a yearly plan gets its credits one month at a time: for 66 paid years anchored on month-ends, the one window granted is exactly the shared calendar’s month containing now, at the whole monthly level', async () => {
    const before = await databaseNow();
    const anchors = recentAnchors(before);
    expect(anchors).toHaveLength(66);

    const cases: Array<{ accountId: string; anchor: Date }> = [];
    for (const anchor of anchors) {
      const accountId = await newAccountOn(db(), 'api_builder');
      const subscriptionId = await subscription(db(), accountId, { tier: 'api_builder' });
      const yearEnd = new Date(anchor.getTime());
      yearEnd.setUTCFullYear(yearEnd.getUTCFullYear() + 1);
      await paidLine(db(), accountId, {
        subscriptionId,
        tier: 'api_builder',
        interval: 'year',
        start: at(anchor),
        // A generous year: what is under test is the MONTH, which the paid end only ever cuts.
        end: `${at(yearEnd)} + interval '5 days'`,
      });
      cases.push({ accountId, anchor });
    }
    for (const c of cases) await h().grants.refreshCredits(c.accountId);
    const after = await databaseNow();

    let compared = 0;
    for (const { accountId, anchor } of cases) {
      const expected = naturalMonthContaining(anchor, before);
      // A boundary crossed while the test ran would make "now" ambiguous. It is a
      // matter of milliseconds a month; skipped rather than guessed.
      if (naturalMonthContaining(anchor, after).index !== expected.index) continue;
      const [w, ...more] = await windowsOf(db(), accountId);
      expect(more, anchor.toISOString()).toEqual([]);
      expect(
        {
          naturalStart: w?.natural_start.toISOString(),
          naturalEnd: w?.natural_end.toISOString(),
          windowStart: w?.window_start.toISOString(),
          windowEnd: w?.window_end.toISOString(),
        },
        `anchored ${anchor.toISOString()}, month ${String(expected.index)}`,
      ).toEqual({
        naturalStart: expected.start.toISOString(),
        naturalEnd: expected.end.toISOString(),
        windowStart: expected.start.toISOString(),
        windowEnd: expected.end.toISOString(),
      });
      expect(
        expected.index,
        'a month-end anchor in the last eleven months is past its first month',
      ).toBeGreaterThanOrEqual(0);
      const [lot] = await lotsOf(db(), accountId);
      expect(lot?.granted_micro, anchor.toISOString()).toBe(String(10_000 * MICRO));
      compared += 1;
    }
    expect(compared, 'windows compared with the shared calendar').toBeGreaterThanOrEqual(60);
  });

  it('a plan an admin set runs on the same calendar from its anchor, years on: anchored on a 31st, on Feb 29, and a millisecond before a new year', async () => {
    const before = await databaseNow();
    for (const iso of [
      '2024-01-31T10:30:00.000Z',
      '2024-02-29T00:00:00.000Z',
      '2023-12-31T23:59:59.999Z',
      '2025-03-30T12:00:00.250Z',
    ]) {
      const anchor = new Date(iso);
      const accountId = await newAccountOn(db(), 'enterprise');
      await planOverride(db(), accountId, { monthlyCredits: 40_000, anchor: at(anchor) });
      await h().grants.refreshCredits(accountId);
      const expected = naturalMonthContaining(anchor, before);
      if (naturalMonthContaining(anchor, await databaseNow()).index !== expected.index) continue;
      const [w] = await windowsOf(db(), accountId);
      expect(
        [w?.natural_start.toISOString(), w?.natural_end.toISOString()],
        `anchored ${iso}`,
      ).toEqual([expected.start.toISOString(), expected.end.toISOString()]);
      expect(expected.index, iso).toBeGreaterThan(12);
    }
  });

  it('a yearly line’s LAST month is cut where the paid year ends, and gets its share of that month rather than the whole level', async () => {
    const now = await databaseNow();
    // A "year" that ends 3 days from now, part-way through its current month.
    const anchor = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
    anchor.setUTCMilliseconds(0);
    const accountId = await newAccountOn(db(), 'api_scale');
    const subscriptionId = await subscription(db(), accountId, { tier: 'api_scale' });
    await paidLine(db(), accountId, {
      subscriptionId,
      tier: 'api_scale',
      interval: 'year',
      start: at(anchor),
      end: "date_trunc('second', now()) + interval '3 days'",
    });
    await h().grants.refreshCredits(accountId);

    const expected = naturalMonthContaining(anchor, now);
    const [w] = await windowsOf(db(), accountId);
    expect(w?.natural_end.toISOString(), 'the natural month is not cut').toBe(
      expected.end.toISOString(),
    );
    expect(w?.window_end.getTime(), 'the window is cut at the paid end').toBeLessThan(
      expected.end.getTime(),
    );
    if (w === undefined) throw new Error('no window');
    const share = windowShareMicro(
      30_000 * MICRO,
      { start: w.window_start, end: w.window_end },
      { start: w.natural_start, end: w.natural_end },
    );
    expect(share).toBeLessThan(30_000 * MICRO);
    expect((await lotsOf(db(), accountId))[0]?.granted_micro).toBe(String(share));
  });

  it('CRITICAL a monthly line is its own month even when it is LONGER than `start + 1 month` (Feb 28 → Mar 31, as Stripe draws a subscription anchored on the 31st): one window over the whole paid period, the whole level, and nothing left over to be granted again', async () => {
    const accountId = await newAccountOn(db(), 'api_starter');
    const subscriptionId = await subscription(db(), accountId, { tier: 'api_starter' });
    const start = "date_trunc('second', now()) - interval '5 days'";
    await paidLine(db(), accountId, {
      subscriptionId,
      tier: 'api_starter',
      start,
      end: `((${start}) AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC' + interval '3 days'`,
    });
    await h().grants.refreshCredits(accountId);

    const [w, ...more] = await windowsOf(db(), accountId);
    expect(more).toEqual([]);
    const [line] = await db()<Array<{ s: Date; e: Date }>>`
      SELECT line_period_start AS s, line_period_end AS e FROM billing_invoice_payments
       WHERE account_id = ${accountId}::uuid`;
    expect([w?.natural_start.getTime(), w?.natural_end.getTime()]).toEqual([
      line?.s.getTime(),
      line?.e.getTime(),
    ]);
    expect([w?.window_start.getTime(), w?.window_end.getTime()]).toEqual([
      line?.s.getTime(),
      line?.e.getTime(),
    ]);
    expect((await lotsOf(db(), accountId))[0]?.granted_micro).toBe(String(3_000 * MICRO));
  });

  it('CRITICAL a paid line of three days does NOT grant a whole month of credits: its month still runs a calendar month from its start, the window is the three days, and it holds three days’ share', async () => {
    const accountId = await newAccountOn(db(), 'api_scale');
    const subscriptionId = await subscription(db(), accountId, { tier: 'api_scale' });
    await paidLine(db(), accountId, {
      subscriptionId,
      tier: 'api_scale',
      start: "date_trunc('second', now()) - interval '1 day'",
      end: "date_trunc('second', now()) + interval '2 days'",
    });
    await h().grants.refreshCredits(accountId);

    const [w] = await windowsOf(db(), accountId);
    if (w === undefined) throw new Error('no window');
    expect(w.window_end.getTime() - w.window_start.getTime()).toBe(3 * 24 * 60 * 60 * 1000);
    expect(w.natural_end.toISOString()).toBe(
      naturalMonthContaining(w.natural_start, w.natural_start).end.toISOString(),
    );
    const share = windowShareMicro(
      30_000 * MICRO,
      { start: w.window_start, end: w.window_end },
      { start: w.natural_start, end: w.natural_end },
    );
    const granted = Number((await lotsOf(db(), accountId))[0]?.granted_micro);
    expect(granted).toBe(share);
    expect(granted, 'three days of a 30,000-credit month').toBeGreaterThanOrEqual(2_900 * MICRO);
    expect(granted).toBeLessThanOrEqual(3_300 * MICRO);
    expect(granted % MICRO, 'whole credits').toBe(0);
  });

  it('CRITICAL a shortened window after a switch gets its share of the month: it starts where the earlier window ended, and holds level × (window ÷ month), floored to whole credits — the same figure the shared rule gives', async () => {
    const accountId = await newAccountOn(db(), 'api_builder');
    // The account's earlier coverage, which ran until an hour ago.
    await insertWindow(db(), accountId, {
      source: 'crypto_entitlement',
      start: "date_trunc('second', now()) - interval '31 days 1 hour'",
      end: "date_trunc('second', now()) - interval '1 hour'",
    });
    const subscriptionId = await subscription(db(), accountId, { tier: 'api_builder' });
    await paidLine(db(), accountId, { subscriptionId, tier: 'api_builder' });

    const result = await h().grants.refreshCredits(accountId);
    const windows = await windowsOf(db(), accountId);
    expect(windows).toHaveLength(2);
    const [earlier, w] = windows;
    if (earlier === undefined || w === undefined) throw new Error('missing window');
    expect(w.window_start.getTime(), 'it starts where the earlier one ended').toBe(
      earlier.window_end.getTime(),
    );
    expect(w.natural_start.getTime(), 'its month began five days ago').toBeLessThan(
      w.window_start.getTime(),
    );

    const share = windowShareMicro(
      10_000 * MICRO,
      { start: w.window_start, end: w.window_end },
      { start: w.natural_start, end: w.natural_end },
    );
    expect(share).toBeLessThan(10_000 * MICRO);
    expect(share % MICRO).toBe(0);
    expect(result.window).toMatchObject({ outcome: 'created', grantedMicro: share });
    const lot = (await lotsOf(db(), accountId)).find((l) => l.window_id === w.id);
    expect(lot?.granted_micro).toBe(String(share));
    expect(lot?.starts_at.getTime()).toBe(w.window_start.getTime());
    expect(await h().ledger.spendableMicro(accountId)).toBe(share);
  });

  it('a window whose share floors to nothing is still written — that time is covered — but has no lot and grants nothing', async () => {
    const accountId = await newAccountOn(db(), 'solo_manual');
    await insertWindow(db(), accountId, {
      source: 'crypto_entitlement',
      start: "date_trunc('second', now()) - interval '31 days'",
      end: "date_trunc('second', now()) - interval '1 second'",
    });
    const subscriptionId = await subscription(db(), accountId, { tier: 'solo_manual' });
    // Two minutes of a 1,500-credit month is 0.07 of a credit.
    await paidLine(db(), accountId, {
      subscriptionId,
      tier: 'solo_manual',
      start: "date_trunc('second', now()) - interval '29 days'",
      end: "date_trunc('second', now()) + interval '2 minutes'",
    });

    const result = await h().grants.refreshCredits(accountId);
    expect(result.window).toMatchObject({ outcome: 'created', grantedMicro: 0 });
    expect(await windowsOf(db(), accountId)).toHaveLength(2);
    expect(await lotsOf(db(), accountId)).toEqual([]);
    expect(await h().ledger.spendableMicro(accountId)).toBe(0);
  });
});
