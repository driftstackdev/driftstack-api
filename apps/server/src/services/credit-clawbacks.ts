// S17 — refunds and chargebacks take credits back, any shortfall becomes debt,
// and a won dispute restores what it took. Plan §6.7 and findings H2, L5, M6, M8.
//
// What a reversed payment does to the credits it bought:
//
//   · A refund of a fraction `f` of an invoice (or a dispute of `f`) claws
//     `floor(f × what the invoice's lots EVER HELD)` out of each window that
//     invoice earned — never what expired unspent (H2), never what a running
//     task holds (that becomes a pending claim the settlement pays). What the
//     lots can no longer give is DEBT, and an account in debt cannot start a
//     task on credits until it is paid (its own key is unaffected). The
//     arithmetic is `planClawbackOfAmount` and the writing is `clawBack`, both
//     in credit-grants.ts: a refund differs from a plan change only in what it
//     claws and why the debt is owed.
//   · The invoice's CURRENT window is levelled down by the same fraction (M8),
//     to the level the coverage reads now compute for that invoice — the same
//     expression, so the next reconciliation finds nothing to change, and a new
//     paid source on a later subscription is treated as an upgrade FROM the
//     reduced level rather than ignored.
//   · The fraction of a refund is measured against the LARGEST cumulative
//     refund seen so far for the charge (L5): Stripe's `amount_refunded` is
//     cumulative, deliveries arrive out of order and more than once, and each
//     distinct cumulative claws exactly once — the clawback rows are keyed on
//     `<charge>:<cumulative>` per window, and a cumulative that is not higher
//     than the stored one claws nothing.
//   · A won dispute (M6) reverses its clawback: the clawback row moves to
//     `reversed`, the unrepaid debt it created is forgiven, the credits it took
//     are re-granted as a goodwill lot that dies with the window they came
//     from, and the window's level is put back.
//   · A crypto order refunded is `f = 1` on the term that order bought.
//   · A refund that matches no recorded payment is kept for review: logged at
//     error with the charge, and alerted without it. Nothing is guessed.
//
// ⛔ ONE ACCOUNT, ONE TRANSACTION, UNDER THE CREDIT LOCK. The payment row's
// cumulative, the level change and every ledger row commit together or not
// at all, so a redelivery that arrives mid-way finds either everything or
// nothing. Nothing here fails a webhook for a customer-visible reason: the
// caller decides what a thrown error means for the delivery (a transient one
// is retried by the provider; any other is logged and the event acknowledged).

import { sql } from 'drizzle-orm';
import type { AiDebtReason } from '@driftstack/api-types';
import type { CreditLedgerTx, DrizzleCreditLedgerRepo } from '../db/credit-ledger-repo.js';
import { rowsOf } from '../db/credit-ledger-repo.js';
import type {
  ClawbackTargetLot,
  CreditClawbackRecord,
  CreditClawbackSource,
  CreditWindowLevelChangeReason,
  CreditWindowSource,
  DrizzleCreditWindowsRepo,
  PgInstant,
  SourcedCreditWindow,
} from '../db/credit-windows-repo.js';
import type { CreditGrantsService } from './credit-grants.js';
import type { Logger } from '../lib/logger.js';
import type { SentryClient } from '../lib/sentry.js';

/** Parts per million: the unit `credit_clawbacks.fraction_ppm` records a share in. */
export const PPM = 1_000_000;

/**
 * The share of a payment one reversal is, in parts per million, rounded to the
 * nearest part and clamped to the whole. `deltaMinor` is the NEW money reversed
 * by this event — for a refund, the cumulative less the largest cumulative
 * already recorded — never the cumulative itself.
 */
export function reversedFractionPpm(deltaMinor: number, amountPaidMinor: number): number {
  if (!Number.isSafeInteger(deltaMinor) || !Number.isSafeInteger(amountPaidMinor)) {
    throw new RangeError('a reversal and a payment are whole minor units');
  }
  if (amountPaidMinor <= 0 || deltaMinor <= 0) return 0;
  return Math.min(PPM, Math.round((deltaMinor * PPM) / amountPaidMinor));
}

