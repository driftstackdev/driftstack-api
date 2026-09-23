// S17 — refunds and chargebacks take credits back, any shortfall becomes debt,
// and a won dispute restores what it took. Plan §6.7 and findings H2, L5, M6, M8,
// as corrected by the independent audit of S17.
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
//   F  the share of I reversed so far: (refunded + disputed) / paid, at most 1.
//      A dispute counts while it stands; a won one is taken off.
//   the lots of W that I paid for: W's monthly lot when W was drawn from I, the
//      proration lots of the plan-change steps keyed to I (0136), and the lots
//      a won dispute of I re-granted for W. Never another invoice's lot, never a
//      goodwill or bought lot.
//   A  what those lots were granted (a re-grant is not more of what I paid for);
//   S  what left them on the customer's work: task charges and debt repaid;
//   L  what they still hold, held credit included;
//   O  what the reversals of I that still stand on W already asked beyond what
//      they took from these lots: their debt, their standing claims, and the
//      claims they collected from any OTHER lot.
//   E  = floor((1 − F) × A): the credit the customer still paid for.
//
// The customer keeps E. Everything they hold or spent above it, less what the
// earlier reversals already charged for, is taken now: `S + L − E − O`, out of
// L first (free credit taken, held credit a pending claim), and the rest —
// credit that was spent — is debt. Nothing when that is 0 or less: no row is
// written for W. So a second refund after the first refund's credit expired
// finds nothing to take, two refunds of the whole owe exactly what was spent,
// and a delivery repeated or out of order recomputes the same state and takes
// nothing more (L5 still keys each distinct cumulative once).
//
// ⛔ O COUNTS STANDING CLAIMS, NOT ONLY DEBT. The coordinator's model counted
// only `debt_micro` of the earlier reversals. Counterexample: a task holds the
// whole 3,000-credit month when the invoice is fully refunded — the clawback is
// 3,000 of PENDING claim and 0 debt; a dispute of the same charge before the
// task settles then saw nothing already asked and claimed 3,000 again, and at
// settlement the customer owed 2,500 for 1,000 spent. Counting the claim (and
// what it collects from other lots) as already asked makes the second event a
// no-op, and a claim paid from these lots is already out of L.
//
// ⛔ AN ANNUAL INVOICE'S DEBT IS CAPPED ACROSS ITS WINDOWS — AN INTERIM RULE
// PENDING THE OWNER (audit #6). Applied per window, a refund of half a year
// canceled in month one owes half of the month the customer used, although six
// months are still paid for and one was used; a month-six cancellation with
// every month spent would owe 9,000. Until the owner rules, the debt a
// reversal creates across ALL of an invoice's windows is capped at
// `max(0, ΣS − (1 − F) × what the payment bought)`, where what it bought is the
// line's plan allowance × the months it pays for (12 for a yearly line, 1 for a
// monthly one). The cap only ever LOWERS debt, never raises it. For a monthly
// invoice it binds only on a short first window, where it is kinder; an upgrade
// (proration) invoice paid for its prorated lot and nothing more, so it is not
// capped beyond the per-window rule — the plan allowance would have forgiven
// debt for credit its payment never bought.
//
// ⛔ THE LEVEL FOLLOWS ALL COVERAGE, NOT THE INVOICE ALONE (audit #4, #16).
// After a reversal the invoice's CURRENT window moves to the level every paid
// coverage over now() earns together — the same query the next reconciliation
// runs, so that refresh finds nothing to do. A reversal only ever lowers it (a
// higher target is an upgrade nobody has granted yet, and granting it is the
// reconciliation's job). When nothing covers now — the subscription canceled
// before the refund arrived — the level falls by the share of what was still
// paid that this event reverses, not to zero, so a later resubscription is an
// upgrade from the right place. The level change records 0 as its delta: the
// credits moved are the clawback's rows (audit #14).
//
// A WON DISPUTE (M6) takes the account's credit lock FIRST and only then locks
// the dispute's clawbacks (a settlement takes them in that order, audit #13).
// Whether or not the dispute took anything — it may have been all debt, or
// have found no credit and written no row at all — the invoice's disputed
// amount is lowered by the dispute's and the window's level put back (audit
// #2). Each clawback the dispute wrote is reversed and its pending claim zeroed
// in one statement (audit #3), the debt it created forgiven as far as it is
// still owed, and what it took — the credit it clawed and the claims it
// already collected — re-granted as one goodwill lot that dies with the window.
// A dispute redelivered after the win finds its reversed rows and is already
// applied (audit #12).
//
//   · A crypto order refunded is F = 1 on the term that order bought.
//   · A refund whose invoice has not been recorded yet (it arrived before
//     `invoice.paid`) is refused with `CreditReversalAwaitsPaymentError`, which
//     the webhook lets through so Stripe redelivers it (audit #8). A charge
//     that names no invoice at all is kept for review: logged at error with the
//     charge, alerted without it. Nothing is guessed.
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
  planMonthlyCreditsMicro,
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

