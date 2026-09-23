// S17 — refunds and chargebacks take credits back, any shortfall becomes debt,
// and a won dispute restores what it took. Plan §6.7 and findings H2, L5, M6, M8,
// as corrected by the independent audit of S17 and its two re-audits.
//
// ⛔ A REVERSAL CHANGES A FACT; THE CREDIT FOLLOWS THE FACTS (round 3). A refund
// raises what the payment has refunded, a dispute adds its amount to what the
// payment has disputed (the SUM of its standing disputes, by dispute id — R2),
// and a won dispute takes its own amount off again, on its FIRST win only.
// Nothing else here decides an amount. Every window the payment has credit in
// is then brought to its TARGET by the grants service
// (`CreditGrantsService.reconcilePaymentUnits`, see the header of
// credit-grants.ts): what the payment still pays — refunds and standing disputes
// taken off — decides what each grant and take attributed to it keeps,
// scaled by what is still paid now over what was still paid when it was made,
// summed unfloored and rounded to whole credits once (R3). The customer keeps
// that; whatever they hold or spent above it is taken, out of what they hold
// first (free credit taken, held credit a pending claim) and the rest — credit
// that was spent — as debt. So:
//
//   · a second refund after the first refund's credit expired finds nothing to
//     take (audit #1): expired credit is neither held nor spent;
//   · two refunds of the whole owe exactly what was spent (#11);
//   · a dispute after a refund is measured against what was still paid (#7);
//   · a delivery repeated or out of order recomputes the same state and takes
//     nothing more (L5 still keys each distinct cumulative once);
//   · the order of a refund, a dispute and its win does not matter (re-audit #3,
//     A10): the win moves the payment's units to the target WITHOUT the
//     dispute — giving back credit the dispute took from a month still
//     running, forgiving debt it (or a refund measured while it stood) charged
//     beyond, and returning as credit the part of that debt later credit
//     repaid, lasting as long as the credit that repaid it (R1).
//
// ⛔ A DISPUTE NEVER CHANGES WHAT A MONTH IS WORTH. A month drawn while a
// dispute stands is drawn in full and the dispute takes its share of it; a
// plan change made while a dispute stands grants or takes what it would have
// without the dispute (A3–A5), and the dispute's share of the result follows.
// That is 0139's undisputed level. So a won dispute has nothing to redo: the
// account it leaves is the one its twin without the dispute holds.
//
// ⛔ AN ANNUAL INVOICE'S DEBT IS CAPPED ACROSS ITS WINDOWS — AN INTERIM RULE
// PENDING THE OWNER (audit #6). Applied per window, a refund of half a year
// canceled in month one owes half of the month the customer used, although six
// months are still paid for and one was used. Until the owner rules, the debt a
// payment leaves across ALL of its windows is capped at
// `max(0, ΣS − floor_whole(s/paid × what the payment bought))`, shared out
// newest window first. What a PERIOD line bought is its plan allowance × the
// months it pays for (12 a year, 1 a month). An ANNUAL UPGRADE (`proration_up`)
// line bought the step up `(upper − from) × the calendar months the line spans`
// (re-audit #8); a MONTHLY upgrade line stays uncapped — it bought its prorated
// lot and nothing more. The cap only ever LOWERS debt.
//
// ⛔ THE LEVEL FOLLOWS ALL COVERAGE, NOT THE INVOICE ALONE (audit #4, #16).
// After a reversal the CURRENT window's two levels move to what every paid
// coverage over now() earns — the same read the next reconciliation makes, so
// that refresh finds nothing to do. When nothing covers now — the subscription
// canceled before the refund arrived — the window keeps what its own payment
// still pays for, not zero. The level change records 0 as its delta: the
// credits moved are the reversal's own rows (audit #14).
//
// ⛔ WHEN ANOTHER PAYMENT NOW COVERS THE MONTH BEST (re-audit #7, M8, R5). A
// payment that stands on its own beside the window's — a resubscription's
// month, a crypto term, an override — earns the part of the month its level
// stands above what the window's own payment still covers (decided against it,
// not against an upgrade line, which pays only for the step above the month
// beneath it). A refund or a dispute of the window's own payment raises that
// share, in the same transaction, and the debt the reversal wrote is repaid
// from it before the transaction commits (finding 1: the commit-time check
// refused debt beside that credit); a won dispute lowers it again (A8).
//
// A WON DISPUTE (M6) takes the account's credit lock FIRST and only then locks
// the dispute's clawbacks (a settlement takes them in that order, audit #13).
// Its clawbacks are reversed and their pending claims zeroed in one statement
// (audit #3). A month a win makes the payment cover again is drawn inside the
// win, before the level is set (R4), so the next refresh writes nothing.
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
import { floorMicroToWholeCredits } from '@driftstack/api-types';
import type { CreditLedgerTx, DrizzleCreditLedgerRepo } from '../db/credit-ledger-repo.js';
import { rowsOf } from '../db/credit-ledger-repo.js';
import {
  unitTargetKey,
  type CreditClawbackRecord,
  type DrizzleCreditWindowsRepo,
} from '../db/credit-windows-repo.js';
import {
  floorToPriorMinute,
  invoiceTerms,
  reinstateGrantKey,
  returnedGrantKey,
  unitKeepMicro,
  type CreditGrantsService,
  type CreditUnitEvent,
} from './credit-grants.js';
import type { Logger } from '../lib/logger.js';
import type { SentryClient } from '../lib/sentry.js';

