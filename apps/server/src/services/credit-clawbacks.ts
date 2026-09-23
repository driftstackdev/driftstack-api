// S17 — refunds and chargebacks take credits back, any shortfall becomes debt,
// and a won dispute restores what it took. Plan §6.7 and findings H2, L5, M6, M8,
// as corrected by the independent audit of S17 and its re-audit.
//
// ⛔ A REVERSAL IS MEASURED ON STATE, NOT ON THE EVENT. What a refund or a
// dispute takes back is decided from where the invoice's credit stands NOW and
// how much of the payment is reversed IN TOTAL — never "the fraction this event
// adds, of what the lots ever held". The event-based rule put debt on credit
// nobody spent whenever an earlier reversal or an expiry had already moved the
// credit (audit #1), rounded two refunds of the whole payment into more than the
// whole (#11), and let a dispute after a refund reverse more than was still paid
// (#7). For invoice I and each window W it earned:
//
//   s  what I still pays: paid − refunded − disputed, never below 0. A dispute
//      counts while it stands; a won one is taken off.
//   the lots of W that I paid for: W's monthly lot when W was drawn from I, the
//      proration lots of the steps keyed to I (0136), and the lots a won
//      dispute of I gave back for W. Never another invoice's lot, never a
//      goodwill or bought lot, never the credit a win returns to no invoice.
//   E  what the customer keeps: for each lot I bought (not a give-back),
//      `floor_whole(granted × s / what I still paid when it was granted)`
//      (0137, re-audit #5) — a month granted after a half refund was granted
//      at half, so a refund to three quarters leaves it half of its grant, not
//      a quarter. A lot written before 0137 is measured against the whole
//      payment. Whole credits, like every level and every grant.
//   S  what left those lots on the customer's work: task charges, debt repaid,
//      and claims OTHER clawbacks collected from them (re-audit #12);
//   L  what they still hold, held credit included;
//   O  what the clawbacks that still stand against I's credit in W already
//      asked beyond what they took from these lots: I's refunds and disputes
//      there, and the window's plan changes attributed to I (re-audit #4: a
//      downgrade's debt is spend already charged for) — their debt, their
//      standing claims, and the claims they collected from any OTHER lot.
//
// The customer keeps E. Everything they hold or spent above it, less what the
// standing clawbacks already charged for, is taken now: `S + L − E − O`, out of
// L first (free credit taken, held credit a pending claim), and the rest —
// credit that was spent — is debt. Nothing when that is 0 or less: no row is
// written for W. So a second refund after the first refund's credit expired
// finds nothing to take, two refunds of the whole owe exactly what was spent,
// and a delivery repeated or out of order recomputes the same state and takes
// nothing more (L5 still keys each distinct cumulative once).
//
// ⛔ O COUNTS STANDING CLAIMS, NOT ONLY DEBT. A task holds the whole 3,000-credit
// month when the invoice is fully refunded — the clawback is 3,000 of PENDING
// claim and 0 debt; a dispute of the same charge before the task settles must
// see that as already asked, or the customer owes 2,500 for 1,000 spent.
//
// ⛔ AN ANNUAL INVOICE'S DEBT IS CAPPED ACROSS ITS WINDOWS — AN INTERIM RULE
// PENDING THE OWNER (audit #6). Applied per window, a refund of half a year
// canceled in month one owes half of the month the customer used, although six
// months are still paid for and one was used. Until the owner rules, the debt a
// reversal creates across ALL of an invoice's windows is capped at
// `max(0, ΣS − floor_whole(s/paid × what the payment bought))`. What a PERIOD
// line bought is its plan allowance × the months it pays for (12 a year, 1 a
// month). An ANNUAL UPGRADE (`proration_up`) line bought the step up
// `(upper − from) × the calendar months the line spans`, under the same cap
// (re-audit #8: it had been left uncapped, so half a refund of an upgrade whose
// month was spent owed half that month although the payment still covered about
// 41,000 credits of step-up); a MONTHLY upgrade line stays uncapped — it bought
// its prorated lot and nothing more. The cap only ever LOWERS debt.
//
// ⛔ THE LEVEL FOLLOWS ALL COVERAGE, NOT THE INVOICE ALONE (audit #4, #16).
// After a reversal the invoice's CURRENT window moves to the level every paid
// coverage over now() earns together — the same query the next reconciliation
// runs, so that refresh finds nothing to do. When nothing covers now — the
// subscription canceled before the refund arrived — the level falls by the
// share of what was still paid that this event reverses, not to zero. The
// level change records 0 as its delta: the credits moved are the clawback's
// rows (audit #14).
//
// ⛔ WHEN ANOTHER PAYMENT NOW COVERS THE MONTH BEST (re-audit #7, M8). If the
// best coverage after the reversal is ANOTHER payment that stands on its own —
// a resubscription's month, a crypto term, an override; not an upgrade line,
// which pays only for the step above the month beneath it — the month is
// handed over: the level falls to what the reversed invoice ALONE still covers,
// and `reconcileLevel` raises it again for the other payment, prorated from
// that payment's start and net of the lots it was already granted in the
// month. A customer who resubscribed before the old invoice was refunded gets
// the new subscription's month (they had kept nothing of it: the old level
// already matched); the order half refund → resubscribe → three-quarter refund
// ends the same way (it left 2,250 of 3,000).
//
// A WON DISPUTE (M6) takes the account's credit lock FIRST and only then locks
// the dispute's clawbacks (a settlement takes them in that order, audit #13).
// Whether or not the dispute took anything, the invoice's disputed amount is
// lowered by the dispute's and the window's level put back (audit #2). Each
// clawback the dispute wrote is reversed and its pending claim zeroed in one
// statement (audit #3), the debt it created forgiven as far as it is still
// owed, and what it took given back, rounded UP to a whole credit (a lot holds
// only whole credits; re-audit #1):
//
//   · to the invoice, as `reinstate:<clawback>` — the credit it clawed and the
//     claims it collected from the invoice's own lots of that month — only
//     while that month is still running: credit clawed in a month that has
//     since ended would have expired with it (M6);
//   · to NO invoice, as `reinstate:<clawback>:returned` — the claims it
//     collected from other lots (a bought top-up, another invoice's month;
//     re-audit #10) and the part of its debt that later credit already repaid
//     (re-audit #2: the next month's grant usually repays a spent month's
//     dispute before the win, which then gave back nothing) — expiring with
//     the account's CURRENT month. It belongs to no invoice because it replaces
//     credit no refund of this invoice may take back: the refund of the lot it
//     came from already counts it as spent. With no month over now there is
//     nothing for it to belong to, and nothing is returned.
//
// Then the month's level is put back: as far as the dispute's own level drops
// went, as a plain move (the credit came back above); beyond that — a month
// drawn while the dispute stood — through the upgrade arithmetic, as a
// prorated lot of a `dispute_reinstated` step (re-audit #6), which is a
// give-back, not more of what the payment bought. Months that ENDED while the
// dispute stood are not brought back: that is M6's rule, not a limitation.
// Last, the invoice is settled at its CURRENT refunded share by the same
// state-based pass a refund runs, keyed to the win (`<dispute>:won`, re-audit
// #3): a refund that landed while the dispute stood is applied now, and any
// whole-credit rounding above what the payment still pays for is trimmed, so a
// refund, a dispute and its win end in the same state in either order.
//
// A dispute is remembered by its id whatever it took (re-audit #13): one that
// wrote no clawback row leaves a record row (`invoice:<invoice>`), and a win
// for a dispute nothing recorded writes that record as reversed. A `created`
// or `funds_withdrawn` delivered again — or late — finds it and changes
// nothing.
//
//   · A crypto order refunded is s = 0 on the term that order bought.
//   · A refund whose invoice has not been recorded yet (it arrived before
//     `invoice.paid`) is refused with `CreditReversalAwaitsPaymentError`, which
//     the webhook lets through so Stripe redelivers it (audit #8) — for 48
//     hours; after that the webhook keeps it for review (re-audit #14). A
//     charge that names no invoice at all is kept for review: logged at error
//     with the charge, alerted without it. Nothing is guessed.
//
// ⛔ ONE ACCOUNT, ONE TRANSACTION, UNDER THE CREDIT LOCK. The payment row's
// amounts, the level change and every ledger row commit together or not at all,
// so a redelivery that arrives mid-way finds either everything or nothing.
// Nothing here fails a webhook for a customer-visible reason: the caller decides
// what a thrown error means for the delivery (a transient one is retried by the
// provider; any other is recorded as a failed event and alerted).

