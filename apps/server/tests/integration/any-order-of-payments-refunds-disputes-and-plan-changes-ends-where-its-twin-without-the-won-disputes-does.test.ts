// Any order of payments, refunds, disputes and plan changes over TWO MONTHS ends
// where its twin without the won disputes ends. A seeded differential property
// test written by the second independent audit of the S17 refund and chargeback
// rework (a48fb9b47), with the audit's fixed-order arms beside it.
//
// ⛔ IT FAILS ON THE CODE IT WAS WRITTEN AGAINST, ON PURPOSE. Every arm and every
// configuration below states what the bar requires; the audit report lists the
// defect each one reproduces. A builder makes it pass by fixing the code, never
// by skipping an arm or loosening an expectation.
//
// THE PROPERTY. Each seed runs two accounts through the same sequence, in
// lockstep, across a REAL month boundary a few seconds ahead of the database's
// clock (every coverage, window and expiry is judged on that clock):
//
//   W  the whole sequence: spends, refunds as cumulative amounts in any order,
//      disputes created then won (both win events, `closed` and
//      `funds_reinstated`) or lost, a mid-month upgrade or downgrade,
//      resubscriptions, replays and refreshes;
//   T  the same sequence with every dispute that is eventually WON removed.
//
// A won dispute must restore exactly what it took (M6), so W and T end in the
// same place: the same spendable credit, the same debt and the same level. Spends
// are coupled — the same amount in both, never more than either can spend, taken
// in the product's spend order — and so are the instants of a plan change and a
// resubscription (one second read once, used by both), so the twins can only
// drift apart through the reversal logic. Checked after every event of W as well:
//
//   · a refresh writes NOTHING (no window, lot, ledger row, clawback or level
//     change, and no balance or payment amount moves);
//   · a replay of any reversal already delivered changes NOTHING;
//   · nothing throws.
//
// THE SHAPES. `annual`: one api_starter invoice of 58,800 paying a year whose
// first month ends at the boundary. `monthly`: two api_starter invoices of 4,900,
// one per month. In month 2 an upgrade to api_builder (a paid `proration_up`
// line on the month-2 invoice's subscription) or a downgrade to solo_manual may
// land, and — in the configurations that allow it — a resubscription.
//
// THE CONFIGURATIONS, each over its own fixed seeds (a failure names its seed):
//
//   base                      refunds may be delivered while a dispute of the
//                             same invoice stands (a delayed delivery);
//                             one dispute per payment; no plan change while a
//                             dispute of the base month stands
//   inOrder                   as base, but a refund is never delivered while a
//                             dispute of its invoice stands (Stripe refuses them)
//   inOrder+resubscribe       as inOrder, plus a resubscription in month 2
//   +planChangeDuringDispute  as base, and the plan change may land while a
//                             dispute of the base month stands
//   +twoDisputesOnePayment    as base, and a payment may carry two disputes
//   +resubscribe              as base, plus a resubscription in month 2
//
// The twins may differ by LESS than one credit: a won dispute's give-back is
// rounded up to a whole credit (coordinator decision #1), and a lot not owned by
// the invoice keeps that rounding. Anything from one credit up is a failure.

import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import {
  CreditClawbacksService,
  floorToPriorMinute,
  type ReversalOutcome,
} from '../../src/services/credit-clawbacks.js';
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
  leaving,
  mirrorMovedTo,
  paidMonth,
  paidProrationUpLine,
  spendFromLot,
} from './_helpers/credit-plan-change-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_twin_property';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const PAID = 4_900;
const ANNUAL = 58_800;
const QUARTER = MICRO / 4;
/** Seeds per configuration. Fixed: a failure is reproducible from its seed. */
const SEEDS_PER_CONFIG = 36;
/** Seeds whose first month runs before one shared month boundary. */
const BATCH = 12;
/** How far ahead of the database's clock a batch's month boundary is drawn. */
const BOUNDARY_AHEAD_SECONDS = 14;

let client: postgres.Sql | null = null;
let harness: GrantsHarness | null = null;
let service: CreditClawbacksService | null = null;
const alerts: SentryMessage[] = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 8);
  if (opened === null) return;
  client = opened.sql;
  harness = grantsHarness(opened.url, { max: 4 });
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

// ── shared helpers ──────────────────────────────────────────────────────────

const credits = (micro: number): number => micro / MICRO;

async function charge(invoiceId: string, chargeId: string): Promise<void> {
  await db()`UPDATE billing_invoice_payments SET stripe_charge_id = ${chargeId} WHERE stripe_invoice_id = ${invoiceId}`;
}

interface MicroBalances {
  readonly spendable: number;
  readonly debt: number;
  /** The current window's level; -1 when no window contains now(). */
  readonly level: number;
}

async function microBalances(accountId: string): Promise<MicroBalances> {
  const [row] = await db()<Array<{ level: string }>>`
    SELECT level_micro::text AS level FROM credit_windows
     WHERE account_id = ${accountId}::uuid AND window_start <= now() AND now() < window_end`;
  return {
    spendable: await h().ledger.spendableMicro(accountId),
    debt: await debtOf(db(), accountId),
    level: row === undefined ? -1 : Number(row.level),
  };
}

interface Balances {
  readonly spendable: number;
  readonly debt: number;
  readonly level: number | null;
}

/** Balances in credits, for the fixed-order arms. */
async function balances(accountId: string): Promise<Balances> {
  const b = await microBalances(accountId);
  return {
    spendable: credits(b.spendable),
    debt: credits(b.debt),
    level: b.level < 0 ? null : credits(b.level),
  };
}

function oneLine(b: MicroBalances): string {
  return `{spendable ${String(credits(b.spendable))}, debt ${String(credits(b.debt))}, level ${b.level < 0 ? 'none' : String(credits(b.level))}}`;
}

async function paymentOf(invoiceId: string): Promise<{ refunded: number; disputed: number }> {
  const [row] = await db()<Array<{ r: string; d: string }>>`
    SELECT refunded_minor::text AS r, disputed_minor::text AS d
      FROM billing_invoice_payments WHERE stripe_invoice_id = ${invoiceId}`;
  return { refunded: Number(row?.r ?? '-1'), disputed: Number(row?.d ?? '-1') };
}

async function monthlyLotOf(accountId: string): Promise<string> {
  const lot = (await lotsOf(db(), accountId)).find((l) => l.kind === 'monthly');
  if (lot === undefined) throw new Error('setup: no monthly lot');
  return lot.id;
}

