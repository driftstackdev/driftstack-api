// A reversal lands on the amount the spec gives, not just where its twin does.
//
// The twin property test (any-order-of-payments-…-does.test.ts) compares an
// account with the same account minus its won disputes. Two runs of the same
// code can agree and BOTH be wrong, and a history its generators never produce
// is never compared at all. Each arm here is one such history, found by the
// fourth independent audit of the S17 refunds work (585b5a5f0), with the amount
// the spec gives WORKED OUT BY HAND in the comment beside it — so a defect both
// twins share fails here. Where an arm has a twin, the twin's amount is
// asserted absolutely too, which checks the hand arithmetic against the code
// where the code is right.
//
// THE RULINGS THESE ARMS ENCODE (the coordinator, 2026-09-23, after audit 4):
//
//   (a) R1 REVISED. Credit a won dispute returns for debt that another lot
//       repaid keeps ONLY that lot's own remaining term. If the lot has
//       expired, nothing is returned: it would have expired anyway, which is
//       exactly where the twin without the dispute is.
//   (b) The interim annual cap uses each reversal's consumption FROZEN at the
//       moment of that reversal. A later spend, a later settle or a later win
//       does not move it.
//   (c) Debt an admin forgave while a dispute stood is not returned by the
//       win: a win returns at most what claims and repayments actually paid.
//   (d) At a win after its window ended, the month gives back min(what the
//       dispute took from the unit's own lots, what was spent from OTHER lots
//       in that window while it stood) — into those other lots.
//
// REVERSAL POLICY v2 (design-reversal-policy-v2.md, 2026-09-24) moved three arms
// to BOUNDS: P3, P9 and P11, where a win after the month ended returns credit
// the twin let expire (rule 6's new lot, B2) or keeps a hand-over share fixed
// (B3). Each keeps its twin's amount exact and asserts of W what §3's
// invariants 3 and 4 say: never below the twin (for every expiry instant too),
// levels equal, and at most what the dispute removed above it. Every other arm
// stays exact.
//
// Amounts are credits. A starter month is 3,000 credits for 4,900 minor units;
// an annual starter invoice is 58,800 for twelve such months (36,000 credits);
// a builder month is 10,000. Every share below is floored to whole credits.
// P10 and P14 of the audit (rows written before 0139) are not here: they need a
// database migrated to 0138 first and are covered separately.

import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { CreditClawbacksService, floorToPriorMinute } from '../../src/services/credit-clawbacks.js';
import { debtOf, openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  cryptoEntitlement,
  grantsHarness,
  lotsOf,
  newAccountOn,
  paidLine,
  payingCustomer,
  subscription,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';
import {
  holdOnLot,
  leaving,
  mirrorMovedTo,
  paidMonth,
  spendFromLot,
} from './_helpers/credit-plan-change-fixtures.js';
import {
  reservationsHarness,
  settledCall,
  type ReservationsHarness,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_spec_amounts';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const PAID = 4_900;
const ANNUAL = 58_800;

let client: postgres.Sql | null = null;
let harness: GrantsHarness | null = null;
let reservations: ReservationsHarness | null = null;
let service: CreditClawbacksService | null = null;
const alerts: SentryMessage[] = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 10);
  if (opened === null) return;
  client = opened.sql;
  harness = grantsHarness(opened.url, { max: 8 });
  reservations = reservationsHarness(opened.url, { refresher: null, max: 3 });
  const quiet = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
  service = new CreditClawbacksService({
    ledger: harness.ledger,
    windows: harness.windows,
    grants: harness.grants,
    logger: quiet as unknown as Logger,
    sentry: {
      captureMessage: (msg) => {
        alerts.push(msg);
      },
    },
  });
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await harness?.database.close().catch(() => {});
  await reservations?.database.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}
function h(): GrantsHarness {
  if (harness === null) throw new Error('isolated database unreachable');
  return harness;
}
function svc(): CreditClawbacksService {
  if (service === null) throw new Error('isolated database unreachable');
  return service;
}
function tasks(): ReservationsHarness {
  if (reservations === null) throw new Error('isolated database unreachable');
  return reservations;
}

// ── reading the account ─────────────────────────────────────────────────────

const credits = (micro: number): number => micro / MICRO;

interface Balances {
  readonly spendable: number;
  readonly debt: number;
  /** The current window's level; null when no window contains now(). */
  readonly level: number | null;
}

async function balances(accountId: string): Promise<Balances> {
  const [row] = await db()<Array<{ level: string }>>`
    SELECT level_micro::text AS level FROM credit_windows
     WHERE account_id = ${accountId}::uuid AND window_start <= now() AND now() < window_end`;
  return {
    spendable: credits(await h().ledger.spendableMicro(accountId)),
    debt: credits(await debtOf(db(), accountId)),
    level: row === undefined ? null : credits(Number(row.level)),
  };
}

interface Term {
  /** The instant the credit expires, as microsecond UTC text. */
  readonly expires: string;
  readonly credits: number;
}

/** What the account can spend, grouped by when it expires, soonest first. */
async function termsOf(accountId: string): Promise<Term[]> {
  const rows = await db()<Array<{ e: string; free: string }>>`
    SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS e,
           sum(remaining_micro - held_micro)::text AS free
      FROM credit_lots
     WHERE account_id = ${accountId}::uuid AND revoked_at IS NULL
       AND starts_at <= now() AND now() < expires_at AND remaining_micro > held_micro
     GROUP BY expires_at
     ORDER BY expires_at`;
  return rows.map((r) => ({ expires: r.e, credits: credits(Number(r.free)) }));
}

/**
 * §3 invariants 3 and 4, for one won-dispute account W against its twin T:
 * never worse off (spendable, debt, and the credit valid until every expiry
 * instant or later, each within one credit), the same level, and never more
 * than `removed` credits (what the dispute removed, B2) better off.
 */