import { sql } from 'drizzle-orm';
import {
  AccountTierSchema,
  AI_PLAN_ENTITLEMENTS,
  addUtcMonths,
  ceilMicroToWholeCredits,
  floorMicroToWholeCredits,
  planMonthlyCreditsMicro,
  proratedWholeCreditsMicro,
  type AiDebtReason,
} from '@driftstack/api-types';
import type { CreditLedgerTx, DrizzleCreditLedgerRepo } from '../db/credit-ledger-repo.js';
import { rowsOf } from '../db/credit-ledger-repo.js';
import type {
  CreditClawbackRecord,
  CreditClawbackSource,
  CreditWindowLevelChangeReason,
  CreditWindowSource,
  DrizzleCreditWindowsRepo,
  PgInstant,
  ReversalLot,
  SourcedCreditWindow,
} from '../db/credit-windows-repo.js';
import type { CreditGrantsService } from './credit-grants.js';
import type { Logger } from '../lib/logger.js';
import type { SentryClient } from '../lib/sentry.js';

/** Parts per million: the unit an outcome reports a share of a payment in. */
export const PPM = 1_000_000;

const MICRO_PER_CREDIT = 1_000_000n;

/**
 * The share of a payment reversed so far, in parts per million, rounded to the
 * nearest part and clamped to the whole. INFORMATIONAL: it is what an outcome
 * reports. No amount is computed from it — every amount is exact integer
 * arithmetic on minor units (`stillPaidForMicro`), because shares rounded one
 * event at a time can add up to more than the whole (audit #11).
 */
export function reversedFractionPpm(reversedMinor: number, amountPaidMinor: number): number {
  if (!Number.isSafeInteger(reversedMinor) || !Number.isSafeInteger(amountPaidMinor)) {
    throw new RangeError('a reversal and a payment are whole minor units');
  }
  if (amountPaidMinor <= 0 || reversedMinor <= 0) return 0;
  return Math.min(PPM, Math.round((reversedMinor * PPM) / amountPaidMinor));
}

function wholeMinor(what: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} is a whole non-negative number of minor units`);
  }
  return value;
}

function wholeMicro(what: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} is a whole non-negative number of microcredits`);
  }
  return value;
}

/**
 * E — the part of `grantedMicro` the customer still paid for once
 * `reversedMinor` of a payment of `amountPaidMinor` is refunded or disputed:
 * `floor(granted × (paid − reversed) / paid)`. Rounded DOWN, in exact integer
 * arithmetic. A payment of nothing reverses nothing; a reversal beyond the
 * payment reverses the whole of it.
 */
export function stillPaidForMicro(
  grantedMicro: number,
  amountPaidMinor: number,
  reversedMinor: number,
): number {
  wholeMicro('a grant', grantedMicro);
  wholeMinor('a payment', amountPaidMinor);
  wholeMinor('a reversal', reversedMinor);
  if (amountPaidMinor === 0) return grantedMicro;
  const kept = BigInt(amountPaidMinor - Math.min(amountPaidMinor, reversedMinor));
  return Number((BigInt(grantedMicro) * kept) / BigInt(amountPaidMinor));
}

/**
 * What one lot keeps once the payment that bought it still pays
 * `amountPaidMinor − reversedMinor`: its grant scaled by what is still paid
 * over what was still paid WHEN IT WAS GRANTED (`stillPaidAtGrantMinor`, 0137;
 * null — a lot written before 0137 — is the whole payment), rounded DOWN to
 * whole credits (S17 re-audit #5). A lot granted while part of the payment
 * stood reversed keeps MORE than its grant once that part is put back (a won
 * dispute): the month it belongs to is then worth more than it was granted,
 * and the win's give-back makes up the difference. A payment of nothing
 * reverses nothing.
 */
export function lotKeepMicro(
  grantedMicro: number,
  amountPaidMinor: number,
  stillPaidAtGrantMinor: number | null,
  reversedMinor: number,
): number {
  wholeMicro('a grant', grantedMicro);
  wholeMinor('a payment', amountPaidMinor);
  wholeMinor('a reversal', reversedMinor);
  if (amountPaidMinor === 0) return grantedMicro;
  const stillPaid = amountPaidMinor - Math.min(amountPaidMinor, reversedMinor);
  const atGrant =
    stillPaidAtGrantMinor === null
      ? amountPaidMinor
      : wholeMinor('still paid', stillPaidAtGrantMinor);
  // A lot granted when nothing was still paid cannot be written (a wholly
  // reversed payment covers nothing); if one were, it keeps all or nothing.
  if (atGrant === 0) return stillPaid > 0 ? grantedMicro : 0;
  const scaled = (BigInt(grantedMicro) * BigInt(stillPaid)) / BigInt(atGrant);
  return Number((scaled / MICRO_PER_CREDIT) * MICRO_PER_CREDIT);
}

/** Where one invoice's credit in one window stands, as a reversal reads it. */
export interface ReversalWindowState {
  /** E — what the invoice's own lots keep at what is still paid (`lotKeepMicro`, summed). */
  readonly keepMicro: number;
  /** S — what left those lots on the customer's work: task charges, debt repaid, others' claims. */
  readonly consumedMicro: number;
  /** L — what those lots still hold, held credit included. */
  readonly remainingMicro: number;
  /** What running tasks hold of those lots. */
  readonly heldMicro: number;
  /** O — what the clawbacks standing against this credit already asked beyond these lots. */
  readonly owedMicro: number;
}

/** What one window gives up to a reversal. */
export interface WindowReversalPlan {
  /** What `clawBack` is asked for: `fromLotsMicro + beyondLotsMicro`. 0: nothing is written. */
  readonly amountMicro: number;
  /** Taken out of the lots: their free credit, and their held credit as a pending claim. */
  readonly fromLotsMicro: number;
  /** Credit that was spent: debt (or a claim on other held credit). */
  readonly beyondLotsMicro: number;
}

/**
 * What one window gives up: everything the customer holds or spent above what
 * they keep, less what the standing clawbacks already asked beyond the lots —
 * out of the lots first, and what the lots cannot give is the part that
 * becomes debt, never more than `debtBudgetMicro`.
 */
export function planWindowReversal(
  w: ReversalWindowState,
  debtBudgetMicro: number,
): WindowReversalPlan {
  const needed = Math.max(0, w.consumedMicro + w.remainingMicro - w.keepMicro - w.owedMicro);
  const fromLotsMicro = Math.min(needed, w.remainingMicro);
  const beyondLotsMicro = Math.min(needed - fromLotsMicro, Math.max(0, debtBudgetMicro));
  return { amountMicro: fromLotsMicro + beyondLotsMicro, fromLotsMicro, beyondLotsMicro };
}

/**
 * The most debt one reversal may still create across ALL of an invoice's
 * windows — the interim cap pending the owner (see the header): what was spent
 * less what the payment still pays for (whole credits, as every keep is), less
 * what the standing clawbacks already charged for spent credit.
 * `paidForMicro` null means no cap beyond the per-window rule.
 *
 * What a standing clawback "already charged for spent credit" is its `O` less
 * the credit running tasks still hold of the lots: that part of a standing
 * claim is paid from the lots themselves when the tasks settle.
 */