/** A paying api_starter customer with this month granted, the invoice carrying its charge. */
async function granted(chargeId: string) {
  const customer = await payingCustomer(db(), 'api_starter', { amountPaid: PAID });
  await charge(customer.invoiceId, chargeId);
  const first = await h().grants.refreshCredits(customer.accountId);
  if (first.window.outcome !== 'created') throw new Error('setup: the month was not granted');
  return { ...customer, lotId: await monthlyLotOf(customer.accountId) };
}

/** A bought top-up lasting 360 days, funded and set against any debt in one transaction. */
async function buyTopUp(accountId: string, amount: number, key: string): Promise<string> {
  return h().ledger.transaction(async (tx) => {
    await h().ledger.lockAccount(tx, accountId);
    const inserted = await h().ledger.insertLot(
      {
        accountId,
        kind: 'top_up',
        grantKey: `topup:${key}`,
        grantedMicro: amount * MICRO,
        startsAt: floorToPriorMinute(new Date()),
        expiresAt: new Date(Date.now() + 360 * 24 * 3600 * 1000),
      },
      tx,
    );
    // A top-up's funding row is written by the purchase that owns it, not by
    // the ledger repo's `append`; this is that row, as the purchase writes it.
    await tx.execute(sql`
      INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key, actor)
      VALUES (${accountId}::uuid, 'top_up', ${inserted.lot.id}::uuid,
              ${String(amount * MICRO)}::bigint, ${`top_up:${inserted.lot.id}`}, 'customer')`);
    await h().ledger.settleDebtFromFree(tx, accountId);
    return inserted.lot.id;
  });
}

function dispute(disputeId: string, chargeId: string, amountMinor = PAID) {
  return { disputeId, chargeId, stripeInvoiceId: null, amountMinor };
}
function refund(chargeId: string, cumulativeRefundedMinor: number) {
  return { chargeId, stripeInvoiceId: null, cumulativeRefundedMinor };
}

