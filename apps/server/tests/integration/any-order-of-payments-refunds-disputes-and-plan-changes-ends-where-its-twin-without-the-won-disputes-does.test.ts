// Any order of payments, refunds, disputes and plan changes over TWO MONTHS ends
// where the reversal policy (v2, 2026-09-24) says, measured against its twin
// without the won disputes. A seeded differential property test, first written
// by the second independent audit of the S17 refund and chargeback rework
// (a48fb9b47), extended by the fourth and fifth, and re-based on the policy's
// stated bounds (design-reversal-policy-v2.md §3) when exact twin equality was
// replaced as the acceptance. The fixed-order arms (A1–A12) stay EXACT.
//
// THE WORLDS. Each seed runs two accounts through the same sequence, in
// lockstep, across a REAL month boundary a few seconds ahead of the database's
// clock (every coverage, window and expiry is judged on that clock):
//
//   W  the whole sequence: spends, refunds as cumulative amounts in any order,
//      disputes created then won (both win events, `closed` and
//      `funds_reinstated`) or lost, a mid-month upgrade or downgrade,
//      resubscriptions, replays and refreshes;
//   T  the same sequence with every dispute that is eventually WON removed;
//   X  (the monotone config only) W with ONE refund raised by a quarter of the
//      payment, or ONE more dispute that is never won.
//
// Spends and holds are coupled — the same amount in every world, never more
// than any can spend, taken in the product's spend order — and so are the
// instants of a plan change, a resubscription and every lot's expiry (read once,
// used by all), so the worlds can only drift apart through the reversal logic.
//
// THE INVARIANTS (§3), on EVERY seed:
//
//   1  No debt for unspent credit. At rest, the account's debt is at most, per
//      payment, Σ over its months of max(0, spent + claims collected − worth)
//      — for the annual invoice no more than the frozen cap, max(0, spent and
//      held at a reversal − still-paid share of 36,000) — plus what plan
//      changes charged. An independent SQL closed form: lots are tied to their
//      payment and month by their keys, worth is recomputed here from the
//      stored grants and steps and the TEST's own record of what was paid,
//      refunded and disputed; nothing calls into the code under test.
//   2  Paid-for ceiling, summed over the account: what every lot holds, plus
//      what tasks spent, less debt, is at most each month's worth of each
//      payment (annual: the larger of the month's worth and what was spent,
//      repaid or claimed out of it, since the frozen cap may excuse debt; plus
//      the credit tasks held on the payment at its reversals — B1), plus every
//      other lot's grant, plus rounding (B4). (Per unit, a unit's "position"
//      needs the code's own attribution of charges; the account-wide sum does not.)
//   3  A win never leaves the customer worse off than the twin: spendable W ≥
//      twin − 1 credit, debt W ≤ twin + 1 credit, levels exactly equal, and
//      the same for the credit valid until each expiry instant or later
//      (dominance — this replaced exact expiry buckets). The tolerance also
//      carries the annual claims the twin had DROPPED (B1) beyond W's
//      (Amendment 3, R-J): a concession only the twin received is not owed to W.
//      B5 (Amendment 4, a stated customer-UNfavourable exception): when the
//      trace shows an ANNUAL payment refunded or disputed again after one of
//      its disputes was won, W may end below the twin by at most what the wins
//      returned to that payment as lots of its own (`…:returned`), because the
//      frozen cap measures spending on the payment's own lots. Every other
//      seed keeps the full invariant.
//   4  Win cap: W's spendable above the twin's, and the twin's debt above W's,
//      are each at most what the won disputes could remove — (dispute ÷ paid)
//      × what the payment granted, B2 — plus the most credit tasks held, plus
//      one credit.
//   5  Replays and refreshes change nothing (exact, after every event).
//   6  Monotone: X's net position (spendable − debt) never exceeds W's.
//   7  Direction, after every event: a refund or dispute never raises what its
//      own payment's lots hold. (Its second clause — a win never lowers net
//      position — was dropped by Amendment 1, R-B: a win shrinks a same-month
//      second payment's share back, rule 7, while W still meets the twin.)
//
// EXACT EQUALITY (spendable, debt, level, and credit per expiry instant, within
// one credit) is kept on the seeds whose trace allows it. §3 names two
// conditions: every win landed in its dispute's own month, and none of its debt
// was repaid from credit that later expired. Those two do not make a seed exact
// under rule 6, so three more are required (adopted by Amendment 1), each a
// case the rules themselves leave apart:
//
//   ·  no coupled spend or hold drew from different lots (kind and expiry) in
//      W and T — a dispute that took a month's credit sends spending to other
//      lots, and the win returns the credit with the longest term used (R-A),
//      so W ends above the twin (P-C) or level with it but longer-lived
//      (P-A2): dominance holds, equality does not, so the condition stays;
//   ·  no reversal landed while a won dispute stood and a task held credit — a
//      refund measured then claims more of the held credit, and an annual
//      claim left unpaid is dropped (B1);
//   ·  no debt was repaid, from any lot, while a won dispute stood (the
//      design's condition is the case of this that needs no spending at all);
//   ·  no win returned credit as a NEW lot (Amendment 3, R-K): such a lot
//      lasts as long as what the dispute displaced, so the seed is checked by
//      dominance, not by credit per expiry instant.
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
// From the fourth audit (histories the six above never produce):
//
//   +topUpsAndGoodwill        as base, plus top-ups (360 days) and goodwill
//                             lasting 1 or 40 days, bought between the events
//   +runningTasks             as base, plus tasks that HOLD credit and settle
//                             later — across a reversal, a win or the month end
//   inOrder+topUpsAndGoodwill+runningTasks
//   +planChangeDuringDispute+twoDisputesOnePayment+topUpsAndGoodwill+runningTasks
//   +resubscribe+resubscriptionReversed+topUpsAndGoodwill+runningTasks
//                             the resubscription's own invoice is refunded or
//                             disputed (won or lost) after it
//   inOrder+resubscribeInMonth1+resubscriptionReversed+cryptoTerm
//                             a resubscription in MONTH 1 on a line that began
//                             20 days before the month ends, and a builder
//                             crypto term above the Stripe month, refunded or not
//
// From the fifth audit (seeds 51000–54035): `dense`, `dense+twoDisputesOnePayment`,
// `inOrder+dense`, `dense+planChangeDuringDispute+twoDisputesOnePayment` — tasks
// crowded in, top-ups and goodwill bought between a task's hold and its settle,
// goodwill that expires within seconds, several claims standing at once, and
// debt repaid from several sources. And the small monotone config (55000–55023)
// with its third world.

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
import { randomUUID } from 'node:crypto';
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
import {
  reservationsHarness,
  settledCall,
  type ReservationsHarness,
} from './_helpers/credit-reservation-fixtures.js';

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
let reservations: ReservationsHarness | null = null;
const alerts: SentryMessage[] = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 8);
  if (opened === null) return;
  client = opened.sql;
  harness = grantsHarness(opened.url, { max: 4 });
  reservations = reservationsHarness(opened.url, { refresher: null, max: 2 });
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

/**
 * The period of a second line that must start WITH the first line of the
 * account's `invoiceId`, read off that line rather than off the clock. Written
 * as the fixtures' default ("five days ago, on the second") each insert takes
 * its own reading, and two inserts that straddle a second boundary start a
 * second apart: the later line then covers the month less one second and its
 * share of it floors a whole credit short (7,000 × (month − 1 s) / month =
 * 6,999). CI failed arm A8 exactly so (8,999 against 9,000).
 */
async function periodOf(invoiceId: string): Promise<{ start: string; end: string }> {
  const [row] = await db()<Array<{ s: string }>>`
    SELECT to_char(line_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS s
      FROM billing_invoice_payments WHERE stripe_invoice_id = ${invoiceId}`;
  if (row === undefined) throw new Error('setup: no line to start with');
  const start = at(row.s);
  return { start, end: `((${start} AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC')` };
}