export function reversalDebtBudgetMicro(
  windows: readonly ReversalWindowState[],
  terms: {
    readonly amountPaidMinor: number;
    readonly reversedMinor: number;
    readonly paidForMicro: number | null;
  },
): number {
  if (terms.paidForMicro === null) return Number.MAX_SAFE_INTEGER;
  let consumed = 0;
  let charged = 0;
  for (const w of windows) {
    consumed = consumed + w.consumedMicro;
    charged = charged + Math.max(0, w.owedMicro - w.heldMicro);
  }
  const keep = floorMicroToWholeCredits(
    stillPaidForMicro(terms.paidForMicro, terms.amountPaidMinor, terms.reversedMinor),
  );
  return Math.max(0, Math.max(0, consumed - keep) - charged);
}

/**
 * The level a reversal leaves a window at when NOTHING covers now() (audit
 * #16): the level scaled by what is still paid after this event over what was
 * still paid before it, rounded down to whole credits. Unchanged when nothing
 * was still paid before.
 */
export function levelScaledByPayment(
  levelMicro: number,
  stillPaidBeforeMinor: number,
  stillPaidAfterMinor: number,
): number {
  wholeMicro('a level', levelMicro);
  wholeMinor('what was still paid', stillPaidBeforeMinor);
  wholeMinor('what is still paid', stillPaidAfterMinor);
  if (stillPaidBeforeMinor === 0) return levelMicro;
  const scaled =
    (BigInt(levelMicro) * BigInt(Math.min(stillPaidAfterMinor, stillPaidBeforeMinor))) /
    BigInt(stillPaidBeforeMinor);
  return Number((scaled / MICRO_PER_CREDIT) * MICRO_PER_CREDIT);
}

/** The clawback key of a Stripe refund: the charge and the cumulative it reached. */
export function refundSourceRef(chargeId: string, cumulativeRefundedMinor: number): string {
  return `${chargeId}:${String(cumulativeRefundedMinor)}`;
}

/**
 * What a reversal claws from: one invoice's (or crypto order's) lots in one
 * window. The window alone is not enough — a window can hold lots two invoices
 * paid for (a base month and its upgrade, or a refunded month and the
 * resubscription that re-upgraded it), and each reversal must see only its own.
 */
export function reversalTargetKey(windowId: string, coverageRef: string): string {
  return `window:${windowId}:${coverageRef}`;
}

/**
 * The lot a won dispute gives back to the INVOICE, one per clawback it
 * reverses: what the clawback clawed and collected from the invoice's own lots
 * of that month.
 */
export function reinstateGrantKey(clawbackId: string): string {
  return `reinstate:${clawbackId}`;
}

/**
 * The lot a won dispute gives back to NO invoice, one per clawback it
 * reverses: the claims it collected from other lots and the part of its debt
 * later credit repaid (S17 re-audit #2, #10). The suffix keeps it out of every
 * read that matches an invoice's give-back by its exact key.
 */
export function returnedGrantKey(clawbackId: string): string {
  return `reinstate:${clawbackId}:returned`;
}

/**
 * The target of a dispute's RECORD row (S17 re-audit #13): the invoice, not a
 * window, so no read of a window's clawbacks sees it.
 */
export function disputeRecordTarget(stripeInvoiceId: string): string {
  return `invoice:${stripeInvoiceId}`;
}

/** The source reference of the pass a won dispute settles its invoice with (re-audit #3). */
export function wonDisputeSettleRef(disputeId: string): string {
  return `${disputeId}:won`;
}

/**
 * How long a reversal naming an invoice that is not on record is refused for
 * a retry, counted from Stripe's event `created` (S17 re-audit #14). Stripe
 * retries a failed delivery for about three days; two leave a day of margin
 * for the one delivery that records it as kept for review.
 */
export const REVERSAL_AWAITS_PAYMENT_FOR_MS = 48 * 60 * 60 * 1000;

/**
 * A refund or dispute names an invoice whose payment is not recorded yet: it
 * arrived before `invoice.paid` (Stripe does not order its events). NOT kept
 * for review — the webhook lets this through so the delivery fails and Stripe
 * redelivers it, by when the payment is on record (audit #8).
 */
export class CreditReversalAwaitsPaymentError extends Error {
  readonly retryable = true;
  constructor(what: 'refund' | 'dispute') {
    super(
      `a payment ${what} names an invoice whose payment is not recorded yet; ` +
        'it is refused so the provider delivers it again after the payment',
    );
    this.name = 'CreditReversalAwaitsPaymentError';
  }
}

/** Whether `err` is a reversal that must be retried once its payment is on record. */
export function isCreditReversalAwaitingPayment(err: unknown): boolean {
  return err instanceof CreditReversalAwaitsPaymentError;
}

export type ReversalOutcome =
  /** The reversal is recorded; `clawbacks` are what it took (none when nothing was owed). */
  | {
      readonly kind: 'applied';
      readonly accountId: string;
      /** The share of the payment reversed so far, informational. */
      readonly fractionPpm: number;
      readonly clawbacks: readonly CreditClawbackRecord[];
    }
  /** The same or a smaller cumulative was already recorded, or the dispute already applied (L5). */
  | { readonly kind: 'already_applied'; readonly accountId: string }
  /** The payment is on record but earned no window (an account never granted). */
  | { readonly kind: 'no_windows'; readonly accountId: string }
  /** No recorded payment matches and no invoice is named; kept for review. */
  | { readonly kind: 'unmatched' };

export type ReinstateOutcome =
  | {
      readonly kind: 'reinstated';
      readonly accountId: string;
      readonly reversed: number;
      readonly regrantedMicro: number;
      readonly forgivenMicro: number;
    }
  /** Nothing stands under that dispute and nothing was left to put back. */
  | { readonly kind: 'nothing_to_reinstate' };

/** What the Stripe webhook and the crypto refund path may ask of this service. */
export interface CreditClawbacks {
  applyStripeRefund(args: {
    chargeId: string;
    /** The invoice the charge paid, when the event or a fetch names it. */
    stripeInvoiceId: string | null;
    cumulativeRefundedMinor: number;
  }): Promise<ReversalOutcome>;
  applyStripeDispute(args: {
    disputeId: string;
    chargeId: string;
    stripeInvoiceId: string | null;
    amountMinor: number;
  }): Promise<ReversalOutcome>;
  /**
   * A dispute won: the funds are back. `chargeId` and `amountMinor` come from
   * the closed or funds_reinstated event, so the invoice is put back even when
   * the dispute wrote no clawback row (audit #2). `amountMinor` null lowers the
   * invoice's disputed amount to nothing (one dispute stands per charge at a
   * time).
   */
  reinstateDispute(args: {
    disputeId: string;
    chargeId: string | null;
    stripeInvoiceId: string | null;
    amountMinor: number | null;
  }): Promise<ReinstateOutcome>;
  applyCryptoRefund(args: { accountId: string; orderId: string }): Promise<ReversalOutcome>;
}

export interface CreditClawbacksDeps {
  readonly ledger: DrizzleCreditLedgerRepo;
  readonly windows: DrizzleCreditWindowsRepo;
  readonly grants: CreditGrantsService;
  readonly logger?: Logger;
  readonly sentry?: Pick<SentryClient, 'captureMessage'> | null;
  /** Injectable clock for tests. */
  readonly now?: () => Date;
}

interface PaymentRow {
  readonly stripeInvoiceId: string;
  readonly accountId: string;
  readonly amountPaidMinor: number;
  readonly refundedMinor: number;
  readonly disputedMinor: number;
  readonly lineKind: string | null;
  readonly lineInterval: string | null;
  readonly lineTier: string | null;
  /** The paid line's period, as microsecond UTC text; null when the invoice names no line. */
  readonly linePeriodStart: PgInstant | null;
  readonly linePeriodEnd: PgInstant | null;
  /**
   * The level the FIRST plan-change step keyed to this invoice started from —
   * what an upgrade line stepped up from (0136); null when no step names it.
   */
  readonly upgradeFromMicro: number | null;
}