async function expectBoundedByTwin(
  w: string,
  t: string,
  removed: number,
  what: string,
): Promise<void> {
  const bw = await balances(w);
  const bt = await balances(t);
  expect(bw.level, `${what}: levels`).toBe(bt.level);
  expect(bw.spendable, `${what}: W spendable not below the twin`).toBeGreaterThan(bt.spendable - 1);
  expect(bw.debt, `${what}: W debt not above the twin`).toBeLessThan(bt.debt + 1);
  expect(
    bw.spendable - bt.spendable,
    `${what}: W above the twin by at most what was removed`,
  ).toBeLessThan(removed + 1);
  expect(
    bt.debt - bw.debt,
    `${what}: W's debt below the twin's by at most what was removed`,
  ).toBeLessThan(removed + 1);
  const tw = await termsOf(w);
  const tt = await termsOf(t);
  const instants = [...new Set([...tw, ...tt].map((x) => x.expires))].sort();
  for (const x of instants) {
    const from = (terms: Term[]): number =>
      terms.filter((term) => term.expires >= x).reduce((sum, term) => sum + term.credits, 0);
    expect(from(tw), `${what}: credit valid until ${x} or later`).toBeGreaterThan(from(tt) - 1);
  }
}

/** Invariant 2's left side: what every lot still holds (live) or has held back, plus what tasks spent, less debt. */
async function heldSpentLessDebt(accountId: string): Promise<number> {
  const [row] = await db()<Array<{ n: string }>>`
    SELECT (COALESCE((SELECT sum(CASE WHEN revoked_at IS NULL AND starts_at <= now() AND now() < expires_at
                                      THEN remaining_micro - held_micro ELSE 0 END + held_micro)
                        FROM credit_lots WHERE account_id = ${accountId}::uuid), 0)
            + COALESCE((SELECT -sum(lot_delta_micro) FROM credit_ledger
                         WHERE account_id = ${accountId}::uuid AND kind = 'task_charge'), 0))::text AS n`;
  return credits(Number(row?.n ?? '0') - (await debtOf(db(), accountId)));
}

/** An SQL instant as `termsOf` spells it. */
async function instant(expression: string): Promise<string> {
  const [row] = await db().unsafe<Array<{ t: string }>>(
    `SELECT to_char((${expression}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`,
  );
  if (row === undefined) throw new Error('setup: no clock');
  return row.t;
}

/** Everything a refresh could write, for one account. */
async function footprint(accountId: string): Promise<string> {
  const [row] = await db()<Array<Record<string, string>>>`
    SELECT (SELECT count(*)::text FROM credit_lots WHERE account_id = ${accountId}::uuid) AS lots,
           (SELECT count(*)::text FROM credit_ledger WHERE account_id = ${accountId}::uuid) AS ledger,
           (SELECT count(*)::text FROM credit_clawbacks WHERE account_id = ${accountId}::uuid) AS clawbacks,
           (SELECT count(*)::text FROM credit_windows WHERE account_id = ${accountId}::uuid) AS windows`;
  return JSON.stringify({ ...row, ...(await balances(accountId)) });
}

// ── the clock ───────────────────────────────────────────────────────────────

/** An instant `seconds` ahead of the database's clock, whole seconds, as UTC text. */
async function boundaryIn(seconds: number): Promise<string> {
  const [row] = await db()<Array<{ t: string }>>`
    SELECT to_char((date_trunc('second', now()) + make_interval(secs => ${seconds})) AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t`;
  if (row === undefined) throw new Error('setup: no clock');
  return row.t;
}
function at(i: string): string {
  return `'${i}'::timestamptz`;
}
function monthBefore(i: string): string {
  return `((${at(i)} AT TIME ZONE 'UTC' - interval '1 month') AT TIME ZONE 'UTC')`;
}
function monthAfter(i: string): string {
  return `((${at(i)} AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC')`;
}
async function waitPast(i: string): Promise<void> {
  for (let n = 0; n < 240; n += 1) {
    const [row] = await db()<Array<{ past: boolean }>>`SELECT now() > ${i}::timestamptz AS past`;
    if (row?.past === true) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the database clock never passed the boundary');
}

// ── the accounts ────────────────────────────────────────────────────────────

async function charge(invoiceId: string, chargeId: string): Promise<void> {
  await db()`UPDATE billing_invoice_payments SET stripe_charge_id = ${chargeId} WHERE stripe_invoice_id = ${invoiceId}`;
}

/** The newest monthly lot of the account. */
async function monthlyLot(accountId: string): Promise<string> {
  const lots = (await lotsOf(db(), accountId)).filter((l) => l.kind === 'monthly');
  const lot = lots[lots.length - 1];
  if (lot === undefined) throw new Error('setup: no monthly lot');
  return lot.id;
}

/** The monthly lot of the window that contains now(). */
async function currentMonthlyLot(accountId: string): Promise<string> {
  const [row] = await db()<Array<{ id: string }>>`
    SELECT l.id FROM credit_lots l JOIN credit_windows cw ON cw.id = l.window_id
     WHERE l.account_id = ${accountId}::uuid AND l.kind = 'monthly'
       AND cw.window_start <= now() AND now() < cw.window_end`;
  if (row === undefined) throw new Error('setup: no current monthly lot');
  return row.id;
}

let spends = 0;
/** Spend `amount` credits in the product's spend order, as tasks do. */
async function spendInOrder(accountId: string, amount: number): Promise<void> {
  let left = amount * MICRO;
  const lots = await db()<Array<{ id: string; free: string }>>`
    SELECT id, (remaining_micro - held_micro)::text AS free FROM credit_lots
     WHERE account_id = ${accountId}::uuid AND starts_at <= now() AND now() < expires_at
       AND revoked_at IS NULL AND remaining_micro > held_micro
     ORDER BY spend_rank, expires_at, created_at, id`;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(left, Number(lot.free));
    spends += 1;
    await spendFromLot(db(), accountId, lot.id, credits(take), spends);
    left = left - take;
  }
  if (left > 0) throw new Error('setup: less free credit than the arm spends');
}