/** Where one invoice's credit in one window stands, as a reversal reads it. */
export interface ReversalWindowState {
  /** A — what the invoice's own lots in the window were granted (never a re-grant). */
  readonly grantedMicro: number;
  /** S — what left those lots on the customer's work: task charges and debt repaid. */
  readonly consumedMicro: number;
  /** L — what those lots still hold, held credit included. */
  readonly remainingMicro: number;
  /** What running tasks hold of those lots. */
  readonly heldMicro: number;
  /** O — what the invoice's standing reversals already asked of the window beyond these lots. */
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
 * they still paid for, less what the invoice's earlier reversals already asked
 * beyond the lots — out of the lots first, and what the lots cannot give is
 * the part that becomes debt, never more than `debtBudgetMicro`.
 */
export function planWindowReversal(
  w: ReversalWindowState,
  terms: { readonly amountPaidMinor: number; readonly reversedMinor: number },
  debtBudgetMicro: number,
): WindowReversalPlan {
  const keep = stillPaidForMicro(w.grantedMicro, terms.amountPaidMinor, terms.reversedMinor);
  const needed = Math.max(0, w.consumedMicro + w.remainingMicro - keep - w.owedMicro);
  const fromLotsMicro = Math.min(needed, w.remainingMicro);
  const beyondLotsMicro = Math.min(needed - fromLotsMicro, Math.max(0, debtBudgetMicro));
  return { amountMicro: fromLotsMicro + beyondLotsMicro, fromLotsMicro, beyondLotsMicro };
}

/**
 * The most debt one reversal may still create across ALL of an invoice's
 * windows — the interim cap pending the owner (see the header): what was spent
 * less what the payment still pays for, less what the invoice's standing
 * reversals already charged for spent credit. `paidForMicro` null means no cap
 * beyond the per-window rule.
 *
 * What a standing reversal "already charged for spent credit" is its `O` less
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
  const keep = stillPaidForMicro(terms.paidForMicro, terms.amountPaidMinor, terms.reversedMinor);
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

/** The goodwill lot a won dispute re-grants, one per clawback it reverses. */
export function reinstateGrantKey(clawbackId: string): string {
  return `reinstate:${clawbackId}`;
}

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
      // A dispute applies once. Any row it wrote — standing, or reversed by a
      // win — says it was applied: a `created` redelivered after the win must
      // not dispute the invoice again (audit #12).
      const recorded = await windows.clawbacksForSource(tx, 'stripe_dispute', args.disputeId);
      if (recorded.length > 0 || args.amountMinor === 0) {
        return { kind: 'already_applied', accountId: payment.accountId };
      }
      const disputedAfter = Math.max(payment.disputedMinor, args.amountMinor);
      await tx.execute(sql`
        UPDATE billing_invoice_payments
           SET disputed_minor = GREATEST(disputed_minor, ${String(args.amountMinor)}::bigint)
         WHERE stripe_invoice_id = ${payment.stripeInvoiceId}`);
      return this.reverse(tx, {
        accountId: payment.accountId,
        source: 'stripe_dispute',
        sourceRef: args.disputeId,
        coverage: { source: 'stripe_invoice', sourceRef: payment.stripeInvoiceId },
        amountPaidMinor: payment.amountPaidMinor,
        reversedBeforeMinor: payment.refundedMinor + payment.disputedMinor,
        reversedAfterMinor: payment.refundedMinor + disputedAfter,
        paidForMicro: paidForMicro(payment),
        levelReason: 'dispute',
      });
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

      let regrantedMicro = 0;
      let forgivenMicro = 0;
      let owed = account.debtMicro;
      for (const clawback of applied) {
        // Reversed and its claim zeroed in one statement: a task that settles
        // after the win pays the dispute nothing (audit #3).
        await windows.markClawbackReversed(tx, clawback.id);
        // The debt this clawback created — its own shortfall and any claim that
        // turned into debt — as much of it as is still owed. A repayment does
        // not say which debt it paid, so what is forgiven is bounded by both.
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
        regrantedMicro = regrantedMicro + (await this.regrant(tx, accountId, clawback));
      }