/** One reversal's terms, handed from an entry point to `reverse`. */
interface ReversalTerms {
  readonly accountId: string;
  readonly source: CreditClawbackSource;
  readonly sourceRef: string;
  readonly coverage: { readonly source: CreditWindowSource; readonly sourceRef: string };
  readonly amountPaidMinor: number;
  /** Refunded plus disputed BEFORE this event, capped at nothing. */
  readonly reversedBeforeMinor: number;
  /** Refunded plus disputed AFTER this event. */
  readonly reversedAfterMinor: number;
  readonly paidForMicro: number | null;
  readonly levelReason: CreditWindowLevelChangeReason;
  /**
   * Whether the reversed coverage stands on its own — a month's line, a crypto
   * term — rather than an upgrade line that pays for the step above the month
   * beneath it. Only a coverage that stands on its own hands its month over to
   * another payment (re-audit #7).
   */
  readonly standsAlone: boolean;
  /**
   * Whether the reversal moves the current window's level. False for the pass
   * a won dispute settles its invoice with: the win has put the level where
   * the coverage says, and the pass only trims credit.
   */
  readonly movesLevel: boolean;
}

const MINUTE_MS = 60_000;

/**
 * The start of the whole UTC minute BEFORE the one `at` falls in — the same
 * rule a goodwill grant uses for a lot's `starts_at`: a lot compared against
 * the database's frozen `now()` must not start a hair after it, and a replay
 * of the same request must compute the same instant.
 */
export function floorToPriorMinute(at: Date): Date {
  return new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS - MINUTE_MS);
}

export class CreditClawbacksService implements CreditClawbacks {
  constructor(private readonly deps: CreditClawbacksDeps) {}

  async applyStripeRefund(args: {
    chargeId: string;
    stripeInvoiceId: string | null;
    cumulativeRefundedMinor: number;
  }): Promise<ReversalOutcome> {
    wholeMinor('a cumulative refund', args.cumulativeRefundedMinor);
    const { ledger } = this.deps;
    return ledger.transaction(async (tx) => {
      const found = await this.findPayment(tx, args.chargeId, args.stripeInvoiceId);
      if (found === null) return this.notOnRecord('refund', args.chargeId, args.stripeInvoiceId);
      await ledger.lockAccount(tx, found.accountId);
      // Re-read under the lock: the cumulative is compared against the row as
      // it is NOW, not as it was before the lock was taken.
      const payment = (await this.findPayment(tx, args.chargeId, args.stripeInvoiceId)) ?? found;
      if (args.cumulativeRefundedMinor <= payment.refundedMinor) {
        return { kind: 'already_applied', accountId: payment.accountId };
      }
      await tx.execute(sql`
        UPDATE billing_invoice_payments
           SET refunded_minor = ${String(args.cumulativeRefundedMinor)}::bigint
         WHERE stripe_invoice_id = ${payment.stripeInvoiceId}
           AND refunded_minor < ${String(args.cumulativeRefundedMinor)}::bigint`);
      return this.reverse(tx, {
        accountId: payment.accountId,
        source: 'stripe_refund',
        sourceRef: refundSourceRef(args.chargeId, args.cumulativeRefundedMinor),
        coverage: { source: 'stripe_invoice', sourceRef: payment.stripeInvoiceId },
        amountPaidMinor: payment.amountPaidMinor,
        reversedBeforeMinor: payment.refundedMinor + payment.disputedMinor,
        reversedAfterMinor: args.cumulativeRefundedMinor + payment.disputedMinor,
        paidForMicro: paidForMicro(payment),
        levelReason: 'refund',
        standsAlone: payment.lineKind !== 'proration_up',
        movesLevel: true,
      });
    });
  }

  async applyStripeDispute(args: {
    disputeId: string;
    chargeId: string;
    stripeInvoiceId: string | null;
    amountMinor: number;
  }): Promise<ReversalOutcome> {
    wholeMinor('a disputed amount', args.amountMinor);
    const { ledger, windows } = this.deps;
    return ledger.transaction(async (tx) => {
      const found = await this.findPayment(tx, args.chargeId, args.stripeInvoiceId);
      if (found === null) return this.notOnRecord('dispute', args.chargeId, args.stripeInvoiceId);
      await ledger.lockAccount(tx, found.accountId);
      const payment = (await this.findPayment(tx, args.chargeId, args.stripeInvoiceId)) ?? found;
      // A dispute applies once, whatever event carries it (`created`, or an
      // escalated inquiry's `funds_withdrawn` / `updated`). Any row it wrote —
      // standing or reversed by a win, a window's or its record — says it was
      // applied: a delivery after the win must not dispute the invoice again
      // (audit #12, re-audit #13).
      const recorded = await windows.clawbacksForSource(tx, 'stripe_dispute', args.disputeId);
      if (recorded.length > 0 || args.amountMinor === 0) {
        return { kind: 'already_applied', accountId: payment.accountId };
      }
      const disputedAfter = Math.max(payment.disputedMinor, args.amountMinor);
      await tx.execute(sql`
        UPDATE billing_invoice_payments
           SET disputed_minor = GREATEST(disputed_minor, ${String(args.amountMinor)}::bigint)
         WHERE stripe_invoice_id = ${payment.stripeInvoiceId}`);
      const outcome = await this.reverse(tx, {
        accountId: payment.accountId,
        source: 'stripe_dispute',
        sourceRef: args.disputeId,
        coverage: { source: 'stripe_invoice', sourceRef: payment.stripeInvoiceId },
        amountPaidMinor: payment.amountPaidMinor,
        reversedBeforeMinor: payment.refundedMinor + payment.disputedMinor,
        reversedAfterMinor: payment.refundedMinor + disputedAfter,
        paidForMicro: paidForMicro(payment),
        levelReason: 'dispute',
        standsAlone: payment.lineKind !== 'proration_up',
        movesLevel: true,
      });
      // ⛔ REMEMBERED EVEN WHEN IT TOOK NOTHING (re-audit #13). A dispute that
      // earned no window, or whose windows gave nothing up, wrote no row, and a
      // `created` delivered again after the win disputed the invoice anew.
      if (outcome.kind !== 'applied' || outcome.clawbacks.length === 0) {
        await windows.recordDispute(tx, {
          accountId: payment.accountId,
          disputeId: args.disputeId,
          targetKey: disputeRecordTarget(payment.stripeInvoiceId),
          fractionPpm: reversedFractionPpm(args.amountMinor, payment.amountPaidMinor),
          state: 'applied',
        });
      }
      return outcome;
    });
  }