/**
 * What a reversal of `fractionPpm` asks of one window's lots: the fraction of
 * what they EVER HELD — granted less what expired unspent (H2). Rounded down,
 * so a rounding never asks for a microcredit the payment did not buy.
 */
export function clawbackAmountForFraction(
  lots: readonly ClawbackTargetLot[],
  fractionPpm: number,
): number {
  if (!Number.isSafeInteger(fractionPpm) || fractionPpm < 0 || fractionPpm > PPM) {
    throw new RangeError('a fraction is between 0 and one million parts per million');
  }
  let everHeld = 0;
  for (const lot of lots) everHeld = everHeld + Math.max(0, lot.grantedMicro - lot.expiredMicro);
  return Math.floor((everHeld * fractionPpm) / PPM);
}

/** The clawback key of a Stripe refund: the charge and the cumulative it reached. */
export function refundSourceRef(chargeId: string, cumulativeRefundedMinor: number): string {
  return `${chargeId}:${String(cumulativeRefundedMinor)}`;
}

/** The goodwill lot a won dispute re-grants, one per clawback it reverses. */
export function reinstateGrantKey(clawbackId: string): string {
  return `reinstate:${clawbackId}`;
}

export type ReversalOutcome =
  /** Credits were taken (or nothing was left to take) from the windows named. */
  | {
      readonly kind: 'applied';
      readonly accountId: string;
      readonly fractionPpm: number;
      readonly clawbacks: readonly CreditClawbackRecord[];
    }
  /** The same or a smaller cumulative was already recorded: nothing to do (L5). */
  | { readonly kind: 'already_applied'; readonly accountId: string }
  /** The payment is on record but earned no window (an account never granted). */
  | { readonly kind: 'no_windows'; readonly accountId: string }
  /** No recorded payment matches; kept for review. */
  | { readonly kind: 'unmatched' };