export { floorToPriorMinute, reinstateGrantKey, returnedGrantKey };

/** Parts per million: the unit an outcome reports a share of a payment in. */
export const PPM = 1_000_000;

/**
 * The share of a payment reversed so far, in parts per million, rounded to the
 * nearest part and clamped to the whole. INFORMATIONAL: it is what an outcome
 * reports. No amount is computed from it — every amount is exact integer
 * arithmetic on minor units, because shares rounded one event at a time can add
 * up to more than the whole (audit #11).
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
 * The part of `grantedMicro` the customer still paid for once
 * `reversedMinor` of a payment of `amountPaidMinor` is refunded or disputed:
 * `floor(granted × (paid − reversed) / paid)`. Rounded DOWN, in exact integer
 * arithmetic. A payment of nothing reverses nothing; a reversal beyond the
 * payment reverses the whole of it. (The interim cap's "what the payment still
 * pays for".)
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
 * What ONE lot keeps once the payment that bought it still pays
 * `amountPaidMinor − reversedMinor`: its grant scaled by what is still paid
 * over what was still paid WHEN IT WAS GRANTED (`stillPaidAtGrantMinor`, 0137;
 * null — a lot written before 0137 — is the whole payment), rounded DOWN to
 * whole credits (S17 re-audit #5). A lot granted while part of the payment
 * stood refunded keeps MORE than its grant once that part is put back. A
 * payment of nothing reverses nothing. It is the one-term case of
 * `unitKeepMicro`, which sums a unit's terms unfloored and rounds once (R3).
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
  if (stillPaidAtGrantMinor !== null) wholeMinor('still paid', stillPaidAtGrantMinor);
  return unitKeepMicro({
    amountPaidMinor,
    stillPaidMinor: amountPaidMinor - Math.min(amountPaidMinor, reversedMinor),
    terms: [{ micro: grantedMicro, stillPaidAtMinor: stillPaidAtGrantMinor }],
  });
}

/** Where one invoice's credit in one window stands, as the single-window arithmetic reads it. */
export interface ReversalWindowState {
  /** E — what the invoice's own lots keep at what is still paid. */
  readonly keepMicro: number;
  /** S — what left those lots on the customer's work: task charges, debt repaid, others' claims. */
  readonly consumedMicro: number;
  /** L — what those lots still hold, held credit included. */
  readonly remainingMicro: number;
  /** What running tasks hold of those lots. */
  readonly heldMicro: number;
  /** O — what the clawbacks standing against this credit already charged beyond these lots. */
  readonly owedMicro: number;
}

/** What one window gives up to a reversal. */
export interface WindowReversalPlan {
  /** What a take is asked for: `fromLotsMicro + beyondLotsMicro`. 0: nothing is written. */
  readonly amountMicro: number;
  /** Taken out of the lots: their free credit, and their held credit as a pending claim. */
  readonly fromLotsMicro: number;
  /** Credit that was spent: debt (or a claim on other held credit). */
  readonly beyondLotsMicro: number;
}