/** A bought top-up lasting 360 days (or until `expiresAt`), funded and set against any debt in one transaction. */
async function buyTopUp(
  accountId: string,
  amount: number,
  key: string,
  expiresAt: Date = new Date(Date.now() + 360 * 24 * 3600 * 1000),
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
        expiresAt,
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
  | {
      readonly k: 'refund';
      readonly inv: Inv;
      readonly cum: number;
      /** The monotone config's third world X delivers this refund raised to `xCum`. */
      readonly xCum?: number;
    }
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
  | { readonly k: 'replay'; readonly r: number }
  | { readonly k: 'topUp'; readonly amount: number }
  | {
      readonly k: 'goodwill';
      readonly amount: number;
      readonly days: number;
      /** Goodwill that expires within seconds, inside the run (the dense configs). */
      readonly seconds?: number;
    }
  | { readonly k: 'hold'; readonly r: number }
  | { readonly k: 'settle'; readonly r: number }
  | { readonly k: 'resubscribeInMonth1' }
  | { readonly k: 'crypto' }
  | { readonly k: 'cryptoRefund' }
  /** The monotone config: a reversal only the third world X receives (a dispute it loses). */
  | { readonly k: 'xOnly'; readonly e: Reversal };

function isReversal(e: Ev): e is Reversal {
  return e.k === 'refund' || e.k === 'created' || e.k === 'won';
}

function describeEvent(e: Ev): string {
  switch (e.k) {
    case 'refund':
      return `refund of ${e.inv} to ${String(e.cum)}${e.xCum !== undefined ? ` (X: ${String(e.xCum)})` : ''}`;
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
    case 'topUp':
      return `top-up of ${String(e.amount)}`;
    case 'goodwill':
      return e.seconds !== undefined
        ? `goodwill of ${String(e.amount)} for ${String(e.seconds)} seconds`
        : `goodwill of ${String(e.amount)} for ${String(e.days)} days`;
    case 'hold':
      return 'a task holds credit';
    case 'settle':
      return 'the oldest running task settles';
    case 'resubscribeInMonth1':
      return 'resubscription in month 1 (line began 20 days before the month ends)';
    case 'crypto':
      return 'builder crypto term bought';
    case 'cryptoRefund':
      return 'crypto term refunded';
    case 'xOnly':
      return `X only: ${describeEvent(e.e)} (lost)`;
  }
}

interface Config {
  readonly name: string;
  readonly firstSeed: number;
  /** Default SEEDS_PER_CONFIG. */
  readonly seeds?: number;
  readonly inOrder: boolean;
  readonly resubscribe: boolean;
  readonly planChangeDuringDispute: boolean;
  readonly twoDisputesOnePayment: boolean;
  /** Top-ups (360 days) and goodwill (1 or 40 days) woven between the events. */
  readonly topUpsAndGoodwill?: boolean;
  /** Tasks holding credit, settled later: across reversals, wins and the month end. */
  readonly runningTasks?: boolean;
  /** A resubscription in month 1, on a line that began 20 days before the month ends. */
  readonly resubscribeInMonth1?: boolean;
  /** The resubscription's own invoice refunded, or disputed and won or lost, after it. */
  readonly resubscriptionReversed?: boolean;
  /** A builder crypto term bought above the Stripe month, refunded or not. */
  readonly cryptoTerm?: boolean;
  /**
   * The fifth audit's generator (seeds 51000–54035): tasks crowded in, top-ups
   * and goodwill bought BETWEEN a task's hold and its settle, goodwill that
   * expires within seconds, several claims standing at once, and debt repaid
   * from several sources.
   */
  readonly dense?: boolean;
  /** Invariant 6: a third world X that receives one more refund, or one more (lost) dispute. */
  readonly monotone?: boolean;
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
  {
    name: '+topUpsAndGoodwill',
    firstSeed: 11_000,
    inOrder: false,
    resubscribe: false,
    planChangeDuringDispute: false,
    twoDisputesOnePayment: false,
    topUpsAndGoodwill: true,
  },
  {
    name: '+runningTasks',
    firstSeed: 12_000,
    inOrder: false,
    resubscribe: false,
    planChangeDuringDispute: false,
    twoDisputesOnePayment: false,
    runningTasks: true,
  },
  {
    name: 'inOrder+topUpsAndGoodwill+runningTasks',
    firstSeed: 13_000,
    inOrder: true,
    resubscribe: false,
    planChangeDuringDispute: false,
    twoDisputesOnePayment: false,
    topUpsAndGoodwill: true,
    runningTasks: true,
  },
  {
    name: '+planChangeDuringDispute+twoDisputesOnePayment+topUpsAndGoodwill+runningTasks',
    firstSeed: 14_000,
    inOrder: false,
    resubscribe: false,
    planChangeDuringDispute: true,
    twoDisputesOnePayment: true,
    topUpsAndGoodwill: true,
    runningTasks: true,
  },
  {
    name: '+resubscribe+resubscriptionReversed+topUpsAndGoodwill+runningTasks',
    firstSeed: 15_000,
    inOrder: false,
    resubscribe: true,
    planChangeDuringDispute: false,
    twoDisputesOnePayment: false,
    topUpsAndGoodwill: true,
    runningTasks: true,
    resubscriptionReversed: true,
  },
  {
    name: 'inOrder+resubscribeInMonth1+resubscriptionReversed+cryptoTerm',
    firstSeed: 16_000,
    inOrder: true,
    resubscribe: false,
    planChangeDuringDispute: false,
    twoDisputesOnePayment: false,
    resubscribeInMonth1: true,
    resubscriptionReversed: true,
    cryptoTerm: true,
  },
  // The fifth audit's four generator configurations, now permanent.
  {
    name: 'dense',
    firstSeed: 51_000,
    inOrder: false,
    resubscribe: false,
    planChangeDuringDispute: false,
    twoDisputesOnePayment: false,
    dense: true,
  },
  {
    name: 'dense+twoDisputesOnePayment',
    firstSeed: 52_000,
    inOrder: false,
    resubscribe: false,
    planChangeDuringDispute: false,
    twoDisputesOnePayment: true,
    dense: true,
  },
  {
    name: 'inOrder+dense',
    firstSeed: 53_000,
    inOrder: true,
    resubscribe: false,
    planChangeDuringDispute: false,
    twoDisputesOnePayment: false,
    dense: true,
  },
  {
    name: 'dense+planChangeDuringDispute+twoDisputesOnePayment',
    firstSeed: 54_000,
    inOrder: false,
    resubscribe: false,
    planChangeDuringDispute: true,
    twoDisputesOnePayment: true,
    dense: true,
  },
  // Invariant 6, small: three worlds.
  {
    name: 'monotone: a third world with one refund raised or one more lost dispute',
    firstSeed: 55_000,
    seeds: 24,
    inOrder: false,
    resubscribe: false,
    planChangeDuringDispute: false,
    twoDisputesOnePayment: false,
    monotone: true,
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
  /** §3 exactness, first half: every won dispute is created and won in the same month. */
  readonly winsInOwnMonth: boolean;
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
  // The later configurations' draws come AFTER every draw the six original
  // ones make, and only under their own flags: an original seed plans exactly
  // what it always planned.
  const resubscriptions: { list: Ev[]; event: Ev }[] = [];
  if (resubscribes) {
    const event: Ev = { k: 'resub' };
    insertAt(month2, event);
    resubscriptions.push({ list: month2, event });
  }
  if (cfg.resubscribeInMonth1 === true && r() < 0.6) {
    const event: Ev = { k: 'resubscribeInMonth1' };
    insertAt(month1, event);
    resubscriptions.push({ list: month1, event });
  }
  if (cfg.resubscriptionReversed === true) {
    for (const { list, event } of resubscriptions) {
      // A refund of the resubscription, and a dispute of it won or lost, each
      // after the resubscription itself (in its month, or in month 2).
      const after = (): { xs: Ev[]; from: number } =>
        list === month1 && r() < 0.5
          ? { xs: month2, from: 0 }
          : { xs: list, from: list.indexOf(event) + 1 };
      if (r() < 0.6) {
        const where = after();
        insertAt(where.xs, { k: 'refund', inv: 'resub', cum: share('resub') }, where.from);
      }
      if (r() < 0.5) {
        const d = `dr_${String(seed)}`;
        const amount = share('resub');
        const where = after();
        const created = insertAt(where.xs, { k: 'created', d, inv: 'resub', amount }, where.from);
        if (r() < 0.5) {
          insertAt(where.xs, { k: 'won', d, inv: 'resub', amount }, created + 1);
          insertAt(where.xs, { k: 'won', d, inv: 'resub', amount }, created + 1);
          won.add(d);
        } else lost.add(d);
      }
    }
  }
  if (cfg.cryptoTerm === true && r() < 0.7) {
    const list = r() < 0.5 ? month1 : month2;
    const bought = insertAt(list, { k: 'crypto' });
    if (r() < 0.6) {
      if (list === month1 && r() < 0.5) insertAt(month2, { k: 'cryptoRefund' });
      else insertAt(list, { k: 'cryptoRefund' }, bought + 1);
    }
  }

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
      if (cfg.dense === true) {
        const y = r();
        if (y < 0.15) out.push({ k: 'topUp', amount: pick([250, 1_000, 3_000]) });
        else if (y < 0.3) out.push({ k: 'goodwill', amount: pick([500, 1_000, 2_000]), days: 40 });
        else if (y < 0.5) {
          out.push({
            k: 'goodwill',
            amount: pick([500, 1_000, 3_000]),
            days: 0,
            seconds: pick([3, 5, 8]),
          });
        }
        const z = r();
        if (z < 0.4) out.push({ k: 'hold', r: r() });
        else if (z < 0.65) out.push({ k: 'settle', r: r() < 0.3 ? 0.999 : r() });
        return;
      }
      if (cfg.topUpsAndGoodwill === true) {
        const y = r();
        if (y < 0.12) out.push({ k: 'topUp', amount: pick([250, 1_000, 3_000]) });
        else if (y < 0.24) {
          out.push({ k: 'goodwill', amount: pick([500, 2_000]), days: pick([1, 40]) });
        }
      }
      if (cfg.runningTasks === true) {
        const z = r();
        if (z < 0.2) out.push({ k: 'hold', r: r() });
        else if (z < 0.35) out.push({ k: 'settle', r: r() });
      }
    };
    extra();
    for (const e of xs) {
      out.push(e);
      extra();
    }
    out.push({ k: 'spend', r: r() });
    return out;
  };
  const woven1 = weave(month1);
  const woven2 = [...weave(month2), { k: 'refresh' } as Ev];

  // Invariant 6: the third world X is W with ONE refund raised by a quarter of
  // what was paid, or ONE more dispute that is never won.
  let monotone = '';
  if (cfg.monotone === true) {
    const lists = [woven1, woven2];
    const refunds: { list: Ev[]; index: number; e: Reversal & { k: 'refund' } }[] = [];
    for (const list of lists) {
      list.forEach((e, index) => {
        if (e.k === 'refund' && e.cum < paidFor(shape, e.inv)) refunds.push({ list, index, e });
      });
    }
    if (refunds.length > 0 && r() < 0.5) {
      const chosen = pick(refunds);
      const raised = Math.min(
        paidFor(shape, chosen.e.inv),
        chosen.e.cum + Math.round(paidFor(shape, chosen.e.inv) / 4),
      );
      chosen.list[chosen.index] = { ...chosen.e, xCum: raised };
      monotone = `X raises a refund of ${chosen.e.inv} to ${String(raised)}`;
    } else {
      const list = r() < 0.5 ? woven1 : woven2;
      const inv = pick<Inv>(['base1', base2]);
      const extraDispute: Reversal = {
        k: 'created',
        d: `dx_${String(seed)}`,
        inv,
        amount: share(inv),
      };
      // Never before the first event, so the invoice exists; anywhere after.
      insertAt(list, { k: 'xOnly', e: extraDispute }, 1);
      monotone = `X has one more (lost) dispute of ${String(extraDispute.amount)} on ${inv}`;
    }
  }

  // §3 exactness, first half: every won dispute is created and won in the same month.
  const monthOf = (d: string, k: 'created' | 'won'): number =>
    month1.some((e) => e.k === k && e.d === d)
      ? 1
      : month2.some((e) => e.k === k && e.d === d)
        ? 2
        : 0;
  const winsInOwnMonth = [...won].every((d) => monthOf(d, 'created') === monthOf(d, 'won'));

  const described = disputes
    .map((d) => `${String(d.amount)}:${d.fate}`)
    .concat(month2.filter((e) => e.k === 'created').map(() => 'month-2 dispute'));
  return {
    shape,
    month1: woven1,
    month2: woven2,
    won,
    winsInOwnMonth,
    summary: `${shape}, plan ${planChange}, resubscribes ${String(resubscribes)}, disputes [${described.join(', ')}]${monotone === '' ? '' : `, ${monotone}`}`,
  };
}