      // ⛔ THE INVOICE IS WHOLE AGAIN WHETHER OR NOT ANYTHING WAS TAKEN (audit
      // #2): a dispute that was all debt, or that found nothing and wrote no
      // row, still marked the invoice disputed and lowered the level.
      let restored = false;
      const payment = invoiceId === null ? null : await this.paymentOfInvoice(tx, invoiceId);
      if (payment !== null && payment.accountId === accountId) {
        // Any plan change still waiting is reconciled FIRST, against the
        // coverage as it stands without this invoice: the level the win then
        // restores is the invoice's own, and a pending upgrade keeps its lot.
        await this.deps.grants.reconcileLevel(tx, accountId);
        const lowerBy = args.amountMinor ?? payment.disputedMinor;
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
        // A refunded order is refunded whole: F = 1 on the term it bought. Its
        // entitlement has been revoked before this runs (or its term is over),
        // so nothing of it covers now().
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
      this.deps.logger?.warn(
        {
          component: 'credit-clawbacks',
          event: 'reversal_earned_no_window',
          accountId: t.accountId,
          source: t.source,
        },
        'a reversed payment earned no credit window; nothing to take back',
      );
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
      const plan = planWindowReversal(state, terms, budget);
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
    if (current !== undefined) await this.levelAfterReversal(tx, t, current);

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
    const standing = await windows.standingReversals(tx, t.accountId, targetKey);
    const collected = await windows.collectedClaims(tx, t.accountId, { targetKey });
    const ownLots = new Set(lots.map((l) => l.lotId));
    const standingIds = new Set(standing.map((r) => r.id));
    let asked = 0;
    for (const r of standing) asked = asked + Math.max(0, r.amountMicro - r.clawedMicro);
    // A claim a standing reversal collected from THESE lots is already out of
    // L; counting it in O as well would count it twice.
    let collectedHere = 0;
    for (const c of collected) {
      if (standingIds.has(c.clawbackId) && ownLots.has(c.lotId)) {
        collectedHere = collectedHere + c.micro;
      }
    }
    let granted = 0;
    let consumed = 0;
    let remaining = 0;
    let held = 0;
    for (const lot of lots) {
      if (!lot.regrant) granted = granted + lot.grantedMicro;
      consumed = consumed + lot.consumedMicro;
      remaining = remaining + lot.remainingMicro;
      held = held + lot.heldMicro;
    }
    return {
      lots,
      targetKey,
      state: {
        grantedMicro: granted,
        consumedMicro: consumed,
        remainingMicro: remaining,
        heldMicro: held,
        owedMicro: Math.max(0, asked - collectedHere),
      },
    };
  }

  /**
   * Lower the invoice's current window to what all coverage earns now — never
   * raise it — or, when nothing covers now, by the share of what was still paid
   * that this event reverses (audit #4, #16). Recorded with a delta of 0.
   */
  private async levelAfterReversal(
    tx: CreditLedgerTx,
    t: ReversalTerms,
    current: SourcedCreditWindow,
  ): Promise<void> {
    const cover = await this.deps.windows.coverNow(tx, t.accountId);
    if (cover === null || cover.windowId !== current.id) return;
    const target =
      cover.targetMicro ??
      levelScaledByPayment(
        cover.levelMicro,
        Math.max(0, t.amountPaidMinor - t.reversedBeforeMinor),
        Math.max(0, t.amountPaidMinor - t.reversedAfterMinor),
      );
    if (target >= cover.levelMicro) return;
    await this.moveLevel(tx, t.accountId, cover, target, t.levelReason, t.coverage.sourceRef);
  }

