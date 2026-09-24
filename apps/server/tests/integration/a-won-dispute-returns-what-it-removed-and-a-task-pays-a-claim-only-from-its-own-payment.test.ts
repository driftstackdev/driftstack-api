// A won dispute returns what it removed, and a running task pays a reversal's
// claim only from its own payment's credit — the fifth independent audit's
// histories (a68862506), each landing where the reversal policy v2
// (design-reversal-policy-v2.md, 2026-09-24) says it does.
//
// Every expected amount below was worked out BY HAND from the policy's RULES
// (§1), not from the design's table of findings (§2) and not from the code.
// Where an arm has a twin, the twin's amount is asserted too. The rules each arm
// leans on:
//
//   1  A refund or dispute only takes: each month of the payment is brought
//      down to its worth — unspent credit first, then credit a running task
//      holds ON THAT MONTH as a claim, and only what was spent beyond the worth
//      as debt.
//   3  Annual: reversal debt ≤ what was spent and held when the reversal
//      arrived − the still-paid share of the year; what a running task spends
//      of credit an annual reversal claimed is NOT charged (the claim is dropped).
//   4  A reversal's claim is paid only from what tasks release back into that
//      payment's own lots; on a monthly payment an unpaid claim becomes debt.
//   6  A won dispute's claims are cancelled and its debt still owed forgiven;
//      everything else it removed — credit taken from lots, its debt other
//      credit paid, what its claims collected — comes back. As amended (R-A):
//      into the lot it came from ONLY while that lot is valid AND lasts at
//      least as long as every lot the customer used or held while the dispute
//      stood; otherwise as ONE NEW LOT, of the payment whose dispute was won
//      (R-D), valid until the latest of the end of the current month, the
//      expiry of the lots it came from, and the expiry of any lot used or held
//      while the dispute stood (one month from the win if none of those is in
//      the future). Credit the dispute TOOK from a lot whose validity ended
//      while it stood comes back only if some other lot was used or held
//      meanwhile (R-G). A returned lot is the payment's whose credit it
//      replaces (R-F). Then rule 1 is re-applied in both directions at the new
//      still-paid share. No replay of spending, settlements or holds.
//
// Every arm with a won dispute also checks invariant 3's dominance against its
// twin: W never holds less credit valid until any expiry instant or later.
//
// Amounts are credits. A starter month is 3,000 credits for 4,900 minor units;
// an annual starter invoice is 58,800 for twelve such months (36,000 credits).