/** An api_starter customer on a paid month (five days in), granted. */
async function startedMonth(chargeId: string) {
  const c = await payingCustomer(db(), 'api_starter', { amountPaid: PAID });
  await charge(c.invoiceId, chargeId);
  await h().grants.refreshCredits(c.accountId);
  return { ...c, lotId: await monthlyLot(c.accountId) };
}

/**
 * A second subscription on `tier`, its first month paid from the SAME INSTANT
 * as the month it takes over, granted. The instant is read off the first line
 * rather than written as the fixtures' default "five days ago on the second":
 * two inserts that straddle a second boundary each floor to a different second,
 * the resubscription then covers the month less one second, and its share of
 * it floors a whole credit short (7,000 × (month − 1 s) / month = 6,999).
 */
async function resubscribed(
  accountId: string,
  tier: 'api_starter' | 'api_builder',
  chargeId: string,
): Promise<void> {
  const [first] = await db()<Array<{ s: string }>>`
    SELECT to_char(line_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS s
      FROM billing_invoice_payments WHERE account_id = ${accountId}::uuid
     ORDER BY paid_at, stripe_invoice_id LIMIT 1`;
  if (first === undefined) throw new Error('setup: no first line');
  const start = at(first.s);
  const next = await subscription(db(), accountId, { tier });
  const invoice = await paidLine(db(), accountId, {
    subscriptionId: next,
    tier,
    amountPaid: PAID,
    start,
    end: `((${start} AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC')`,
  });
  await charge(invoice, chargeId);
  await h().grants.refreshCredits(accountId);
}

/**
 * An api_starter customer paying a YEAR (58,800) whose current month ends at
 * `boundary`. The year is anchored k months before the boundary, k = 1 unless
 * the calendar cannot land on it from one month back (the 29th–31st), then 2:
 * either way the window containing now() ends exactly at `boundary`.
 */
async function annualCustomer(chargeId: string, boundary: string) {
  const [row] = await db()<Array<{ k: number }>>`
    SELECT CASE WHEN ((${boundary}::timestamptz AT TIME ZONE 'UTC' - interval '1 month')
                      + interval '1 month') AT TIME ZONE 'UTC' = ${boundary}::timestamptz
                THEN 1 ELSE 2 END AS k`;
  const k = row?.k ?? 1;
  const anchor = `((${at(boundary)} AT TIME ZONE 'UTC' - interval '${String(k)} months') AT TIME ZONE 'UTC')`;
  const monthsAfterAnchor = (n: number): string =>
    `((${anchor} AT TIME ZONE 'UTC' + interval '${String(n)} months') AT TIME ZONE 'UTC')`;
  const accountId = await newAccountOn(db(), 'api_starter');
  const subscriptionId = await subscription(db(), accountId, { tier: 'api_starter' });
  const invoiceId = await paidLine(db(), accountId, {
    subscriptionId,
    tier: 'api_starter',
    interval: 'year',
    start: anchor,
    end: monthsAfterAnchor(12),
    amountPaid: ANNUAL,
  });
  await charge(invoiceId, chargeId);
  await h().grants.refreshCredits(accountId);
  return {
    accountId,
    subscriptionId,
    invoiceId,
    /** The start of the month that contains now(). */
    monthStart: monthsAfterAnchor(k - 1),
    /** The end of the month after it. */
    nextMonthEnd: monthsAfterAnchor(k + 1),
    yearEnd: monthsAfterAnchor(12),
  };
}

/** Two api_starter months on one subscription, the first ending at `boundary`; the first granted. */
async function twoMonths(chargeId: string, boundary: string) {
  const c = await payingCustomer(db(), 'api_starter', {
    amountPaid: PAID,
    start: monthBefore(boundary),
    end: at(boundary),
  });
  await paidLine(db(), c.accountId, {
    subscriptionId: c.subscriptionId,
    tier: 'api_starter',
    start: at(boundary),
    end: monthAfter(boundary),
    amountPaid: PAID,
  });
  await charge(c.invoiceId, chargeId);
  await h().grants.refreshCredits(c.accountId);
  return { ...c, lotId: await monthlyLot(c.accountId) };
}

/** A bought top-up, funded and set against any debt in one transaction. */
async function buyTopUp(
  accountId: string,
  amount: number,
  key: string,
  expires: string,
): Promise<void> {
  const [row] = await db().unsafe<Array<{ e: Date }>>(`SELECT (${expires}) AS e`);
  if (row === undefined) throw new Error('setup: no expiry');
  await h().ledger.transaction(async (tx) => {
    await h().ledger.lockAccount(tx, accountId);
    const inserted = await h().ledger.insertLot(
      {
        accountId,
        kind: 'top_up',
        grantKey: `topup:${key}`,
        grantedMicro: amount * MICRO,
        startsAt: floorToPriorMinute(new Date()),
        expiresAt: row.e,
      },
      tx,
    );
    // A top-up's funding row is written by the purchase that owns it.
    await tx.execute(sql`
      INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key, actor)
      VALUES (${accountId}::uuid, 'top_up', ${inserted.lot.id}::uuid,
              ${String(amount * MICRO)}::bigint, ${`top_up:${inserted.lot.id}`}, 'customer')`);
    await h().ledger.settleDebtFromFree(tx, accountId);
  });
}