/**
 * The single-window form of a take: everything the customer holds or spent
 * above what they keep, less what the standing clawbacks already charged
 * beyond the lots — out of the lots first, and what the lots cannot give is
 * the part that becomes debt, never more than `debtBudgetMicro`. A unit's
 * reconciliation (credit-grants.ts) is this with the budget written as a
 * target: `S + L − O − max(E, S − allowed)`.
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
 * `paidForMicro` null means no cap beyond the per-window rule. (The grants
 * service shares the same cap out as a total, `allowedDebtByUnit`.)
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
 * A level scaled by what is still paid after an event over what was still
 * paid before it, rounded down to whole credits; unchanged when nothing was
 * still paid before. (What a window whose own payment covers nothing any more
 * would show, measured from where it stood; the grants service reads the same
 * number straight off the payment.)
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
  return Number((scaled / 1_000_000n) * 1_000_000n);
}

/** The clawback key of a Stripe refund: the charge and the cumulative it reached. */
export function refundSourceRef(chargeId: string, cumulativeRefundedMinor: number): string {
  return `${chargeId}:${String(cumulativeRefundedMinor)}`;
}

/**
 * What a reversal claws from: one invoice's (or crypto order's) credit in one
 * window — a credit UNIT. The window alone is not enough — a window can hold
 * credit two payments bought (a base month and its upgrade, or a refunded month
 * and the resubscription that took it over), and each reversal must see only
 * its own.
 */
export function reversalTargetKey(windowId: string, coverageRef: string): string {
  return unitTargetKey(windowId, coverageRef);
}

/**
 * The target of a dispute's RECORD row (S17 re-audit #13): the invoice, not a
 * window, so no read of a window's clawbacks sees it.
 */
export function disputeRecordTarget(stripeInvoiceId: string): string {
  return `invoice:${stripeInvoiceId}`;
}

/** The source reference a won dispute reconciles its payment's units under (re-audit #3). */
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
   * the dispute wrote no clawback row (audit #2). The invoice's disputed
   * amount falls by `amountMinor` on the dispute's first win only (R2); null
   * lowers it to nothing.
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
}