import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import { CreditClawbacksService, floorToPriorMinute } from '../../src/services/credit-clawbacks.js';
import { debtOf, openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  grantsHarness,
  lotsOf,
  newAccountOn,
  paidLine,
  payingCustomer,
  subscription,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';
import { holdOnLot, mirrorMovedTo, spendFromLot } from './_helpers/credit-plan-change-fixtures.js';
import {
  reservationsHarness,
  settledCall,
  type ReservationsHarness,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_reversal_policy_v2';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const PAID = 4_900;
const ANNUAL = 58_800;

let client: postgres.Sql | null = null;
let harness: GrantsHarness | null = null;
let reservations: ReservationsHarness | null = null;
let service: CreditClawbacksService | null = null;

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
    sentry: { captureMessage: () => {} },
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

/** An SQL instant as `termsOf` spells it. */
async function instant(expression: string): Promise<string> {
  const [row] = await db().unsafe<Array<{ t: string }>>(
    `SELECT to_char((${expression}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`,
  );
  if (row === undefined) throw new Error('setup: no clock');
  return row.t;
}

/** When one lot expires, as `termsOf` spells it. */
async function expiryOf(lotId: string): Promise<string> {
  const [row] = await db()<Array<{ t: string }>>`
    SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t
      FROM credit_lots WHERE id = ${lotId}::uuid`;
  if (row === undefined) throw new Error('setup: no such lot');
  return row.t;
}

/** Invariant 3: W's credit valid until every expiry instant or later is at least the twin's. */
async function expectDominates(w: string, t: string): Promise<void> {
  const tw = await termsOf(w);
  const tt = await termsOf(t);
  for (const x of [...new Set([...tw, ...tt].map((term) => term.expires))].sort()) {
    const from = (terms: Term[]): number =>
      terms.filter((term) => term.expires >= x).reduce((sum, term) => sum + term.credits, 0);
    expect(from(tw), `credit valid until ${x} or later`).toBeGreaterThan(from(tt) - 1);
  }
}

// ── the clock ───────────────────────────────────────────────────────────────

/** An instant `seconds` ahead of the database's clock, whole seconds, as UTC text. */
async function instantIn(seconds: number): Promise<string> {
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
  for (let n = 0; n < 400; n += 1) {
    const [row] = await db()<Array<{ past: boolean }>>`SELECT now() > ${i}::timestamptz AS past`;
    if (row?.past === true) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the database clock never passed the instant');
}
/** A year from now to the whole second, read once for every account an arm compares. */
async function aYearFromNow(): Promise<string> {
  return instantIn(360 * 24 * 3600);
}

// ── the accounts ────────────────────────────────────────────────────────────

async function charge(invoiceId: string, chargeId: string): Promise<void> {
  await db()`UPDATE billing_invoice_payments SET stripe_charge_id = ${chargeId} WHERE stripe_invoice_id = ${invoiceId}`;
}
async function monthlyLot(accountId: string): Promise<string> {
  const lots = (await lotsOf(db(), accountId)).filter((l) => l.kind === 'monthly');
  const lot = lots[lots.length - 1];
  if (lot === undefined) throw new Error('setup: no monthly lot');
  return lot.id;
}
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
async function spendInOrder(accountId: string, amount: number): Promise<string> {
  let left = amount * MICRO;
  const lots = await db()<Array<{ id: string; free: string; kind: string }>>`
    SELECT id, kind, (remaining_micro - held_micro)::text AS free FROM credit_lots
     WHERE account_id = ${accountId}::uuid AND starts_at <= now() AND now() < expires_at
       AND revoked_at IS NULL AND remaining_micro > held_micro
     ORDER BY spend_rank, expires_at, created_at, id`;
  const from: string[] = [];
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(left, Number(lot.free));
    spends += 1;
    await spendFromLot(db(), accountId, lot.id, credits(take), 100_000 + spends);
    from.push(`${lot.kind}:${String(credits(take))}`);
    left = left - take;
  }
  if (left > 0) throw new Error('setup: less free credit than the arm spends');
  return from.join(',');
}

/** An api_starter customer on a paid month (five days in), granted. */
async function startedMonth(chargeId: string) {
  const c = await payingCustomer(db(), 'api_starter', { amountPaid: PAID });
  await charge(c.invoiceId, chargeId);
  await h().grants.refreshCredits(c.accountId);
  return { ...c, lotId: await monthlyLot(c.accountId) };
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

/**
 * An api_starter customer paying a YEAR (58,800) whose current month ends at
 * `boundary`: the year is anchored k months before it, k = 1 unless the
 * calendar cannot land on it from one month back (the 29th–31st), then 2.
 */
async function annualCustomer(chargeId: string, boundary: string) {
  const [row] = await db()<Array<{ k: number }>>`
    SELECT CASE WHEN ((${boundary}::timestamptz AT TIME ZONE 'UTC' - interval '1 month')
                      + interval '1 month') AT TIME ZONE 'UTC' = ${boundary}::timestamptz
                THEN 1 ELSE 2 END AS k`;
  const k = row?.k ?? 1;
  const anchor = `((${at(boundary)} AT TIME ZONE 'UTC' - interval '${String(k)} months') AT TIME ZONE 'UTC')`;
  const accountId = await newAccountOn(db(), 'api_starter');
  const subscriptionId = await subscription(db(), accountId, { tier: 'api_starter' });
  const invoiceId = await paidLine(db(), accountId, {
    subscriptionId,
    tier: 'api_starter',
    interval: 'year',
    start: anchor,
    end: `((${anchor} AT TIME ZONE 'UTC' + interval '12 months') AT TIME ZONE 'UTC')`,
    amountPaid: ANNUAL,
  });
  await charge(invoiceId, chargeId);
  await h().grants.refreshCredits(accountId);
  return { accountId, subscriptionId, invoiceId };
}

/** A bought top-up, funded and set against any debt in one transaction. Returns the lot. */
async function buyTopUp(
  accountId: string,
  amount: number,
  key: string,
  expires: string,
): Promise<string> {
  return h().ledger.transaction(async (tx) => {
    await h().ledger.lockAccount(tx, accountId);
    const inserted = await h().ledger.insertLot(
      {
        accountId,
        kind: 'top_up',
        grantKey: `topup:${key}`,
        grantedMicro: amount * MICRO,
        startsAt: floorToPriorMinute(new Date()),
        expiresAt: new Date(expires),
      },
      tx,
    );
    // A top-up's funding row is written by the purchase that owns it.
    await tx.execute(sql`
      INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key, actor)
      VALUES (${accountId}::uuid, 'top_up', ${inserted.lot.id}::uuid,
              ${String(amount * MICRO)}::bigint, ${`top_up:${inserted.lot.id}`}, 'customer')`);
    await h().ledger.settleDebtFromFree(tx, accountId);
    return inserted.lot.id;
  });
}

/** Goodwill granted by support, as the admin route writes it: a lot, its grant, debt settled. */
async function goodwill(
  accountId: string,
  amount: number,
  key: string,
  expires: string,
): Promise<string> {
  return h().ledger.transaction(async (tx) => {
    await h().ledger.lockAccount(tx, accountId);
    const inserted = await h().ledger.insertLot(
      {
        accountId,
        kind: 'adjustment',
        grantKey: `goodwill:${key}`,
        grantedMicro: amount * MICRO,
        startsAt: floorToPriorMinute(new Date()),
        expiresAt: new Date(expires),
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
    return inserted.lot.id;
  });
}

/**
 * A running task holding `amount` credits in the product's spend order: a real
 * reservation and one real hold per lot, in one transaction.
 */
async function holdInOrder(accountId: string, amount: number): Promise<string> {
  const lots = await db()<Array<{ id: string; free: string }>>`
    SELECT id, (remaining_micro - held_micro)::text AS free FROM credit_lots
     WHERE account_id = ${accountId}::uuid AND starts_at <= now() AND now() < expires_at
       AND revoked_at IS NULL AND remaining_micro > held_micro
     ORDER BY spend_rank, expires_at, created_at, id`;
  const { randomUUID } = await import('node:crypto');
  const task = randomUUID();
  let left = amount * MICRO;
  await db().begin(async (tx) => {
    await tx`
      INSERT INTO credit_reservations (id, account_id, agent_session_id, model, rate_card_version,
                                       mode, slot, reserved_micro, lease_owner, lease_expires_at, max_until)
      SELECT ${task}::uuid, ${accountId}::uuid, ${`as_${task}`}, 'claude-sonnet-5', 1, 'enforce',
             (SELECT s FROM generate_series(1, 3) s
               WHERE NOT EXISTS (SELECT 1 FROM credit_reservations o
                                  WHERE o.account_id = ${accountId}::uuid
                                    AND o.state = 'open' AND o.mode = 'enforce' AND o.slot = s)
               ORDER BY s LIMIT 1),
             ${String(amount * MICRO)}::bigint, 'fixture-boot',
             now() + interval '90 seconds', now() + interval '30 minutes'`;
    for (const lot of lots) {
      if (left <= 0) break;
      const take = Math.min(left, Number(lot.free));
      await tx`INSERT INTO credit_reservation_holds (reservation_id, lot_id, account_id, held_micro)
               VALUES (${task}::uuid, ${lot.id}::uuid, ${accountId}::uuid, ${String(take)}::bigint)`;
      left = left - take;
    }
  });
  if (left > 0) throw new Error('setup: less free credit than the task holds');
  return task;
}

function refund(chargeId: string, cumulativeRefundedMinor: number) {
  return { chargeId, stripeInvoiceId: null, cumulativeRefundedMinor };
}
function dispute(disputeId: string, chargeId: string, amountMinor = PAID) {
  return { disputeId, chargeId, stripeInvoiceId: null, amountMinor };
}

async function settleTask(accountId: string, task: string, charged: number): Promise<void> {
  if (charged > 0) {
    await settledCall(db(), { reservationId: task, accountId, chargedMicro: charged * MICRO });
  }
  await tasks().service.settle(task, 'completed');
}

// ── the arms ────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_DB_TESTS)(
  'a won dispute returns what it removed, and a task pays a claim only from its own payment',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL a refund measured while a dispute stood has its claim released by a win past the month, and nothing of the ended month comes back when no spending was displaced (P-R10, rules 1, 4, 6 with R-G)', async () => {
      const boundary = await instantIn(14);
      async function world(tag: string, disputed: boolean) {
        const c = await twoMonths(`ch_v2_r10_${tag}`, boundary);
        const task = await holdOnLot(db(), c.accountId, c.lotId, 1_000);
        if (disputed) {
          await svc().applyStripeDispute(dispute(`dp_v2_r10_${tag}`, `ch_v2_r10_${tag}`, 2_450));
        }
        await svc().applyStripeRefund(refund(`ch_v2_r10_${tag}`, 2_450));
        return { ...c, task };
      }
      const w = await world('w', true);
      const t = await world('t', false);
      // W: the dispute keeps 1,500 and takes 1,500 of the 2,000 free; the refund
      // (nothing still paid) takes the last 500 free and claims the task's 1,000.
      // T: the refund keeps 1,500 and takes 1,500 free, claiming nothing.
      expect(await balances(w.accountId)).toEqual({ spendable: 0, debt: 0, level: 0 });
      expect(await balances(t.accountId)).toEqual({ spendable: 500, debt: 0, level: 1_500 });
      await waitPast(boundary);
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      await svc().reinstateDispute(dispute('dp_v2_r10_w', 'ch_v2_r10_w', 2_450));
      // Rule 6 as amended (R-G): month 1 ended while the dispute stood and no
      // OTHER lot was used or held meanwhile (the task held month 1's own lot
      // from before the dispute), so the 1,500 it took is not returned — the
      // twin's unspent credit expired with the month too. Re-applied at 2,450
      // still paid: month 1 holds 1,000 held − the refund's 1,000 claim = 0,
      // below its worth of 1,500, so the claim is released first (rule 6);
      // the rest would go back into a month that has ended: nothing.
      await settleTask(w.accountId, w.task, 1_000);
      await settleTask(t.accountId, t.task, 1_000);
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      // W: the task spends the 1,000 it held; no claim is left, so nothing is
      // owed: month 2's 3,000 — the twin's amount exactly.
      // T: the task spent 1,000 of the 1,500 kept; month 2's 3,000.
      const monthTwoEnd = await instant(monthAfter(boundary));
      expect(await balances(t.accountId)).toEqual({ spendable: 3_000, debt: 0, level: 3_000 });
      expect(await balances(w.accountId)).toEqual({ spendable: 3_000, debt: 0, level: 3_000 });
      expect(await termsOf(w.accountId)).toEqual([{ expires: monthTwoEnd, credits: 3_000 }]);
      await expectDominates(w.accountId, t.accountId);
    }, 90_000);

    it('CRITICAL the same with a second, lost dispute in place of the refund (P-R10, two disputes)', async () => {
      const boundary = await instantIn(14);
      async function world(tag: string, disputed: boolean) {
        const c = await twoMonths(`ch_v2_r10d_${tag}`, boundary);
        const task = await holdOnLot(db(), c.accountId, c.lotId, 1_000);
        if (disputed) {
          await svc().applyStripeDispute(dispute(`dp_v2_r10d1_${tag}`, `ch_v2_r10d_${tag}`, 2_450));
        }
        await svc().applyStripeDispute(dispute(`dp_v2_r10d2_${tag}`, `ch_v2_r10d_${tag}`, 2_450));
        return { ...c, task };
      }
      const w = await world('w', true);
      const t = await world('t', false);
      await waitPast(boundary);
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      await svc().reinstateDispute(dispute('dp_v2_r10d1_w', 'ch_v2_r10d_w', 2_450));
      await settleTask(w.accountId, w.task, 1_000);
      await settleTask(t.accountId, t.task, 1_000);
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      expect(await balances(t.accountId)).toEqual({ spendable: 3_000, debt: 0, level: 3_000 });
      // As above (R-G): nothing of month 1 returns; the second dispute's claim
      // is released at the win; month 2's 3,000.
      expect(await balances(w.accountId)).toEqual({ spendable: 3_000, debt: 0, level: 3_000 });
      await expectDominates(w.accountId, t.accountId);
    }, 90_000);

    it('CRITICAL debt goodwill paid comes back when the goodwill has expired, valid as long as the top-up the customer spent meanwhile (P-A, rule 6)', async () => {
      const gwEnds = await instantIn(12);
      const yearEnd = await aYearFromNow();
      async function world(tag: string, disputed: boolean) {
        const c = await startedMonth(`ch_v2_a_${tag}`);
        await spendFromLot(db(), c.accountId, c.lotId, 3_000);
        if (disputed) await svc().applyStripeDispute(dispute(`dp_v2_a_${tag}`, `ch_v2_a_${tag}`));
        await goodwill(c.accountId, 3_000, `v2_a_${tag}`, gwEnds);
        const topUp = await buyTopUp(c.accountId, 3_000, `v2_a_${tag}`, yearEnd);
        const from = await spendInOrder(c.accountId, 1_000);
        return { ...c, topUp, from };
      }
      const w = await world('w', true);
      const t = await world('t', false);
      // W: the goodwill repaid the dispute's 3,000, so the 1,000 fell on the top-up.
      // T: the 1,000 fell on the goodwill (spent before a top-up).
      expect(w.from).toBe('top_up:1000');
      expect(t.from).toBe('adjustment:1000');
      await waitPast(gwEnds);
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      await svc().reinstateDispute(dispute('dp_v2_a_w', 'ch_v2_a_w'));
      await h().grants.refreshCredits(w.accountId);
      // T: the goodwill expired with 2,000; the top-up is whole.
      expect(await balances(t.accountId)).toEqual({ spendable: 3_000, debt: 0, level: 3_000 });
      // W: the 3,000 the goodwill paid comes back as one new lot (the goodwill
      // has expired), valid to the top-up's end — the latest lot the customer
      // used while the dispute stood. With the top-up's 2,000: 5,000, +2,000
      // over the twin, within the 3,000 the dispute removed (B2).
      expect(await balances(w.accountId)).toEqual({ spendable: 5_000, debt: 0, level: 3_000 });
      expect(await termsOf(w.accountId)).toEqual([
        { expires: await expiryOf(w.topUp), credits: 5_000 },
      ]);
      await expectDominates(w.accountId, t.accountId);
    }, 90_000);

    it('CRITICAL debt month 2 repaid comes back lasting as long as the top-up spent meanwhile, not into month 2 (P-A2, rule 6 as amended by R-A)', async () => {
      const boundary = await instantIn(10);
      async function world(tag: string, disputed: boolean) {
        const c = await twoMonths(`ch_v2_a2_${tag}`, boundary);
        await spendFromLot(db(), c.accountId, c.lotId, 3_000);
        if (disputed) await svc().applyStripeDispute(dispute(`dp_v2_a2_${tag}`, `ch_v2_a2_${tag}`));
        return c;
      }
      const w = await world('w', true);
      const t = await world('t', false);
      await waitPast(boundary);
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      // Month 2's lot repaid W's 3,000; then a top-up, bought with no debt left.
      const yearEnd = await aYearFromNow();
      await buyTopUp(w.accountId, 3_000, 'v2_a2_w', yearEnd);
      await buyTopUp(t.accountId, 3_000, 'v2_a2_t', yearEnd);
      expect(await spendInOrder(w.accountId, 1_000)).toBe('top_up:1000');
      expect(await spendInOrder(t.accountId, 1_000)).toBe('monthly:1000');
      await svc().reinstateDispute(dispute('dp_v2_a2_w', 'ch_v2_a2_w'));
      await h().grants.refreshCredits(w.accountId);
      // Month 2's lot paid the 3,000 but ends before the top-up the customer
      // used while the dispute stood (R-A), so the 3,000 comes back as a new
      // lot valid to the top-up's end: W holds it and the top-up's 2,000, all
      // to the top-up's end; T month 2's 2,000 and the top-up's 3,000.
      const monthTwoEnd = await instant(monthAfter(boundary));
      const topUpEnd = await instant(at(yearEnd));
      expect(await balances(t.accountId)).toEqual({ spendable: 5_000, debt: 0, level: 3_000 });
      expect(await termsOf(t.accountId)).toEqual([
        { expires: monthTwoEnd, credits: 2_000 },
        { expires: topUpEnd, credits: 3_000 },
      ]);
      expect(await balances(w.accountId)).toEqual({ spendable: 5_000, debt: 0, level: 3_000 });
      expect(await termsOf(w.accountId)).toEqual([{ expires: topUpEnd, credits: 5_000 }]);
      await expectDominates(w.accountId, t.accountId);
    }, 90_000);

    it('CRITICAL a claim the dispute collected in a month that has ended comes back as a new lot, and a top-up task never pays a reversal claim (P-B, rules 4, 6)', async () => {
      const boundary = await instantIn(14);
      const yearEnd = await aYearFromNow();
      async function world(tag: string, disputed: boolean) {
        const c = await twoMonths(`ch_v2_b_${tag}`, boundary);
        const topUp = await buyTopUp(c.accountId, 3_000, `v2_b_${tag}`, yearEnd);
        const t1 = await holdOnLot(db(), c.accountId, c.lotId, 3_000);
        const t2 = await holdOnLot(db(), c.accountId, topUp, 1_000);
        if (disputed)
          await svc().applyStripeDispute(dispute(`dp_v2_b_${tag}`, `ch_v2_b_${tag}`, 2_450));
        await svc().applyStripeRefund(refund(`ch_v2_b_${tag}`, 2_450));
        // Rule 4: the top-up task's release pays no claim of the invoice.
        await settleTask(c.accountId, t2, 0);
        return { ...c, t1, topUp };
      }
      const w = await world('w', true);
      const t = await world('t', false);
      // W: the dispute claims 1,500 and the refund 1,500 of the month's held 3,000;
      // T: the refund claims 1,500. Both: the top-up is whole again.
      expect(await balances(w.accountId)).toEqual({ spendable: 3_000, debt: 0, level: 0 });
      expect(await balances(t.accountId)).toEqual({ spendable: 3_000, debt: 0, level: 1_500 });
      await waitPast(boundary);
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      // Month 1 has ended: its task's release pays the claims, the rest expires.
      await settleTask(w.accountId, w.t1, 0);
      await settleTask(t.accountId, t.t1, 0);
      await svc().reinstateDispute(dispute('dp_v2_b_w', 'ch_v2_b_w', 2_450));
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      // W: the 1,500 the dispute's claim collected comes back as a new lot,
      // valid to the top-up's end (the top-up was held while the dispute stood).
      // Re-applied at 2,450 still paid: month 1 holds 1,500 = its worth.
      const monthTwoEnd = await instant(monthAfter(boundary));
      expect(await balances(t.accountId)).toEqual({ spendable: 6_000, debt: 0, level: 3_000 });
      expect(await termsOf(t.accountId)).toEqual([
        { expires: monthTwoEnd, credits: 3_000 },
        { expires: await expiryOf(t.topUp), credits: 3_000 },
      ]);
      expect(await balances(w.accountId)).toEqual({ spendable: 7_500, debt: 0, level: 3_000 });
      expect(await termsOf(w.accountId)).toEqual([
        { expires: monthTwoEnd, credits: 3_000 },
        { expires: await expiryOf(w.topUp), credits: 4_500 },
      ]);
      await expectDominates(w.accountId, t.accountId);
    }, 90_000);

    it('CRITICAL credit a dispute took from the month comes back lasting as long as the top-up the spending fell on (P-C, rule 6 as amended by R-A)', async () => {
      const gwEnds = await instantIn(10);
      const yearEnd = await aYearFromNow();
      async function world(tag: string, disputed: boolean) {
        const c = await startedMonth(`ch_v2_c_${tag}`);
        await goodwill(c.accountId, 1_000, `v2_c_${tag}`, gwEnds);
        await buyTopUp(c.accountId, 3_000, `v2_c_${tag}`, yearEnd);
        if (disputed)
          await svc().applyStripeDispute(dispute(`dp_v2_c_${tag}`, `ch_v2_c_${tag}`, 2_450));
        return c;
      }
      const w = await world('w', true);
      const t = await world('t', false);
      expect(await spendInOrder(w.accountId, 2_000)).toBe('monthly:1500,adjustment:500');
      expect(await spendInOrder(t.accountId, 2_000)).toBe('monthly:2000');
      await waitPast(gwEnds);
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      expect(await spendInOrder(w.accountId, 1_500)).toBe('top_up:1500');
      expect(await spendInOrder(t.accountId, 1_500)).toBe('monthly:1000,top_up:500');
      await svc().reinstateDispute(dispute('dp_v2_c_w', 'ch_v2_c_w', 2_450));
      await h().grants.refreshCredits(w.accountId);
      // W: the month ends before the top-up used while the dispute stood (R-A),
      // so the 1,500 taken comes back as a new lot valid to the top-up's end:
      // with the top-up's 1,500, 3,000 — +500 over the twin's top-up 2,500 (the
      // goodwill T never touched expired whole), within the 1,500 removed.
      const topUpEnd = await instant(at(yearEnd));
      expect(await balances(t.accountId)).toEqual({ spendable: 2_500, debt: 0, level: 3_000 });
      expect(await termsOf(t.accountId)).toEqual([{ expires: topUpEnd, credits: 2_500 }]);
      expect(await balances(w.accountId)).toEqual({ spendable: 3_000, debt: 0, level: 3_000 });
      expect(await termsOf(w.accountId)).toEqual([{ expires: topUpEnd, credits: 3_000 }]);
      await expectDominates(w.accountId, t.accountId);
    }, 90_000);

    it('CRITICAL a win returns the dispute debt month 2 repaid, and the month it took, lasting as long as the top-up, but not a downgrade’s debt (P-E, rule 6 as amended by R-A)', async () => {
      const boundary = await instantIn(10);
      async function world(tag: string, disputed: boolean) {
        const c = await twoMonths(`ch_v2_e_${tag}`, boundary);
        await spendFromLot(db(), c.accountId, c.lotId, 2_000);
        if (disputed)
          await svc().applyStripeDispute(dispute(`dp_v2_e_${tag}`, `ch_v2_e_${tag}`, 3_675));
        return c;
      }
      const w = await world('w', true);
      const t = await world('t', false);
      await waitPast(boundary);
      for (const c of [w, t]) await h().grants.refreshCredits(c.accountId);
      for (const c of [w, t]) {
        await spendFromLot(db(), c.accountId, await currentMonthlyLot(c.accountId), 1_450, 5);
      }
      const yearEnd = await aYearFromNow();
      for (const c of [w, t]) await buyTopUp(c.accountId, 1_000, `v2_e_${c.accountId}`, yearEnd);
      for (const c of [w, t]) {
        await mirrorMovedTo(db(), c.subscriptionId, 'solo_manual', at(boundary));
        await h().grants.refreshCredits(c.accountId);
      }
      const gwEnds = await instantIn(40 * 24 * 3600);
      for (const c of [w, t]) await goodwill(c.accountId, 1_000, `v2_e_${c.accountId}`, gwEnds);
      await svc().reinstateDispute(dispute('dp_v2_e_w', 'ch_v2_e_w', 3_675));
      await h().grants.refreshCredits(w.accountId);
      // T: month 2 3,000 − 1,450 − the downgrade's 1,500 = 50; top-up 1,000; goodwill 1,000.
      const monthTwoEnd = await instant(monthAfter(boundary));
      const topUpEnd = await instant(at(yearEnd));
      const goodwillEnd = await instant(at(gwEnds));
      expect(await balances(t.accountId)).toEqual({ spendable: 2_050, debt: 0, level: 1_500 });
      expect(await termsOf(t.accountId)).toEqual([
        { expires: monthTwoEnd, credits: 50 },
        { expires: goodwillEnd, credits: 1_000 },
        { expires: topUpEnd, credits: 1_000 },
      ]);
      // W: the dispute kept 750 of month 1 and took its 1,000 free and 1,250 of
      // debt, which month 2 repaid. The downgrade then found 300 free: 1,200
      // debt, repaid by the top-up (1,000) and the goodwill (200) — not the
      // dispute's, so not returned. While the dispute stood the customer used
      // month 2, the top-up and the goodwill; the top-up lasts longest (R-A).
      // So the 1,250 month 2 paid AND month 1's 1,000 come back as one new lot
      // valid to the top-up's end: 0 + 0 + 800 + 2,250 = 3,050, +1,000 over the
      // twin, within the 2,250 removed.
      expect(await balances(w.accountId)).toEqual({ spendable: 3_050, debt: 0, level: 1_500 });
      expect(await termsOf(w.accountId)).toEqual([
        { expires: goodwillEnd, credits: 800 },
        { expires: topUpEnd, credits: 2_250 },
      ]);
      await expectDominates(w.accountId, t.accountId);
    }, 90_000);

    it('CRITICAL the month a dispute took, when a task held a top-up across the month end, comes back lasting as long as the top-up (P-H, rules 4, 6)', async () => {
      const boundary = await instantIn(14);
      const yearEnd = await aYearFromNow();
      async function world(tag: string, disputed: boolean) {
        const c = await twoMonths(`ch_v2_h_${tag}`, boundary);
        const topUp = await buyTopUp(c.accountId, 3_000, `v2_h_${tag}`, yearEnd);
        if (disputed)
          await svc().applyStripeDispute(dispute(`dp_v2_h_${tag}`, `ch_v2_h_${tag}`, 1_225));
        // A task holds 3,000 in the spend order: W the month's 2,250 and 750 of
        // the top-up; T the month's 3,000.
        const task = await holdInOrder(c.accountId, 3_000);
        await svc().applyStripeRefund(refund(`ch_v2_h_${tag}`, 1_225));
        return { ...c, task, topUp };
      }
      const w = await world('w', true);
      const t = await world('t', false);
      await waitPast(boundary);
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      await svc().reinstateDispute(dispute('dp_v2_h_w', 'ch_v2_h_w', 1_225));
      await settleTask(w.accountId, w.task, 0);
      await settleTask(t.accountId, t.task, 0);
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      // Both: the refund claimed 750 of the month's held credit, paid when the
      // task released it (month 1's lot); the rest expired; the top-up is whole.
      // W: the 750 the dispute took from month 1 (ended) comes back as a new lot
      // valid to the top-up's end (the task held the top-up while it stood):
      // +750, within what it removed.
      const monthTwoEnd = await instant(monthAfter(boundary));
      expect(await balances(t.accountId)).toEqual({ spendable: 6_000, debt: 0, level: 3_000 });
      expect(await balances(w.accountId)).toEqual({ spendable: 6_750, debt: 0, level: 3_000 });
      expect(await termsOf(w.accountId)).toEqual([
        { expires: monthTwoEnd, credits: 3_000 },
        { expires: await expiryOf(w.topUp), credits: 3_750 },
      ]);
      await expectDominates(w.accountId, t.accountId);
    }, 90_000);

    it('CRITICAL an annual claim a task then spends is dropped, not charged: month 1’s own shortfall is the only debt (P-R8a, rules 1, 3)', async () => {
      const boundary = await instantIn(10);
      const x = await annualCustomer('ch_v2_r8a_x', boundary);
      const y = await annualCustomer('ch_v2_r8a_y', boundary);
      for (const c of [x, y])
        await spendFromLot(db(), c.accountId, await monthlyLot(c.accountId), 3_000);
      await waitPast(boundary);
      await h().grants.refreshCredits(x.accountId);
      await h().grants.refreshCredits(y.accountId);
      const task = await holdOnLot(db(), x.accountId, await currentMonthlyLot(x.accountId), 3_000);
      // X: refunded to 1,000 still paid while the task holds all of month 2.
      await svc().applyStripeRefund(refund('ch_v2_r8a_x', ANNUAL - 1_000));
      await settleTask(x.accountId, task, 3_000);
      await h().grants.refreshCredits(x.accountId);
      // Y: the same 3,000 spent first, then the refund.
      await spendFromLot(db(), y.accountId, await currentMonthlyLot(y.accountId), 3_000, 7);
      await svc().applyStripeRefund(refund('ch_v2_r8a_y', ANNUAL - 1_000));
      // Each month keeps floor(3,000 × 1,000 / 58,800) = 51; the year still pays
      // for floor(36,000 × 1,000 / 58,800) = 612.
      // Y: 6,000 spent, cap 6,000 − 612 = 5,388 of debt (month 2 2,949, month 1 2,439).
      expect(await balances(y.accountId)).toEqual({ spendable: 0, debt: 5_388, level: 51 });
      // X: frozen at the refund: 3,000 spent + 3,000 held; the cap (5,388) lets
      // month 1 owe its 2,949 shortfall. Month 2 has nothing spent: its 2,949
      // is a claim on its own held credit (month 1 holds none, so its
      // shortfall is debt, rule 1). The task spends all it held: the annual
      // claim is dropped (rule 3, B1). Debt 2,949.
      expect(await balances(x.accountId)).toEqual({ spendable: 0, debt: 2_949, level: 51 });
    }, 90_000);

    it('CRITICAL a claim on the month is paid only from the month’s own release, never from a top-up task’s (P-R8b, rule 4)', async () => {
      const boundary = await instantIn(3_600);
      const yearEnd = await aYearFromNow();
      const x = await annualCustomer('ch_v2_r8b_x', boundary);
      const y = await annualCustomer('ch_v2_r8b_y', boundary);
      const run: Record<string, { t1: string; t2: string }> = {};
      for (const c of [x, y]) {
        const topUp = await buyTopUp(c.accountId, 1_000, `v2_r8b_${c.accountId}`, yearEnd);
        run[c.accountId] = {
          t1: await holdOnLot(db(), c.accountId, await monthlyLot(c.accountId), 2_000),
          t2: await holdOnLot(db(), c.accountId, topUp, 1_000),
        };
      }
      const rx = run[x.accountId] as { t1: string; t2: string };
      const ry = run[y.accountId] as { t1: string; t2: string };
      // X: half refunded while both tasks hold: keep 1,500, 1,000 free taken, 500
      // claimed from the month's held 2,000. The top-up task settles first:
      // its release pays nothing (rule 4). The month task spends 1,800 and
      // releases 200, which pays 200 of the claim; the other 300 is dropped (rule 3).
      await svc().applyStripeRefund(refund('ch_v2_r8b_x', ANNUAL / 2));
      await settleTask(x.accountId, rx.t2, 0);
      await settleTask(x.accountId, rx.t1, 1_800);
      await h().grants.refreshCredits(x.accountId);
      // Y: the month task settles first (1,800 spent), then the same refund: the
      // month keeps what was spent (the year still pays for 18,000 ≥ 1,800).
      await settleTask(y.accountId, ry.t1, 1_800);
      await svc().applyStripeRefund(refund('ch_v2_r8b_y', ANNUAL / 2));
      await settleTask(y.accountId, ry.t2, 0);
      for (const c of [x, y]) {
        // The top-up's 1,000 is untouched.
        expect(await balances(c.accountId)).toEqual({ spendable: 1_000, debt: 0, level: 1_500 });
      }
    }, 90_000);

    it('CRITICAL a refund measured while a dispute stood keeps its larger claim after the win, and an annual claim left unpaid is dropped: debt 0 (P-R8c, rules 3, 6)', async () => {
      const boundary = await instantIn(3_600);
      const w = await annualCustomer('ch_v2_r8c_w', boundary);
      const t = await annualCustomer('ch_v2_r8c_t', boundary);
      const tw = await holdOnLot(db(), w.accountId, await monthlyLot(w.accountId), 2_000);
      const tt = await holdOnLot(db(), t.accountId, await monthlyLot(t.accountId), 2_000);
      // W: the dispute of half keeps 1,500: 1,000 free taken, 500 claimed. The
      // refund of half (nothing still paid) claims the other 1,500 of the held 2,000.
      await svc().applyStripeDispute(dispute('dp_v2_r8c_w', 'ch_v2_r8c_w', ANNUAL / 2));
      await svc().applyStripeRefund(refund('ch_v2_r8c_w', ANNUAL / 2));
      // T: the refund alone keeps 1,500: 1,000 free taken, 500 claimed.
      await svc().applyStripeRefund(refund('ch_v2_r8c_t', ANNUAL / 2));
      // The win (the month still runs): its 500 claim is cancelled and its 1,000
      // goes back into the month. Re-applied at 29,400 still paid: the month
      // holds 1,000 free + 2,000 held − the refund's 1,500 claim = 1,500, its
      // worth — nothing moves.
      await svc().reinstateDispute(dispute('dp_v2_r8c_w', 'ch_v2_r8c_w', ANNUAL / 2));
      await settleTask(w.accountId, tw, 1_800);
      await settleTask(t.accountId, tt, 1_800);
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      // The task spends 1,800 and releases 200, paying 200 of each claim; the
      // rest is dropped (annual, rule 3). T: 0 left. W: the 1,000 returned stays
      // — +1,000 over the twin, within B1 (credit tasks held at the reversal).
      expect(await balances(t.accountId)).toEqual({ spendable: 0, debt: 0, level: 1_500 });
      expect(await balances(w.accountId)).toEqual({ spendable: 1_000, debt: 0, level: 1_500 });
      await expectDominates(w.accountId, t.accountId);
    }, 90_000);
  },
);