  async reinstateDispute(args: {
    disputeId: string;
    chargeId: string | null;
    stripeInvoiceId: string | null;
    amountMinor: number | null;
  }): Promise<ReinstateOutcome> {
    if (args.amountMinor !== null) wholeMinor('a disputed amount', args.amountMinor);
    const { ledger, windows } = this.deps;
    return ledger.transaction(async (tx) => {
      // ⛔ THE ACCOUNT'S LOCK FIRST (audit #13). Find the account without
      // locking anything — from the dispute's own rows, or from the payment the
      // event names — then take the credit lock, and only then lock the rows.
      const recorded = await windows.clawbacksForSource(tx, 'stripe_dispute', args.disputeId);
      const named =
        args.chargeId !== null || args.stripeInvoiceId !== null
          ? await this.findPayment(tx, args.chargeId, args.stripeInvoiceId)
          : null;
      const recordedRef = recorded.map((r) => coverageRefOf(r.targetKey)).find((r) => r !== null);
      const invoiceId = named?.stripeInvoiceId ?? recordedRef ?? null;
      const accountId = recorded[0]?.accountId ?? named?.accountId ?? null;
      if (accountId === null) return { kind: 'nothing_to_reinstate' };

      const account = await ledger.lockAccount(tx, accountId);
      const applied = await windows.appliedClawbacksForSource(tx, 'stripe_dispute', args.disputeId);
      // Credit that belongs to no invoice lives as long as the account's
      // current month (re-audit #2, #10).
      const month = await windows.currentWindow(accountId, tx);

      let regrantedMicro = 0;
      let forgivenMicro = 0;
      let owed = account.debtMicro;
      for (const clawback of applied) {
        // Reversed and its claim zeroed in one statement: a task that settles
        // after the win pays the dispute nothing (audit #3).
        await windows.markClawbackReversed(tx, clawback.id);
        // The dispute's record took nothing itself: there is nothing to give back.
        if (windowIdOf(clawback.targetKey) === null) continue;
        // The debt this clawback created — its own shortfall and any claim that
        // turned into debt — as much of it as is still owed. What is not still
        // owed was repaid from later credit, and is given back below.
        const forgive = Math.min(owed, clawback.debtMicro);
        if (forgive > 0) {
          await ledger.append(
            {
              accountId,
              kind: 'adjustment',
              forgiveDebtMicro: forgive,
              idempotencyKey: `${reinstateGrantKey(clawback.id)}:forgive`,
              reason: 'dispute_reinstated',
            },
            tx,
          );
          owed = owed - forgive;
          forgivenMicro = forgivenMicro + forgive;
        }
        regrantedMicro =
          regrantedMicro +
          (await this.giveBack(tx, accountId, clawback, clawback.debtMicro - forgive, month));
      }

      // ⛔ THE INVOICE IS WHOLE AGAIN WHETHER OR NOT ANYTHING WAS TAKEN (audit
      // #2): a dispute that was all debt, or that found nothing, still marked
      // the invoice disputed and lowered the level.
      let restored = false;
      const payment = invoiceId === null ? null : await this.paymentOfInvoice(tx, invoiceId);
      if (payment !== null && payment.accountId === accountId) {
        if (recorded.length === 0) {
          // A win for a dispute nothing recorded: its `created` has not been
          // applied (it may yet arrive). Remember the win, so that it never is
          // (re-audit #13) — and leave the invoice's disputed amount alone:
          // this dispute never raised it.
          await windows.recordDispute(tx, {
            accountId,
            disputeId: args.disputeId,
            targetKey: disputeRecordTarget(payment.stripeInvoiceId),
            fractionPpm: reversedFractionPpm(args.amountMinor ?? 0, payment.amountPaidMinor),
            state: 'reversed',
          });
        }
        // Any plan change still waiting is reconciled FIRST, against the
        // coverage as it stands without this invoice: the level the win then
        // restores is the invoice's own, and a pending upgrade keeps its lot.
        await this.deps.grants.reconcileLevel(tx, accountId);
        const lowerBy = recorded.length === 0 ? 0 : (args.amountMinor ?? payment.disputedMinor);
        const disputedAfter = Math.max(0, payment.disputedMinor - lowerBy);
        if (disputedAfter !== payment.disputedMinor) {
          await tx.execute(sql`
            UPDATE billing_invoice_payments
               SET disputed_minor = ${String(disputedAfter)}::bigint
             WHERE stripe_invoice_id = ${payment.stripeInvoiceId}`);
          restored = true;
        }
        const levelRaised = await this.levelAfterWin(tx, payment, disputedAfter);
        restored = restored || levelRaised;
        // ⛔ SETTLED AT THE INVOICE'S CURRENT REFUNDED SHARE (re-audit #3). A
        // refund delivered while the dispute stood took nothing (the dispute
        // had taken it all), and the give-back above returned everything the
        // dispute took: the same state-based pass a refund runs now leaves the
        // customer what the refunds leave, and trims the whole-credit rounding
        // of the give-back. Keyed to the win, so a replay takes nothing more.
        const stillReversed = payment.refundedMinor + disputedAfter;
        await this.reverse(tx, {
          accountId,
          source: 'stripe_dispute',
          sourceRef: wonDisputeSettleRef(args.disputeId),
          coverage: { source: 'stripe_invoice', sourceRef: payment.stripeInvoiceId },
          amountPaidMinor: payment.amountPaidMinor,
          reversedBeforeMinor: stillReversed,
          reversedAfterMinor: stillReversed,
          paidForMicro: paidForMicro(payment),
          levelReason: 'refund',
          standsAlone: payment.lineKind !== 'proration_up',
          movesLevel: false,
        });
      }
      await ledger.settleDebtFromFree(tx, accountId);
      if (applied.length === 0 && !restored) return { kind: 'nothing_to_reinstate' };

      this.deps.logger?.info(
        {
          component: 'credit-clawbacks',
          event: 'dispute_reinstated',
          accountId,
          reversed: applied.length,
          regrantedMicro,
          forgivenMicro,
        },
        'a won dispute put its credits back',
      );
      return {
        kind: 'reinstated',
        accountId,
        reversed: applied.length,
        regrantedMicro,
        forgivenMicro,
      };
    });
  }

  async applyCryptoRefund(args: { accountId: string; orderId: string }): Promise<ReversalOutcome> {
    const { ledger } = this.deps;
    try {
      return await ledger.transaction(async (tx) => {
        await ledger.lockAccount(tx, args.accountId);
        // A refunded order is refunded whole: nothing is still paid on the term
        // it bought. Its entitlement has been revoked before this runs (or its
        // term is over), so nothing of it covers now().
        return this.reverse(tx, {
          accountId: args.accountId,
          source: 'crypto_refund',
          sourceRef: args.orderId,
          coverage: { source: 'crypto_entitlement', sourceRef: args.orderId },
          amountPaidMinor: 1,
          reversedBeforeMinor: 0,
          reversedAfterMinor: 1,
          paidForMicro: null,
          levelReason: 'refund',
          standsAlone: true,
          movesLevel: true,
        });
      });
    } catch (err) {
      // Nothing retries a crypto refund by itself (the IPN is acknowledged, and
      // a replay may never come), so every failure is a person's to review:
      // the caller logs it with the order, the alert carries no id (audit #10).
      try {
        this.deps.sentry?.captureMessage({
          message:
            'Taking AI credits back for a refunded crypto order failed. ' +
            'Find the order id in the server log and review the account by hand.',
          level: 'error',
          fingerprint: ['billing', 'ai_credits_reversal_failed', 'crypto_refund'],
          tags: { kind: 'ai_credits_reversal_failed', what: 'crypto_refund' },
        });
      } catch {
        /* the caller's log line is the record; alerting must not hide the error */
      }
      throw err;
    }
  }

  // ── the shared reversal ────────────────────────────────────────────────

  private async reverse(tx: CreditLedgerTx, t: ReversalTerms): Promise<ReversalOutcome> {
    const { windows, grants } = this.deps;
    const fractionPpm = reversedFractionPpm(t.reversedAfterMinor, t.amountPaidMinor);
    const earned = await windows.windowsOfCoverage(
      tx,
      t.accountId,
      t.coverage.source,
      t.coverage.sourceRef,
    );
    if (earned.length === 0) {
      if (t.movesLevel) {
        this.deps.logger?.warn(
          {
            component: 'credit-clawbacks',
            event: 'reversal_earned_no_window',
            accountId: t.accountId,
            source: t.source,
          },
          'a reversed payment earned no credit window; nothing to take back',
        );
      }
      return { kind: 'no_windows', accountId: t.accountId };
    }
    const terms = { amountPaidMinor: t.amountPaidMinor, reversedMinor: t.reversedAfterMinor };

    // The cap reads every window first; each window is then read AGAIN just
    // before it is clawed, because the debt an earlier window's clawback
    // settles may have been repaid out of a later window's lots.
    let budget = Number.MAX_SAFE_INTEGER;
    if (t.paidForMicro !== null) {
      const all: ReversalWindowState[] = [];
      for (const window of earned) all.push((await this.windowState(tx, t, window.id)).state);
      budget = reversalDebtBudgetMicro(all, { ...terms, paidForMicro: t.paidForMicro });
    }

    const clawbacks: CreditClawbackRecord[] = [];
    for (const window of earned) {
      const { lots, state, targetKey } = await this.windowState(tx, t, window.id);
      const plan = planWindowReversal(state, budget);
      budget = budget - plan.beyondLotsMicro;
      if (plan.amountMicro <= 0) continue;
      const record = await grants.clawBack(tx, t.accountId, {
        source: t.source,
        sourceRef: t.sourceRef,
        targetKey,
        windowId: window.id,
        amountMicro: plan.amountMicro,
        ledgerKind: 'refund_clawback',
        debtReason: 'payment_reversed' satisfies AiDebtReason,
        ledgerKeyPrefix: `clawback:${t.source}:${t.sourceRef}:${window.id}`,
        targets: lots,
      });
      clawbacks.push(record);
    }

    const current = earned.find((w) => w.current);
    if (t.movesLevel && current !== undefined) await this.levelAfterReversal(tx, t, current);

    this.deps.logger?.info(
      {
        component: 'credit-clawbacks',
        event: 'payment_reversed',
        accountId: t.accountId,
        source: t.source,
        fractionPpm,
        windows: earned.length,
        clawbacks: clawbacks.length,
        debtMicro: clawbacks.reduce((sum, c) => sum + c.debtMicro, 0),
      },
      'a reversed payment took its credits back',
    );
    return { kind: 'applied', accountId: t.accountId, fractionPpm, clawbacks };
  }