  /**
   * Put the invoice's current window back after a win: up to what all coverage
   * earns now, or — when nothing covers now (the subscription canceled in the
   * meantime) — up by the share of the payment the win restored, or, when the
   * dispute had reversed all of what was still paid, to what the invoice's own
   * payment covers whatever its subscription says. Never lowered here.
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
    await this.moveLevel(
      tx,
      payment.accountId,
      cover,
      target,
      'dispute_reinstated',
      payment.stripeInvoiceId,
    );
    return true;
  }

  /** Re-grant what one reversed dispute clawback took, for the window it came from. */
  private async regrant(
    tx: CreditLedgerTx,
    accountId: string,
    clawback: CreditClawbackRecord,
  ): Promise<number> {
    const { ledger, windows } = this.deps;
    const windowId = windowIdOf(clawback.targetKey);
    if (windowId === null) return 0;
    // What it took: the credit it clawed from the lots, and the claims it
    // already collected from credit settling tasks released — measured from
    // the claim rows themselves (`claim:<clawback>:…`), not inferred.
    let collected = 0;
    for (const c of await windows.collectedClaims(tx, accountId, { clawbackId: clawback.id })) {
      collected = collected + c.micro;
    }
    const took = clawback.clawedMicro + collected;
    if (took <= 0) return 0;
    const window = await this.windowById(tx, accountId, windowId);
    // A win after the window ended re-grants nothing: the credit would have
    // expired with its window (M6).
    if (window === null || window.windowEnd <= pgInstant(this.now())) return 0;
    const inserted = await ledger.insertLot(
      {
        accountId,
        kind: 'adjustment',
        grantKey: reinstateGrantKey(clawback.id),
        grantedMicro: took,
        startsAt: floorToPriorMinute(this.now()),
        expiresAt: new Date(window.windowEnd),
      },
      tx,
    );
    if (!inserted.inserted) return 0;
    await ledger.append(
      {
        accountId,
        kind: 'grant',
        lotId: inserted.lot.id,
        amountMicro: took,
        idempotencyKey: `${reinstateGrantKey(clawback.id)}:grant`,
        reason: 'dispute_reinstated',
      },
      tx,
    );
    return took;
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
   * is simply not recorded YET — the reversal is refused for a retry. When it
   * names none, it is kept for review.
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
      SELECT stripe_invoice_id, account_id, amount_paid_minor::text AS amount_paid_minor,
             refunded_minor::text AS refunded_minor, disputed_minor::text AS disputed_minor,
             line_kind, line_interval, line_tier::text AS line_tier
        FROM billing_invoice_payments
       WHERE (${chargeId}::text IS NOT NULL AND stripe_charge_id = ${chargeId})
          OR (${stripeInvoiceId}::text IS NOT NULL AND stripe_invoice_id = ${stripeInvoiceId})
       ORDER BY (stripe_charge_id IS NOT DISTINCT FROM ${chargeId}::text) DESC, paid_at DESC
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
      SELECT id, level_micro::text AS level_micro, level_seq,
             to_char(window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_start,
             to_char(window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_end,
             (window_start <= now() AND now() < window_end) AS current
        FROM credit_windows WHERE id = ${windowId}::uuid AND account_id = ${accountId}::uuid
       ORDER BY id`);
    const r = rowsOf<{
      id: string;
      level_micro: string;
      level_seq: number;
      window_start: string;
      window_end: string;
      current: boolean;
    }>(result)[0];
    if (r === undefined) return null;
    return {
      id: r.id,
      levelMicro: minor(r.level_micro),
      levelSeq: r.level_seq,
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
 * What the payment bought, in microcredits, for the interim cap: the line's
 * plan allowance × the months it pays for. Null — no cap beyond the per-window
 * rule — for an upgrade line (it bought its prorated lot, nothing more), a line
 * on a plan with no plan-wide allowance, or one whose interval is unknown.
 */
function paidForMicro(payment: PaymentRow): number | null {
  if (payment.lineKind !== 'period' || payment.lineTier === null) return null;
  const months = payment.lineInterval === 'year' ? 12 : payment.lineInterval === 'month' ? 1 : null;
  if (months === null) return null;
  const tier = AccountTierSchema.safeParse(payment.lineTier);
  if (!tier.success || !Object.hasOwn(AI_PLAN_ENTITLEMENTS, tier.data)) return null;
  const monthly = planMonthlyCreditsMicro(tier.data);
  return monthly === null || monthly <= 0 ? null : monthly * months;
}

/** A level scaled UP by what a win restored, rounded down to whole credits. */
function scaledUp(levelMicro: number, stillPaidBefore: number, stillPaidAfter: number): number {
  const scaled = (BigInt(levelMicro) * BigInt(stillPaidAfter)) / BigInt(stillPaidBefore);
  return Number((scaled / MICRO_PER_CREDIT) * MICRO_PER_CREDIT);
}

const WINDOW_TARGET = /^window:([0-9a-f-]{36})(?::(.+))?$/;

/** The window a clawback's target names. */
function windowIdOf(targetKey: string): string | null {
  return WINDOW_TARGET.exec(targetKey)?.[1] ?? null;
}

/** The invoice or order a reversal's target names (`window:<window>:<coverage>`). */
function coverageRefOf(targetKey: string): string | null {
  return WINDOW_TARGET.exec(targetKey)?.[2] ?? null;
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