export type ReinstateOutcome =
  | {
      readonly kind: 'reinstated';
      readonly accountId: string;
      readonly reversed: number;
      readonly regrantedMicro: number;
      readonly forgivenMicro: number;
    }
  /** Nothing applied stands under that dispute: already reinstated, or never clawed. */
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
  reinstateDispute(args: { disputeId: string }): Promise<ReinstateOutcome>;
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
    if (!Number.isSafeInteger(args.cumulativeRefundedMinor) || args.cumulativeRefundedMinor < 0) {
      throw new RangeError('a cumulative refund is a whole non-negative number of minor units');
    }
    const { ledger } = this.deps;
    return ledger.transaction(async (tx) => {
      const found = await this.findPayment(tx, args.chargeId, args.stripeInvoiceId);
      if (found === null) return this.unmatched('refund', args.chargeId);
      await ledger.lockAccount(tx, found.accountId);
      // Re-read under the lock: the cumulative is compared against the row as
      // it is NOW, not as it was before the lock was taken.
      const payment = (await this.findPayment(tx, args.chargeId, args.stripeInvoiceId)) ?? found;
      const delta = args.cumulativeRefundedMinor - payment.refundedMinor;
      if (delta <= 0) return { kind: 'already_applied', accountId: payment.accountId };
      await tx.execute(sql`
        UPDATE billing_invoice_payments
           SET refunded_minor = ${String(args.cumulativeRefundedMinor)}::bigint
         WHERE stripe_invoice_id = ${payment.stripeInvoiceId}
           AND refunded_minor < ${String(args.cumulativeRefundedMinor)}::bigint`);
      const fractionPpm = reversedFractionPpm(delta, payment.amountPaidMinor);
      return this.reverse(tx, {
        accountId: payment.accountId,
        source: 'stripe_refund',
        sourceRef: refundSourceRef(args.chargeId, args.cumulativeRefundedMinor),
        windowSource: 'stripe_invoice',
        windowSourceRef: payment.stripeInvoiceId,
        fractionPpm,
        levelReason: 'refund',
        levelFor: () =>
          this.deps.windows.coverageLevelForInvoice(tx, payment.accountId, payment.stripeInvoiceId),
      });
    });
  }

  async applyStripeDispute(args: {
    disputeId: string;
    chargeId: string;
    stripeInvoiceId: string | null;
    amountMinor: number;
  }): Promise<ReversalOutcome> {
    if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor < 0) {
      throw new RangeError('a disputed amount is a whole non-negative number of minor units');
    }
    const { ledger } = this.deps;
    return ledger.transaction(async (tx) => {
      const found = await this.findPayment(tx, args.chargeId, args.stripeInvoiceId);
      if (found === null) return this.unmatched('dispute', args.chargeId);
      await ledger.lockAccount(tx, found.accountId);
      const payment = (await this.findPayment(tx, args.chargeId, args.stripeInvoiceId)) ?? found;
      // One dispute stands per charge at a time; a redelivery of `created` finds
      // its clawback rows already there and claws nothing (the key below).
      const standing = await this.deps.windows.appliedClawbacksForSource(
        tx,
        'stripe_dispute',
        args.disputeId,
      );
      if (standing.length > 0) return { kind: 'already_applied', accountId: payment.accountId };
      if (args.amountMinor === 0) return { kind: 'already_applied', accountId: payment.accountId };
      await tx.execute(sql`
        UPDATE billing_invoice_payments
           SET disputed_minor = GREATEST(disputed_minor, ${String(args.amountMinor)}::bigint)
         WHERE stripe_invoice_id = ${payment.stripeInvoiceId}`);
      const fractionPpm = reversedFractionPpm(args.amountMinor, payment.amountPaidMinor);
      return this.reverse(tx, {
        accountId: payment.accountId,
        source: 'stripe_dispute',
        sourceRef: args.disputeId,
        windowSource: 'stripe_invoice',
        windowSourceRef: payment.stripeInvoiceId,
        fractionPpm,
        levelReason: 'dispute',
        levelFor: () =>
          this.deps.windows.coverageLevelForInvoice(tx, payment.accountId, payment.stripeInvoiceId),
      });
    });
  }

  async reinstateDispute(args: { disputeId: string }): Promise<ReinstateOutcome> {
    const { ledger, windows } = this.deps;
    return ledger.transaction(async (tx) => {
      const applied = await windows.appliedClawbacksForSource(tx, 'stripe_dispute', args.disputeId);
      const first = applied[0];
      if (first === undefined) return { kind: 'nothing_to_reinstate' };
      const accountId = first.accountId;
      const account = await ledger.lockAccount(tx, accountId);
      let regrantedMicro = 0;
      let forgivenMicro = 0;
      let owed = account.debtMicro;
      let invoiceId: string | null = null;
      for (const clawback of applied) {
        await windows.markClawbackReversed(tx, clawback.id);
        // The debt this clawback created, as much of it as is still owed. A
        // repayment does not say which debt it paid, so what is forgiven is
        // bounded by both: this clawback's own debt, and what the account owes now.
        const forgive = Math.min(owed, clawback.debtMicro ?? 0);
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
        const windowId = windowIdOf(clawback.targetKey);
        const clawed = clawback.clawedMicro ?? 0;
        if (windowId !== null && clawed > 0) {
          const window = await this.windowById(tx, accountId, windowId);
          if (window !== null && window.windowEnd > pgInstant(this.now())) {
            const inserted = await ledger.insertLot(
              {
                accountId,
                kind: 'adjustment',
                grantKey: reinstateGrantKey(clawback.id),
                grantedMicro: clawed,
                startsAt: floorToPriorMinute(this.now()),
                expiresAt: new Date(window.windowEnd),
              },
              tx,
            );
            if (inserted.inserted) {
              await ledger.append(
                {
                  accountId,
                  kind: 'grant',
                  lotId: inserted.lot.id,
                  amountMicro: clawed,
                  idempotencyKey: `${reinstateGrantKey(clawback.id)}:grant`,
                  reason: 'dispute_reinstated',
                },
                tx,
              );
              regrantedMicro = regrantedMicro + clawed;
            }
          }
          // Put the window's level back: the payment is whole again, so the
          // level the coverage reads compute for its invoice is the level the
          // dispute took it down from.
          if (invoiceId === null) invoiceId = await this.invoiceOfWindow(tx, accountId, windowId);
          if (invoiceId !== null) {
            await tx.execute(sql`
              UPDATE billing_invoice_payments
                 SET disputed_minor = GREATEST(disputed_minor - ${String(await this.disputedMinorOf(tx, invoiceId, clawback))}::bigint, 0)
               WHERE stripe_invoice_id = ${invoiceId}`);
          }
        }
      }
      if (invoiceId !== null) {
        const windowsOfInvoice = await windows.windowsForSource(
          tx,
          accountId,
          'stripe_invoice',
          invoiceId,
        );
        const current = windowsOfInvoice.find((w) => w.current);
        if (current !== undefined) {
          const level = await windows.coverageLevelForInvoice(tx, accountId, invoiceId);
          await this.moveLevel(
            tx,
            accountId,
            current,
            level ?? current.levelMicro,
            'dispute_reinstated',
          );
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
    const { ledger } = this.deps;
    return ledger.transaction(async (tx) => {
      await ledger.lockAccount(tx, args.accountId);
      return this.reverse(tx, {
        accountId: args.accountId,
        source: 'crypto_refund',
        sourceRef: args.orderId,
        windowSource: 'crypto_entitlement',
        windowSourceRef: args.orderId,
        fractionPpm: PPM,
        levelReason: 'refund',
        // The order's entitlement has been revoked before this runs (or is about
        // to be): the term covers nothing, so the level goes to zero.
        levelFor: () => Promise.resolve(0),
      });
    });
  }

  // ── the shared reversal ────────────────────────────────────────────────

  private async reverse(
    tx: CreditLedgerTx,
    args: {
      accountId: string;
      source: CreditClawbackSource;
      sourceRef: string;
      windowSource: CreditWindowSource;
      windowSourceRef: string;
      fractionPpm: number;
      levelReason: CreditWindowLevelChangeReason;
      levelFor: () => Promise<number | null>;
    },
  ): Promise<ReversalOutcome> {
    const { windows, grants } = this.deps;
    const targets = await windows.windowsForSource(
      tx,
      args.accountId,
      args.windowSource,
      args.windowSourceRef,
    );
    if (targets.length === 0) {
      this.deps.logger?.warn(
        {
          component: 'credit-clawbacks',
          event: 'reversal_earned_no_window',
          accountId: args.accountId,
          source: args.source,
        },
        'a reversed payment earned no credit window; nothing to take back',
      );
      return { kind: 'no_windows', accountId: args.accountId };
    }
    const clawbacks: CreditClawbackRecord[] = [];
    for (const window of targets) {
      const lots = await windows.clawbackTargets(tx, args.accountId, window.id);
      const amountMicro = clawbackAmountForFraction(lots, args.fractionPpm);
      if (amountMicro <= 0) continue;
      const record = await grants.clawBack(tx, args.accountId, {
        source: args.source,
        sourceRef: args.sourceRef,
        targetKey: `window:${window.id}`,
        windowId: window.id,
        amountMicro,
        ledgerKind: 'refund_clawback',
        debtReason: 'payment_reversed' satisfies AiDebtReason,
        ledgerKeyPrefix: `clawback:${args.source}:${args.sourceRef}:${window.id}`,
      });
      clawbacks.push(record);
    }
    const current = targets.find((w) => w.current);
    if (current !== undefined) {
      const level = await args.levelFor();
      await this.moveLevel(tx, args.accountId, current, level ?? 0, args.levelReason);
    }
    this.deps.logger?.info(
      {
        component: 'credit-clawbacks',
        event: 'payment_reversed',
        accountId: args.accountId,
        source: args.source,
        fractionPpm: args.fractionPpm,
        windows: targets.length,
        clawbacks: clawbacks.length,
        debtMicro: clawbacks.reduce((sum, c) => sum + (c.debtMicro ?? 0), 0),
      },
      'a reversed payment took its credits back',
    );
    return { kind: 'applied', accountId: args.accountId, fractionPpm: args.fractionPpm, clawbacks };
  }

  /** Move a window's level to `toLevelMicro`, recording why; nothing when it is there already. */
  private async moveLevel(
    tx: CreditLedgerTx,
    accountId: string,
    window: SourcedCreditWindow,
    toLevelMicro: number,
    reason: CreditWindowLevelChangeReason,
  ): Promise<void> {
    if (toLevelMicro === window.levelMicro) return;
    await this.deps.windows.setWindowLevel(tx, {
      accountId,
      windowId: window.id,
      seq: window.levelSeq + 1,
      reason,
      fromLevelMicro: window.levelMicro,
      toLevelMicro,
      effectiveAt: pgInstant(this.now()),
      // The credits this change is worth for the rest of the window are the
      // ones the clawback (or the reinstatement) moved through the ledger; the
      // level row records the direction, not a second amount.
      deltaMicro: toLevelMicro - window.levelMicro,
    });
  }

  private async findPayment(
    tx: CreditLedgerTx,
    chargeId: string,
    stripeInvoiceId: string | null,
  ): Promise<PaymentRow | null> {
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT stripe_invoice_id, account_id, amount_paid_minor::text AS amount_paid_minor,
             refunded_minor::text AS refunded_minor, disputed_minor::text AS disputed_minor
        FROM billing_invoice_payments
       WHERE stripe_charge_id = ${chargeId}
          OR (${stripeInvoiceId}::text IS NOT NULL AND stripe_invoice_id = ${stripeInvoiceId})
       ORDER BY (stripe_charge_id = ${chargeId}) DESC, paid_at DESC
       LIMIT 1`);
    const row = rowsOf<{
      stripe_invoice_id: string;
      account_id: string;
      amount_paid_minor: string;
      refunded_minor: string;
      disputed_minor: string;
    }>(result)[0];
    if (row === undefined) return null;
    return {
      stripeInvoiceId: row.stripe_invoice_id,
      accountId: row.account_id,
      amountPaidMinor: minor(row.amount_paid_minor),
      refundedMinor: minor(row.refunded_minor),
      disputedMinor: minor(row.disputed_minor),
    };
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
        FROM credit_windows WHERE id = ${windowId}::uuid AND account_id = ${accountId}::uuid`);
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

  private async invoiceOfWindow(
    tx: CreditLedgerTx,
    accountId: string,
    windowId: string,
  ): Promise<string | null> {
    const result = await tx.execute<{ source: string; source_ref: string }>(sql`
      SELECT source, source_ref FROM credit_windows
       WHERE id = ${windowId}::uuid AND account_id = ${accountId}::uuid`);
    const r = rowsOf<{ source: string; source_ref: string }>(result)[0];
    return r !== undefined && r.source === 'stripe_invoice' ? r.source_ref : null;
  }

  /**
   * What a reversed dispute clawback took of the payment, in minor units, so
   * the invoice's `disputed_minor` can be lowered by the same share. Recovered
   * from the clawback's own record rather than the event, which a won dispute
   * may not restate.
   */
  private async disputedMinorOf(
    tx: CreditLedgerTx,
    stripeInvoiceId: string,
    clawback: CreditClawbackRecord,
  ): Promise<number> {
    const result = await tx.execute<{ amount_paid_minor: string; disputed_minor: string }>(sql`
      SELECT amount_paid_minor::text AS amount_paid_minor, disputed_minor::text AS disputed_minor
        FROM billing_invoice_payments WHERE stripe_invoice_id = ${stripeInvoiceId}`);
    const r = rowsOf<{ amount_paid_minor: string; disputed_minor: string }>(result)[0];
    if (r === undefined) return 0;
    // One dispute at a time per charge: the whole disputed amount is this one's.
    void clawback;
    return minor(r.disputed_minor);
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

function windowIdOf(targetKey: string): string | null {
  return targetKey.startsWith('window:') ? targetKey.slice('window:'.length) : null;
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