  /** Where one invoice's credit in one window stands: its lots, and the arithmetic's inputs. */
  private async windowState(
    tx: CreditLedgerTx,
    t: ReversalTerms,
    windowId: string,
  ): Promise<{ lots: ReversalLot[]; state: ReversalWindowState; targetKey: string }> {
    const { windows } = this.deps;
    const targetKey = reversalTargetKey(windowId, t.coverage.sourceRef);
    const lots = await windows.reversalLots(tx, t.accountId, windowId, t.coverage, targetKey);
    const standing = await windows.standingReversals(tx, t.accountId, {
      windowId,
      targetKey,
      coverageRef: t.coverage.sourceRef,
    });
    const ownLots = new Set(lots.map((l) => l.lotId));
    let asked = 0;
    let collectedHere = 0;
    for (const r of standing) {
      asked = asked + Math.max(0, r.amountMicro - r.clawedMicro);
      // A claim a standing clawback collected from THESE lots is already out of
      // L; counting it in O as well would count it twice.
      for (const c of await windows.collectedClaims(tx, t.accountId, { clawbackId: r.id })) {
        if (ownLots.has(c.lotId)) collectedHere = collectedHere + c.micro;
      }
    }
    let keep = 0;
    let consumed = 0;
    let remaining = 0;
    let held = 0;
    for (const lot of lots) {
      if (!lot.regrant) {
        keep =
          keep +
          lotKeepMicro(
            lot.grantedMicro,
            t.amountPaidMinor,
            lot.stillPaidMinor,
            t.reversedAfterMinor,
          );
      }
      consumed = consumed + lot.consumedMicro;
      remaining = remaining + lot.remainingMicro;
      held = held + lot.heldMicro;
    }
    return {
      lots,
      targetKey,
      state: {
        keepMicro: keep,
        consumedMicro: consumed,
        remainingMicro: remaining,
        heldMicro: held,
        owedMicro: Math.max(0, asked - collectedHere),
      },
    };
  }

  /**
   * Lower the invoice's current window to what all coverage earns now — never
   * raise it here — or, when nothing covers now, by the share of what was
   * still paid that this event reverses (audit #4, #16). When ANOTHER payment
   * that stands on its own now covers the month best, the month is handed
   * over: the level falls to what the reversed coverage alone still covers,
   * and `reconcileLevel` raises it for the other payment, net of what that
   * payment's lots here were already granted (re-audit #7). Recorded with a
   * delta of 0.
   */
  private async levelAfterReversal(
    tx: CreditLedgerTx,
    t: ReversalTerms,
    current: SourcedCreditWindow,
  ): Promise<void> {
    const { windows, grants } = this.deps;
    const cover = await windows.coverNow(tx, t.accountId);
    if (cover === null || cover.windowId !== current.id) return;
    if (cover.targetMicro === null) {
      const scaled = levelScaledByPayment(
        cover.levelMicro,
        Math.max(0, t.amountPaidMinor - t.reversedBeforeMinor),
        Math.max(0, t.amountPaidMinor - t.reversedAfterMinor),
      );
      if (scaled < cover.levelMicro) {
        await this.moveLevel(tx, t.accountId, cover, scaled, t.levelReason, t.coverage.sourceRef);
      }
      return;
    }
    const handOver =
      t.standsAlone && !cover.upgradeLine && cover.sourceRef !== t.coverage.sourceRef;
    if (handOver) {
      const alone =
        t.coverage.source === 'stripe_invoice'
          ? ((await windows.coverageLevelForInvoice(tx, t.accountId, t.coverage.sourceRef, {
              requireActive: false,
            })) ?? 0)
          : 0;
      if (alone >= cover.levelMicro) return;
      await this.moveLevel(tx, t.accountId, cover, alone, t.levelReason, t.coverage.sourceRef);
      await grants.reconcileLevel(tx, t.accountId, { netOfExistingLots: true });
      return;
    }
    if (cover.targetMicro < cover.levelMicro) {
      await this.moveLevel(
        tx,
        t.accountId,
        cover,
        cover.targetMicro,
        t.levelReason,
        t.coverage.sourceRef,
      );
    }
  }

  /**
   * Put the invoice's current window back after a win. The target is what all
   * coverage earns now or — when nothing covers now (the subscription canceled
   * in the meantime) — the level scaled up by the share the win restored, or,
   * when the dispute had reversed all of what was still paid, what the
   * invoice's own payment covers whatever its subscription says. Never lowered
   * here.
   *
   * ⛔ TWO KINDS OF RAISE (re-audit #6). As far as the disputes of this invoice
   * lowered this window's level and no win has put it back, the level is simply
   * restored: the credit that went with that drop came back with the
   * give-back. Anything above that is a month drawn while the dispute stood,
   * at the lower level: it is raised through the upgrade arithmetic — the
   * difference prorated over the time the invoice's line covers of the window —
   * as a `dispute_reinstated` step with a lot of its own, which is a give-back
   * (not more of what the payment bought) to every later reversal. When the
   * rest of the raise is ANOTHER payment's, the ordinary plan change grants it.
   */
  private async levelAfterWin(
    tx: CreditLedgerTx,
    payment: PaymentRow,
    disputedAfter: number,
  ): Promise<boolean> {
    const { windows } = this.deps;
    const earned = await windows.windowsOfCoverage(
      tx,
      payment.accountId,
      'stripe_invoice',
      payment.stripeInvoiceId,
    );
    const current = earned.find((w) => w.current);
    if (current === undefined) return false;
    const cover = await windows.coverNow(tx, payment.accountId);
    if (cover === null || cover.windowId !== current.id) return false;
    let target = cover.targetMicro;
    if (target === null) {
      const before = Math.max(
        0,
        payment.amountPaidMinor - payment.refundedMinor - payment.disputedMinor,
      );
      const after = Math.max(0, payment.amountPaidMinor - payment.refundedMinor - disputedAfter);
      target =
        before > 0
          ? scaledUp(cover.levelMicro, before, after)
          : await windows.coverageLevelForInvoice(tx, payment.accountId, payment.stripeInvoiceId, {
              requireActive: false,
            });
    }
    if (target === null || target <= cover.levelMicro) return false;

    const dropped = await windows.unrestoredDisputeDropMicro(
      tx,
      current.id,
      payment.stripeInvoiceId,
    );
    let at = { windowId: cover.windowId, levelMicro: cover.levelMicro, levelSeq: cover.levelSeq };
    const restoreTo = Math.min(target, cover.levelMicro + dropped);
    if (restoreTo > at.levelMicro) {
      await this.moveLevel(
        tx,
        payment.accountId,
        at,
        restoreTo,
        'dispute_reinstated',
        payment.stripeInvoiceId,
      );
      at = { ...at, levelMicro: restoreTo, levelSeq: at.levelSeq + 1 };
    }
    if (target > at.levelMicro) {
      await this.raiseMonthDrawnDuringDispute(tx, payment, current, cover, at, target);
    }
    return true;
  }

