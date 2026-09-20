// A plan change mid-month is worth the days that are LEFT, and nothing else.
//
// A customer who upgrades on the 20th has already had the smaller plan's
// credits for twenty days; what they have bought is the difference for the rest
// of the month. A customer who downgrades has been granted a month of the
// larger plan and is keeping only part of it. Both are the same arithmetic with
// opposite signs:
//
//     delta = floor to whole credits of (target − level) × (window_end − u) / (natural month)
//
// where `target` is the highest allowance any PAID coverage earns right now
// (for Stripe, the lower of the paid line's plan and the subscription's current
// plan, which a paid `proration_up` line raises), and `u` is when the plan
// actually changed — the paid proration line's start for an upgrade, the
// subscription's `tier_since` for a downgrade. Never when the event arrived: a
// webhook delivered a day late must not cost the customer a day.
//
// An upgrade's share arrives in a `proration` lot of its own that dies with the
// window. A downgrade takes its share back out of the window's lots, newest
// first (`a-downgrade-takes-back-what-is-free…` is where the taking-back and
// the debt it can leave are proved).
//
// ⛔ IDEMPOTENT BY THE LEVEL ITSELF. The window carries the level it is at, so
// once it has been moved to the target there is no difference left to prorate.
// Every caller — a redelivered webhook, the sweep, the boundary job, an admin —
// runs the same `refreshCredits`, and the second one computes nothing. That is
// what the "twice" arms below are for, and the negative control for them is
// recorded in the slice report.
//
// ⛔ A LAPSE NEVER LOWERS THE LEVEL. An account whose coverage has ended has no
// target at all and keeps the month it paid for. What stops it SPENDING is its
// tier, which is not decided here (S12).
//
// The paid lines here are 840 hours long so that every share is a fraction that
// can be checked by hand; see the header of `credit-plan-change-fixtures.ts`.
// The last arm re-checks the same composition against an ORDINARY Stripe
// monthly line, against an expectation computed independently in SQL.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { debtOf, openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { DrizzleCreditPlanOverridesRepo } from '../../src/db/credit-plan-overrides-repo.js';
import {
  MICRO,
  grantsHarness,
  ledgerOf,
  lotsOf,
  payingCustomer,
  windowsOf,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';
import {
  MONTH_HOURS,
  MONTH_START,
  adminOverride,
  atHour,
  clawbacksOf,
  leaving,
  levelChangesOf,
  mirrorCanceled,
  mirrorMovedTo,
  paidMonth,
  paidPeriodLine,
  paidProrationUpLine,
  spendFromLot,
} from './_helpers/credit-plan-change-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_plan_change';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
let harness: GrantsHarness | null = null;
let databaseUrl: string | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  databaseUrl = opened.url;
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

function url(): string {
  if (databaseUrl === null) throw new Error('isolated database unreachable');
  return databaseUrl;
}

/** An account on `tier`, one paid month old, with its month already granted. */
async function granted(tier: 'api_starter' | 'api_builder' | 'api_scale' | 'team_manual') {
  const month = await paidMonth(db(), tier);
  const first = await h().grants.refreshCredits(month.accountId);
  if (first.window.outcome !== 'created') {
    throw new Error(`setup: the first refresh did not grant (${first.window.outcome})`);
  }
  return { ...month, windowId: first.window.windowId };
}

describe.skipIf(!RUN_DB_TESTS)('a plan change mid-month is worth the days that are left', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
  });

  it('CRITICAL an UPGRADE with half the month left grants half the difference, in a proration lot of its own that dies with the window: 3,000 → 30,000 with 420 of 840 hours to run is 13,500 credits', async () => {
    const { accountId, subscriptionId, windowId } = await granted('api_starter');
    expect(await h().ledger.spendableMicro(accountId)).toBe(3_000 * MICRO);

    await mirrorMovedTo(db(), subscriptionId, 'api_scale', leaving(420));
    await paidProrationUpLine(db(), accountId, {
      subscriptionId,
      tier: 'api_scale',
      from: leaving(420),
    });
    const result = await h().grants.refreshCredits(accountId);

    expect(result.level).toMatchObject({
      windowId,
      fromLevelMicro: 3_000 * MICRO,
      toLevelMicro: 30_000 * MICRO,
      seq: 1,
      deltaMicro: 13_500 * MICRO,
      clawback: null,
    });
    const prorationLotId = result.level?.prorationLotId;
    expect(prorationLotId, 'an upgrade wrote no proration lot').not.toBeNull();

    const [w] = await windowsOf(db(), accountId);
    expect(w).toMatchObject({ level_micro: String(30_000 * MICRO), level_seq: 1 });

    const lots = await lotsOf(db(), accountId);
    const proration = lots.find((l) => l.kind === 'proration');
    expect(proration).toMatchObject({
      window_id: windowId,
      grant_key: `proration:${windowId}:1`,
      granted_micro: String(13_500 * MICRO),
      remaining_micro: String(13_500 * MICRO),
    });
    // It dies with the window it belongs to: a mid-month upgrade's credits never
    // outlive the month they were bought for.
    expect(proration?.expires_at).toEqual(w?.window_end);

    expect((await ledgerOf(db(), accountId)).filter((e) => e.kind === 'proration_grant')).toEqual([
      {
        kind: 'proration_grant',
        lot_id: prorationLotId,
        lot_delta_micro: String(13_500 * MICRO),
        debt_delta_micro: '0',
        idempotency_key: `proration_grant:${String(prorationLotId)}`,
      },
    ]);
    expect(await h().ledger.spendableMicro(accountId)).toBe(16_500 * MICRO);
  });

  it('CRITICAL the same upgrade refreshed again grants NOTHING: the window is already at the target, so there is no difference left to prorate — one level change, one proration lot, one funding row, whoever asks and however often', async () => {
    const { accountId, subscriptionId, windowId } = await granted('api_builder');
    await mirrorMovedTo(db(), subscriptionId, 'api_scale', leaving(420));
    await paidProrationUpLine(db(), accountId, {
      subscriptionId,
      tier: 'api_scale',
      from: leaving(420),
    });

    const first = await h().grants.refreshCredits(accountId);
    expect(first.level?.deltaMicro).toBe(10_000 * MICRO); // (30,000 − 10,000) × 420/840
    const after = {
      lots: await lotsOf(db(), accountId),
      ledger: await ledgerOf(db(), accountId),
      changes: await levelChangesOf(db(), windowId),
      spendable: await h().ledger.spendableMicro(accountId),
    };

    for (const _ of [1, 2, 3]) {
      const again = await h().grants.refreshCredits(accountId);
      expect(again.level, 'a repeated refresh prorated the plan change again').toBeNull();
    }

    expect(await lotsOf(db(), accountId)).toEqual(after.lots);
    expect(await ledgerOf(db(), accountId)).toEqual(after.ledger);
    expect(await levelChangesOf(db(), windowId)).toEqual(after.changes);
    expect(await h().ledger.spendableMicro(accountId)).toBe(after.spendable);
    expect(after.changes).toHaveLength(1);
  });

  it('an upgrade that lands at the very start of the window grants exactly the difference between the two plans — the same arithmetic, over the same denominator, that granted the month', async () => {
    const { accountId, subscriptionId } = await granted('api_starter');
    await mirrorMovedTo(db(), subscriptionId, 'api_scale', MONTH_START);
    await paidProrationUpLine(db(), accountId, {
      subscriptionId,
      tier: 'api_scale',
      from: MONTH_START,
    });

    const result = await h().grants.refreshCredits(accountId);

    expect(result.level?.deltaMicro).toBe(27_000 * MICRO);
    expect(await h().ledger.spendableMicro(accountId)).toBe(30_000 * MICRO);
  });

  it('the share is FLOORED to whole credits, never rounded up: 7,000 credits over a third of the month is 2,333, not 2,333⅓ and not 2,334', async () => {
    const { accountId, subscriptionId } = await granted('api_starter');
    await mirrorMovedTo(db(), subscriptionId, 'api_builder', leaving(280));
    await paidProrationUpLine(db(), accountId, {
      subscriptionId,
      tier: 'api_builder',
      from: leaving(280),
    });

    const result = await h().grants.refreshCredits(accountId);

    // (10,000 − 3,000) × 280/840 = 2,333.33…
    expect(result.level?.deltaMicro).toBe(2_333 * MICRO);
    expect(await h().ledger.spendableMicro(accountId)).toBe(5_333 * MICRO);
  });

  it('CRITICAL a DOWNGRADE with half the month left takes back half the difference: 30,000 → 3,000 with 420 of 840 hours to run takes 13,500 credits out of the month’s lot', async () => {
    const { accountId, subscriptionId, windowId } = await granted('api_scale');

    // A downgrade is billed at the next renewal, so there is no new paid line:
    // the mirror moving is the whole event.
    await mirrorMovedTo(db(), subscriptionId, 'api_starter', leaving(420));
    const result = await h().grants.refreshCredits(accountId);

    expect(result.level).toMatchObject({
      fromLevelMicro: 30_000 * MICRO,
      toLevelMicro: 3_000 * MICRO,
      seq: 1,
      deltaMicro: -13_500 * MICRO,
      prorationLotId: null,
    });
    expect(result.level?.clawback).toMatchObject({
      source: 'plan_change',
      sourceRef: `${windowId}:1`,
      targetKey: `window:${windowId}`,
      state: 'applied',
      amountMicro: 13_500 * MICRO,
      clawedMicro: 13_500 * MICRO,
      pendingMicro: 0,
      debtMicro: 0,
    });

    const [monthly] = await lotsOf(db(), accountId);
    expect(monthly).toMatchObject({
      kind: 'monthly',
      granted_micro: String(30_000 * MICRO),
      remaining_micro: String(16_500 * MICRO),
    });
    expect(
      (await ledgerOf(db(), accountId)).filter((e) => e.kind === 'proration_clawback'),
    ).toEqual([
      {
        kind: 'proration_clawback',
        lot_id: monthly?.id ?? null,
        lot_delta_micro: String(-13_500 * MICRO),
        debt_delta_micro: '0',
        idempotency_key: `clawback:plan_change:${windowId}:1:${String(monthly?.id)}`,
      },
    ]);
    expect(await h().ledger.spendableMicro(accountId)).toBe(16_500 * MICRO);
  });

  it('CRITICAL the same downgrade refreshed again takes NOTHING more, and the clawback record is the one already there', async () => {
    const { accountId, subscriptionId } = await granted('api_scale');
    await mirrorMovedTo(db(), subscriptionId, 'team_manual', leaving(420));

    const first = await h().grants.refreshCredits(accountId);
    expect(first.level?.deltaMicro).toBe(-12_500 * MICRO); // (5,000 − 30,000) × 420/840
    const after = {
      lots: await lotsOf(db(), accountId),
      ledger: await ledgerOf(db(), accountId),
      clawbacks: await clawbacksOf(db(), accountId),
    };

    for (const _ of [1, 2, 3]) {
      const again = await h().grants.refreshCredits(accountId);
      expect(again.level, 'a repeated refresh clawed the plan change again').toBeNull();
    }

    expect(await lotsOf(db(), accountId)).toEqual(after.lots);
    expect(await ledgerOf(db(), accountId)).toEqual(after.ledger);
    expect(await clawbacksOf(db(), accountId)).toEqual(after.clawbacks);
    expect(after.clawbacks).toHaveLength(1);
  });

  it('CRITICAL switching up and back down nets to NOTHING: the upgrade’s lot is emptied by the downgrade that reverses it, the month’s own lot is untouched, and no debt is owed', async () => {
    const { accountId, subscriptionId, windowId } = await granted('api_starter');
    await mirrorMovedTo(db(), subscriptionId, 'api_scale', leaving(420));
    await paidProrationUpLine(db(), accountId, {
      subscriptionId,
      tier: 'api_scale',
      from: leaving(420),
    });
    expect((await h().grants.refreshCredits(accountId)).level?.deltaMicro).toBe(13_500 * MICRO);

    // Back to where they started, at the same instant: the mirror falls, and the
    // paid proration line is now capped by it (the lower of line and mirror).
    await mirrorMovedTo(db(), subscriptionId, 'api_starter', leaving(420));
    const back = await h().grants.refreshCredits(accountId);

    expect(back.level).toMatchObject({
      fromLevelMicro: 30_000 * MICRO,
      toLevelMicro: 3_000 * MICRO,
      seq: 2,
      deltaMicro: -13_500 * MICRO,
    });
    const lots = await lotsOf(db(), accountId);
    expect(lots.find((l) => l.kind === 'monthly')?.remaining_micro).toBe(String(3_000 * MICRO));
    expect(lots.find((l) => l.kind === 'proration')?.remaining_micro).toBe('0');
    expect(await h().ledger.spendableMicro(accountId)).toBe(3_000 * MICRO);

    const [{ debt_micro: debt } = { debt_micro: 'missing' }] = await db()<
      Array<{ debt_micro: string }>
    >`SELECT debt_micro::text AS debt_micro FROM credit_accounts WHERE account_id = ${accountId}::uuid`;
    expect(debt).toBe('0');

    // Two changes, two steps, and each one starts where the last left off.
    expect(await levelChangesOf(db(), windowId)).toMatchObject([
      {
        seq: 1,
        reason: 'plan_change',
        from_level_micro: String(3_000 * MICRO),
        to_level_micro: String(30_000 * MICRO),
      },
      {
        seq: 2,
        reason: 'plan_change',
        from_level_micro: String(30_000 * MICRO),
        to_level_micro: String(3_000 * MICRO),
      },
    ]);
    expect((await windowsOf(db(), accountId))[0]).toMatchObject({ level_seq: 2 });
  });

  it('CRITICAL a downgrade takes the NEWEST credit first: the upgrade’s lot gives up what is asked before the month’s own lot is touched at all', async () => {
    const { accountId, subscriptionId } = await granted('api_starter');
    await mirrorMovedTo(db(), subscriptionId, 'api_scale', leaving(420));
    await paidProrationUpLine(db(), accountId, {
      subscriptionId,
      tier: 'api_scale',
      from: leaving(420),
    });
    expect((await h().grants.refreshCredits(accountId)).level?.deltaMicro).toBe(13_500 * MICRO);

    // Down to api_builder, not all the way back: the paid proration line is
    // capped at the mirror's 10,000, so the target is 10,000 and the claw is
    // (10,000 − 30,000) × 420/840 = 10,000 — less than the 13,500 the upgrade
    // put in, so the month's own lot must not be touched.
    await mirrorMovedTo(db(), subscriptionId, 'api_builder', leaving(420));
    const back = await h().grants.refreshCredits(accountId);

    expect(back.level?.deltaMicro).toBe(-10_000 * MICRO);
    const lots = await lotsOf(db(), accountId);
    expect(lots.find((l) => l.kind === 'proration')?.remaining_micro).toBe(String(3_500 * MICRO));
    expect(lots.find((l) => l.kind === 'monthly')?.remaining_micro).toBe(String(3_000 * MICRO));
    expect(await h().ledger.spendableMicro(accountId)).toBe(6_500 * MICRO);
  });

  it('CRITICAL a LATE event is prorated from when the plan changed, not from when it arrived: a downgrade recorded at the start of the month takes the whole difference back, though the refresh runs 600 hours later', async () => {
    const { accountId, subscriptionId, windowId } = await granted('api_scale');

    // `tier_since` is the moment the plan changed. The refresh is running now,
    // 600 hours after it; prorating from now() would take back only
    // 27,000 × 240/840 = 7,714 and leave the customer 19,286 credits of a plan
    // they stopped paying for at the start of the month.
    await mirrorMovedTo(db(), subscriptionId, 'api_starter', MONTH_START);
    const result = await h().grants.refreshCredits(accountId);

    expect(result.level?.deltaMicro).toBe(-27_000 * MICRO);
    expect(await h().ledger.spendableMicro(accountId)).toBe(3_000 * MICRO);
    const [change] = await levelChangesOf(db(), windowId);
    const [{ u } = { u: null }] = await db()<Array<{ u: Date }>>`
      SELECT ${db().unsafe(MONTH_START)} AS u`;
    expect(change?.effective_at, 'the level change recorded the wrong instant').toEqual(u);
  });

  it('a change recorded BEFORE the window started is clamped to the window: a plan that changed a month ago prorates over this month, not over more of it than exists', async () => {
    const { accountId, subscriptionId } = await granted('api_scale');

    await mirrorMovedTo(
      db(),
      subscriptionId,
      'api_starter',
      `(${MONTH_START} - interval '900 hours')`,
    );
    const result = await h().grants.refreshCredits(accountId);

    // Clamped to window_start, so the share is the whole window: exactly the
    // difference, never more than the month was ever worth.
    expect(result.level?.deltaMicro).toBe(-27_000 * MICRO);
  });

  it('CRITICAL a LAPSE never lowers the level: a cancelled subscription keeps the month it paid for, with no level change, no clawback and no lost credits. (What stops the account SPENDING them is its tier, which is not decided here.)', async () => {
    const { accountId, subscriptionId, windowId } = await granted('api_builder');
    const before = await lotsOf(db(), accountId);

    await mirrorCanceled(db(), subscriptionId);
    const result = await h().grants.refreshCredits(accountId);

    expect(result.level).toBeNull();
    expect(result.window).toEqual({ outcome: 'none' });
    expect(await levelChangesOf(db(), windowId)).toEqual([]);
    expect(await clawbacksOf(db(), accountId)).toEqual([]);
    expect(await lotsOf(db(), accountId)).toEqual(before);
    expect((await windowsOf(db(), accountId))[0]).toMatchObject({
      level_micro: String(10_000 * MICRO),
      level_seq: 0,
    });
    expect(await h().ledger.spendableMicro(accountId)).toBe(10_000 * MICRO);
  });

  it('a move to a plan with NO included credits is a target of nothing, which never lowers the level either — the same rule as a lapse, reached by a different route', async () => {
    const { accountId, subscriptionId, windowId } = await granted('team_manual');

    await mirrorMovedTo(db(), subscriptionId, 'free', leaving(420));
    const result = await h().grants.refreshCredits(accountId);

    expect(result.level).toBeNull();
    expect(await levelChangesOf(db(), windowId)).toEqual([]);
    expect(await h().ledger.spendableMicro(accountId)).toBe(5_000 * MICRO);
  });

  it('an UNPAID upgrade never raises the level: the mirror says the bigger plan and no paid line does, so the target stays at the lower of the two and nothing is granted', async () => {
    const { accountId, subscriptionId, windowId } = await granted('api_starter');

    // The subscription is updated the moment the customer clicks; the
    // `subscription_update` invoice is paid afterwards, and may never be.
    await mirrorMovedTo(db(), subscriptionId, 'api_scale', leaving(420));
    const result = await h().grants.refreshCredits(accountId);

    expect(result.level, 'an unpaid upgrade prorated credits').toBeNull();
    expect(await levelChangesOf(db(), windowId)).toEqual([]);
    expect(await h().ledger.spendableMicro(accountId)).toBe(3_000 * MICRO);

    // …and the moment its invoice IS paid, the same refresh grants the share.
    await paidProrationUpLine(db(), accountId, {
      subscriptionId,
      tier: 'api_scale',
      from: leaving(420),
    });
    expect((await h().grants.refreshCredits(accountId)).level?.deltaMicro).toBe(13_500 * MICRO);
  });

  it('CRITICAL the same composition on an ORDINARY Stripe monthly line, whose month is whatever the calendar says: the delta the service computes equals the share computed independently in SQL, floored toward zero', async () => {
    const { accountId, subscriptionId } = await payingCustomer(db(), 'api_scale');
    const first = await h().grants.refreshCredits(accountId);
    expect(first.window.outcome).toBe('created');

    // Parenthesised: spliced bare into `window_end - <since>`, Postgres would
    // read `(window_end - now()) - interval '38 hours'` and the check would
    // quietly measure a different span from the one under test.
    const since = "(date_trunc('second', now()) - interval '38 hours')";
    await mirrorMovedTo(db(), subscriptionId, 'api_starter', since);
    const result = await h().grants.refreshCredits(accountId);

    // Computed by Postgres from the stored instants, with `trunc` rather than
    // `floor` because the magnitude is floored and the sign kept: floor(−x)
    // would take back one credit MORE than the customer ever had.
    //
    // ⛔ IT READS THE STORED `tier_since`, NEVER `since` A SECOND TIME. That
    // string holds `now()`, so evaluating it again here dates the move from
    // THIS statement's clock instead of the one the service prorated from. The
    // two differ by however long the statements took, which is ~0.012 credits a
    // second on a 30,000-credit month — invisible until the gap happens to
    // straddle a whole credit, and then the arm is off by exactly one. Measured:
    // it failed in a full-suite run with `expected -23925000000 to be
    // -23924000000` and passed three times in a row when run alone.
    const [row] = await db()<Array<{ expected: string }>>`
      SELECT trunc(
               (${String(3_000 - 30_000)}::numeric
                 * extract(epoch FROM (w.window_end - s.tier_since)))
               / extract(epoch FROM (w.natural_end - w.natural_start)))::text AS expected
        FROM credit_windows w
        JOIN subscriptions s ON s.stripe_subscription_id = ${subscriptionId}
       WHERE w.account_id = ${accountId}::uuid AND w.window_start <= now() AND now() < w.window_end`;
    expect(row, 'the account has no current window to prorate over').toBeDefined();
    expect(result.level?.deltaMicro).toBe(Number(row?.expected) * MICRO);
    expect(result.level?.deltaMicro).toBeLessThan(0);
  });

  it('CRITICAL RACE: six connections reconcile one upgrade AT ONCE and exactly one of them moves the level. The account’s credit lock runs them one after the other; behind it the level-change row’s (window, step) and the proration lot’s grant key each refuse a second copy, and the window’s own UPDATE is conditional on the step it was read at, so a writer that somehow read a stale level moves nothing and says so', async () => {
    const { accountId, subscriptionId, windowId } = await granted('api_starter');
    await h().ledger.ensureAccount(accountId);
    await mirrorMovedTo(db(), subscriptionId, 'api_scale', leaving(420));
    await paidProrationUpLine(db(), accountId, {
      subscriptionId,
      tier: 'api_scale',
      from: leaving(420),
    });

    // One connection each, so "at once" is six backends and not one taking turns.
    const racers = Array.from({ length: 6 }, () => grantsHarness(url(), { max: 1 }));
    try {
      const pids = await Promise.all(
        racers.map(async (r) => {
          const [row] = await r.database.client<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          return row?.pid;
        }),
      );
      expect(new Set(pids).size, 'the racers shared a backend').toBe(racers.length);

      const results = await Promise.all(racers.map((r) => r.grants.refreshCredits(accountId)));

      expect(results.filter((r) => r.level !== null)).toHaveLength(1);
      expect(results.find((r) => r.level !== null)?.level?.deltaMicro).toBe(13_500 * MICRO);
      expect(await levelChangesOf(db(), windowId)).toHaveLength(1);
      expect((await windowsOf(db(), accountId))[0]).toMatchObject({ level_seq: 1 });
      expect((await lotsOf(db(), accountId)).filter((l) => l.kind === 'proration')).toHaveLength(1);
      expect(
        (await ledgerOf(db(), accountId)).filter((e) => e.kind === 'proration_grant'),
      ).toHaveLength(1);
      expect(await h().ledger.spendableMicro(accountId)).toBe(16_500 * MICRO);
    } finally {
      await Promise.all(racers.map((r) => r.database.close().catch(() => {})));
    }
  });

  it('CRITICAL a writer that read a level someone else has since moved writes NOTHING and says so: the window’s UPDATE is conditional on the level AND the step it was read at, which is what makes a lost update impossible rather than merely unlikely behind the lock', async () => {
    const { accountId, subscriptionId, windowId } = await granted('api_scale');
    await mirrorMovedTo(db(), subscriptionId, 'api_starter', leaving(420));
    expect((await h().grants.refreshCredits(accountId)).level?.seq).toBe(1);

    const stale = {
      accountId,
      windowId,
      seq: 1,
      reason: 'plan_change',
      fromLevelMicro: 30_000 * MICRO,
      toLevelMicro: 5_000 * MICRO,
      effectiveAt: '2026-01-01T00:00:00.000000Z',
      deltaMicro: -1 * MICRO,
    } as const;
    await expect(
      h().ledger.transaction((tx) => h().windows.setWindowLevel(tx, stale)),
    ).rejects.toThrow(/moved under a level change that had already read it/i);

    // Nothing of the stale writer's survived: not the level, not the step, and
    // not a second row in the history.
    expect((await windowsOf(db(), accountId))[0]).toMatchObject({
      level_micro: String(3_000 * MICRO),
      level_seq: 1,
    });
    expect(await levelChangesOf(db(), windowId)).toHaveLength(1);

    // …and the same writer, having re-read, is accepted.
    await h().ledger.transaction((tx) =>
      h().windows.setWindowLevel(tx, {
        ...stale,
        seq: 2,
        fromLevelMicro: 3_000 * MICRO,
        toLevelMicro: 5_000 * MICRO,
      }),
    );
    expect((await windowsOf(db(), accountId))[0]).toMatchObject({
      level_micro: String(5_000 * MICRO),
      level_seq: 2,
    });
  });

  it('the coverage that supplies the target is chosen by a TOTAL order, so an amount of money never depends on the order Postgres returned rows in: with a renewal’s period line and an upgrade’s proration line both earning 30,000, the proration line wins and the share runs from ITS start', async () => {
    const { accountId, subscriptionId } = await granted('api_starter');
    await mirrorMovedTo(db(), subscriptionId, 'api_scale', leaving(840));
    // Two paid lines over now(), both at the new plan: the same level, two
    // different starts. Prorating from the period line's start would grant the
    // whole 27,000; §6.6 says an upgrade runs from its paid proration line.
    await paidPeriodLine(db(), accountId, {
      subscriptionId,
      tier: 'api_scale',
      start: MONTH_START,
    });
    await paidProrationUpLine(db(), accountId, {
      subscriptionId,
      tier: 'api_scale',
      from: leaving(420),
    });

    const result = await h().grants.refreshCredits(accountId);

    expect(result.level?.deltaMicro).toBe(13_500 * MICRO);
  });

  it('CRITICAL `u` IS ONLY EVIDENCE WHEN IT COMES FROM THE COVERAGE THE WINDOW WAS DRAWN FROM: an account served all month by an admin’s plan, whose subscription mirror last moved months ago, is clawed only for the time left when that plan ENDS — not for the whole month, and it is not put into debt for credits it spent while the plan was live', async () => {
    // The shape S6 itself creates: `setTier` ends an `admin_tier` override
    // automatically (M7), and what is left covering now() is a cheaper paid
    // subscription whose `tier_since` has nothing to do with this window.
    const { accountId, subscriptionId } = await paidMonth(db(), 'api_starter');
    await mirrorMovedTo(db(), subscriptionId, 'api_starter', atHour(-24 * 90));
    await adminOverride(db(), accountId, {
      monthlyCredits: 30_000,
      reason: 'admin_tier',
      anchor: MONTH_START,
    });
    const first = await h().grants.refreshCredits(accountId);
    if (first.window.outcome !== 'created') {
      throw new Error(`setup: the admin plan did not draw the window (${first.window.outcome})`);
    }
    const windowId = first.window.windowId;
    const [lot] = await lotsOf(db(), accountId);
    if (lot === undefined) throw new Error('setup: the month was granted into no lot');
    expect(lot.granted_micro).toBe(String(30_000 * MICRO));
    // The customer spends two thirds of the month while the admin plan is live.
    await spendFromLot(db(), accountId, lot.id, 20_000);

    // The admin plan ends NOW, exactly as `setTier` ends it.
    const ended = await new DrizzleCreditPlanOverridesRepo(h().database).endAdminTierOverride(
      accountId,
    );
    expect(ended, 'setup: the admin plan was not ended').toBe(true);
    const result = await h().grants.refreshCredits(accountId);

    // What the account stopped earning 30,000 at is when the override ended —
    // NOT `tier_since`, which predates the window and would clamp to its start
    // and take the whole month's difference back. Computed from the stored
    // instants, with trunc, exactly as the ordinary-monthly-line arm does.
    const [row] = await db()<Array<{ expected: string; start: Date; u: Date }>>`
      SELECT trunc((${String(3_000 - 30_000)}::numeric
                     * extract(epoch FROM (w.window_end - o.ends_at)))
                   / extract(epoch FROM (w.natural_end - w.natural_start)))::text AS expected,
             w.window_start AS start, o.ends_at AS u
        FROM credit_windows w
        JOIN credit_plan_overrides o ON o.account_id = w.account_id
       WHERE w.account_id = ${accountId}::uuid AND w.window_start <= now() AND now() < w.window_end`;
    expect(row, 'the account has no current window to prorate over').toBeDefined();
    expect(result.level?.deltaMicro).toBe(Number(row?.expected) * MICRO);
    expect(result.level?.deltaMicro).toBeGreaterThan(-27_000 * MICRO);
    const [change] = await levelChangesOf(db(), windowId);
    expect(
      change?.effective_at,
      'the change was dated to the window start, so the whole month was taken back',
    ).not.toEqual(row?.start);

    // And the point of all of it: the 20,000 they spent under the plan that was
    // live is theirs. A claw of the whole month would have taken the 10,000 that
    // was left and charged them 17,000 credits of debt for the rest.
    expect(await debtOf(db(), accountId), 'spending under a live plan became debt').toBe(0);
    expect(await h().ledger.spendableMicro(accountId)).toBe(
      10_000 * MICRO + Number(row?.expected) * MICRO,
    );
  });

  it('the fixtures really do draw a window of 840 hours whose natural month is the paid period itself — otherwise every hand-checked fraction above would be measuring a different denominator', async () => {
    const { accountId } = await granted('api_starter');
    const [row] = await db()<Array<{ natural: string; window: string; same: boolean }>>`
      SELECT extract(epoch FROM (natural_end - natural_start))::text AS natural,
             extract(epoch FROM (window_end - window_start))::text AS window,
             (natural_start = window_start AND natural_end = window_end) AS same
        FROM credit_windows WHERE account_id = ${accountId}::uuid`;
    expect(Number(row?.natural)).toBe(MONTH_HOURS * 3_600);
    expect(Number(row?.window)).toBe(MONTH_HOURS * 3_600);
    expect(row?.same).toBe(true);
  });
});