/** The event a refund of `ref` is reconciled at. */
function refundEvent(ref: string): CreditUnitEvent {
  return {
    source: 'stripe_refund',
    ref,
    ledgerKind: 'refund_clawback',
    debtReason: 'payment_reversed',
    label: 'refund',
  };
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
      // A plan change still waiting is measured before the refund moves anything.
      await this.deps.grants.reconcileLevel(tx, payment.accountId);
      await tx.execute(sql`
        UPDATE billing_invoice_payments
           SET refunded_minor = ${String(args.cumulativeRefundedMinor)}::bigint
         WHERE stripe_invoice_id = ${payment.stripeInvoiceId}
           AND refunded_minor < ${String(args.cumulativeRefundedMinor)}::bigint`);
      return this.reverse(tx, payment, {
        event: refundEvent(refundSourceRef(args.chargeId, args.cumulativeRefundedMinor)),
        reason: 'refund',
        reversedAfterMinor: args.cumulativeRefundedMinor + payment.disputedMinor,
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
      await this.deps.grants.reconcileLevel(tx, payment.accountId);
      // ⛔ THE SUM OF THE STANDING DISPUTES, BY DISPUTE ID (R2). Two disputes
      // standing on one payment each take their share; a win takes only its
      // own amount off, once. The payment row holds the sum capped at what was
      // paid (its own CHECK); each dispute's amount is on its rows (0139).
      const standing = await this.standingDisputedMinor(tx, payment);
      await this.setDisputed(tx, payment, standing + args.amountMinor);
      const outcome = await this.reverse(tx, payment, {
        event: {
          source: 'stripe_dispute',
          ref: args.disputeId,
          ledgerKind: 'refund_clawback',
          debtReason: 'payment_reversed',
          label: 'dispute',
          disputedMinor: args.amountMinor,
        },
        reason: 'dispute',
        reversedAfterMinor: payment.refundedMinor + payment.disputedMinor + args.amountMinor,
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
          disputedMinor: args.amountMinor,
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
    const { ledger, windows, grants } = this.deps;
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

      await ledger.lockAccount(tx, accountId);
      const applied = await windows.appliedDisputeClawbacks(tx, args.disputeId);
      const payment = invoiceId === null ? null : await this.paymentOfInvoice(tx, invoiceId);
      if (applied.length === 0) {
        // Either the win was already applied (a second event of the same win,
        // `closed` after `funds_reinstated`: R2, nothing changes), or it came
        // before the dispute's own `created`. In that case remember the win so
        // the late `created` changes nothing (re-audit #13), and leave the
        // invoice's disputed amount alone: this dispute never raised it.
        if (recorded.length === 0 && payment !== null && payment.accountId === accountId) {
          await windows.recordDispute(tx, {
            accountId,
            disputeId: args.disputeId,
            targetKey: disputeRecordTarget(payment.stripeInvoiceId),
            fractionPpm: reversedFractionPpm(args.amountMinor ?? 0, payment.amountPaidMinor),
            state: 'reversed',
            disputedMinor: args.amountMinor,
          });
        }
        return { kind: 'nothing_to_reinstate' };
      }

      // A plan change still waiting is measured first, on the undisputed level.
      await grants.reconcileLevel(tx, accountId);
      // Reversed and its claim zeroed in one statement: a task that settles
      // after the win pays the dispute nothing (audit #3).
      for (const clawback of applied) await windows.markClawbackReversed(tx, clawback.id);

      let regrantedMicro = 0;
      let forgivenMicro = 0;
      if (payment !== null && payment.accountId === accountId) {
        // What still stands once this dispute's rows are reversed: the other
        // disputes, by id (R2) — so a second event of the same win, finding
        // nothing applied, changed nothing above.
        await this.setDisputed(tx, payment, await this.standingDisputedMinor(tx, payment));
        // R4 — the month a win makes the payment cover again is drawn INSIDE
        // the win, before the level is set, so the next refresh writes nothing.
        await grants.materializeWindows(tx, accountId);
        const facts = await windows.invoicePayment(tx, accountId, payment.stripeInvoiceId);
        if (facts !== null) {
          const event: CreditUnitEvent = {
            source: 'stripe_dispute',
            ref: wonDisputeSettleRef(args.disputeId),
            ledgerKind: 'refund_clawback',
            debtReason: 'payment_reversed',
            label: 'dispute_reinstated',
          };
          const done = await grants.reconcilePaymentUnits(
            tx,
            accountId,
            { source: 'stripe_invoice', sourceRef: facts.stripeInvoiceId },
            invoiceTerms(facts),
            { mode: 'both', event, standsAlone: facts.lineKind !== 'proration_up' },
          );
          regrantedMicro = done.regrantedMicro;
          forgivenMicro = done.forgivenMicro;
          await grants.alignLevels(tx, accountId, {
            reason: 'dispute_reinstated',
            sourceRef: facts.stripeInvoiceId,
          });
          await grants.reconcileWindowUnits(tx, accountId, {
            event,
            exclude: [facts.stripeInvoiceId],
          });
        }
      }
      await ledger.settleDebtFromFree(tx, accountId);

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
    const { ledger, grants } = this.deps;
    try {
      return await ledger.transaction(async (tx) => {
        await ledger.lockAccount(tx, args.accountId);
        await grants.reconcileLevel(tx, args.accountId);
        // A refunded order is refunded whole: nothing is still paid on the term
        // it bought. Its entitlement has been revoked before this runs (or its
        // term is over), so nothing of it covers now().
        const event: CreditUnitEvent = {
          source: 'crypto_refund',
          ref: args.orderId,
          ledgerKind: 'refund_clawback',
          debtReason: 'payment_reversed',
          label: 'refund',
        };
        const done = await grants.reconcilePaymentUnits(
          tx,
          args.accountId,
          { source: 'crypto_entitlement', sourceRef: args.orderId },
          { amountPaidMinor: 1, stillPaidMinor: 0, paidForMicro: null },
          { mode: 'take', event, standsAlone: true },
        );
        await grants.alignLevels(tx, args.accountId, { reason: 'refund', sourceRef: args.orderId });
        await grants.reconcileWindowUnits(tx, args.accountId, { event, exclude: [args.orderId] });
        await ledger.settleDebtFromFree(tx, args.accountId);
        if (done.windows === 0) return { kind: 'no_windows', accountId: args.accountId };
        return {
          kind: 'applied',
          accountId: args.accountId,
          fractionPpm: PPM,
          clawbacks: done.clawbacks,
        };
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

  /**
   * A refund or a dispute of one Stripe payment, after its row has moved: its
   * units are brought to what it still pays (take only — a reversal never adds
   * credit), the current window's levels follow all coverage, the stand-alone
   * cover's share follows the window's own payment, and the debt that leaves
   * is repaid from whatever credit is now free — in this transaction, before
   * the commit-time check sees it (finding 1).
   */
  private async reverse(
    tx: CreditLedgerTx,
    payment: PaymentRow,
    input: {
      readonly event: CreditUnitEvent;
      readonly reason: 'refund' | 'dispute';
      readonly reversedAfterMinor: number;
    },
  ): Promise<ReversalOutcome> {
    const { ledger, windows, grants } = this.deps;
    const accountId = payment.accountId;
    const facts = await windows.invoicePayment(tx, accountId, payment.stripeInvoiceId);
    if (facts === null) throw new Error('a recorded payment could not be read back under its lock');
    const done = await grants.reconcilePaymentUnits(
      tx,
      accountId,
      { source: 'stripe_invoice', sourceRef: facts.stripeInvoiceId },
      invoiceTerms(facts),
      { mode: 'take', event: input.event, standsAlone: facts.lineKind !== 'proration_up' },
    );
    await grants.alignLevels(tx, accountId, {
      reason: input.reason,
      sourceRef: facts.stripeInvoiceId,
    });
    await grants.reconcileWindowUnits(tx, accountId, {
      event: input.event,
      exclude: [facts.stripeInvoiceId],
    });
    await ledger.settleDebtFromFree(tx, accountId);
    const fractionPpm = reversedFractionPpm(input.reversedAfterMinor, facts.amountPaidMinor);
    if (done.windows === 0) {
      this.deps.logger?.warn(
        {
          component: 'credit-clawbacks',
          event: 'reversal_earned_no_window',
          accountId,
          source: input.event.source,
        },
        'a reversed payment earned no credit window; nothing to take back',
      );
      return { kind: 'no_windows', accountId };
    }
    this.deps.logger?.info(
      {
        component: 'credit-clawbacks',
        event: 'payment_reversed',
        accountId,
        source: input.event.source,
        fractionPpm,
        windows: done.windows,
        clawbacks: done.clawbacks.length,
        debtMicro: done.clawbacks.reduce((sum, c) => sum + c.debtMicro, 0),
      },
      'a reversed payment took its credits back',
    );
    return { kind: 'applied', accountId, fractionPpm, clawbacks: done.clawbacks };
  }

  /**
   * S17 R2 — the sum of the disputes still standing on a payment, each by its
   * id and the amount on its rows (0139).
   */
  private async standingDisputedMinor(tx: CreditLedgerTx, payment: PaymentRow): Promise<number> {
    const standing = await this.deps.windows.standingDisputes(
      tx,
      payment.accountId,
      payment.stripeInvoiceId,
    );
    let sum = 0;
    for (const d of standing) sum = sum + d.amountMinor;
    return sum;
  }

  /** The payment row's disputed amount: the standing sum, capped at what was paid (its CHECK). */
  private async setDisputed(
    tx: CreditLedgerTx,
    payment: PaymentRow,
    sumMinor: number,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE billing_invoice_payments
         SET disputed_minor = LEAST(amount_paid_minor, ${String(Math.max(0, sumMinor))}::bigint)
       WHERE stripe_invoice_id = ${payment.stripeInvoiceId}`);
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
             pay.line_kind
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
}

/** `window:<window uuid>` or `window:<window uuid>:<invoice or order>`. The uuid
 *  is spelled 8-4-4-4-12, never 36 hex-or-dash characters (which admits 36
 *  dashes — twelve-copies-of-the-id-parser-must-agree). */
const WINDOW_TARGET =
  /^window:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::(.+))?$/;

/** A dispute's record target (`disputeRecordTarget`): `invoice:<invoice>`. */
const INVOICE_TARGET = /^invoice:(.+)$/;

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
  }>(result)[0];
  if (row === undefined) return null;
  return {
    stripeInvoiceId: row.stripe_invoice_id,
    accountId: row.account_id,
    amountPaidMinor: minor(row.amount_paid_minor),
    refundedMinor: minor(row.refunded_minor),
    disputedMinor: minor(row.disputed_minor),
    lineKind: row.line_kind,
  };
}

function minor(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('a stored amount is not a safe non-negative integer');
  }
  return value;
}
