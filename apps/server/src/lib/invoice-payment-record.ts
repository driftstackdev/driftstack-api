// One paid invoice as it is recorded, and the ONE rule for what a later
// sighting of the same invoice may change. Pure.
//
// An invoice is seen more than once by design: Stripe sends two events for a
// paid invoice, retries either for days, and the backfill reads the same
// invoices again. The record is keyed on the invoice id, so none of those writes
// a second row. What a later sighting may do is COMPLETE the record:
//
//   · tie it to its subscription line, when the stored row named none (the first
//     sighting arrived in a shape this server could not read, or Stripe could
//     not be asked);
//   · name the plan and interval of a line whose price the configuration did not
//     name when it was first seen, and does now;
//   · add a subscription, billing reason, payment intent or charge that was
//     absent;
//   · raise the amount paid (it only ever grows on an invoice; a lower figure is
//     an older sighting arriving late).
//
// ⛔ A KNOWN FACT IS NEVER REWRITTEN. Not the account, the period, the line, the
// plan, the currency or when it was paid. `refunded` and `disputed` are not in
// this record at all: a sighting of a paid invoice says nothing about them.
//
// The rule lives here, once, because two stores apply it — Postgres and the
// in-memory double the integration tests run on — and two copies of a merge rule
// are two rules the day one of them is edited.

import type { PaidInvoiceLine } from './stripe-billing-facts.js';

export interface InvoicePaymentRecord {
  stripeInvoiceId: string;
  accountId: string;
  stripeSubscriptionId: string | null;
  billingReason: string | null;
  /** Minor units; a non-negative whole number. */
  amountPaidMinor: number;
  currency: string;
  stripePaymentIntentId: string | null;
  stripeChargeId: string | null;
  /** Null when the invoice could not be tied to a subscription line. */
  line: PaidInvoiceLine | null;
  paidAt: Date;
}

/** What one write did. See StripeWebhooksRepo.upsertInvoicePayment. */
export type InvoicePaymentOutcome = 'inserted' | 'completed' | 'unchanged' | 'account_mismatch';

function completeLine(
  stored: PaidInvoiceLine | null,
  seen: PaidInvoiceLine | null,
): PaidInvoiceLine | null {
  if (stored === null) return seen;
  if (seen === null) return stored;
  // The same line, seen again: same kind, same price. Only then may the plan or
  // the interval it lacked be filled in; the period is never touched.
  const seenAgain =
    stored.kind === seen.kind &&
    stored.stripePriceId !== null &&
    stored.stripePriceId === seen.stripePriceId;
  if (!seenAgain) return stored;
  return {
    ...stored,
    tier: stored.tier ?? seen.tier,
    interval: stored.interval ?? seen.interval,
  };
}

function linesEqual(a: PaidInvoiceLine | null, b: PaidInvoiceLine | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.kind === b.kind &&
    a.stripePriceId === b.stripePriceId &&
    a.tier === b.tier &&
    a.interval === b.interval &&
    a.periodStart.getTime() === b.periodStart.getTime() &&
    a.periodEnd.getTime() === b.periodEnd.getTime()
  );
}

/**
 * The stored record completed by a later sighting, or null when the sighting
 * adds nothing (so the caller writes nothing). Both records must be for the
 * same invoice AND the same account; the caller checks the account first,
 * because a mismatch there is refused, not merged.
 */
export function completeInvoicePayment(
  stored: InvoicePaymentRecord,
  seen: InvoicePaymentRecord,
): InvoicePaymentRecord | null {
  const completed: InvoicePaymentRecord = {
    ...stored,
    stripeSubscriptionId: stored.stripeSubscriptionId ?? seen.stripeSubscriptionId,
    billingReason: stored.billingReason ?? seen.billingReason,
    amountPaidMinor: Math.max(stored.amountPaidMinor, seen.amountPaidMinor),
    stripePaymentIntentId: stored.stripePaymentIntentId ?? seen.stripePaymentIntentId,
    stripeChargeId: stored.stripeChargeId ?? seen.stripeChargeId,
    line: completeLine(stored.line, seen.line),
  };
  const unchanged =
    completed.stripeSubscriptionId === stored.stripeSubscriptionId &&
    completed.billingReason === stored.billingReason &&
    completed.amountPaidMinor === stored.amountPaidMinor &&
    completed.stripePaymentIntentId === stored.stripePaymentIntentId &&
    completed.stripeChargeId === stored.stripeChargeId &&
    linesEqual(completed.line, stored.line);
  return unchanged ? null : completed;
}