/** An instant `seconds` ahead of the database's clock, whole seconds, as UTC text. */
async function boundaryIn(seconds: number): Promise<string> {
  const [row] = await db()<Array<{ t: string }>>`
    SELECT to_char((date_trunc('second', now()) + make_interval(secs => ${seconds})) AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t`;
  if (row === undefined) throw new Error('setup: no clock');
  return row.t;
}
/** SQL for an instant given as UTC text. */
function at(instant: string): string {
  return `'${instant}'::timestamptz`;
}
/** SQL for one calendar month before / after an instant, counted in UTC. */
function monthBefore(instant: string): string {
  return `((${at(instant)} AT TIME ZONE 'UTC' - interval '1 month') AT TIME ZONE 'UTC')`;
}
function monthAfter(instant: string): string {
  return `((${at(instant)} AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC')`;
}
async function isPast(instant: string): Promise<boolean> {
  const [row] = await db()<
    Array<{ past: boolean }>
  >`SELECT now() > ${instant}::timestamptz AS past`;
  return row?.past === true;
}
async function waitPast(instant: string): Promise<void> {
  for (let i = 0; i < 240; i += 1) {
    if (await isPast(instant)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the database clock never passed the boundary');
}

function failureMessage(err: unknown): string {
  const e = err as { message?: string; cause?: { message?: string } };
  return (e.cause?.message ?? e.message ?? String(err)).slice(0, 180);
}

// ── the property ────────────────────────────────────────────────────────────

type Shape = 'annual' | 'monthly';
type Inv = 'base1' | 'base2' | 'up' | 'resub';
type Reversal =
  | { readonly k: 'refund'; readonly inv: Inv; readonly cum: number }
  | {
      readonly k: 'created' | 'won';
      readonly d: string;
      readonly inv: Inv;
      readonly amount: number;
    };
type Ev =
  | Reversal
  | { readonly k: 'spend'; readonly r: number }
  | { readonly k: 'plan'; readonly to: 'up' | 'down' }
  | { readonly k: 'resub' }
  | { readonly k: 'refresh' }
  | { readonly k: 'replay'; readonly r: number };

function isReversal(e: Ev): e is Reversal {
  return e.k === 'refund' || e.k === 'created' || e.k === 'won';
}

function describeEvent(e: Ev): string {
  switch (e.k) {
    case 'refund':
      return `refund of ${e.inv} to ${String(e.cum)}`;
    case 'created':
      return `dispute ${e.d} of ${String(e.amount)} on ${e.inv}`;
    case 'won':
      return `win of ${e.d}`;
    case 'spend':
      return 'spend';
    case 'plan':
      return `plan ${e.to === 'up' ? 'upgrade' : 'downgrade'}`;
    case 'resub':
      return 'resubscription';
    case 'refresh':
      return 'refresh';
    case 'replay':
      return 'replay';
  }
}

interface Config {
  readonly name: string;
  readonly firstSeed: number;
  readonly inOrder: boolean;
  readonly resubscribe: boolean;
  readonly planChangeDuringDispute: boolean;
  readonly twoDisputesOnePayment: boolean;
}

const CONFIGS: readonly Config[] = [
  {
    name: 'base',
    firstSeed: 1_000,
    inOrder: false,
    resubscribe: false,
    planChangeDuringDispute: false,
    twoDisputesOnePayment: false,
  },
  {
    name: 'inOrder',
    firstSeed: 2_000,
    inOrder: true,
    resubscribe: false,
    planChangeDuringDispute: false,
    twoDisputesOnePayment: false,
  },
  {
    name: 'inOrder+resubscribe',
    firstSeed: 3_000,
    inOrder: true,
    resubscribe: true,
    planChangeDuringDispute: false,
    twoDisputesOnePayment: false,
  },
  {
    name: '+planChangeDuringDispute',
    firstSeed: 4_000,
    inOrder: false,
    resubscribe: false,
    planChangeDuringDispute: true,
    twoDisputesOnePayment: false,
  },
  {
    name: '+twoDisputesOnePayment',
    firstSeed: 5_000,
    inOrder: false,
    resubscribe: false,
    planChangeDuringDispute: false,
    twoDisputesOnePayment: true,
  },
  {
    name: '+resubscribe',
    firstSeed: 6_000,
    inOrder: false,
    resubscribe: true,
    planChangeDuringDispute: false,
    twoDisputesOnePayment: false,
  },
];

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

function paidFor(shape: Shape, inv: Inv): number {
  if (inv === 'up') return shape === 'annual' ? 40_000 : PAID;
  if (inv === 'resub') return PAID;
  return shape === 'annual' ? ANNUAL : PAID;
}

/** Moves every win to after its own dispute's `created`, when both are in `xs`. */
function winsAfterTheirDispute(xs: Ev[]): void {
  let moved = true;
  while (moved) {
    moved = false;
    for (let i = 0; i < xs.length; i += 1) {
      const e = xs[i] as Ev;
      if (e.k !== 'won') continue;
      const created = xs.findIndex((x) => x.k === 'created' && x.d === e.d);
      if (created > i) {
        xs.splice(i, 1);
        xs.splice(created, 0, e);
        moved = true;
        break;
      }
    }
  }
}

interface Plan {
  readonly shape: Shape;
  readonly month1: readonly Ev[];
  readonly month2: readonly Ev[];
  /** Disputes that are won in the end: the twin never sees them. */
  readonly won: ReadonlySet<string>;
  readonly summary: string;
}

function planFor(seed: number, cfg: Config): Plan {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const shape: Shape = r() < 0.5 ? 'annual' : 'monthly';
  const share = (inv: Inv): number =>
    Math.max(1, Math.round(paidFor(shape, inv) * pick([0.25, 0.5, 0.75, 1, r()])));
  const base2: Inv = shape === 'annual' ? 'base1' : 'base2';
  const payment = (inv: Inv): Inv => (inv === 'base2' ? base2 : inv);
  const won = new Set<string>();
  const lost = new Set<string>();
  const month1: Ev[] = [];
  const month2: Ev[] = [];
  const insertAt = (xs: Ev[], e: Ev, from = 0): number => {
    const index = from + Math.floor(r() * (xs.length - from + 1));
    xs.splice(index, 0, e);
    return index;
  };

  // Month 1: refunds of the month-1 invoice, and a dispute of it (two, when allowed).
  const refunds1 = Math.floor(r() * 3);
  for (let i = 0; i < refunds1; i += 1) {
    month1.push({ k: 'refund', inv: 'base1', cum: share('base1') });
  }
  const disputes: { d: string; inv: Inv; amount: number; fate: 'won1' | 'won2' | 'lost' }[] = [];
  if (r() < 0.7) {
    const fate = pick(['won1', 'won2', 'won2', 'lost'] as const);
    disputes.push({ d: `d1_${String(seed)}`, inv: 'base1', amount: share('base1'), fate });
  }
  if (cfg.twoDisputesOnePayment && r() < 0.7) {
    const fate = pick(['won1', 'won2', 'lost'] as const);
    disputes.push({ d: `d1b_${String(seed)}`, inv: 'base1', amount: share('base1'), fate });
  }
  let planChange = pick(['none', 'up', 'up', 'down'] as const);
  const resubscribes = cfg.resubscribe && r() < 0.5;
  for (const d of disputes) {
    const created: Ev = { k: 'created', d: d.d, inv: d.inv, amount: d.amount };
    const win: Ev = { k: 'won', d: d.d, inv: d.inv, amount: d.amount };
    const index = insertAt(month1, created);
    if (d.fate === 'won1') {
      insertAt(month1, win, index + 1);
      insertAt(month1, { ...win }, index + 1);
      won.add(d.d);
    } else if (d.fate === 'won2') {
      month2.push(win, { ...win });
      won.add(d.d);
    } else lost.add(d.d);
  }

  // Month 2: refunds of either month's invoice, and a dispute of a month-2 payment.
  const refunds2 = Math.floor(r() * 3);
  for (let i = 0; i < refunds2; i += 1) {
    const inv = pick<Inv>(['base1', base2]);
    month2.push({ k: 'refund', inv, cum: share(inv) });
  }
  const choices: Inv[] = planChange === 'up' ? [base2, 'up'] : [base2];
  const allowed = choices.filter(
    (inv) => cfg.twoDisputesOnePayment || !disputes.some((d) => payment(d.inv) === payment(inv)),
  );
  if (allowed.length > 0 && r() < 0.6) {
    const inv = pick(allowed);
    const amount = share(inv);
    const d = `d2_${String(seed)}`;
    month2.push({ k: 'created', d, inv, amount });
    if (r() < 0.5) {
      month2.push({ k: 'won', d, inv, amount });
      won.add(d);
    } else lost.add(d);
  }
  for (let i = month2.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [month2[i], month2[j]] = [month2[j] as Ev, month2[i] as Ev];
  }
  winsAfterTheirDispute(month2);

  if (planChange !== 'none') {
    // Without the flag, the plan change lands only where no dispute of a base
    // month stands. A lost dispute never stands in this sense: it is never won,
    // so W and T both keep it.
    const baseDisputeStands = (index: number): boolean => {
      const open = new Set<string>();
      for (const e of [...month1, ...month2.slice(0, index)]) {
        if (e.k === 'created' && e.inv !== 'up' && !lost.has(e.d)) open.add(e.d);
        if (e.k === 'won') open.delete(e.d);
      }
      return open.size > 0;
    };
    const slots = Array.from({ length: month2.length + 1 }, (_, i) => i).filter(
      (i) => cfg.planChangeDuringDispute || !baseDisputeStands(i),
    );
    if (slots.length === 0) {
      planChange = 'none';
      for (let i = month2.length - 1; i >= 0; i -= 1) {
        const e = month2[i] as Ev;
        if (isReversal(e) && e.inv === 'up') month2.splice(i, 1);
      }
    } else {
      const index = pick(slots);
      month2.splice(index, 0, { k: 'plan', to: planChange });
      // Whatever names the upgrade invoice comes after the upgrade exists.
      const early = month2.slice(0, index).filter((e) => isReversal(e) && e.inv === 'up');
      const kept = month2.filter((e) => !early.includes(e));
      month2.length = 0;
      month2.push(...kept, ...early);
      winsAfterTheirDispute(month2);
    }
  }
  if (resubscribes) insertAt(month2, { k: 'resub' });

  if (cfg.inOrder) {
    // A refund is never delivered while a dispute of its payment stands: it is
    // moved to just after that dispute's last win in the same month, or dropped.
    const standing = new Map<string, Inv>();
    for (const list of [month1, month2]) {
      for (let i = 0; i < list.length; i += 1) {
        const e = list[i] as Ev;
        if (e.k === 'created') standing.set(e.d, payment(e.inv));
        else if (e.k === 'won') {
          if (!list.slice(i + 1).some((x) => x.k === 'won' && x.d === e.d)) standing.delete(e.d);
        } else if (e.k === 'refund') {
          const blocking = [...standing].find(([, inv]) => inv === payment(e.inv));
          if (blocking === undefined) continue;
          let lastWin = -1;
          for (let j = i + 1; j < list.length; j += 1) {
            const x = list[j] as Ev;
            if (x.k === 'won' && x.d === blocking[0]) lastWin = j;
          }
          list.splice(i, 1);
          if (lastWin >= 0) list.splice(lastWin, 0, e);
          i -= 1;
        }
      }
    }
  }

  // Spends, refreshes and replays woven between the events.
  const weave = (xs: readonly Ev[]): Ev[] => {
    const out: Ev[] = [];
    const extra = (): void => {
      const x = r();
      if (x < 0.35) out.push({ k: 'spend', r: r() });
      else if (x < 0.5) out.push({ k: 'refresh' });
      else if (x < 0.65) out.push({ k: 'replay', r: r() });
    };
    extra();
    for (const e of xs) {
      out.push(e);
      extra();
    }
    out.push({ k: 'spend', r: r() });
    return out;
  };
  const described = disputes
    .map((d) => `${String(d.amount)}:${d.fate}`)
    .concat(month2.filter((e) => e.k === 'created').map(() => 'month-2 dispute'));
  return {
    shape,
    month1: weave(month1),
    month2: [...weave(month2), { k: 'refresh' }],
    won,
    summary: `${shape}, plan ${planChange}, resubscribes ${String(resubscribes)}, disputes [${described.join(', ')}]`,
  };
}

interface World {
  readonly label: 'W' | 'T';
  /** Unique per world and attempt: every charge and dispute id carries it. */
  readonly tag: string;
  readonly accountId: string;
  readonly subscriptionId: string;
  readonly invoices: Record<Inv, string | null>;
  readonly charges: Record<Inv, string>;
  nth: number;
  readonly delivered: Reversal[];
}

async function makeWorld(
  label: 'W' | 'T',
  seed: number,
  attempt: number,
  shape: Shape,
  boundary: string,
): Promise<World> {
  const accountId = await newAccountOn(db(), 'api_starter');
  const subscriptionId = await subscription(db(), accountId, { tier: 'api_starter' });
  const tag = `${label}_${String(seed)}_${String(attempt)}`;
  const charges: Record<Inv, string> = {
    base1: `ch_tw_${tag}_b1`,
    base2: `ch_tw_${tag}_b2`,
    up: `ch_tw_${tag}_up`,
    resub: `ch_tw_${tag}_rs`,
  };
  const invoices: Record<Inv, string | null> = { base1: null, base2: null, up: null, resub: null };
  if (shape === 'annual') {
    invoices.base1 = await paidLine(db(), accountId, {
      subscriptionId,
      tier: 'api_starter',
      interval: 'year',
      start: monthBefore(boundary),
      end: `((${monthBefore(boundary)} AT TIME ZONE 'UTC' + interval '1 year') AT TIME ZONE 'UTC')`,
      amountPaid: ANNUAL,
    });
    invoices.base2 = invoices.base1;
  } else {
    invoices.base1 = await paidLine(db(), accountId, {
      subscriptionId,
      tier: 'api_starter',
      start: monthBefore(boundary),
      end: at(boundary),
      amountPaid: PAID,
    });
    invoices.base2 = await paidLine(db(), accountId, {
      subscriptionId,
      tier: 'api_starter',
      start: at(boundary),
      end: monthAfter(boundary),
      amountPaid: PAID,
    });
    await charge(invoices.base2, charges.base2);
  }
  await charge(invoices.base1, charges.base1);
  if (shape === 'annual') charges.base2 = charges.base1;
  await h().grants.refreshCredits(accountId);
  return { label, tag, accountId, subscriptionId, invoices, charges, nth: 0, delivered: [] };
}

/** Everything a refresh or a replay could move, for one world. */
async function footprint(w: World) {
  const [row] = await db()<Array<Record<string, string>>>`
    SELECT (SELECT count(*)::text FROM credit_lots WHERE account_id = ${w.accountId}::uuid) AS lots,
           (SELECT count(*)::text FROM credit_ledger WHERE account_id = ${w.accountId}::uuid) AS ledger,
           (SELECT count(*)::text FROM credit_clawbacks WHERE account_id = ${w.accountId}::uuid) AS clawbacks,
           (SELECT count(*)::text FROM credit_window_level_changes s
              JOIN credit_windows cw ON cw.id = s.window_id
             WHERE cw.account_id = ${w.accountId}::uuid) AS steps,
           (SELECT count(*)::text FROM credit_windows WHERE account_id = ${w.accountId}::uuid) AS windows,
           (SELECT string_agg(refunded_minor::text || '/' || disputed_minor::text, ','
                              ORDER BY stripe_invoice_id)
              FROM billing_invoice_payments WHERE account_id = ${w.accountId}::uuid) AS payments`;
  const b = await microBalances(w.accountId);
  return {
    ...row,
    spendable: String(credits(b.spendable)),
    debt: String(credits(b.debt)),
    level: b.level < 0 ? 'none' : String(credits(b.level)),
  };
}

function changed(before: Record<string, string>, after: Record<string, string>): string {
  return Object.keys(after)
    .filter((k) => before[k] !== after[k])
    .map((k) => `${k} ${before[k] ?? '?'}→${after[k] ?? '?'}`)
    .join(', ');
}

async function spendInOrder(w: World, micro: number): Promise<void> {
  let left = micro;
  const lots = await db()<Array<{ id: string; free: string }>>`
    SELECT id, (remaining_micro - held_micro)::text AS free FROM credit_lots
     WHERE account_id = ${w.accountId}::uuid AND starts_at <= now() AND now() < expires_at
       AND revoked_at IS NULL AND remaining_micro > held_micro
     ORDER BY spend_rank, expires_at, created_at, id`;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(left, Number(lot.free));
    w.nth += 1;
    await spendFromLot(db(), w.accountId, lot.id, take / MICRO, w.nth);
    left = left - take;
  }
  if (left > 0) throw new Error('a coupled spend found less free credit than was measured');
}

async function deliver(w: World, e: Reversal): Promise<string> {
  if (w.invoices[e.inv] === null) return 'no invoice';
  const chargeId = w.charges[e.inv];
  if (e.k === 'refund') {
    return (await svc().applyStripeRefund(refund(chargeId, e.cum))).kind;
  }
  const args = dispute(`${w.tag}_${e.d}`, chargeId, e.amount);
  if (e.k === 'created') return (await svc().applyStripeDispute(args)).kind;
  return (await svc().reinstateDispute(args)).kind;
}

/**
 * The database's clock to the whole second, as UTC text, read ONCE for an event
 * both twins receive. When each world read its own clock, W's plan change or
 * resubscription could land in the new window's first second (the whole level)
 * and T's a second later (a share floored to a whole credit below it), and the
 * twins then differed by a credit no reversal moved: seed 3011, which has no
 * dispute at all, differs by exactly one credit of debt that way.
 */
async function wholeSecondNow(): Promise<string> {
  const [row] = await db()<Array<{ t: string }>>`
    SELECT to_char(date_trunc('second', now()) AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t`;
  if (row === undefined) throw new Error('setup: no clock');
  return row.t;
}

async function changePlan(
  w: World,
  to: 'up' | 'down',
  shape: Shape,
  second: string,
): Promise<void> {
  const since = `(${at(second)} - interval '1 second')`;
  if (to === 'down') {
    await mirrorMovedTo(db(), w.subscriptionId, 'solo_manual', since);
  } else {
    await mirrorMovedTo(db(), w.subscriptionId, 'api_builder', since);
    const [end] = await db()<Array<{ e: string }>>`
      SELECT to_char(line_period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS e
        FROM billing_invoice_payments WHERE stripe_invoice_id = ${w.invoices.base2 ?? ''}`;
    if (end === undefined) throw new Error('setup: no month-2 invoice');
    const up = await paidLine(db(), w.accountId, {
      subscriptionId: w.subscriptionId,
      tier: 'api_builder',
      lineKind: 'proration_up',
      interval: shape === 'annual' ? 'year' : 'month',
      start: since,
      end: at(end.e),
      amountPaid: paidFor(shape, 'up'),
    });
    await charge(up, w.charges.up);
    w.invoices.up = up;
  }
  // `customer.subscription.updated` and `invoice.paid` each refresh the account.
  await h().grants.refreshCredits(w.accountId);
}

async function resubscribe(w: World, second: string): Promise<void> {
  const next = await subscription(db(), w.accountId, { tier: 'api_starter' });
  const invoice = await paidLine(db(), w.accountId, {
    subscriptionId: next,
    tier: 'api_starter',
    start: `(${at(second)} - interval '1 second')`,
    end: monthAfter(second),
    amountPaid: PAID,
  });
  await charge(invoice, w.charges.resub);
  w.invoices.resub = invoice;
  await h().grants.refreshCredits(w.accountId);
}

interface SeedRun {
  readonly seed: number;
  readonly plan: Plan;
  readonly w: World;
  readonly t: World;
  readonly trace: string[];
  failure: string | null;
}

/** One event, in both worlds (W's own checks included). Returns a failure, or null. */
async function step(run: SeedRun, e: Ev): Promise<string | null> {
  const { w, t, trace } = run;
  switch (e.k) {
    case 'spend': {
      const most = Math.floor(
        Math.min(
          await h().ledger.spendableMicro(w.accountId),
          await h().ledger.spendableMicro(t.accountId),
        ) / QUARTER,
      );
      if (most <= 0) return null;
      const micro = (1 + Math.floor(e.r * most)) * QUARTER;
      await spendInOrder(w, micro);
      await spendInOrder(t, micro);
      trace.push(`spend ${String(credits(micro))}`);
      const before = await footprint(w);
      await h().grants.refreshCredits(w.accountId);
      const after = await footprint(w);
      return JSON.stringify(before) === JSON.stringify(after)
        ? null
        : `the refresh after a spend wrote: ${changed(before, after)}`;
    }
    case 'refresh':
      await h().grants.refreshCredits(w.accountId);
      await h().grants.refreshCredits(t.accountId);
      return null;
    case 'plan': {
      const second = await wholeSecondNow();
      await changePlan(w, e.to, run.plan.shape, second);
      await changePlan(t, e.to, run.plan.shape, second);
      trace.push(describeEvent(e));
      return null;
    }
    case 'resub': {
      const second = await wholeSecondNow();
      await resubscribe(w, second);
      await resubscribe(t, second);
      trace.push(describeEvent(e));
      return null;
    }
    case 'replay': {
      if (w.delivered.length === 0) return null;
      const again = w.delivered[Math.floor(e.r * w.delivered.length)] as Reversal;
      const before = await footprint(w);
      await deliver(w, again);
      const after = await footprint(w);
      trace.push(`replay of ${describeEvent(again)}`);
      return JSON.stringify(before) === JSON.stringify(after)
        ? null
        : `a replay of the ${describeEvent(again)} changed: ${changed(before, after)}`;
    }
    default: {
      const inTwin = !(e.k !== 'refund' && run.plan.won.has(e.d));
      const inW = await deliver(w, e);
      w.delivered.push(e);
      const inT = inTwin ? await deliver(t, e) : 'not in the twin';
      trace.push(`${describeEvent(e)} (W ${inW}, T ${inT})`);
      const before = await footprint(w);
      await h().grants.refreshCredits(w.accountId);
      const after = await footprint(w);
      await h().grants.refreshCredits(t.accountId);
      return JSON.stringify(before) === JSON.stringify(after)
        ? null
        : `the refresh after the ${describeEvent(e)} wrote: ${changed(before, after)}`;
    }
  }
}

async function runMonth(run: SeedRun, events: readonly Ev[]): Promise<void> {
  for (const e of events) {
    if (run.failure !== null) return;
    try {
      run.failure = await step(run, e);
    } catch (err) {
      run.failure = `the ${describeEvent(e)} threw: ${failureMessage(err)}`;
    }
  }
}

/**
 * One batch of seeds around one month boundary, drawn `aheadSeconds` from the
 * database's clock. Null when month 1 did not finish before the boundary — a
 * slow machine, not a verdict — so the caller runs the batch again, afresh (new
 * accounts, new ids), with a longer lead. No wall-clock bound is asserted: a
 * slower machine only takes longer.
 */
async function runBatch(
  cfg: Config,
  seeds: readonly number[],
  attempt: number,
  aheadSeconds: number,
): Promise<SeedRun[] | null> {
  const boundary = await boundaryIn(aheadSeconds);
  const batch: SeedRun[] = [];
  for (const seed of seeds) {
    const plan = planFor(seed, cfg);
    batch.push({
      seed,
      plan,
      w: await makeWorld('W', seed, attempt, plan.shape, boundary),
      t: await makeWorld('T', seed, attempt, plan.shape, boundary),
      trace: [plan.summary],
      failure: null,
    });
  }
  for (const run of batch) await runMonth(run, run.plan.month1);
  if (await isPast(boundary)) return null;
  await waitPast(boundary);
  for (const run of batch) {
    if (run.failure !== null) continue;
    await h().grants.refreshCredits(run.w.accountId);
    await h().grants.refreshCredits(run.t.accountId);
    run.trace.push('— month 2 —');
    await runMonth(run, run.plan.month2);
    if (run.failure !== null) continue;
    const bw = await microBalances(run.w.accountId);
    const bt = await microBalances(run.t.accountId);
    const apart =
      Math.abs(bw.spendable - bt.spendable) >= MICRO ||
      Math.abs(bw.debt - bt.debt) >= MICRO ||
      bw.level !== bt.level;
    if (apart) run.failure = `W ${oneLine(bw)} ≠ twin ${oneLine(bt)}`;
  }
  return batch;
}

/** Runs one configuration's seeds, a batch at a time around a shared month boundary. */
async function runConfig(cfg: Config): Promise<SeedRun[]> {
  const seeds = Array.from({ length: SEEDS_PER_CONFIG }, (_, i) => cfg.firstSeed + i);
  const runs: SeedRun[] = [];
  for (let b = 0; b < seeds.length; b += BATCH) {
    const slice = seeds.slice(b, b + BATCH);
    let batch: SeedRun[] | null = null;
    for (let attempt = 0; attempt < 3 && batch === null; attempt += 1) {
      batch = await runBatch(cfg, slice, attempt, BOUNDARY_AHEAD_SECONDS * 2 ** attempt);
    }
    if (batch === null) {
      throw new Error(
        `month 1 of seeds ${String(slice[0])}… never finished before its boundary, even ${String(BOUNDARY_AHEAD_SECONDS * 4)} s ahead`,
      );
    }
    runs.push(...batch);
  }
  return runs;
}

describe.skipIf(!RUN_DB_TESTS)(
  'any order of payments, refunds, disputes and plan changes ends where its twin without the won disputes does',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    // ── fixed-order arms (the audit's A1–A12) ─────────────────────────────

    it('CRITICAL a won dispute gives back the bought credit its debt consumed, lasting as long as that credit would have (A1a)', async () => {
      const c = await granted('ch_tw_a1a');
      await spendFromLot(db(), c.accountId, c.lotId, 3_000);
      const topUp = await buyTopUp(c.accountId, 3_000, 'a1a');
      await svc().applyStripeDispute(dispute('dp_tw_a1a', 'ch_tw_a1a'));
      await svc().reinstateDispute(dispute('dp_tw_a1a', 'ch_tw_a1a'));
      expect(await balances(c.accountId)).toEqual({ spendable: 3_000, debt: 0, level: 3_000 });
      // The twin without the dispute holds 3,000 of top-up for its whole term.
      const [lasting] = await db()<Array<{ n: string }>>`
        SELECT COALESCE(sum(remaining_micro - held_micro), 0)::text AS n FROM credit_lots
         WHERE account_id = ${c.accountId}::uuid AND revoked_at IS NULL
           AND expires_at >= (SELECT expires_at - interval '1 day' FROM credit_lots WHERE id = ${topUp}::uuid)`;
      expect(credits(Number(lasting?.n)), 'credit lasting as long as the top-up').toBe(3_000);
    });

    it('CRITICAL a won dispute gives back the bought credit its debt consumed even when no month is running any more (A1b)', async () => {
      const boundary = await boundaryIn(10);
      const c = await payingCustomer(db(), 'api_starter', {
        amountPaid: PAID,
        start: monthBefore(boundary),
        end: at(boundary),
      });
      await charge(c.invoiceId, 'ch_tw_a1b');
      await h().grants.refreshCredits(c.accountId);
      await spendFromLot(db(), c.accountId, await monthlyLotOf(c.accountId), 3_000);
      await buyTopUp(c.accountId, 3_000, 'a1b');
      await svc().applyStripeDispute(dispute('dp_tw_a1b', 'ch_tw_a1b'));
      await waitPast(boundary);
      await h().grants.refreshCredits(c.accountId);
      await svc().reinstateDispute(dispute('dp_tw_a1b', 'ch_tw_a1b'));
      expect((await balances(c.accountId)).spendable).toBe(3_000);
    }, 60_000);

    it('CRITICAL a resubscription that was then upgraded still gets its own month when the old invoice is refunded (A2, deviation D)', async () => {
      const c = await granted('ch_tw_a2');
      const next = await subscription(db(), c.accountId, { tier: 'api_starter' });
      await paidLine(db(), c.accountId, {
        subscriptionId: next,
        tier: 'api_starter',
        amountPaid: PAID,
      });
      await h().grants.refreshCredits(c.accountId);
      const upFrom = "date_trunc('second', now()) - interval '1 hour'";
      await mirrorMovedTo(db(), next, 'api_builder', upFrom);
      const up = await paidLine(db(), c.accountId, {
        subscriptionId: next,
        tier: 'api_builder',
        lineKind: 'proration_up',
        start: upFrom,
      });
      await charge(up, 'ch_tw_a2_up');
      await h().grants.refreshCredits(c.accountId);
      const upLot = (await lotsOf(db(), c.accountId)).find((l) => l.kind === 'proration');
      if (upLot === undefined) throw new Error('setup: no upgrade lot');

      await svc().applyStripeRefund(refund('ch_tw_a2', PAID));
      // The twin without the old invoice: the resubscription's month and the upgrade.
      expect(await balances(c.accountId)).toEqual({
        spendable: 3_000 + credits(Number(upLot.granted_micro)),
        debt: 0,
        level: 10_000,
      });
    });

    async function builderMonthDowngraded(
      chargeId: string,
      disputed: number | null,
    ): Promise<Balances> {
      const m = await paidMonth(db(), 'api_builder');
      await charge(m.invoiceId, chargeId);
      await h().grants.refreshCredits(m.accountId);
      if (disputed !== null)
        await svc().applyStripeDispute(dispute(`dp_${chargeId}`, chargeId, disputed));
      await mirrorMovedTo(db(), m.subscriptionId, 'api_starter', leaving(420));
      await h().grants.refreshCredits(m.accountId);
      if (disputed !== null)
        await svc().reinstateDispute(dispute(`dp_${chargeId}`, chargeId, disputed));
      return balances(m.accountId);
    }

    it('CRITICAL a downgrade made while a FULL dispute stands is applied once the dispute is won (A3)', async () => {
      const twin = await builderMonthDowngraded('ch_tw_a3_twin', null);
      expect(twin).toEqual({ spendable: 6_500, debt: 0, level: 3_000 });
      expect(await builderMonthDowngraded('ch_tw_a3', PAID)).toEqual(twin);
    });

    it('CRITICAL a downgrade made while HALF the month is disputed is applied in full once the dispute is won (A4)', async () => {
      const twin = await builderMonthDowngraded('ch_tw_a4_twin', null);
      expect(await builderMonthDowngraded('ch_tw_a4', PAID / 2)).toEqual(twin);
    });

    it('CRITICAL an upgrade made while half the base month is disputed grants only the step the upgrade paid for (A5)', async () => {
      async function upgraded(chargeId: string, disputed: boolean): Promise<Balances> {
        const m = await paidMonth(db(), 'api_starter');
        await charge(m.invoiceId, chargeId);
        await h().grants.refreshCredits(m.accountId);
        if (disputed) await svc().applyStripeDispute(dispute(`dp_${chargeId}`, chargeId, PAID / 2));
        await mirrorMovedTo(db(), m.subscriptionId, 'api_builder', leaving(420));
        const up = await paidProrationUpLine(db(), m.accountId, {
          subscriptionId: m.subscriptionId,
          tier: 'api_builder',
          from: leaving(420),
        });
        await charge(up, `${chargeId}_up`);
        await h().grants.refreshCredits(m.accountId);
        if (disputed) await svc().reinstateDispute(dispute(`dp_${chargeId}`, chargeId, PAID / 2));
        return balances(m.accountId);
      }
      const twin = await upgraded('ch_tw_a5_twin', false);
      expect(twin).toEqual({ spendable: 6_500, debt: 0, level: 10_000 });
      expect(await upgraded('ch_tw_a5', true)).toEqual(twin);
    });

    it('CRITICAL a downgrade and a half refund leave the same credit in either order (A6)', async () => {
      const x = await paidMonth(db(), 'api_builder');
      await charge(x.invoiceId, 'ch_tw_a6x');
      await h().grants.refreshCredits(x.accountId);
      await mirrorMovedTo(db(), x.subscriptionId, 'api_starter', leaving(420));
      await h().grants.refreshCredits(x.accountId);
      await svc().applyStripeRefund(refund('ch_tw_a6x', PAID / 2));

      const y = await paidMonth(db(), 'api_builder');
      await charge(y.invoiceId, 'ch_tw_a6y');
      await h().grants.refreshCredits(y.accountId);
      await svc().applyStripeRefund(refund('ch_tw_a6y', PAID / 2));
      await mirrorMovedTo(db(), y.subscriptionId, 'api_starter', leaving(420));
      await h().grants.refreshCredits(y.accountId);

      // Half of the month the downgrade left (6,500), either way.
      expect(await balances(y.accountId)).toEqual({ spendable: 3_250, debt: 0, level: 1_500 });
      expect(await balances(x.accountId)).toEqual(await balances(y.accountId));
    });

    it('CRITICAL two disputes standing on one payment each take their share, and a win lowers the disputed amount by its own dispute once (A7)', async () => {
      const c = await granted('ch_tw_a7a');
      await svc().applyStripeDispute(dispute('dp_tw_a7a1', 'ch_tw_a7a', 2_000));
      await svc().applyStripeDispute(dispute('dp_tw_a7a2', 'ch_tw_a7a', 2_000));
      // 900 of 4,900 still paid.
      expect((await balances(c.accountId)).spendable, 'both disputes standing').toBe(551);
      await svc().reinstateDispute(dispute('dp_tw_a7a1', 'ch_tw_a7a', 2_000));
      expect((await balances(c.accountId)).spendable, 'the first won, the second standing').toBe(
        1_775,
      );

      const d = await granted('ch_tw_a7b');
      await svc().applyStripeDispute(dispute('dp_tw_a7b1', 'ch_tw_a7b', 2_000));
      await svc().applyStripeDispute(dispute('dp_tw_a7b2', 'ch_tw_a7b', 2_900));
      expect((await balances(d.accountId)).spendable, 'nothing still paid').toBe(0);
      // `funds_reinstated`, then `closed`: two events of the same win.
      await svc().reinstateDispute(dispute('dp_tw_a7b1', 'ch_tw_a7b', 2_000));
      await svc().reinstateDispute(dispute('dp_tw_a7b1', 'ch_tw_a7b', 2_000));
      expect(await paymentOf(d.invoiceId)).toEqual({ refunded: 0, disputed: 2_900 });
      expect(await balances(d.accountId)).toEqual({ spendable: 1_224, debt: 0, level: 1_224 });
      await svc().reinstateDispute(dispute('dp_tw_a7b2', 'ch_tw_a7b', 2_900));
      expect(await balances(d.accountId)).toEqual({ spendable: 3_000, debt: 0, level: 3_000 });
    });

    it('CRITICAL a won dispute of the old invoice while a resubscription covers the month ends where no dispute would have (A8)', async () => {
      const c = await granted('ch_tw_a8');
      await spendFromLot(db(), c.accountId, c.lotId, 1_000);
      const next = await subscription(db(), c.accountId, { tier: 'api_builder' });
      await paidLine(db(), c.accountId, {
        subscriptionId: next,
        tier: 'api_builder',
        amountPaid: PAID,
      });
      await h().grants.refreshCredits(c.accountId);
      const beforeDispute = await balances(c.accountId);
      expect(beforeDispute).toEqual({ spendable: 9_000, debt: 0, level: 10_000 });
      await svc().applyStripeDispute(dispute('dp_tw_a8', 'ch_tw_a8'));
      await svc().reinstateDispute(dispute('dp_tw_a8', 'ch_tw_a8'));
      expect(await balances(c.accountId)).toEqual(beforeDispute);
    });

    it('CRITICAL a refund or dispute that hands the month to a resubscription and writes debt is applied, not refused at commit (A9)', async () => {
      for (const how of ['refund', 'dispute'] as const) {
        const chargeId = `ch_tw_a9_${how}`;
        const c = await granted(chargeId);
        await spendFromLot(db(), c.accountId, c.lotId, 1_000);
        const next = await subscription(db(), c.accountId, { tier: 'api_starter' });
        await paidLine(db(), c.accountId, {
          subscriptionId: next,
          tier: 'api_starter',
          amountPaid: PAID,
        });
        await h().grants.refreshCredits(c.accountId);
        const outcome = await (
          how === 'refund'
            ? svc().applyStripeRefund(refund(chargeId, PAID))
            : svc().applyStripeDispute(dispute(`dp_tw_a9_${how}`, chargeId))
        ).then(
          (o: ReversalOutcome) => o.kind,
          (err: unknown) => `threw: ${failureMessage(err)}`,
        );
        expect(outcome, how).toBe('applied');
        expect(await paymentOf(c.invoiceId), how).toEqual(
          how === 'refund' ? { refunded: PAID, disputed: 0 } : { refunded: 0, disputed: PAID },
        );
        // The 1,000 spent is owed and the resubscription's month pays it.
        expect(await balances(c.accountId), how).toEqual({
          spendable: 2_000,
          debt: 0,
          level: 3_000,
        });
      }
    });

    it('CRITICAL a refund delivered while a dispute stood ends, once the dispute is won after its month, where the refund alone ends (A10)', async () => {
      const boundary = await boundaryIn(10);
      async function month(tag: string): Promise<string> {
        const c = await payingCustomer(db(), 'api_starter', {
          amountPaid: PAID,
          start: monthBefore(boundary),
          end: at(boundary),
        });
        await charge(c.invoiceId, `ch_tw_a10_${tag}`);
        await paidLine(db(), c.accountId, {
          subscriptionId: c.subscriptionId,
          tier: 'api_starter',
          start: at(boundary),
          end: monthAfter(boundary),
          amountPaid: PAID,
        });
        await h().grants.refreshCredits(c.accountId);
        await spendFromLot(db(), c.accountId, await monthlyLotOf(c.accountId), 2_000);
        return c.accountId;
      }
      const late = await month('late');
      const inOrder = await month('in_order');
      const twin = await month('twin');
      await svc().applyStripeDispute(dispute('dp_tw_a10_late', 'ch_tw_a10_late', 1_225));
      await svc().applyStripeRefund(refund('ch_tw_a10_late', 3_675));
      await svc().applyStripeRefund(refund('ch_tw_a10_in_order', 3_675));
      await svc().applyStripeDispute(dispute('dp_tw_a10_in_order', 'ch_tw_a10_in_order', 1_225));
      await svc().applyStripeRefund(refund('ch_tw_a10_twin', 3_675));
      await waitPast(boundary);
      for (const accountId of [late, inOrder, twin]) await h().grants.refreshCredits(accountId);
      await svc().reinstateDispute(dispute('dp_tw_a10_late', 'ch_tw_a10_late', 1_225));
      await svc().reinstateDispute(dispute('dp_tw_a10_in_order', 'ch_tw_a10_in_order', 1_225));
      const expected = await balances(twin);
      expect(expected).toEqual({ spendable: 1_750, debt: 0, level: 3_000 });
      expect(await balances(inOrder), 'refund, then dispute').toEqual(expected);
      expect(await balances(late), 'dispute, then the late refund').toEqual(expected);
    }, 60_000);

    it('a month drawn while a dispute stood keeps every credit of it once the dispute is won (A11, deviation A)', async () => {
      async function drawn(tag: string, disputed: boolean): Promise<Balances> {
        const c = await payingCustomer(db(), 'api_starter', { amountPaid: PAID });
        const chargeId = `ch_tw_a11_${tag}`;
        await charge(c.invoiceId, chargeId);
        await svc().applyStripeRefund(refund(chargeId, 1));
        if (disputed) await svc().applyStripeDispute(dispute(`dp_tw_a11_${tag}`, chargeId, 2_450));
        await h().grants.refreshCredits(c.accountId);
        if (disputed) await svc().reinstateDispute(dispute(`dp_tw_a11_${tag}`, chargeId, 2_450));
        return balances(c.accountId);
      }
      const twin = await drawn('twin', false);
      expect(twin).toEqual({ spendable: 2_999, debt: 0, level: 2_999 });
      expect(await drawn('won', true)).toEqual(twin);
    });

    it('CRITICAL a crypto refund that hands the month to a Stripe subscription and writes debt is applied (A12)', async () => {
      const accountId = await newAccountOn(db(), 'api_starter');
      const order = await cryptoEntitlement(db(), accountId, { tier: 'api_starter' });
      await h().grants.refreshCredits(accountId);
      await spendFromLot(db(), accountId, await monthlyLotOf(accountId), 1_000);
      const sub = await subscription(db(), accountId, { tier: 'api_starter' });
      await paidLine(db(), accountId, {
        subscriptionId: sub,
        tier: 'api_starter',
        amountPaid: PAID,
      });
      await h().grants.refreshCredits(accountId);
      // The refund revokes the entitlement before the credits are taken back.
      await db()`UPDATE crypto_entitlements SET expires_at = now() - interval '1 second' WHERE order_id = ${order}`;
      const alertsBefore = alerts.length;
      const outcome = await svc()
        .applyCryptoRefund({ accountId, orderId: order })
        .then(
          (o: ReversalOutcome) => o.kind,
          (err: unknown) => `threw: ${failureMessage(err)}`,
        );
      expect(outcome).toBe('applied');
      expect(alerts.length - alertsBefore, 'no failure alert').toBe(0);
      expect(await balances(accountId)).toEqual({ spendable: 2_000, debt: 0, level: 3_000 });
    });

    // ── the property, one configuration at a time ───────────────────────

    for (const cfg of CONFIGS) {
      it(`CRITICAL ${String(SEEDS_PER_CONFIG)} seeded two-month sequences under "${cfg.name}" end where their twins do, and no refresh or replay on the way writes anything`, async () => {
        const runs = await runConfig(cfg);
        const failing = runs.filter((run) => run.failure !== null);
        const first = failing[0];
        // Every failing seed on its own line, then the first one's whole sequence.
        const lines = failing.map((run) => `    seed ${String(run.seed)}: ${run.failure ?? ''}`);
        expect(
          failing.length,
          first === undefined
            ? ''
            : `${String(failing.length)} of ${String(runs.length)} seeds fail; first: seed ${String(first.seed)}: ${first.failure ?? ''}\n${lines.join('\n')}\n  seed ${String(first.seed)} ran: ${first.trace.join(' | ')}`,
        ).toBe(0);
        // No wall-clock bound: about 45 s a configuration locally; the timeout
        // is only the backstop for a hang (a slow run retries its boundary).
      }, 240_000);
    }
  },
);