interface World {
  readonly label: 'W' | 'T' | 'X';
  /** Unique per world and attempt: every charge and dispute id carries it. */
  readonly tag: string;
  readonly accountId: string;
  readonly subscriptionId: string;
  readonly invoices: Record<Inv, string | null>;
  readonly charges: Record<Inv, string>;
  nth: number;
  readonly delivered: Reversal[];
  /** Running tasks, oldest first; the worlds open and settle them in lockstep. */
  readonly holds: string[];
  /** The month boundary this world's batch runs around. */
  readonly boundary: string;
  /** The crypto order bought above the Stripe month, once bought. */
  cryptoOrder: string | null;
  // ── what the TEST knows about each payment, for the closed forms (never read from the code) ──
  /** The largest cumulative refund delivered, by invoice id (L5). */
  readonly refunded: Map<string, number>;
  /** Disputes delivered and not won, by id: their invoice and amount (R2). */
  readonly disputesStanding: Map<string, { invoiceId: string; amount: number }>;
  /** Disputes already won once (a second win event changes nothing). */
  readonly disputesWon: Set<string>;
  /** Invariant 1's frozen-cap figure, by invoice id: the most C+Q+H its lots showed at a reversal or win. */
  readonly capSpent: Map<string, number>;
  /** Credit tasks held on an ANNUAL payment's lots when a reversal of it landed (B1), by invoice id. */
  readonly heldAtReversal: Map<string, number>;
  /** The most credit tasks held on the account at any reversal or win (invariant 4). */
  maxHeld: number;
}