/** Goodwill granted by support, as the admin route writes it: a lot, its grant, debt settled. */
async function goodwill(
  accountId: string,
  amount: number,
  key: string,
  expires: string,
): Promise<void> {
  const [row] = await db().unsafe<Array<{ e: Date }>>(`SELECT (${expires}) AS e`);
  if (row === undefined) throw new Error('setup: no expiry');
  await h().ledger.transaction(async (tx) => {
    await h().ledger.lockAccount(tx, accountId);
    const inserted = await h().ledger.insertLot(
      {
        accountId,
        kind: 'adjustment',
        grantKey: `goodwill:${key}`,
        grantedMicro: amount * MICRO,
        startsAt: floorToPriorMinute(new Date()),
        expiresAt: row.e,
      },
      tx,
    );
    await h().ledger.append(
      {
        accountId,
        kind: 'grant',
        lotId: inserted.lot.id,
        amountMicro: amount * MICRO,
        idempotencyKey: `admin_goodwill:${key}`,
        actor: 'admin',
      },
      tx,
    );
    await h().ledger.settleDebtFromFree(tx, accountId);
  });
}

/** An admin forgives all the account's debt, as the admin route's `forgive_debt` writes it. */
async function adminForgivesTheDebt(accountId: string, key: string): Promise<number> {
  return h().ledger.transaction(async (tx) => {
    const before = await h().ledger.lockAccount(tx, accountId);
    if (before.debtMicro <= 0) return 0;
    await h().ledger.append(
      {
        accountId,
        kind: 'adjustment',
        forgiveDebtMicro: before.debtMicro,
        idempotencyKey: `admin_forgive_debt:${key}`,
        actor: 'admin',
        reason: 'support',
      },
      tx,
    );
    return credits(before.debtMicro);
  });
}

function refund(chargeId: string, cumulativeRefundedMinor: number) {
  return { chargeId, stripeInvoiceId: null, cumulativeRefundedMinor };
}
function dispute(disputeId: string, chargeId: string, amountMinor = PAID) {
  return { disputeId, chargeId, stripeInvoiceId: null, amountMinor };
}
function failureMessage(err: unknown): string {
  const e = err as { message?: string; cause?: { message?: string } };
  return (e.cause?.message ?? e.message ?? String(err)).slice(0, 180);
}