  /** The part of a win's raise no drop of this dispute accounts for (re-audit #6). */
  private async raiseMonthDrawnDuringDispute(
    tx: CreditLedgerTx,
    payment: PaymentRow,
    current: SourcedCreditWindow,
    cover: { readonly targetMicro: number | null; readonly sourceRef: string | null },
    at: { readonly windowId: string; readonly levelMicro: number; readonly levelSeq: number },
    target: number,
  ): Promise<void> {
    const { windows, ledger, grants } = this.deps;
    const accountId = payment.accountId;
    let share: { portion: number; whole: number; effectiveAt: PgInstant } | null = null;
    if (cover.targetMicro !== null && cover.sourceRef === payment.stripeInvoiceId) {
      // The invoice itself is the best cover: the upgrade arithmetic, from its
      // own line's start (a month's line starts at or before its window).
      const due = await windows.levelReconciliation(tx, accountId);
      if (
        due !== null &&
        due.windowId === at.windowId &&
        due.sourceRef === payment.stripeInvoiceId
      ) {
        share = {
          portion: due.remainingMicroseconds,
          whole: due.naturalMicroseconds,
          effectiveAt: due.effectiveAt,
        };
      }
    } else if (cover.targetMicro === null && current.sourceRef === payment.stripeInvoiceId) {
      // Nothing covers now (the subscription was canceled) but the window was
      // drawn from this invoice: the same arithmetic over the whole window.
      const whole = await windows.wholeWindowMicroseconds(tx, accountId, at.windowId);
      if (whole !== null) {
        share = {
          portion: whole.windowMicroseconds,
          whole: whole.naturalMicroseconds,
          effectiveAt: current.windowStart,
        };
      }
    }
    if (share === null) {
      // The rest of the raise is another payment's: an ordinary plan change.
      if (cover.targetMicro !== null) await grants.reconcileLevel(tx, accountId);
      return;
    }
    const deltaMicro = proratedWholeCreditsMicro(
      target - at.levelMicro,
      Math.min(share.portion, share.whole),
      share.whole,
    );
    const seq = at.levelSeq + 1;
    await windows.setWindowLevel(tx, {
      accountId,
      windowId: at.windowId,
      seq,
      reason: 'dispute_reinstated',
      fromLevelMicro: at.levelMicro,
      toLevelMicro: target,
      effectiveAt: share.effectiveAt,
      deltaMicro,
      sourceRef: payment.stripeInvoiceId,
    });
    if (deltaMicro <= 0) return;
    const lot = await windows.ensureProrationLot(tx, accountId, at.windowId, seq, deltaMicro);
    await ledger.append(
      {
        accountId,
        kind: 'proration_grant',
        lotId: lot.lotId,
        amountMicro: lot.grantedMicro,
        idempotencyKey: `proration_grant:${lot.lotId}`,
        reason: 'dispute_reinstated',
      },
      tx,
    );
  }

  /**
   * Give back what one reversed dispute clawback took (M6, re-audit #1, #2,
   * #10), rounded UP to whole credits: to the invoice, what it clawed and
   * collected from the invoice's own lots of its month, while that month runs;
   * to no invoice, what it collected from other lots and the part of its debt
   * that later credit repaid, until the account's current month ends.
   */
  private async giveBack(
    tx: CreditLedgerTx,
    accountId: string,
    clawback: CreditClawbackRecord,
    repaidMicro: number,
    month: { readonly windowEnd: PgInstant } | null,
  ): Promise<number> {
    const { windows } = this.deps;
    const windowId = windowIdOf(clawback.targetKey);
    const coverageRef = coverageRefOf(clawback.targetKey);
    if (windowId === null || coverageRef === null) return 0;
    // What it collected, measured from the claim rows themselves
    // (`claim:<clawback>:…`), split by where the credit came from.
    const own = await windows.reversalLots(
      tx,
      accountId,
      windowId,
      { source: 'stripe_invoice', sourceRef: coverageRef },
      clawback.targetKey,
    );
    const ownLots = new Set(own.map((l) => l.lotId));
    let collectedOwn = 0;
    let collectedElsewhere = 0;
    for (const c of await windows.collectedClaims(tx, accountId, { clawbackId: clawback.id })) {
      if (ownLots.has(c.lotId)) collectedOwn = collectedOwn + c.micro;
      else collectedElsewhere = collectedElsewhere + c.micro;
    }
    let given = 0;
    const window = await this.windowById(tx, accountId, windowId);
    // A win after the window ended gives nothing of it back: the credit would
    // have expired with its window (M6).
    if (window !== null && window.windowEnd > pgInstant(this.now())) {
      given =
        given +
        (await this.grantBack(
          tx,
          accountId,
          reinstateGrantKey(clawback.id),
          clawback.clawedMicro + collectedOwn,
          window.windowEnd,
        ));
    }
    const returned = collectedElsewhere + Math.max(0, repaidMicro);
    if (returned > 0 && month === null) {
      this.deps.logger?.warn(
        { component: 'credit-clawbacks', event: 'dispute_return_no_month', accountId },
        'a won dispute had credit to return but the account has no month running; none returned',
      );
    } else if (month !== null) {
      given =
        given +
        (await this.grantBack(
          tx,
          accountId,
          returnedGrantKey(clawback.id),
          returned,
          month.windowEnd,
        ));
    }
    return given;
  }

  /** One give-back lot of `micro`, raised to whole credits, funded once. */
  private async grantBack(
    tx: CreditLedgerTx,
    accountId: string,
    grantKey: string,
    micro: number,
    expiresAt: PgInstant,
  ): Promise<number> {
    if (micro <= 0) return 0;
    const { ledger } = this.deps;
    const amount = ceilMicroToWholeCredits(micro);
    const inserted = await ledger.insertLot(
      {
        accountId,
        kind: 'adjustment',
        grantKey,
        grantedMicro: amount,
        startsAt: floorToPriorMinute(this.now()),
        expiresAt: new Date(expiresAt),
      },
      tx,
    );
    if (!inserted.inserted) return 0;
    await ledger.append(
      {
        accountId,
        kind: 'grant',
        lotId: inserted.lot.id,
        amountMicro: amount,
        idempotencyKey: `${grantKey}:grant`,
        reason: 'dispute_reinstated',
      },
      tx,
    );
    return amount;
  }

  /** Move a window to `toLevelMicro`, recording why; nothing when it is there already. */
  private async moveLevel(
    tx: CreditLedgerTx,
    accountId: string,
    window: { readonly windowId: string; readonly levelMicro: number; readonly levelSeq: number },
    toLevelMicro: number,
    reason: CreditWindowLevelChangeReason,
    sourceRef: string,
  ): Promise<void> {
    if (toLevelMicro === window.levelMicro) return;
    await this.deps.windows.setWindowLevel(tx, {
      accountId,
      windowId: window.windowId,
      seq: window.levelSeq + 1,
      reason,
      fromLevelMicro: window.levelMicro,
      toLevelMicro,
      effectiveAt: pgInstant(this.now()),
      // ⛔ 0, NOT THE LEVEL DIFFERENCE (audit #14). The credits a reversal or a
      // win moves are its clawback's rows and its re-grant; the level row
      // records the new level and why, not a second amount that disagrees with
      // them.
      deltaMicro: 0,
      sourceRef,
    });
  }

  /**
   * No recorded payment matches. When the event names an invoice, its payment
   * is simply not recorded YET — the reversal is refused for a retry (the
   * webhook keeps it for review once it is two days old). When it names none,
   * it is kept for review.
   */
  private notOnRecord(
    what: 'refund' | 'dispute',
    chargeId: string,
    stripeInvoiceId: string | null,
  ): ReversalOutcome {
    if (stripeInvoiceId !== null) {
      this.deps.logger?.warn(
        {
          component: 'credit-clawbacks',
          event: 'reversal_awaits_payment',
          what,
          chargeId,
          stripeInvoiceId,
        },
        'a reversed payment names an invoice whose payment is not recorded yet; refused for a retry',
      );
      throw new CreditReversalAwaitsPaymentError(what);
    }
    return this.unmatched(what, chargeId);
  }