async function makeWorld(
  label: 'W' | 'T' | 'X',
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
      invoiceId: `in_tw_${tag}_b1`,
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
      invoiceId: `in_tw_${tag}_b1`,
      subscriptionId,
      tier: 'api_starter',
      start: monthBefore(boundary),
      end: at(boundary),
      amountPaid: PAID,
    });
    invoices.base2 = await paidLine(db(), accountId, {
      invoiceId: `in_tw_${tag}_b2`,
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
  return {
    label,
    tag,
    accountId,
    subscriptionId,
    invoices,
    charges,
    nth: 0,
    delivered: [],
    holds: [],
    boundary,
    cryptoOrder: null,
    refunded: new Map(),
    disputesStanding: new Map(),
    disputesWon: new Set(),
    capSpent: new Map(),
    heldAtReversal: new Map(),
    maxHeld: 0,
  };
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

/**
 * What the account can spend, grouped by the instant it expires (microsecond
 * UTC text): the terms a comparison of totals cannot see.
 */
async function termsOf(accountId: string): Promise<Map<string, number>> {
  const rows = await db()<Array<{ e: string; free: string }>>`
    SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS e,
           sum(remaining_micro - held_micro)::text AS free
      FROM credit_lots
     WHERE account_id = ${accountId}::uuid AND revoked_at IS NULL
       AND starts_at <= now() AND now() < expires_at AND remaining_micro > held_micro
     GROUP BY expires_at
     ORDER BY expires_at`;
  return new Map(rows.map((row) => [row.e, Number(row.free)]));
}

/** EXACT seeds only: the first expiry at which the twins' credit differs by a credit or more. */
function termsApart(w: Map<string, number>, t: Map<string, number>): string | null {
  const instants = [...new Set([...w.keys(), ...t.keys()])].sort();
  for (const instant of instants) {
    const a = w.get(instant) ?? 0;
    const b = t.get(instant) ?? 0;
    if (Math.abs(a - b) >= MICRO) {
      return `credit expiring ${instant}: W ${String(credits(a))} ≠ twin ${String(credits(b))}`;
    }
  }
  return null;
}

/**
 * Invariant 3's dominance, which replaces exact buckets on every seed: for every
 * expiry instant x either twin holds credit at, the credit W holds that is valid
 * until x or later is at least the twin's, less one credit. Null when W dominates.
 */
function dominanceGap(
  w: Map<string, number>,
  t: Map<string, number>,
  tolerance: number = MICRO,
): string | null {
  const instants = [...new Set([...w.keys(), ...t.keys()])].sort();
  const validFrom = (m: Map<string, number>, x: string): number => {
    let micro = 0;
    for (const [e, v] of m) if (e >= x) micro = micro + v;
    return micro;
  };
  for (const x of instants) {
    const a = validFrom(w, x);
    const b = validFrom(t, x);
    if (b - a >= tolerance) {
      return `credit valid until ${x} or later: W ${String(credits(a))} < twin ${String(credits(b))}`;
    }
  }
  return null;
}

/** An instant `days` after the database's clock to the whole second, read ONCE for every world. */
async function sharedExpiry(days: number): Promise<Date> {
  const [row] = await db()<Array<{ e: Date }>>`
    SELECT date_trunc('second', now()) + make_interval(days => ${days}) AS e`;
  if (row === undefined) throw new Error('setup: no clock');
  return row.e;
}

/** An instant `seconds` after the database's clock, whole seconds, read ONCE for every world. */
async function sharedExpirySeconds(seconds: number): Promise<Date> {
  const [row] = await db()<Array<{ e: Date }>>`
    SELECT date_trunc('second', now()) + make_interval(secs => ${seconds}) AS e`;
  if (row === undefined) throw new Error('setup: no clock');
  return row.e;
}

async function goodwillLot(w: World, amount: number, expiresAt: Date): Promise<void> {
  w.nth += 1;
  const key = `${w.tag}_gw_${String(w.nth)}`;
  await h().ledger.transaction(async (tx) => {
    await h().ledger.lockAccount(tx, w.accountId);
    const inserted = await h().ledger.insertLot(
      {
        accountId: w.accountId,
        kind: 'adjustment',
        grantKey: `goodwill:${key}`,
        grantedMicro: amount * MICRO,
        startsAt: floorToPriorMinute(new Date()),
        expiresAt,
      },
      tx,
    );
    await h().ledger.append(
      {
        accountId: w.accountId,
        kind: 'grant',
        lotId: inserted.lot.id,
        amountMicro: amount * MICRO,
        idempotencyKey: `admin_goodwill:${key}`,
        actor: 'admin',
      },
      tx,
    );
    await h().ledger.settleDebtFromFree(tx, w.accountId);
  });
}

/** The account's free lots in the product's spend order, with what identifies a lot across worlds. */
async function freeLotsInOrder(
  accountId: string,
): Promise<Array<{ id: string; free: string; kind: string; e: string }>> {
  return db()<Array<{ id: string; free: string; kind: string; e: string }>>`
    SELECT id, (remaining_micro - held_micro)::text AS free, kind,
           to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS e
      FROM credit_lots
     WHERE account_id = ${accountId}::uuid AND starts_at <= now() AND now() < expires_at
       AND revoked_at IS NULL AND remaining_micro > held_micro
     ORDER BY spend_rank, expires_at, created_at, id`;
}

/** Where a spend or hold drew from, by lot kind and expiry: equal in two worlds or not (§3 exactness). */
function bucketsOf(parts: readonly { kind: string; e: string; micro: number }[]): string {
  const m = new Map<string, number>();
  for (const p of parts) m.set(`${p.kind}@${p.e}`, (m.get(`${p.kind}@${p.e}`) ?? 0) + p.micro);
  return [...m.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}:${String(v)}`)
    .join(',');
}

/**
 * A running task holding `micro`, taken from the lots in the product's spend
 * order: a real reservation and one real hold per lot, in one transaction.
 */
async function holdInOrder(w: World, micro: number): Promise<{ id: string; buckets: string }> {
  const lots = await freeLotsInOrder(w.accountId);
  const parts: { lotId: string; micro: number; kind: string; e: string }[] = [];
  let left = micro;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(left, Number(lot.free));
    parts.push({ lotId: lot.id, micro: take, kind: lot.kind, e: lot.e });
    left = left - take;
  }
  if (left > 0) throw new Error('a coupled hold found less free credit than was measured');
  const reservationId = randomUUID();
  await db().begin(async (tx) => {
    await tx`
      INSERT INTO credit_reservations (id, account_id, agent_session_id, model, rate_card_version,
                                       mode, slot, reserved_micro, lease_owner,
                                       lease_expires_at, max_until)
      SELECT ${reservationId}::uuid, ${w.accountId}::uuid, ${`as_${reservationId}`},
             'claude-sonnet-5', 1, 'enforce',
             (SELECT s FROM generate_series(1, 3) s
               WHERE NOT EXISTS (SELECT 1 FROM credit_reservations o
                                  WHERE o.account_id = ${w.accountId}::uuid
                                    AND o.state = 'open' AND o.mode = 'enforce' AND o.slot = s)
               ORDER BY s LIMIT 1),
             ${String(micro)}::bigint, 'fixture-boot',
             now() + interval '10 minutes', now() + interval '29 minutes'`;
    for (const part of parts) {
      await tx`
        INSERT INTO credit_reservation_holds (reservation_id, lot_id, account_id, held_micro)
        VALUES (${reservationId}::uuid, ${part.lotId}::uuid, ${w.accountId}::uuid,
                ${String(part.micro)}::bigint)`;
    }
  });
  return { id: reservationId, buckets: bucketsOf(parts) };
}

async function reservedOf(reservationId: string): Promise<number> {
  const [row] = await db()<Array<{ r: string }>>`
    SELECT reserved_micro::text AS r FROM credit_reservations WHERE id = ${reservationId}::uuid`;
  return Number(row?.r ?? '0');
}

/** The task's one model call cost `charged`, and it settles as a task does. */
async function settleHold(w: World, reservationId: string, charged: number): Promise<void> {
  if (charged > 0) {
    await settledCall(db(), { reservationId, accountId: w.accountId, chargedMicro: charged });
  }
  await tasks().service.settle(reservationId, 'completed');
}

async function spendInOrder(w: World, micro: number): Promise<string> {
  let left = micro;
  const lots = await freeLotsInOrder(w.accountId);
  const parts: { kind: string; e: string; micro: number }[] = [];
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(left, Number(lot.free));
    w.nth += 1;
    await spendFromLot(db(), w.accountId, lot.id, take / MICRO, w.nth);
    parts.push({ kind: lot.kind, e: lot.e, micro: take });
    left = left - take;
  }
  if (left > 0) throw new Error('a coupled spend found less free credit than was measured');
  return bucketsOf(parts);
}

async function deliver(w: World, e: Reversal): Promise<string> {
  const invoiceId = w.invoices[e.inv];
  if (invoiceId === null) return 'no invoice';
  const chargeId = w.charges[e.inv];
  if (e.k === 'refund') {
    const cum = w.label === 'X' && e.xCum !== undefined ? e.xCum : e.cum;
    const outcome = (await svc().applyStripeRefund(refund(chargeId, cum))).kind;
    w.refunded.set(invoiceId, Math.max(w.refunded.get(invoiceId) ?? 0, cum));
    return outcome;
  }
  const args = dispute(`${w.tag}_${e.d}`, chargeId, e.amount);
  if (e.k === 'created') {
    const outcome = (await svc().applyStripeDispute(args)).kind;
    if (!w.disputesWon.has(e.d) && !w.disputesStanding.has(e.d)) {
      w.disputesStanding.set(e.d, { invoiceId, amount: e.amount });
    }
    return outcome;
  }
  const outcome = (await svc().reinstateDispute(args)).kind;
  w.disputesStanding.delete(e.d);
  w.disputesWon.add(e.d);
  return outcome;
}

/**
 * The database's clock to the whole second, as UTC text, read ONCE for an event
 * every world receives. When each world read its own clock, W's plan change or
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

/**
 * A resubscription in MONTH 1 on a line that began 20 days before the month
 * ends — so the share of the month it is handed is a real one, while the month
 * still has only seconds left on the database's clock. Its invoice id is fixed
 * per world, so a tie with the month-2 invoice breaks the same way in both.
 */
async function resubscribeInMonth1(w: World): Promise<void> {
  const next = await subscription(db(), w.accountId, { tier: 'api_starter' });
  const start = `(${at(w.boundary)} - interval '20 days')`;
  const invoice = await paidLine(db(), w.accountId, {
    invoiceId: `in_tw_${w.tag}_rs`,
    subscriptionId: next,
    tier: 'api_starter',
    start,
    end: `((${start} AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC')`,
    amountPaid: PAID,
  });
  await charge(invoice, w.charges.resub);
  w.invoices.resub = invoice;
  await h().grants.refreshCredits(w.accountId);
}

// ── the closed forms (invariants 1 and 2): SQL over the stored facts, and the
//    test's own record of what was paid, refunded and disputed — never a call
//    into the code under test ────────────────────────────────────────────────

/** One lot, and the payment and month it belongs to (null for goodwill, a top-up, anything else). */
interface LotFact {
  readonly lotId: string;
  readonly kind: string;
  readonly ref: string | null;
  readonly windowId: string | null;
  /** The window was drawn from `ref`. */
  readonly drawn: boolean;
  readonly granted: number;
  readonly remaining: number;
  readonly held: number;
  readonly live: boolean;
  /** What the lot's monthly grant recorded as still paid when granted (0137); null elsewhere. */
  readonly stillPaidAt: number | null;
  /** C: what tasks were charged out of the lot. */
  readonly charged: number;
  /** Q: what claims (any clawback's) collected out of the lot. */
  readonly claims: number;
  /** B: what the lot repaid of the account's debt. */
  readonly repaid: number;
}

async function lotFacts(accountId: string): Promise<LotFact[]> {
  const rows = await db()<
    Array<{
      id: string;
      kind: string;
      ref: string | null;
      window_id: string | null;
      drawn: boolean | null;
      granted: string;
      remaining: string;
      held: string;
      live: boolean;
      still: string | null;
      charged: string;
      claims: string;
      repaid: string;
    }>
  >`
    WITH owned AS (
      SELECT l.*,
             CASE WHEN l.kind = 'monthly' THEN (SELECT w.source_ref FROM credit_windows w WHERE w.id = l.window_id)
                  WHEN l.kind = 'proration' THEN
                    (SELECT COALESCE(s.source_ref, w.source_ref)
                       FROM credit_window_level_changes s JOIN credit_windows w ON w.id = s.window_id
                      WHERE s.window_id = l.window_id
                        AND l.grant_key = 'proration:' || s.window_id::text || ':' || s.seq::text)
                  WHEN l.kind = 'adjustment' AND l.window_id IS NULL
                       AND starts_with(l.grant_key, 'reinstate:window:')
                    THEN split_part(l.grant_key, ':', 4)
             END AS ref,
             CASE WHEN l.kind IN ('monthly', 'proration') THEN l.window_id::text
                  WHEN l.kind = 'adjustment' AND l.window_id IS NULL
                       AND starts_with(l.grant_key, 'reinstate:window:')
                    THEN split_part(l.grant_key, ':', 3)
             END AS unit_window
        FROM credit_lots l
       WHERE l.account_id = ${accountId}::uuid
    )
    SELECT o.id::text AS id, o.kind, o.ref, o.unit_window AS window_id,
           (SELECT w.source_ref = o.ref FROM credit_windows w WHERE w.id::text = o.unit_window) AS drawn,
           o.granted_micro::text AS granted, o.remaining_micro::text AS remaining,
           o.held_micro::text AS held,
           (o.revoked_at IS NULL AND o.starts_at <= now() AND now() < o.expires_at) AS live,
           o.still_paid_minor::text AS still,
           COALESCE((SELECT -sum(x.lot_delta_micro) FROM credit_ledger x
                      WHERE x.lot_id = o.id AND x.kind = 'task_charge'), 0)::text AS charged,
           COALESCE((SELECT -sum(x.lot_delta_micro) FROM credit_ledger x
                      WHERE x.lot_id = o.id AND starts_with(x.idempotency_key, 'claim:')), 0)::text AS claims,
           COALESCE((SELECT -sum(x.lot_delta_micro) FROM credit_ledger x
                      WHERE x.lot_id = o.id AND x.kind = 'debt_repayment'), 0)::text AS repaid
      FROM owned o`;
  return rows.map((r) => ({
    lotId: r.id,
    kind: r.kind,
    ref: r.ref,
    windowId: r.window_id,
    drawn: r.drawn === true,
    granted: Number(r.granted),
    remaining: Number(r.remaining),
    held: Number(r.held),
    live: r.live,
    stillPaidAt: r.still === null ? null : Number(r.still),
    charged: Number(r.charged),
    claims: Number(r.claims),
    repaid: Number(r.repaid),
  }));
}

/** The plan-change steps that make up a unit's worth (0136): window, payment, delta, still paid then. */
async function stepFacts(
  accountId: string,
): Promise<Array<{ windowId: string; ref: string; delta: number; stillPaidAt: number | null }>> {
  const rows = await db()<Array<{ w: string; ref: string; delta: string; still: string | null }>>`
    SELECT s.window_id::text AS w, COALESCE(s.source_ref, w.source_ref) AS ref,
           s.delta_micro::text AS delta, s.still_paid_minor::text AS still
      FROM credit_window_level_changes s JOIN credit_windows w ON w.id = s.window_id
     WHERE w.account_id = ${accountId}::uuid AND s.reason = 'plan_change' AND s.delta_micro <> 0`;
  return rows.map((r) => ({
    windowId: r.w,
    ref: r.ref,
    delta: Number(r.delta),
    stillPaidAt: r.still === null ? null : Number(r.still),
  }));
}

/** Debt a plan change wrote (a downgrade's shortfall, and what its claims became): §3's "plan-change debt". */
async function planChangeDebtIncurred(accountId: string): Promise<number> {
  const [row] = await db()<Array<{ n: string }>>`
    SELECT COALESCE(sum(x.debt_delta_micro), 0)::text AS n FROM credit_ledger x
     WHERE x.account_id = ${accountId}::uuid AND x.kind = 'debt_incurred'
       AND (starts_with(x.idempotency_key, 'clawback:plan_change:')
            OR (starts_with(x.idempotency_key, 'claim_debt:')
                AND EXISTS (SELECT 1 FROM credit_clawbacks c
                             WHERE c.id::text = split_part(x.idempotency_key, ':', 2)
                               AND c.source = 'plan_change')))`;
  return Number(row?.n ?? '0');
}

/**
 * A payment's worth in one month (§1): every grant and plan-change step it
 * bought × still paid now ÷ still paid when granted, summed exactly, rounded
 * down to whole credits once; a payment of nothing keeps everything; a term
 * granted when nothing was still paid keeps all of itself or none of it.
 */
function worthMicro(
  paid: number,
  still: number,
  terms: readonly { micro: number; at: number | null }[],
): number {
  let num = 0n;
  let den = 1n;
  for (const t of terms) {
    let tn: bigint;
    let td: bigint;
    if (paid === 0) {
      tn = BigInt(t.micro);
      td = 1n;
    } else {
      const atMinor = t.at ?? paid;
      if (atMinor === 0) {
        tn = still > 0 ? BigInt(t.micro) : 0n;
        td = 1n;
      } else {
        tn = BigInt(t.micro) * BigInt(still);
        td = BigInt(atMinor);
      }
    }
    num = num * td + tn * den;
    den = den * td;
  }
  if (num <= 0n) return 0;
  const micro = num / den;
  return Number((micro / 1_000_000n) * 1_000_000n);
}

/** What the TEST knows of one Stripe payment in one world. */
function paymentFacts(
  w: World,
  shape: Shape,
  invoiceId: string,
): { inv: Inv; paid: number; still: number; annual: boolean } | null {
  const inv = (Object.keys(w.invoices) as Inv[]).find((k) => w.invoices[k] === invoiceId);
  if (inv === undefined) return null;
  const paid = paidFor(shape, inv);
  let disputed = 0;
  for (const d of w.disputesStanding.values()) if (d.invoiceId === invoiceId) disputed += d.amount;
  const still = Math.max(0, paid - (w.refunded.get(invoiceId) ?? 0) - Math.min(paid, disputed));
  return { inv, paid, still, annual: shape === 'annual' && (inv === 'base1' || inv === 'up') };
}

/** Invariants 1 and 2 on one world at rest (every task settled). Returns what is broken. */
async function closedForms(w: World, shape: Shape): Promise<string[]> {
  const out: string[] = [];
  const lots = await lotFacts(w.accountId);
  const steps = await stepFacts(w.accountId);
  const debt = await debtOf(db(), w.accountId);
  const planDebt = await planChangeDebtIncurred(w.accountId);

  // Units: one payment's credit in one month.
  const units = new Map<
    string,
    { windowId: string; ref: string; lots: LotFact[]; drawn: boolean }
  >();
  for (const lot of lots) {
    if (lot.ref === null || lot.windowId === null) continue;
    const key = `${lot.windowId}|${lot.ref}`;
    const u = units.get(key) ?? { windowId: lot.windowId, ref: lot.ref, lots: [], drawn: false };
    u.lots.push(lot);
    if (lot.drawn) u.drawn = true;
    units.set(key, u);
  }
  for (const s of steps) {
    const key = `${s.windowId}|${s.ref}`;
    if (!units.has(key))
      units.set(key, { windowId: s.windowId, ref: s.ref, lots: [], drawn: false });
  }
  // Worth, where the payment's own line decides it: a month drawn from it, or an upgrade line.
  const worthOf = (u: {
    windowId: string;
    ref: string;
    lots: LotFact[];
    drawn: boolean;
  }): number | null => {
    const pay = paymentFacts(w, shape, u.ref);
    if (pay === null) return null;
    if (!u.drawn && pay.inv !== 'up') return null;
    const terms: { micro: number; at: number | null }[] = [];
    for (const lot of u.lots) {
      if (lot.kind === 'monthly') terms.push({ micro: lot.granted, at: lot.stillPaidAt });
    }
    for (const s of steps) {
      if (s.windowId === u.windowId && s.ref === u.ref)
        terms.push({ micro: s.delta, at: s.stillPaidAt });
    }
    return worthMicro(pay.paid, pay.still, terms);
  };

  // ── invariant 1: no debt for unspent credit ──
  const perPayment = new Map<string, number>();
  let unitCount = 0;
  for (const u of units.values()) {
    unitCount += 1;
    let c = 0;
    let q = 0;
    for (const lot of u.lots) {
      c += lot.charged;
      q += lot.claims;
    }
    const k = worthOf(u) ?? 0;
    perPayment.set(u.ref, (perPayment.get(u.ref) ?? 0) + Math.max(0, c + q - k));
  }
  let allowed = 0;
  for (const [ref, owed] of perPayment) {
    const pay = paymentFacts(w, shape, ref);
    let bound = owed;
    if (pay !== null && pay.annual && pay.inv === 'base1' && w.capSpent.has(ref)) {
      // What the year still pays for (§1 rule 3): the allowance × 12, scaled, whole credits.
      const paidForKeep = Number(
        ((36_000_000_000n * BigInt(pay.still)) / BigInt(pay.paid) / 1_000_000n) * 1_000_000n,
      );
      bound = Math.min(bound, Math.max(0, (w.capSpent.get(ref) ?? 0) - paidForKeep));
    }
    allowed += bound;
  }
  const tolerance1 = MICRO * (unitCount + 1);
  if (debt > allowed + planDebt + tolerance1) {
    out.push(
      `invariant 1 (${w.label}): debt ${String(credits(debt))} > spent-beyond-worth ${String(credits(allowed))} + plan-change debt ${String(credits(planDebt))}`,
    );
  }

  // ── invariant 2: the paid-for ceiling, summed over the account ──
  let held = 0;
  let used = 0;
  for (const lot of lots) {
    held += lot.held;
    used += (lot.live ? lot.remaining - lot.held : 0) + lot.held + lot.charged;
  }
  // A month's target is its worth, or — annual, where the frozen cap may excuse
  // debt — at most what was used out of it (spent, repaid, claimed) when that is more.
  const kUnitLots = new Set<string>();
  const annualRefs = new Set<string>();
  let ceiling = 0;
  for (const u of units.values()) {
    const k = worthOf(u);
    if (k === null) continue;
    for (const lot of u.lots) kUnitLots.add(lot.lotId);
    const pay = paymentFacts(w, shape, u.ref);
    if (pay !== null && pay.annual) {
      let usedOut = 0;
      for (const lot of u.lots) usedOut += lot.charged + lot.repaid + lot.claims;
      ceiling += Math.max(k, usedOut);
      annualRefs.add(u.ref);
    } else ceiling += k;
  }
  for (const ref of annualRefs) ceiling += w.heldAtReversal.get(ref) ?? 0;
  for (const lot of lots) if (!kUnitLots.has(lot.lotId)) ceiling += lot.granted;
  const tolerance2 = MICRO * (lots.length + 1);
  if (used - debt > ceiling + tolerance2) {
    out.push(
      `invariant 2 (${w.label}): held + spent − debt ${String(credits(used - debt))} > paid for ${String(credits(ceiling))}${held > 0 ? ' (tasks still hold credit)' : ''}`,
    );
  }
  return out;
}

/** Σ remaining over one payment's own lots (every unit it has): invariant 7's "the reversed payment's own units". */
async function paymentLotsRemaining(accountId: string, invoiceId: string): Promise<number> {
  let micro = 0;
  for (const lot of await lotFacts(accountId)) if (lot.ref === invoiceId) micro += lot.remaining;
  return micro;
}

/** Before a reversal or a win lands: the frozen-cap figure (C+Q+H of the payment's lots), B1 and held. */
async function measureBefore(w: World, invoiceId: string, shape: Shape): Promise<void> {
  let figure = 0;
  let heldOnPayment = 0;
  let heldAll = 0;
  for (const lot of await lotFacts(w.accountId)) {
    heldAll += lot.held;
    if (lot.ref !== invoiceId) continue;
    figure += lot.charged + lot.claims + lot.held;
    heldOnPayment += lot.held;
  }
  w.capSpent.set(invoiceId, Math.max(w.capSpent.get(invoiceId) ?? 0, figure));
  const pay = paymentFacts(w, shape, invoiceId);
  if (pay !== null && pay.annual) {
    w.heldAtReversal.set(invoiceId, Math.max(w.heldAtReversal.get(invoiceId) ?? 0, heldOnPayment));
  }
  w.maxHeld = Math.max(w.maxHeld, heldAll);
}

async function ledgerMark(accountId: string): Promise<number> {
  const [row] = await db()<Array<{ n: string }>>`
    SELECT COALESCE(max(id), 0)::text AS n FROM credit_ledger WHERE account_id = ${accountId}::uuid`;
  return Number(row?.n ?? '0');
}

interface SeedRun {
  readonly seed: number;
  readonly plan: Plan;
  readonly w: World;
  readonly t: World;
  /** The monotone config's third world: W with one refund raised or one more lost dispute. */
  readonly x: World | null;
  readonly trace: string[];
  failure: string | null;
  // ── §3 exactness evidence ──
  /** A coupled spend or hold drew from different lots (kind and expiry) in W and T. */
  displaced: boolean;
  /** A reversal landed while a won dispute stood and a task held credit (B1 can differ). */
  reversalOverTasks: boolean;
  /** A win in W wrote a lot of its own (R-K): the credit it returned lasts as long as it must, not as the twin's. */
  winNewLot: boolean;
  /** B5: invoices a dispute was WON on in W. */
  readonly wonPayments: Set<string>;
  /** B5: annual invoices refunded or disputed again in W after one of their disputes was won. */
  readonly annualReversedAfterWin: Set<string>;
  /** Won disputes standing in W, with the ledger mark at their `created`. */
  readonly standingWon: Map<string, number>;
  /** W's ledger id ranges (from, to] while a won dispute stood. */
  readonly standingRanges: Array<readonly [number, number]>;
}

/** The lots that are no month's own: goodwill, top-ups, and what a reconciliation or a win wrote. */
async function adjustmentLotCount(accountId: string): Promise<number> {
  const [row] = await db()<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM credit_lots
     WHERE account_id = ${accountId}::uuid AND kind = 'adjustment'`;
  return row?.n ?? 0;
}

/** B5's bound: what the wins returned to these payments as lots of their own (`reinstate:window:<w>:<payment>:…:returned`). */
async function returnedToPayments(
  accountId: string,
  invoiceIds: ReadonlySet<string>,
): Promise<number> {
  if (invoiceIds.size === 0) return 0;
  const rows = await db()<Array<{ ref: string; granted: string }>>`
    SELECT split_part(grant_key, ':', 4) AS ref, granted_micro::text AS granted FROM credit_lots
     WHERE account_id = ${accountId}::uuid AND kind = 'adjustment'
       AND starts_with(grant_key, 'reinstate:window:') AND right(grant_key, 9) = ':returned'`;
  let micro = 0;
  for (const r of rows) if (invoiceIds.has(r.ref)) micro += Number(r.granted);
  return micro;
}

/** Credit an account's annual claims were DROPPED of (B1, rule 3): the builder's `drop:` records. */
async function droppedClaimsMicro(accountId: string): Promise<number> {
  const [row] = await db()<Array<{ n: string }>>`
    SELECT COALESCE(sum(amount_micro), 0)::text AS n FROM credit_clawbacks
     WHERE account_id = ${accountId}::uuid AND starts_with(source_ref, 'drop:')`;
  return Number(row?.n ?? '0');
}

/** Deliver one reversal to one world, with invariant 7's direction check. Returns its outcome. */
async function deliverChecked(run: SeedRun, world: World, e: Reversal): Promise<string> {
  const invoiceId = world.invoices[e.inv];
  if (invoiceId === null) return 'no invoice';
  await measureBefore(world, invoiceId, run.plan.shape);
  // Invariant 7 has no clause for a win (Amendment 1, R-B). R-K: whether W's
  // win wrote a lot of its own (the credit it returned as a new lot).
  if (e.k === 'won') {
    const lotsBefore = await adjustmentLotCount(world.accountId);
    const outcome = await deliver(world, e);
    if (world === run.w && (await adjustmentLotCount(world.accountId)) > lotsBefore) {
      run.winNewLot = true;
    }
    return outcome;
  }
  const before = await paymentLotsRemaining(world.accountId, invoiceId);
  const outcome = await deliver(world, e);
  const after = await paymentLotsRemaining(world.accountId, invoiceId);
  if (after > before && run.failure === null) {
    run.failure = `invariant 7 (${world.label}): the ${describeEvent(e)} raised its own payment's lots ${String(credits(before))} → ${String(credits(after))}`;
  }
  return outcome;
}

/** One event, in every world (W's own checks included). Returns a failure, or null. */
async function step(run: SeedRun, e: Ev): Promise<string | null> {
  const { w, t, x, trace } = run;
  const all = x === null ? [w, t] : [w, t, x];
  const minSpendable = async (): Promise<number> => {
    let m = Number.MAX_SAFE_INTEGER;
    for (const world of all) m = Math.min(m, await h().ledger.spendableMicro(world.accountId));
    return m;
  };
  switch (e.k) {
    case 'spend': {
      // A spend is a task of its own: with three tasks already running there
      // is no slot for it (at most three enforced tasks per account).
      if (all.some((world) => world.holds.length >= 3)) return null;
      const most = Math.floor((await minSpendable()) / QUARTER);
      if (most <= 0) return null;
      const micro = (1 + Math.floor(e.r * most)) * QUARTER;
      const wb = await spendInOrder(w, micro);
      const tb = await spendInOrder(t, micro);
      if (x !== null) await spendInOrder(x, micro);
      if (wb !== tb) run.displaced = true;
      trace.push(`spend ${String(credits(micro))}`);
      const before = await footprint(w);
      await h().grants.refreshCredits(w.accountId);
      const after = await footprint(w);
      return JSON.stringify(before) === JSON.stringify(after)
        ? null
        : `invariant 5: the refresh after a spend wrote: ${changed(before, after)}`;
    }
    case 'refresh':
      for (const world of all) await h().grants.refreshCredits(world.accountId);
      return null;
    case 'topUp': {
      const expiresAt = await sharedExpiry(360);
      for (const world of all) {
        world.nth += 1;
        await buyTopUp(
          world.accountId,
          e.amount,
          `${world.tag}_tu_${String(world.nth)}`,
          expiresAt,
        );
      }
      trace.push(describeEvent(e));
      return null;
    }
    case 'goodwill': {
      const expiresAt =
        e.seconds !== undefined ? await sharedExpirySeconds(e.seconds) : await sharedExpiry(e.days);
      for (const world of all) await goodwillLot(world, e.amount, expiresAt);
      trace.push(describeEvent(e));
      return null;
    }
    case 'hold': {
      if (all.some((world) => world.holds.length >= 3)) return null;
      const most = Math.floor((await minSpendable()) / QUARTER);
      if (most <= 0) return null;
      const micro = (1 + Math.floor(e.r * most)) * QUARTER;
      const hw = await holdInOrder(w, micro);
      const ht = await holdInOrder(t, micro);
      w.holds.push(hw.id);
      t.holds.push(ht.id);
      if (x !== null) x.holds.push((await holdInOrder(x, micro)).id);
      if (hw.buckets !== ht.buckets) run.displaced = true;
      for (const world of all) {
        world.maxHeld = Math.max(world.maxHeld, await h().ledger.heldMicro(world.accountId));
      }
      trace.push(`a task holds ${String(credits(micro))}`);
      return null;
    }
    case 'settle': {
      if (all.some((world) => world.holds.length === 0)) return null;
      const held = await reservedOf(w.holds[0] as string);
      const charged = Math.floor((e.r * held) / QUARTER) * QUARTER;
      for (const world of all) await settleHold(world, world.holds.shift() as string, charged);
      trace.push(
        `the oldest task settles, charged ${String(credits(charged))} of ${String(credits(held))}`,
      );
      const before = await footprint(w);
      await h().grants.refreshCredits(w.accountId);
      const after = await footprint(w);
      return JSON.stringify(before) === JSON.stringify(after)
        ? null
        : `invariant 5: the refresh after a settle wrote: ${changed(before, after)}`;
    }
    case 'resubscribeInMonth1': {
      for (const world of all) await resubscribeInMonth1(world);
      trace.push(describeEvent(e));
      return null;
    }
    case 'crypto': {
      const second = await wholeSecondNow();
      for (const world of all) {
        world.cryptoOrder = await cryptoEntitlement(db(), world.accountId, {
          tier: 'api_builder',
          orderId: `ord_tw_${world.tag}`,
          starts: `(${at(second)} - interval '1 second')`,
          expires: `(${at(second)} + interval '31 days')`,
        });
        // The activation refreshes the account.
        await h().grants.refreshCredits(world.accountId);
      }
      trace.push(describeEvent(e));
      return null;
    }
    case 'cryptoRefund': {
      if (all.some((world) => world.cryptoOrder === null)) return null;
      const second = await wholeSecondNow();
      for (const world of all) {
        // The refund revokes the entitlement at the refund instant, then takes
        // the credits back (crypto-tier-activation's order).
        await db()`
          UPDATE crypto_entitlements SET expires_at = ${second}::timestamptz
           WHERE order_id = ${world.cryptoOrder} AND expires_at > ${second}::timestamptz`;
        await svc().applyCryptoRefund({
          accountId: world.accountId,
          orderId: world.cryptoOrder ?? '',
        });
      }
      trace.push(describeEvent(e));
      const before = await footprint(w);
      await h().grants.refreshCredits(w.accountId);
      const after = await footprint(w);
      for (const world of all) if (world !== w) await h().grants.refreshCredits(world.accountId);
      return JSON.stringify(before) === JSON.stringify(after)
        ? null
        : `invariant 5: the refresh after the ${describeEvent(e)} wrote: ${changed(before, after)}`;
    }
    case 'plan': {
      const second = await wholeSecondNow();
      for (const world of all) await changePlan(world, e.to, run.plan.shape, second);
      trace.push(describeEvent(e));
      return null;
    }
    case 'resub': {
      const second = await wholeSecondNow();
      for (const world of all) await resubscribe(world, second);
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
        : `invariant 5: a replay of the ${describeEvent(again)} changed: ${changed(before, after)}`;
    }
    case 'xOnly': {
      if (x === null) return null;
      const outcome = await deliverChecked(run, x, e.e);
      trace.push(`${describeEvent(e)} (X ${outcome})`);
      await h().grants.refreshCredits(x.accountId);
      return null;
    }
    default: {
      const inTwin = !(e.k !== 'refund' && run.plan.won.has(e.d));
      // §3 exactness: a reversal that lands while a won dispute stands and a task
      // holds credit can leave W's claims shaped unlike T's (B1).
      if (run.standingWon.size > 0 && !(e.k === 'won' && run.standingWon.has(e.d))) {
        if ((await h().ledger.heldMicro(w.accountId)) > 0) run.reversalOverTasks = true;
      }
      if (e.k === 'created' && run.plan.won.has(e.d) && !run.standingWon.has(e.d)) {
        if (!w.disputesWon.has(e.d)) run.standingWon.set(e.d, await ledgerMark(w.accountId));
      }
      if (e.k === 'won' && run.standingWon.has(e.d)) {
        run.standingRanges.push([run.standingWon.get(e.d) ?? 0, await ledgerMark(w.accountId)]);
        run.standingWon.delete(e.d);
      }
      // B5: an annual payment refunded or disputed again after a won dispute.
      const invoiceW = w.invoices[e.inv];
      if (invoiceW !== null && e.k !== 'won' && run.wonPayments.has(invoiceW)) {
        if (run.plan.shape === 'annual' && e.inv !== 'resub')
          run.annualReversedAfterWin.add(invoiceW);
      }
      const inW = await deliverChecked(run, w, e);
      if (invoiceW !== null && e.k === 'won') run.wonPayments.add(invoiceW);
      w.delivered.push(e);
      const inT = inTwin ? await deliverChecked(run, t, e) : 'not in the twin';
      const inX = x === null ? null : await deliverChecked(run, x, e);
      trace.push(`${describeEvent(e)} (W ${inW}, T ${inT}${inX === null ? '' : `, X ${inX}`})`);
      const before = await footprint(w);
      await h().grants.refreshCredits(w.accountId);
      const after = await footprint(w);
      for (const world of all) if (world !== w) await h().grants.refreshCredits(world.accountId);
      return JSON.stringify(before) === JSON.stringify(after)
        ? null
        : `invariant 5: the refresh after the ${describeEvent(e)} wrote: ${changed(before, after)}`;
    }
  }
}

async function runMonth(run: SeedRun, events: readonly Ev[]): Promise<void> {
  for (const e of events) {
    if (run.failure !== null) return;
    try {
      const found = await step(run, e);
      if (run.failure === null) run.failure = found;
    } catch (err) {
      run.failure = `the ${describeEvent(e)} threw: ${failureMessage(err)}`;
    }
  }
}

/** §3: whether this seed's trace allows exact twin equality (see the header). */
async function exactnessHolds(run: SeedRun): Promise<boolean> {
  if (run.plan.won.size === 0) return true;
  if (!run.plan.winsInOwnMonth || run.displaced || run.reversalOverTasks || run.winNewLot) {
    return false;
  }
  // Any debt repayment in W while a won dispute stood (the design's "debt repaid
  // from credit that later expired" is the case of it that needs no displaced spend).
  const ranges = [...run.standingRanges];
  for (const from of run.standingWon.values()) ranges.push([from, Number.MAX_SAFE_INTEGER]);
  for (const [from, to] of ranges) {
    const [row] = await db()<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM credit_ledger
       WHERE account_id = ${run.w.accountId}::uuid AND kind = 'debt_repayment'
         AND id > ${from} AND id <= ${to}`;
    if ((row?.n ?? 0) > 0) return false;
  }
  return true;
}

/** Credit the won disputes could have removed: (dispute ÷ paid) × what the payment granted (B2). */
async function removedBound(run: SeedRun): Promise<number> {
  const lots = await lotFacts(run.w.accountId);
  let micro = 0;
  const seen = new Set<string>();
  for (const list of [run.plan.month1, run.plan.month2]) {
    for (const e of list) {
      if (e.k !== 'created' || !run.plan.won.has(e.d) || seen.has(e.d)) continue;
      seen.add(e.d);
      const invoiceId = run.w.invoices[e.inv];
      if (invoiceId === null) continue;
      let granted = 0;
      for (const lot of lots) if (lot.ref === invoiceId) granted += lot.granted;
      const paid = paidFor(run.plan.shape, e.inv);
      micro += Math.ceil((granted * Math.min(e.amount, paid)) / paid);
    }
  }
  return micro;
}

/** At rest, every invariant of §3 that compares worlds, and the closed forms on each. */
async function judge(run: SeedRun): Promise<string | null> {
  const { w, t, x, plan } = run;
  const found: string[] = [];
  for (const world of x === null ? [w, t] : [w, t, x]) {
    found.push(...(await closedForms(world, plan.shape)));
  }
  const bw = await microBalances(w.accountId);
  const bt = await microBalances(t.accountId);
  // Invariant 3: never worse off than the twin; levels exactly equal. The
  // tolerance is one credit plus what the twin was DROPPED of its annual
  // claims beyond W (Amendment 3, R-J), plus B5 (Amendment 4): what the wins
  // returned to an annual payment reversed again after a won dispute — zero
  // on every other seed.
  const b5 = await returnedToPayments(w.accountId, run.annualReversedAfterWin);
  const tolerance =
    MICRO +
    Math.max(0, (await droppedClaimsMicro(t.accountId)) - (await droppedClaimsMicro(w.accountId))) +
    b5;
  if (bt.spendable - bw.spendable >= tolerance) {
    found.push(
      `invariant 3: W spendable ${String(credits(bw.spendable))} < twin ${String(credits(bt.spendable))}`,
    );
  }
  if (bw.debt - bt.debt >= tolerance) {
    found.push(
      `invariant 3: W debt ${String(credits(bw.debt))} > twin ${String(credits(bt.debt))}`,
    );
  }
  if (bw.level !== bt.level) {
    found.push(
      `invariant 3: W level ${String(credits(bw.level))} ≠ twin ${String(credits(bt.level))}`,
    );
  }
  const tw = await termsOf(w.accountId);
  const tt = await termsOf(t.accountId);
  const gap = dominanceGap(tw, tt, tolerance);
  if (gap !== null) found.push(`invariant 3 (dominance): ${gap}`);
  if (b5 > 0 && found.some((f) => f.startsWith('invariant 3'))) {
    found.push(`(B5 allowed ${String(credits(b5))} below the twin)`);
  }
  // Invariant 4: the win cap.
  const cap = (await removedBound(run)) + Math.max(w.maxHeld, t.maxHeld) + MICRO;
  if (bw.spendable - bt.spendable > cap) {
    found.push(
      `invariant 4: W spendable ${String(credits(bw.spendable))} > twin ${String(credits(bt.spendable))} + ${String(credits(cap))}`,
    );
  }
  if (bt.debt - bw.debt > cap) {
    found.push(
      `invariant 4: twin debt ${String(credits(bt.debt))} > W ${String(credits(bw.debt))} + ${String(credits(cap))}`,
    );
  }
  // §3: exact equality where the trace allows it.
  if (await exactnessHolds(run)) {
    const apart =
      Math.abs(bw.spendable - bt.spendable) >= MICRO ||
      Math.abs(bw.debt - bt.debt) >= MICRO ||
      bw.level !== bt.level;
    if (apart) found.push(`exact seed: W ${oneLine(bw)} ≠ twin ${oneLine(bt)}`);
    else {
      const terms = termsApart(tw, tt);
      if (terms !== null) found.push(`exact seed: W ${oneLine(bw)} = twin, but ${terms}`);
    }
  }
  // Invariant 6: one more refund or lost dispute never raises net position.
  if (x !== null) {
    const bx = await microBalances(x.accountId);
    const netX = bx.spendable - bx.debt;
    const netW = bw.spendable - bw.debt;
    if (netX - netW >= MICRO) {
      found.push(`invariant 6: X net ${String(credits(netX))} > W net ${String(credits(netW))}`);
    }
  }
  return found.length === 0 ? null : found.join(' | ');
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
      x: cfg.monotone === true ? await makeWorld('X', seed, attempt, plan.shape, boundary) : null,
      trace: [plan.summary],
      failure: null,
      displaced: false,
      reversalOverTasks: false,
      winNewLot: false,
      wonPayments: new Set(),
      annualReversedAfterWin: new Set(),
      standingWon: new Map(),
      standingRanges: [],
    });
  }
  for (const run of batch) await runMonth(run, run.plan.month1);
  if (await isPast(boundary)) return null;
  await waitPast(boundary);
  for (const run of batch) {
    if (run.failure !== null) continue;
    const all = run.x === null ? [run.w, run.t] : [run.w, run.t, run.x];
    for (const world of all) await h().grants.refreshCredits(world.accountId);
    run.trace.push('— month 2 —');
    await runMonth(run, run.plan.month2);
    if (run.failure !== null) continue;
    if (run.w.holds.length > 0) {
      // Every task still running settles, having charged nothing more, before
      // the worlds are compared: the invariants are stated at rest.
      try {
        while (run.w.holds.length > 0) {
          for (const world of all) await settleHold(world, world.holds.shift() as string, 0);
          run.trace.push('a task still running settles, charged 0');
        }
        for (const world of all) await h().grants.refreshCredits(world.accountId);
      } catch (err) {
        run.failure = `the final settle threw: ${failureMessage(err)}`;
        continue;
      }
    }
    try {
      run.failure = await judge(run);
    } catch (err) {
      run.failure = `judging threw: ${failureMessage(err)}`;
    }
  }
  return batch;
}

/** Runs one configuration's seeds, a batch at a time around a shared month boundary. */
async function runConfig(cfg: Config): Promise<SeedRun[]> {
  const seeds = Array.from({ length: cfg.seeds ?? SEEDS_PER_CONFIG }, (_, i) => cfg.firstSeed + i);
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
        ...(await periodOf(c.invoiceId)),
      });
      await h().grants.refreshCredits(c.accountId);
      // One clock reading for the plan change: the mirror's tier_since and the
      // upgrade line's start are the same instant.
      const upFrom = `(${at(await wholeSecondNow())} - interval '1 hour')`;
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
        ...(await periodOf(c.invoiceId)),
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
          ...(await periodOf(c.invoiceId)),
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
      it(`CRITICAL ${String(cfg.seeds ?? SEEDS_PER_CONFIG)} seeded two-month sequences under "${cfg.name}" keep every invariant of the reversal policy, and are exact where the trace allows`, async () => {
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
        // No wall-clock bound: about a minute a configuration locally; the
        // timeout is only the backstop for a hang (a slow run retries its boundary).
      }, 480_000);
    }
  },
);
