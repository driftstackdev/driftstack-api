// Any order of spends, running tasks, refunds, one dispute and replays over
// ONE invoice and ONE month ends exactly where the payment says: a seeded
// property test, kept from the re-audit of the S17 rework, whose random
// sequences found the whole-credit failure of a won dispute (#1) and whose
// positive control — refunds landing while a dispute stood — found #3.
//
// The month: an api_starter invoice of 4,900 minor units, its 3,000-credit
// month granted before anything happens. Each seed draws a sequence of:
//
//   · spends of quarter credits (a task that charged exactly that);
//   · tasks that HOLD credit while other events land, then settle having
//     charged part of what they held (at most two at once);
//   · up to three refunds, each a cumulative `amount_refunded`, delivered in
//     ANY order — a smaller cumulative after a larger one is a late delivery;
//   · at most one dispute, whose `created` may land before or after any
//     refund, and which is then won (both win events, `closed` and
//     `funds_reinstated`), lost, or left standing; now and then the win is
//     delivered before the dispute's own `created`;
//   · replays: any reversal event already delivered, delivered again;
//   · refreshes.
//
// What every sequence must hold, checked after every step:
//
//   · every refresh writes NOTHING — no lot, no ledger row, no clawback, no
//     level change, no window;
//   · every replay changes NOTHING — the same, and the balances and the
//     payment row too;
//   · at rest (no task running): with s = 4,900 − refunded − (the disputed
//     amount while the dispute stands), never below 0, and E = the month's
//     3,000 credits × s / 4,900 rounded DOWN to whole credits:
//       debt       = max(0, spent − E)
//       spendable  = max(0, E − spent)
//       level      = E
//     to the microcredit.
//
// Fixed seeds, so a failure is reproducible by its seed; the arm names it.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import { CreditClawbacksService } from '../../src/services/credit-clawbacks.js';
import { debtOf, openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  grantsHarness,
  lotsOf,
  payingCustomer,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';
import { holdOnLot, spendFromLot } from './_helpers/credit-plan-change-fixtures.js';
import {
  reservationsHarness,
  settledCall,
  type ReservationsHarness,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s17_round2_prop';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const PAID = 4900;
const MONTH_MICRO = 3_000 * MICRO;
/** Seeds 1 … SEEDS. Fixed: a failing arm names its seed. */
const SEEDS = 400;
const QUARTER = MICRO / 4;

let client: postgres.Sql | null = null;
let harness: GrantsHarness | null = null;
let reservations: ReservationsHarness | null = null;
let service: CreditClawbacksService | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 6);
  if (opened === null) return;
  client = opened.sql;
  harness = grantsHarness(opened.url, { max: 3 });
  reservations = reservationsHarness(opened.url, { max: 2 });
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
function rh(): ReservationsHarness {
  if (reservations === null) throw new Error('isolated database unreachable');
  return reservations;
}
function svc(): CreditClawbacksService {
  if (service === null) throw new Error('isolated database unreachable');
  return service;
}

/** mulberry32: a small seeded generator, so every sequence is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Delivery =
  | { readonly kind: 'refund'; readonly cumulative: number }
  | { readonly kind: 'created'; readonly amount: number }
  | {
      readonly kind: 'won';
      readonly amount: number;
      readonly event: 'closed' | 'funds_reinstated';
    };

type Step =
  | Delivery
  | { readonly kind: 'spend' }
  | { readonly kind: 'hold'; readonly task: number }
  | { readonly kind: 'settle'; readonly task: number }
  | { readonly kind: 'refresh' }
  | { readonly kind: 'replay' };

interface Plan {
  readonly steps: readonly Step[];
  readonly disputeAmount: number | null;
  readonly outcome: 'won' | 'lost' | 'standing' | null;
}

function planFor(seed: number): Plan {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const pool = [490, 1225, 2450, 3675, 4900, 1 + Math.floor(r() * PAID)];
  const refunds = [...new Set(Array.from({ length: Math.floor(r() * 4) }, () => pick(pool)))];
  const hasDispute = r() < 0.75;
  const disputeAmount = hasDispute ? pick([1000, 2450, 4900, 1 + Math.floor(r() * PAID)]) : null;
  const roll = r();
  const outcome = !hasDispute ? null : roll < 0.45 ? 'won' : roll < 0.8 ? 'lost' : 'standing';

  // The core: refunds in a random order, the dispute's created somewhere among
  // them, and its win after it (or, now and then, before it).
  const core: Step[] = refunds.map((cumulative) => ({ kind: 'refund', cumulative }));
  for (let i = core.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [core[i], core[j]] = [core[j] as Step, core[i] as Step];
  }
  if (disputeAmount !== null) {
    const created: Step = { kind: 'created', amount: disputeAmount };
    const at = Math.floor(r() * (core.length + 1));
    core.splice(at, 0, created);
    if (outcome === 'won') {
      const wins: Step[] = [
        { kind: 'won', amount: disputeAmount, event: 'closed' },
        { kind: 'won', amount: disputeAmount, event: 'funds_reinstated' },
      ];
      if (r() < 0.15) core.splice(at, 0, ...wins);
      else {
        const after = at + 1 + Math.floor(r() * (core.length - at));
        core.splice(after, 0, ...wins);
      }
    }
  }
  // Spends, tasks, refreshes and replays woven in.
  const steps: Step[] = [];
  let tasks = 0;
  const open: number[] = [];
  const extra = (): void => {
    const x = r();
    if (x < 0.25) steps.push({ kind: 'spend' });
    else if (x < 0.4 && open.length < 2 && tasks < 3) {
      open.push(tasks);
      steps.push({ kind: 'hold', task: tasks });
      tasks += 1;
    } else if (x < 0.55 && open.length > 0) {
      const task = open.splice(Math.floor(r() * open.length), 1)[0] as number;
      steps.push({ kind: 'settle', task });
    } else if (x < 0.7) steps.push({ kind: 'refresh' });
    else if (x < 0.85) steps.push({ kind: 'replay' });
  };
  extra();
  extra();
  for (const step of core) {
    steps.push(step);
    extra();
    extra();
  }
  for (const task of open) steps.push({ kind: 'settle', task });
  steps.push({ kind: 'refresh' });
  steps.push({ kind: 'replay' });
  return { steps, disputeAmount, outcome };
}

interface Model {
  refunded: number;
  disputeApplied: boolean;
  disputeWon: boolean;
  spentMicro: number;
  delivered: Delivery[];
  tasks: Map<number, { reservationId: string; heldMicro: number }>;
  refundDuringDispute: boolean;
}

function stillPaid(m: Model, disputeAmount: number | null): number {
  const standing = m.disputeApplied && !m.disputeWon ? (disputeAmount ?? 0) : 0;
  return Math.max(0, PAID - m.refunded - standing);
}

/** E: the month rounded down to whole credits at what is still paid. */
function keepMicro(still: number): number {
  const scaled = (BigInt(MONTH_MICRO) * BigInt(still)) / BigInt(PAID);
  return Number((scaled / 1_000_000n) * 1_000_000n);
}

async function snapshot(accountId: string, invoiceId: string, windowId: string) {
  const [row] = await db()<Array<Record<string, string>>>`
    SELECT (SELECT count(*)::text FROM credit_lots WHERE account_id = ${accountId}::uuid) AS lots,
           (SELECT count(*)::text FROM credit_ledger WHERE account_id = ${accountId}::uuid) AS ledger,
           (SELECT count(*)::text FROM credit_clawbacks WHERE account_id = ${accountId}::uuid) AS clawbacks,
           (SELECT count(*)::text FROM credit_window_level_changes WHERE window_id = ${windowId}::uuid) AS steps,
           (SELECT count(*)::text FROM credit_windows WHERE account_id = ${accountId}::uuid) AS windows,
           (SELECT level_micro::text FROM credit_windows WHERE id = ${windowId}::uuid) AS level,
           (SELECT debt_micro::text FROM credit_accounts WHERE account_id = ${accountId}::uuid) AS debt,
           (SELECT refunded_minor::text || '/' || disputed_minor::text
              FROM billing_invoice_payments WHERE stripe_invoice_id = ${invoiceId}) AS payment`;
  return { ...row, spendable: String(await h().ledger.spendableMicro(accountId)) };
}

/** The lot with the most free credit, and how much. */
async function freestLot(accountId: string): Promise<{ id: string; freeMicro: number } | null> {
  const [row] = await db()<Array<{ id: string; free: string }>>`
    SELECT id, (remaining_micro - held_micro)::text AS free FROM credit_lots
     WHERE account_id = ${accountId}::uuid AND starts_at <= now() AND now() < expires_at
       AND revoked_at IS NULL AND remaining_micro > held_micro
     ORDER BY remaining_micro - held_micro DESC, id
     LIMIT 1`;
  return row === undefined ? null : { id: row.id, freeMicro: Number(row.free) };
}

async function deliver(chargeId: string, disputeId: string, d: Delivery): Promise<void> {
  if (d.kind === 'refund') {
    await svc().applyStripeRefund({
      chargeId,
      stripeInvoiceId: null,
      cumulativeRefundedMinor: d.cumulative,
    });
  } else if (d.kind === 'created') {
    await svc().applyStripeDispute({
      disputeId,
      chargeId,
      stripeInvoiceId: null,
      amountMinor: d.amount,
    });
  } else {
    await svc().reinstateDispute({
      disputeId,
      chargeId,
      stripeInvoiceId: null,
      amountMinor: d.amount,
    });
  }
}

/** Runs one seed's sequence; returns whether a refund landed while its dispute stood. */
async function runSeed(seed: number): Promise<boolean> {
  const plan = planFor(seed);
  const r = rng(seed * 7919 + 1);
  const chargeId = `ch_prop_${String(seed)}`;
  const disputeId = `dp_prop_${String(seed)}`;
  const customer = await payingCustomer(db(), 'api_starter', { amountPaid: PAID });
  await db()`UPDATE billing_invoice_payments SET stripe_charge_id = ${chargeId} WHERE stripe_invoice_id = ${customer.invoiceId}`;
  const first = await h().grants.refreshCredits(customer.accountId);
  if (first.window.outcome !== 'created') throw new Error('setup: no month');
  const windowId = first.window.windowId;
  const accountId = customer.accountId;
  const m: Model = {
    refunded: 0,
    disputeApplied: false,
    disputeWon: false,
    spentMicro: 0,
    delivered: [],
    tasks: new Map(),
    refundDuringDispute: false,
  };
  const log: string[] = [];
  let nth = 0;

  const atRest = async (after: string): Promise<void> => {
    if (m.tasks.size > 0) return;
    const keep = keepMicro(stillPaid(m, plan.disputeAmount));
    const net = keep - m.spentMicro;
    const where = `seed ${String(seed)} after ${after}\n${log.join('\n')}`;
    expect(await debtOf(db(), accountId), `debt — ${where}`).toBe(Math.max(0, -net));
    expect(await h().ledger.spendableMicro(accountId), `spendable — ${where}`).toBe(
      Math.max(0, net),
    );
    const [w] = await db()<Array<{ level: string }>>`
      SELECT level_micro::text AS level FROM credit_windows WHERE id = ${windowId}::uuid`;
    expect(Number(w?.level), `level — ${where}`).toBe(keep);
  };

  for (const step of plan.steps) {
    switch (step.kind) {
      case 'refund':
      case 'created':
      case 'won': {
        if (step.kind === 'refund' && m.disputeApplied && !m.disputeWon)
          m.refundDuringDispute = true;
        await deliver(chargeId, disputeId, step);
        m.delivered.push(step);
        if (step.kind === 'refund') m.refunded = Math.max(m.refunded, step.cumulative);
        if (step.kind === 'created' && !m.disputeWon) m.disputeApplied = true;
        if (step.kind === 'won') m.disputeWon = true;
        log.push(
          step.kind === 'refund'
            ? `refund ${String(step.cumulative)}`
            : step.kind === 'created'
              ? `dispute ${String(step.amount)}`
              : `win (${step.event})`,
        );
        break;
      }
      case 'spend': {
        const lot = await freestLot(accountId);
        if (lot === null || lot.freeMicro < QUARTER) break;
        const quarters = 1 + Math.floor(r() * Math.floor(lot.freeMicro / QUARTER));
        nth += 1;
        await spendFromLot(db(), accountId, lot.id, (quarters * QUARTER) / MICRO, nth);
        m.spentMicro = m.spentMicro + quarters * QUARTER;
        log.push(`spend ${String((quarters * QUARTER) / MICRO)}`);
        break;
      }
      case 'hold': {
        const lot = await freestLot(accountId);
        if (lot === null || lot.freeMicro < MICRO) break;
        const credits = 1 + Math.floor(r() * Math.floor(lot.freeMicro / MICRO));
        const reservationId = await holdOnLot(db(), accountId, lot.id, credits);
        m.tasks.set(step.task, { reservationId, heldMicro: credits * MICRO });
        log.push(`task ${String(step.task)} holds ${String(credits)}`);
        break;
      }
      case 'settle': {
        const task = m.tasks.get(step.task);
        if (task === undefined) break;
        const charged = Math.floor(r() * (task.heldMicro / QUARTER + 1)) * QUARTER;
        if (charged > 0) {
          await settledCall(db(), {
            reservationId: task.reservationId,
            accountId,
            chargedMicro: charged,
          });
        }
        await rh().service.settle(task.reservationId, 'completed');
        m.tasks.delete(step.task);
        m.spentMicro = m.spentMicro + charged;
        log.push(`task ${String(step.task)} settles charging ${String(charged / MICRO)}`);
        break;
      }
      case 'refresh': {
        const before = await snapshot(accountId, customer.invoiceId, windowId);
        const refreshed = await h().grants.refreshCredits(accountId);
        expect(refreshed.level, `seed ${String(seed)}: a refresh moved the level`).toBeNull();
        expect(
          await snapshot(accountId, customer.invoiceId, windowId),
          `seed ${String(seed)}: a refresh wrote something\n${log.join('\n')}`,
        ).toEqual(before);
        log.push('refresh');
        break;
      }
      case 'replay': {
        if (m.delivered.length === 0) break;
        const again = m.delivered[Math.floor(r() * m.delivered.length)] as Delivery;
        const before = await snapshot(accountId, customer.invoiceId, windowId);
        await deliver(chargeId, disputeId, again);
        expect(
          await snapshot(accountId, customer.invoiceId, windowId),
          `seed ${String(seed)}: a replay of ${again.kind} changed something\n${log.join('\n')}`,
        ).toEqual(before);
        log.push(`replay ${again.kind}`);
        break;
      }
    }
    await atRest(log[log.length - 1] ?? step.kind);
  }
  expect(m.tasks.size, `seed ${String(seed)}: a task was left running`).toBe(0);
  await atRest('the end');
  return m.refundDuringDispute;
}

describe.skipIf(!RUN_DB_TESTS)(
  'any order of spends, refunds, a dispute and replays ends where the payment says',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL the re-audit’s positive control PASSES: a full dispute, a half refund delivered while it stands, then the win, leaves half the month (re-audit #3)', async () => {
      const customer = await payingCustomer(db(), 'api_starter', { amountPaid: PAID });
      await db()`UPDATE billing_invoice_payments SET stripe_charge_id = 'ch_prop_ctl' WHERE stripe_invoice_id = ${customer.invoiceId}`;
      await h().grants.refreshCredits(customer.accountId);
      const lot = (await lotsOf(db(), customer.accountId)).find((l) => l.kind === 'monthly');
      if (lot === undefined) throw new Error('setup');
      await spendFromLot(db(), customer.accountId, lot.id, 700.25);
      await deliver('ch_prop_ctl', 'dp_prop_ctl', { kind: 'created', amount: PAID });
      await deliver('ch_prop_ctl', 'dp_prop_ctl', { kind: 'refund', cumulative: PAID / 2 });
      await deliver('ch_prop_ctl', 'dp_prop_ctl', { kind: 'won', amount: PAID, event: 'closed' });
      await deliver('ch_prop_ctl', 'dp_prop_ctl', {
        kind: 'won',
        amount: PAID,
        event: 'funds_reinstated',
      });
      expect(await debtOf(db(), customer.accountId)).toBe(0);
      expect(await h().ledger.spendableMicro(customer.accountId)).toBe(
        keepMicro(PAID / 2) - 700.25 * MICRO,
      );
    });

    it(`CRITICAL ${String(SEEDS)} seeded sequences: every refresh writes nothing, every replay changes nothing, and at rest debt, spendable credit and level are the closed form`, async () => {
      const started = Date.now();
      let refundsDuringADispute = 0;
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        if (await runSeed(seed)) refundsDuringADispute += 1;
      }
      // The sequences reach the case the re-audit's positive control found:
      // a refund delivered while the dispute stood.
      expect(refundsDuringADispute).toBeGreaterThanOrEqual(40);
      expect(Date.now() - started, 'the property run exceeded its time bound').toBeLessThan(60_000);
    }, 90_000);
  },
);