  private async findPayment(
    tx: CreditLedgerTx,
    chargeId: string | null,
    stripeInvoiceId: string | null,
  ): Promise<PaymentRow | null> {
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT pay.stripe_invoice_id, pay.account_id,
             pay.amount_paid_minor::text AS amount_paid_minor,
             pay.refunded_minor::text AS refunded_minor, pay.disputed_minor::text AS disputed_minor,
             pay.line_kind, pay.line_interval, pay.line_tier::text AS line_tier,
             to_char(pay.line_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               AS line_period_start,
             to_char(pay.line_period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               AS line_period_end,
             (SELECT first_step.from_level_micro::text
                FROM credit_window_level_changes first_step
                JOIN credit_windows first_window ON first_window.id = first_step.window_id
               WHERE first_window.account_id = pay.account_id
                 AND first_step.reason = 'plan_change'
                 AND first_step.source_ref = pay.stripe_invoice_id
               ORDER BY first_step.created_at, first_step.window_id, first_step.seq
               LIMIT 1) AS upgrade_from_micro
        FROM billing_invoice_payments pay
       WHERE (${chargeId}::text IS NOT NULL AND pay.stripe_charge_id = ${chargeId})
          OR (${stripeInvoiceId}::text IS NOT NULL AND pay.stripe_invoice_id = ${stripeInvoiceId})
       ORDER BY (pay.stripe_charge_id IS NOT DISTINCT FROM ${chargeId}::text) DESC, pay.paid_at DESC
       LIMIT 1`);
    return paymentOf(result);
  }

  private async paymentOfInvoice(
    tx: CreditLedgerTx,
    stripeInvoiceId: string,
  ): Promise<PaymentRow | null> {
    return this.findPayment(tx, null, stripeInvoiceId);
  }

  private async windowById(
    tx: CreditLedgerTx,
    accountId: string,
    windowId: string,
  ): Promise<SourcedCreditWindow | null> {
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT id, level_micro::text AS level_micro, level_seq, source_ref,
             to_char(window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_start,
             to_char(window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_end,
             (window_start <= now() AND now() < window_end) AS current
        FROM credit_windows WHERE id = ${windowId}::uuid AND account_id = ${accountId}::uuid
       ORDER BY id`);
    const r = rowsOf<{
      id: string;
      level_micro: string;
      level_seq: number;
      source_ref: string;
      window_start: string;
      window_end: string;
      current: boolean;
    }>(result)[0];
    if (r === undefined) return null;
    return {
      id: r.id,
      levelMicro: minor(r.level_micro),
      levelSeq: r.level_seq,
      sourceRef: r.source_ref,
      windowStart: r.window_start,
      windowEnd: r.window_end,
      current: r.current === true,
    };
  }

  private unmatched(what: 'refund' | 'dispute', chargeId: string): ReversalOutcome {
    this.deps.logger?.error(
      { component: 'credit-clawbacks', event: 'reversal_unmatched', what, chargeId },
      'a reversed payment matches no recorded invoice payment; kept for review',
    );
    try {
      this.deps.sentry?.captureMessage({
        message:
          `A payment ${what} matched no recorded payment, so nothing was taken back from AI credits. ` +
          'Find the charge id in the server log and review it by hand.',
        level: 'error',
        fingerprint: ['billing', 'ai_credits_reversal_unmatched', what],
        tags: { kind: 'ai_credits_reversal_unmatched', what },
      });
    } catch {
      /* the log line above is the record; alerting must not fail the event */
    }
    return { kind: 'unmatched' };
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

/**
 * What the payment bought, in microcredits, for the interim cap: a PERIOD
 * line's plan allowance × the months it pays for; an ANNUAL UPGRADE line's step
 * up `(upper − from)` × the calendar months its line spans (re-audit #8). Null —
 * no cap beyond the per-window rule — for a monthly upgrade line (it bought its
 * prorated lot, nothing more), a line on a plan with no plan-wide allowance, or
 * one whose interval or period is unknown.
 */
function paidForMicro(payment: PaymentRow): number | null {
  if (payment.lineTier === null) return null;
  const tier = AccountTierSchema.safeParse(payment.lineTier);
  if (!tier.success || !Object.hasOwn(AI_PLAN_ENTITLEMENTS, tier.data)) return null;
  const monthly = planMonthlyCreditsMicro(tier.data);
  if (monthly === null || monthly <= 0) return null;
  if (payment.lineKind === 'period') {
    const months =
      payment.lineInterval === 'year' ? 12 : payment.lineInterval === 'month' ? 1 : null;
    return months === null ? null : monthly * months;
  }
  if (payment.lineKind === 'proration_up' && payment.lineInterval === 'year') {
    const months = monthsSpanned(payment.linePeriodStart, payment.linePeriodEnd);
    if (months === null) return null;
    const step = monthly - Math.min(monthly, payment.upgradeFromMicro ?? 0);
    return step > 0 ? step * months : null;
  }
  return null;
}

/**
 * The calendar months a line spans, counted UP: the fewest whole months from
 * its start that reach its end (the billing calendar `addUtcMonths` draws). A
 * line of seven and a half months spans eight. Null when the period is unknown.
 */
function monthsSpanned(start: PgInstant | null, end: PgInstant | null): number | null {
  if (start === null || end === null) return null;
  const from = new Date(`${start.slice(0, 23)}Z`);
  const to = new Date(`${end.slice(0, 23)}Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return null;
  // The calendar-field estimate is the answer or one short of it (the day or
  // time of day of the end may lie past the start's).
  const estimate = Math.max(
    1,
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()),
  );
  if (estimate > 1 && addUtcMonths(from, estimate - 1) >= to) return estimate - 1;
  return addUtcMonths(from, estimate) >= to ? estimate : estimate + 1;
}

/** A level scaled UP by what a win restored, rounded down to whole credits. */
function scaledUp(levelMicro: number, stillPaidBefore: number, stillPaidAfter: number): number {
  const scaled = (BigInt(levelMicro) * BigInt(stillPaidAfter)) / BigInt(stillPaidBefore);
  return Number((scaled / MICRO_PER_CREDIT) * MICRO_PER_CREDIT);
}

/** `window:<window uuid>` or `window:<window uuid>:<invoice or order>`. The uuid
 *  is spelled 8-4-4-4-12, never 36 hex-or-dash characters (which admits 36
 *  dashes — twelve-copies-of-the-id-parser-must-agree). */
const WINDOW_TARGET =
  /^window:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::(.+))?$/;

/** A dispute's record target (`disputeRecordTarget`): `invoice:<invoice>`. */
const INVOICE_TARGET = /^invoice:(.+)$/;

/** The window a clawback's target names; null for a dispute's record. */
function windowIdOf(targetKey: string): string | null {
  return WINDOW_TARGET.exec(targetKey)?.[1] ?? null;
}

/** The invoice or order a reversal's target (or a dispute's record) names. */
function coverageRefOf(targetKey: string): string | null {
  return WINDOW_TARGET.exec(targetKey)?.[2] ?? INVOICE_TARGET.exec(targetKey)?.[1] ?? null;
}

function paymentOf(result: unknown): PaymentRow | null {
  const row = rowsOf<{
    stripe_invoice_id: string;
    account_id: string;
    amount_paid_minor: string;
    refunded_minor: string;
    disputed_minor: string;
    line_kind: string | null;
    line_interval: string | null;
    line_tier: string | null;
    line_period_start: string | null;
    line_period_end: string | null;
    upgrade_from_micro: string | null;
  }>(result)[0];
  if (row === undefined) return null;
  return {
    stripeInvoiceId: row.stripe_invoice_id,
    accountId: row.account_id,
    amountPaidMinor: minor(row.amount_paid_minor),
    refundedMinor: minor(row.refunded_minor),
    disputedMinor: minor(row.disputed_minor),
    lineKind: row.line_kind,
    lineInterval: row.line_interval,
    lineTier: row.line_tier,
    linePeriodStart: row.line_period_start,
    linePeriodEnd: row.line_period_end,
    upgradeFromMicro: row.upgrade_from_micro === null ? null : minor(row.upgrade_from_micro),
  };
}

function minor(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('a stored amount is not a safe non-negative integer');
  }
  return value;
}

/** A Date as the microsecond UTC text the windows repo hands the database. */
function pgInstant(at: Date): PgInstant {
  return `${at.toISOString().slice(0, -1)}000Z`;
}
