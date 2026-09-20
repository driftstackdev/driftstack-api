// A credit window is never created ahead of its start.
//
// Credits that exist can be spent. If next month's window could be written
// today, its credits would be spendable today — on top of this month's — and a
// payment refunded before its month began would already be gone. So a window
// must CONTAIN now() when it is written: the month after this one is granted
// when it starts, by the boundary job, the sweep or the next billing event.
//
// The case that makes this more than a tidy rule: a customer on a crypto term
// that runs to the 1st pays, on the 15th, for a subscription month running 15th
// to 15th. The stretch from the 1st to the 15th of NEXT month is paid for, is not
// covered by any window, and must still not be granted yet.
//
// Held twice. The service never asks for such a window (its candidates are drawn
// in SQL and filtered on the database's clock), and the DATABASE refuses one
// anyway: `created_at` is forced to now() on insert and a CHECK requires
// `window_start <= created_at`. The raw-SQL arms prove the second without the
// first.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  cryptoEntitlement,
  grantsHarness,
  insertWindow,
  lotsOf,
  newAccountOn,
  paidLine,
  subscription,
  windowsOf,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';
import { refusal } from './_helpers/database-refusal.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_window_not_early';
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

describe.skipIf(!RUN_DB_TESTS)('a credit window is never created ahead of its start', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
  });

  it('CRITICAL the database refuses a window that starts in the future, by the CHECK written for it — one second ahead is ahead', async () => {
    const accountId = await newAccountOn(db());
    for (const start of ["now() + interval '1 second'", "now() + interval '20 days'"]) {
      const r = await refusal(
        () => insertWindow(db(), accountId, { start, end: "now() + interval '60 days'" }),
        start,
      );
      expect(r.code, start).toBe('23514');
      expect(r.constraint, start).toBe('credit_windows_started');
    }
    expect(await windowsOf(db(), accountId)).toEqual([]);
  });

  it('CRITICAL the check cannot be talked round: `created_at` is forced to the database clock, so a statement that CLAIMS a later creation time still cannot write a future window, and one that claims an earlier time is corrected', async () => {
    const accountId = await newAccountOn(db());
    const claimed = await refusal(() =>
      db().unsafe(
        `INSERT INTO credit_windows
             (account_id, source, source_ref, natural_start, natural_end, window_start, window_end,
              tier, level_micro, created_at)
           VALUES ($1, 'stripe_invoice', 'in_future', now() + interval '20 days', now() + interval '50 days',
                   now() + interval '20 days', now() + interval '50 days', 'api_starter', 3000000000,
                   now() + interval '1 year')`,
        [accountId],
      ),
    );
    expect(claimed.code).toBe('23514');
    expect(claimed.constraint).toBe('credit_windows_started');

    const [row] = await db().unsafe<Array<{ honest: boolean; seq: number }>>(
      `INSERT INTO credit_windows
         (account_id, source, source_ref, natural_start, natural_end, window_start, window_end,
          tier, level_micro, created_at, level_seq)
       VALUES ($1, 'stripe_invoice', 'in_backdated', now() - interval '3 days', now() + interval '27 days',
               now() - interval '3 days', now() + interval '27 days', 'api_starter', 3000000000,
               now() - interval '10 years', 7)
       RETURNING (created_at = now()) AS honest, level_seq AS seq`,
      [accountId],
    );
    expect(row, 'created_at and level_seq are what the database says, not the statement').toEqual({
      honest: true,
      seq: 0,
    });
  });

  it('a paid period that has not started yet grants nothing now', async () => {
    const accountId = await newAccountOn(db(), 'api_builder');
    const subscriptionId = await subscription(db(), accountId, { tier: 'api_builder' });
    await paidLine(db(), accountId, {
      subscriptionId,
      tier: 'api_builder',
      start: "date_trunc('second', now()) + interval '1 day'",
      end: "date_trunc('second', now()) + interval '32 days'",
    });
    expect((await h().grants.refreshCredits(accountId)).window).toEqual({ outcome: 'none' });
    expect(await windowsOf(db(), accountId)).toEqual([]);
  });

  it('a stacked crypto term that starts when the current one ends is not granted until then: only the term containing now() is', async () => {
    const accountId = await newAccountOn(db(), 'team_manual');
    const current = await cryptoEntitlement(db(), accountId, {
      tier: 'team_manual',
      starts: "date_trunc('second', now()) - interval '10 days'",
    });
    await cryptoEntitlement(db(), accountId, {
      tier: 'team_manual',
      starts: "date_trunc('second', now()) + interval '21 days'",
    });

    expect((await h().grants.refreshCredits(accountId)).window).toMatchObject({
      outcome: 'created',
      sourceRef: current,
    });
    expect((await h().grants.refreshCredits(accountId)).window).toEqual({ outcome: 'none' });
    const windows = await windowsOf(db(), accountId);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.current).toBe(true);
  });

  it('CRITICAL the case that matters: a crypto term covers now and ends in 10 days; a subscription month paid today runs 30 days. The 20 days after the term ends are paid for and uncovered, and are NOT granted yet — so no second WINDOW appears over the crypto term’s. What the paid subscription does earn is the DIFFERENCE between the two plans for the ten days they overlap, which S6 grants as a proration on the crypto window itself (§6.6: the target is the highest allowance any paid coverage earns right now). The 20 uncovered days wait for the term to end.', async () => {
    const accountId = await newAccountOn(db(), 'team_manual');
    await cryptoEntitlement(db(), accountId, {
      tier: 'api_starter',
      starts: "date_trunc('second', now()) - interval '21 days'",
    });
    // The crypto term's window exists first, as it would: it was granted 21 days ago.
    expect((await h().grants.refreshCredits(accountId)).window.outcome).toBe('created');

    const subscriptionId = await subscription(db(), accountId, { tier: 'team_manual' });
    await paidLine(db(), accountId, {
      subscriptionId,
      tier: 'team_manual',
      start: "date_trunc('second', now())",
      end: "date_trunc('second', now()) + interval '30 days'",
    });

    const result = await h().grants.refreshCredits(accountId);
    expect(result.window, 'a window was written for time that has not begun').toEqual({
      outcome: 'none',
    });
    const windows = await windowsOf(db(), accountId);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.source).toBe('crypto_entitlement');
    // The crypto month's 3,000, plus the paid plan's 2,000-a-month difference
    // over the ten days of the term that are left: trunc(2,000 × 10/31) = 645.
    // NOT the 5,000 − 3,333 the subscription's own 20-day stub will grant when
    // the term ends and its window can finally be drawn.
    expect((await lotsOf(db(), accountId)).map((l) => l.granted_micro)).toEqual([
      String(3_000 * MICRO),
      String(645 * MICRO),
    ]);
    expect(await h().ledger.spendableMicro(accountId)).toBe(3_645 * MICRO);
    // The window itself is still the crypto term's, and still one.
    expect((await windowsOf(db(), accountId))[0]).toMatchObject({
      source: 'crypto_entitlement',
      level_micro: String(5_000 * MICRO),
      level_seq: 1,
    });
  });

  it('the repository itself refuses to write a window that does not contain now(), and says "covered" rather than failing', async () => {
    const accountId = await newAccountOn(db(), 'api_starter');
    const [t] = await db()<Array<{ soon: string; later: string; past: string; earlier: string }>>`
      SELECT to_char((now() + interval '1 day') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS soon,
             to_char((now() + interval '31 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS later,
             to_char((now() - interval '1 day') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS past,
             to_char((now() - interval '31 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS earlier`;
    if (t === undefined) throw new Error('no clock row');
    const base = {
      source: 'stripe_invoice' as const,
      tier: 'api_starter' as const,
      levelMicro: 3_000 * MICRO,
    };
    const outcomes = await h().ledger.transaction(async (tx) => {
      await h().ledger.lockAccount(tx, accountId);
      const future = await h().windows.writeWindow(tx, accountId, {
        ...base,
        sourceRef: 'in_future',
        naturalStart: t.soon,
        naturalEnd: t.later,
        windowStart: t.soon,
        windowEnd: t.later,
      });
      const over = await h().windows.writeWindow(tx, accountId, {
        ...base,
        sourceRef: 'in_over',
        naturalStart: t.earlier,
        naturalEnd: t.past,
        windowStart: t.earlier,
        windowEnd: t.past,
      });
      return [future.outcome, over.outcome];
    });
    expect(outcomes).toEqual(['covered', 'covered']);
    expect(await windowsOf(db(), accountId)).toEqual([]);
  });
});