// ── the arms ────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_DB_TESTS)(
  'a reversal lands on the amount the spec gives, not just where its twin does',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL a refunded resubscription takes back the share of the month it was handed, and the old month keeps its own credit (P1)', async () => {
      const c = await startedMonth('ch_sa_p1');
      await spendFromLot(db(), c.accountId, c.lotId, 1_000);
      await resubscribed(c.accountId, 'api_builder', 'ch_sa_p1_rs');
      // 3,000 − 1,000 spent, plus the builder resubscription's step above the
      // month for the whole of it (both lines start the same day): 10,000 − 3,000.
      expect(await balances(c.accountId)).toEqual({ spendable: 9_000, debt: 0, level: 10_000 });
      await svc().applyStripeRefund(refund('ch_sa_p1_rs', PAID));
      // Nothing of the resubscription is paid any more: its 7,000 goes back, and
      // the old month keeps 3,000 − 1,000 (the twin that never resubscribed).
      expect(await balances(c.accountId)).toEqual({ spendable: 2_000, debt: 0, level: 3_000 });
    });

    it('CRITICAL a disputed resubscription takes back the share of the month it was handed while the dispute stands (P1b)', async () => {
      const c = await startedMonth('ch_sa_p1b');
      await spendFromLot(db(), c.accountId, c.lotId, 1_000);
      await resubscribed(c.accountId, 'api_builder', 'ch_sa_p1b_rs');
      await svc().applyStripeDispute(dispute('dp_sa_p1b', 'ch_sa_p1b_rs'));
      // As P1: the whole resubscription is disputed, so none of its 7,000 stays.
      expect(await balances(c.accountId)).toEqual({ spendable: 2_000, debt: 0, level: 3_000 });
    });

    it('CRITICAL a refunded crypto term takes back the share of a Stripe month it was handed (P2)', async () => {
      const m = await paidMonth(db(), 'api_starter');
      await charge(m.invoiceId, 'ch_sa_p2');
      await h().grants.refreshCredits(m.accountId);
      const order = await cryptoEntitlement(db(), m.accountId, {
        tier: 'api_builder',
        starts: leaving(420),
      });
      await h().grants.refreshCredits(m.accountId);
      // The 840-hour month: 3,000, plus the builder term's step (7,000) for the
      // 420 of 840 hours it covers: 3,500.
      expect(await balances(m.accountId)).toEqual({ spendable: 6_500, debt: 0, level: 10_000 });
      // The refund revokes the entitlement at the refund instant, then takes the credits back.
      await db()`UPDATE crypto_entitlements SET expires_at = date_trunc('second', now()) WHERE order_id = ${order}`;
      await svc().applyCryptoRefund({ accountId: m.accountId, orderId: order });
      await h().grants.refreshCredits(m.accountId);
      // The twin that never bought the term: the month's 3,000.
      expect(await balances(m.accountId)).toEqual({ spendable: 3_000, debt: 0, level: 3_000 });
    });

    it('CRITICAL a month handed to a resubscription during a dispute: after a win past the month the account is never below the twin and at most what the dispute removed above it (P3, bounds)', async () => {
      const boundary = await boundaryIn(12);
      // 840-hour lines (longer than any calendar month), so every share is exact.
      async function world(tag: string, disputed: boolean): Promise<string> {
        const accountId = await newAccountOn(db(), 'api_starter');
        const sub = await subscription(db(), accountId, { tier: 'api_starter' });
        const base = await paidLine(db(), accountId, {
          subscriptionId: sub,
          tier: 'api_starter',
          start: `(${at(boundary)} - interval '840 hours')`,
          end: at(boundary),
          amountPaid: PAID,
        });
        await charge(base, `ch_sa_p3_${tag}`);
        await h().grants.refreshCredits(accountId);
        await spendFromLot(db(), accountId, await monthlyLot(accountId), 1_000);
        // Resubscribed on starter 480 hours before the month ends.
        const next = await subscription(db(), accountId, { tier: 'api_starter' });
        const start = `(${at(boundary)} - interval '480 hours')`;
        await paidLine(db(), accountId, {
          subscriptionId: next,
          tier: 'api_starter',
          start,
          end: `(${start} + interval '840 hours')`,
          amountPaid: PAID,
        });
        await h().grants.refreshCredits(accountId);
        if (disputed) await svc().applyStripeDispute(dispute(`dp_sa_p3_${tag}`, `ch_sa_p3_${tag}`));
        return accountId;
      }
      const w = await world('w', true);
      const t = await world('t', false);
      // W: the old month is disputed whole — 2,000 free taken, 1,000 spent owed.
      // The resubscription now stands above nothing and is handed its share,
      // 3,000 × 480 / 840 = 1,714, which repays the 1,000: 714 left.
      expect(await balances(w)).toEqual({ spendable: 714, debt: 0, level: 3_000 });
      // T: 3,000 − 1,000; the resubscription stands level with the month, so it earns nothing.
      expect(await balances(t)).toEqual({ spendable: 2_000, debt: 0, level: 3_000 });
      await waitPast(boundary);
      await h().grants.refreshCredits(w);
      await h().grants.refreshCredits(t);
      await svc().reinstateDispute(dispute('dp_sa_p3_w', 'ch_sa_p3_w'));
      await h().grants.refreshCredits(w);
      // Month 2 is the resubscription's window [boundary, start + 840 h): 360 of
      // its 840 hours, 3,000 × 360 / 840 = 1,285 — the twin's amount.
      const monthTwoEnd = await instant(`${at(boundary)} + interval '360 hours'`);
      expect(await balances(t)).toEqual({ spendable: 1_285, debt: 0, level: 3_000 });
      expect(await termsOf(t)).toEqual([{ expires: monthTwoEnd, credits: 1_285 }]);
      // W (policy v2): the dispute removed the month's 2,000 free and 1,000 of
      // debt the hand-over paid — 3,000, all of the month. Month 1 has ended, so
      // rule 6 returns both as one new lot valid to month 2's end, and the
      // hand-over share stays fixed (rule 7, B3): worked by hand, 1,285 + 3,000
      // = 4,285. Asserted as the bound B2 (Amendment 1, R-E): at most the
      // 3,000 the dispute removed above the twin.
      await expectBoundedByTwin(w, t, 3_000, 'P3');
    }, 60_000);

    it('CRITICAL debt an admin forgave while a dispute stood is not handed back as credit when the dispute is won (P4, ruling c)', async () => {
      const c = await startedMonth('ch_sa_p4');
      await spendFromLot(db(), c.accountId, c.lotId, 3_000);
      await svc().applyStripeDispute(dispute('dp_sa_p4', 'ch_sa_p4'));
      // The whole month disputed: everything was spent, so all 3,000 is owed.
      expect(await balances(c.accountId)).toEqual({ spendable: 0, debt: 3_000, level: 0 });
      expect(await adminForgivesTheDebt(c.accountId, 'sa_p4')).toBe(3_000);
      await svc().reinstateDispute(dispute('dp_sa_p4', 'ch_sa_p4'));
      // No claim and no repayment paid the dispute's debt, so the win returns
      // nothing: the twin without the dispute spent 3,000 of 3,000.
      expect(await balances(c.accountId)).toEqual({ spendable: 0, debt: 0, level: 3_000 });
    });

    it('CRITICAL goodwill that repaid a dispute gets its credit back for its own term, and a refund after the win is applied (P5, ruling a)', async () => {
      const boundary = await boundaryIn(12);
      const goodwillEnds = `(${at(boundary)} + interval '2 days')`;
      async function world(tag: string, disputed: boolean) {
        const c = await annualCustomer(`ch_sa_p5_${tag}`, boundary);
        await spendFromLot(db(), c.accountId, await monthlyLot(c.accountId), 3_000);
        if (disputed) {
          await svc().applyStripeDispute(dispute(`dp_sa_p5_${tag}`, `ch_sa_p5_${tag}`, ANNUAL));
        }
        await goodwill(c.accountId, 3_000, `sa_p5_${tag}`, goodwillEnds);
        return c;
      }
      const w = await world('w', true);
      const t = await world('t', false);
      // W: the year disputed whole; month 1 was spent, so 3,000 is owed, and the
      // goodwill repays it. T: the goodwill is free, the month spent.
      expect(await balances(w.accountId)).toEqual({ spendable: 0, debt: 0, level: 0 });
      expect(await balances(t.accountId)).toEqual({ spendable: 3_000, debt: 0, level: 3_000 });
      await waitPast(boundary);
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      await svc().reinstateDispute(dispute('dp_sa_p5_w', 'ch_sa_p5_w', ANNUAL));
      // Month 2's 3,000, and the goodwill's 3,000 BACK IN THE GOODWILL LOT,
      // lasting to its own end two days in (ruling a) — not to month 2's end.
      const terms = [
        { expires: await instant(goodwillEnds), credits: 3_000 },
        { expires: await instant(w.nextMonthEnd), credits: 3_000 },
      ];
      for (const c of [t, w]) {
        expect(await balances(c.accountId)).toEqual({ spendable: 6_000, debt: 0, level: 3_000 });
        expect(await termsOf(c.accountId)).toEqual(terms);
      }
      // 2,500 of month 2 spent, then the year refunded whole. Nothing is still
      // paid (keep 0), and the frozen cap allows all the spend as debt: month 2
      // gives up its 500 free and owes 2,500, month 1 owes its 3,000; the
      // goodwill's 3,000 repays 3,000 of that. 2,500 owed, nothing left.
      for (const [c, tag] of [
        [w, 'w'],
        [t, 't'],
      ] as const) {
        await spendFromLot(db(), c.accountId, await currentMonthlyLot(c.accountId), 2_500, 9);
        const outcome = await svc()
          .applyStripeRefund(refund(`ch_sa_p5_${tag}`, ANNUAL))
          .then(
            (o) => o.kind,
            (err: unknown) => `threw: ${failureMessage(err)}`,
          );
        expect(outcome, tag).toBe('applied');
        expect(await balances(c.accountId), tag).toEqual({ spendable: 0, debt: 2_500, level: 0 });
      }
    }, 60_000);

    it('a refund after a won dispute whose debt goodwill repaid, with nothing spent since, is applied and leaves nothing (P5b)', async () => {
      const boundary = await boundaryIn(12);
      const c = await annualCustomer('ch_sa_p5b', boundary);
      await spendFromLot(db(), c.accountId, await monthlyLot(c.accountId), 3_000);
      await svc().applyStripeDispute(dispute('dp_sa_p5b', 'ch_sa_p5b', ANNUAL));
      await goodwill(c.accountId, 3_000, 'sa_p5b', `(${at(boundary)} + interval '2 days')`);
      await waitPast(boundary);
      await h().grants.refreshCredits(c.accountId);
      await svc().reinstateDispute(dispute('dp_sa_p5b', 'ch_sa_p5b', ANNUAL));
      expect(await balances(c.accountId)).toEqual({ spendable: 6_000, debt: 0, level: 3_000 });
      const outcome = await svc()
        .applyStripeRefund(refund('ch_sa_p5b', ANNUAL))
        .then(
          (o) => o.kind,
          (err: unknown) => `threw: ${failureMessage(err)}`,
        );
      expect(outcome).toBe('applied');
      // Month 2's 3,000 is taken; month 1's 3,000 spent is owed and the
      // goodwill's 3,000 repays it.
      expect(await balances(c.accountId)).toEqual({ spendable: 0, debt: 0, level: 0 });
    }, 60_000);

    it('CRITICAL the interim annual cap is frozen at the refund, so a spend after it and a win after that leave the twin’s amounts (P6, ruling b)', async () => {
      const boundary = await boundaryIn(12);
      const w = await annualCustomer('ch_sa_p6w', boundary);
      const t = await annualCustomer('ch_sa_p6t', boundary);
      for (const c of [w, t]) {
        await spendFromLot(db(), c.accountId, await monthlyLot(c.accountId), 3_000);
      }
      // A dispute of 49 of 58,800 in W. Month 1 keeps floor(3,000 × 58,751 /
      // 58,800) = 2,997 but 3,000 was spent, and the cap (spent 3,000 against
      // 36,000 × 58,751 / 58,800 = 35,970 still paid for) allows no debt: it takes nothing.
      await svc().applyStripeDispute(dispute('dp_sa_p6w', 'ch_sa_p6w', 49));
      await waitPast(boundary);
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      await svc().applyStripeRefund(refund('ch_sa_p6w', 53_900));
      await svc().applyStripeRefund(refund('ch_sa_p6t', 53_900));
      // W: 4,851 still paid. Each month keeps floor(3,000 × 4,851 / 58,800) =
      // 247; the year still pays for 36,000 × 4,851 / 58,800 = 2,970. Spent:
      // month 1 3,000, month 2 nothing (frozen now), so 30 may be owed, newest
      // month first: month 2 has no shortfall, month 1 owes 30. Month 2 keeps
      // 247; the 30 is repaid from it: 217, level 247.
      expect(await balances(w.accountId)).toEqual({ spendable: 217, debt: 0, level: 247 });
      // T: 4,900 still paid: each month keeps 250, the year pays for 3,000,
      // spent 3,000 — nothing may be owed. Month 2 keeps 250.
      expect(await balances(t.accountId)).toEqual({ spendable: 250, debt: 0, level: 250 });
      for (const c of [w, t]) {
        await spendInOrder(c.accountId, 217);
        await h().grants.refreshCredits(c.accountId);
      }
      await svc().reinstateDispute(dispute('dp_sa_p6w', 'ch_sa_p6w', 49));
      for (const c of [w, t]) await h().grants.refreshCredits(c.accountId);
      // The win puts W where T is: the refund's cap stays frozen at the spend
      // it saw (3,000 in month 1, 0 in month 2), so with 4,900 still paid
      // nothing may be owed. 250 − 217 spent = 33.
      for (const c of [t, w]) {
        expect(await balances(c.accountId)).toEqual({ spendable: 33, debt: 0, level: 250 });
      }
    }, 60_000);

    it('a refund, a second dispute, a win, a settle and two refreshes of one account racing on separate connections all apply, and end on one amount (P7)', async () => {
      for (let i = 0; i < 6; i += 1) {
        const chargeId = `ch_sa_p7_${String(i)}`;
        const c = await startedMonth(chargeId);
        await spendFromLot(db(), c.accountId, c.lotId, 500);
        const task = await holdOnLot(db(), c.accountId, c.lotId, 1_000);
        await settledCall(db(), {
          reservationId: task,
          accountId: c.accountId,
          chargedMicro: 400 * MICRO,
        });
        await svc().applyStripeDispute(dispute(`dp_sa_p7a_${String(i)}`, chargeId, 1_000));
        const racing: Array<() => Promise<unknown>> = [
          () => svc().applyStripeRefund(refund(chargeId, 2_000)),
          () => svc().applyStripeDispute(dispute(`dp_sa_p7b_${String(i)}`, chargeId, 900)),
          () => svc().reinstateDispute(dispute(`dp_sa_p7a_${String(i)}`, chargeId, 1_000)),
          () => tasks().service.settle(task, 'completed'),
          () => h().grants.refreshCredits(c.accountId),
          () => h().grants.refreshCredits(c.accountId),
        ];
        const order = i % 2 === 0 ? racing : [...racing].reverse();
        const settled = await Promise.allSettled(order.map((run) => run()));
        const refused = settled
          .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
          .map((s) => failureMessage(s.reason));
        expect(refused, `round ${String(i)}`).toEqual([]);
        await h().grants.refreshCredits(c.accountId);
        // Still paid 4,900 − 2,000 refunded − 900 disputed = 2,000: the month
        // keeps floor(3,000 × 2,000 / 4,900) = 1,224, and 500 + 400 was spent.
        expect(await balances(c.accountId), `round ${String(i)}`).toEqual({
          spendable: 324,
          debt: 0,
          level: 1_224,
        });
      }
    }, 120_000);

    it('CRITICAL debt an upgrade’s lot repaid in a month that has ended: after the win the account is never below the twin and at most what the dispute removed above it (P9, bounds)', async () => {
      const boundary = await boundaryIn(14);
      async function world(tag: string, disputed: boolean) {
        const c = await annualCustomer(`ch_sa_p9_${tag}`, boundary);
        const baseLot = await monthlyLot(c.accountId);
        // Upgraded to builder from the month's start, on a paid annual upgrade line.
        await mirrorMovedTo(db(), c.subscriptionId, 'api_builder', c.monthStart);
        const up = await paidLine(db(), c.accountId, {
          subscriptionId: c.subscriptionId,
          tier: 'api_builder',
          lineKind: 'proration_up',
          interval: 'year',
          start: c.monthStart,
          end: c.yearEnd,
          amountPaid: 40_000,
        });
        await charge(up, `ch_sa_p9_${tag}_up`);
        await h().grants.refreshCredits(c.accountId);
        await spendFromLot(db(), c.accountId, baseLot, 3_000);
        if (disputed) {
          await svc().applyStripeDispute(dispute(`dp_sa_p9_${tag}`, `ch_sa_p9_${tag}`, ANNUAL));
        }
        return c;
      }
      const w = await world('w', true);
      const t = await world('t', false);
      // Month 1: 3,000 and the upgrade's 7,000 for the whole month; 3,000 spent.
      // W: the year disputed whole, 3,000 owed and repaid from the upgrade's lot.
      expect(await balances(w.accountId)).toEqual({ spendable: 4_000, debt: 0, level: 10_000 });
      expect(await balances(t.accountId)).toEqual({ spendable: 7_000, debt: 0, level: 10_000 });
      await waitPast(boundary);
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      await svc().reinstateDispute(dispute('dp_sa_p9_w', 'ch_sa_p9_w', ANNUAL));
      await h().grants.refreshCredits(w.accountId);
      // Month 2: 3,000 and 7,000, both to month 2's end — the twin's amount.
      const monthTwoEnd = await instant(w.nextMonthEnd);
      expect(await balances(t.accountId)).toEqual({ spendable: 10_000, debt: 0, level: 10_000 });
      expect(await termsOf(t.accountId)).toEqual([{ expires: monthTwoEnd, credits: 10_000 }]);
      // W (policy v2): the 3,000 the upgrade's month-1 lot paid of the dispute's
      // debt comes back as one new lot (that lot has expired), valid to month
      // 2's end: worked by hand, 13,000. The dispute removed month 1's 3,000 of
      // debt and month 2's 3,000 (the year disputed whole): at most 6,000 above.
      await expectBoundedByTwin(w.accountId, t.accountId, 6_000, 'P9 at the win');
      // 2,500 of month 2's own lot spent, then the year refunded whole. Month 2
      // gives up its 500 free and owes 2,500; month 1 owes its 3,000 spent (the
      // frozen cap allows all of it: nothing is still paid). The upgrade's
      // 7,000 repays 5,500 of that: 1,500 left, still at the builder level.
      for (const [c, tag] of [
        [w, 'w'],
        [t, 't'],
      ] as const) {
        await spendFromLot(db(), c.accountId, await currentMonthlyLot(c.accountId), 2_500, 9);
        await svc().applyStripeRefund(refund(`ch_sa_p9_${tag}`, ANNUAL));
      }
      // T: 1,500 (above). W (Amendment 3, R-H, with Amendment 2, R-F(b)): the
      // 3,000 the win returned replaced the UPGRADE's month-1 credit that paid
      // the dispute's debt, so it belongs to the upgrade invoice and a refund of
      // the base year does not re-measure it. The refund's 5,500 of debt is
      // repaid from month 2's upgrade lot (spent first): 1,500 + 3,000 = 4,500.
      expect(await balances(t.accountId)).toEqual({ spendable: 1_500, debt: 0, level: 10_000 });
      expect(await balances(w.accountId)).toEqual({ spendable: 4_500, debt: 0, level: 10_000 });
      // Invariants 3 and 4: never below the twin, at most the 6,000 removed above.
      await expectBoundedByTwin(w.accountId, t.accountId, 6_000, 'P9 after the refund');
      // Invariant 2, the paid-for ceiling, summed over the account: what the lots
      // hold plus what tasks spent, less debt, is at most what the payments are
      // worth. The base year is refunded whole (worth 0, but annual: the frozen
      // cap may excuse what was spent — month 1 3,000, month 2 2,500); the
      // upgrade line is still paid in full: 7,000 × 2. 19,500 — W holds 10,000.
      for (const c of [w, t]) {
        expect(await heldSpentLessDebt(c.accountId), 'P9: the paid-for ceiling').toBeLessThan(
          19_500 + 1,
        );
      }
    }, 60_000);

    it('CRITICAL a dispute that takes the month while a top-up is held sends the spending to the top-up, and a win after the month leaves the account never below the twin (P11, bounds)', async () => {
      const boundary = await boundaryIn(12);
      const topUpEnds = `(${at(boundary)} + interval '360 days')`;
      const w = await twoMonths('ch_sa_p11w', boundary);
      const t = await twoMonths('ch_sa_p11t', boundary);
      await buyTopUp(w.accountId, 3_000, 'sa_p11_w', topUpEnds);
      await buyTopUp(t.accountId, 3_000, 'sa_p11_t', topUpEnds);
      // Half the month disputed in W: it keeps 1,500 and gives up 1,500.
      await svc().applyStripeDispute(dispute('dp_sa_p11w', 'ch_sa_p11w', 2_450));
      for (const c of [w, t]) await spendInOrder(c.accountId, 2_000);
      // W spent the month's 1,500 and 500 of the top-up; T spent 2,000 of the month.
      expect(await balances(w.accountId)).toEqual({ spendable: 2_500, debt: 0, level: 1_500 });
      expect(await balances(t.accountId)).toEqual({ spendable: 4_000, debt: 0, level: 3_000 });
      await waitPast(boundary);
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      await svc().reinstateDispute(dispute('dp_sa_p11w', 'ch_sa_p11w', 2_450));
      await h().grants.refreshCredits(w.accountId);
      // The twin: month 2's 3,000 and the top-up's 3,000.
      expect(await balances(t.accountId)).toEqual({ spendable: 6_000, debt: 0, level: 3_000 });
      expect(await termsOf(t.accountId)).toEqual([
        { expires: await instant(monthAfter(boundary)), credits: 3_000 },
        { expires: await instant(topUpEnds), credits: 3_000 },
      ]);
      // W (policy v2): the 1,500 taken from month 1 (ended) comes back as a new
      // lot valid to the top-up's end (spent while the dispute stood): worked by
      // hand, 3,000 + 2,500 + 1,500 = 7,000. At most the 1,500 removed above.
      await expectBoundedByTwin(w.accountId, t.accountId, 1_500, 'P11');
    }, 60_000);

    it('CRITICAL a task holding credit across the month end does not cost the customer when the dispute is won after the month (P12)', async () => {
      const boundary = await boundaryIn(12);
      const w = await twoMonths('ch_sa_p12w', boundary);
      const t = await twoMonths('ch_sa_p12t', boundary);
      const running: Record<string, string> = {};
      for (const c of [w, t]) {
        await spendFromLot(db(), c.accountId, c.lotId, 400);
        running[c.accountId] = await holdOnLot(db(), c.accountId, c.lotId, 1_000);
      }
      await svc().applyStripeRefund(refund('ch_sa_p12w', 4_000));
      await svc().applyStripeRefund(refund('ch_sa_p12t', 4_000));
      await svc().applyStripeDispute(dispute('dp_sa_p12w', 'ch_sa_p12w', 900));
      // T: 900 still paid, so the month keeps floor(3,000 × 900 / 4,900) = 551;
      // 400 was spent, 1,000 is held: 1,600 free taken, 849 claimed from the task.
      expect(await balances(t.accountId)).toEqual({ spendable: 0, debt: 0, level: 551 });
      // W: nothing still paid; the 400 spent is owed.
      expect(await balances(w.accountId)).toEqual({ spendable: 0, debt: 400, level: 0 });
      await waitPast(boundary);
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      await svc().reinstateDispute(dispute('dp_sa_p12w', 'ch_sa_p12w', 900));
      for (const c of [w, t]) {
        await tasks().service.settle(running[c.accountId] as string, 'completed');
        await h().grants.refreshCredits(c.accountId);
      }
      // The task charged nothing: its 1,000 pays T's 849 claim and the rest
      // expires with month 1. W's 400 of debt was repaid from month 2's lot and
      // comes back into it (ruling a: that lot still runs). Both: month 2's 3,000.
      for (const c of [t, w]) {
        expect(await balances(c.accountId)).toEqual({ spendable: 3_000, debt: 0, level: 3_000 });
      }
    }, 60_000);

    it('CRITICAL a task that settles after half a year is refunded owes nothing the frozen annual cap forbids, as when it settled before (P13, ruling b)', async () => {
      const boundary = await boundaryIn(3_600);
      const x = await annualCustomer('ch_sa_p13x', boundary);
      const y = await annualCustomer('ch_sa_p13y', boundary);
      const inX = await holdOnLot(db(), x.accountId, await monthlyLot(x.accountId), 2_000);
      const inY = await holdOnLot(db(), y.accountId, await monthlyLot(y.accountId), 2_000);
      for (const [task, c] of [
        [inX, x],
        [inY, y],
      ] as const) {
        await settledCall(db(), {
          reservationId: task,
          accountId: c.accountId,
          chargedMicro: 1_800 * MICRO,
        });
      }
      // X: half the year refunded while the task runs. The month keeps 1,500;
      // spent so far (frozen now): nothing. 1,000 free is taken and 500 claimed
      // from the task's 2,000.
      await svc().applyStripeRefund(refund('ch_sa_p13x', ANNUAL / 2));
      expect(await balances(x.accountId)).toEqual({ spendable: 0, debt: 0, level: 1_500 });
      await tasks().service.settle(inX, 'completed');
      const settledX = await footprint(x.accountId);
      await h().grants.refreshCredits(x.accountId);
      expect(await footprint(x.accountId), 'a refresh after the settle writes nothing').toBe(
        settledX,
      );
      // Y: the task settles first (1,800 spent), then the same refund: the
      // month keeps 1,500, the year still pays for 18,000 ≥ 1,800 spent, so
      // nothing may be owed and the 1,200 free is taken.
      await tasks().service.settle(inY, 'completed');
      await svc().applyStripeRefund(refund('ch_sa_p13y', ANNUAL / 2));
      // X: the 1,800 charged pays 200 of the claim from the 200 the task
      // released; the frozen cap allowed no debt, so the other 300 is not owed.
      for (const c of [x, y]) {
        expect(await balances(c.accountId)).toEqual({ spendable: 0, debt: 0, level: 1_500 });
      }
    }, 60_000);
  },
);
