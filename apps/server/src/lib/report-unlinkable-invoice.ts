// A paid invoice was recorded, but could not be tied to a subscription period.
// Tell someone.
//
// The payment row is still written, with no period, and it covers nothing. That
// is the safe direction — nothing is granted on a period nobody could read — but
// it is a customer who PAID and whose payment stands for nothing until a person
// repairs it, so it must reach a person and not only a log line.
//
// It is never the customer's doing. Either the payload arrived in a shape this
// server does not read, or the invoice belongs to no subscription (one raised by
// hand), or the amount on it is not a whole non-negative number, or a
// paid-invoice event carried an invoice that says itself it is NOT paid (then no
// row is written at all: a payment nobody can confirm is not recorded as one).
//
// ⛔ NO CUSTOMER DATA, AND NO IDENTIFIERS. The event carries a reason and a
// source, both closed vocabularies, and nothing else. `captureMessage` strips
// the ambient request, user, breadcrumb trail and transaction name
// (lib/sentry.ts), so no URL, account or invoice rides along. The invoice id is
// in the server log line written beside this call, which is where the person
// answering the alert looks it up.
//
// ONE ISSUE PER REASON. The fingerprint is the reason, so every repeat of one
// fault lands in one place however many invoices it touches.

import type { SentryClient } from './sentry.js';

/** Why the invoice stands for no period. A closed set, so it is safe as a tag. */
export type UnlinkableInvoiceReason =
  | 'no_subscription'
  | 'no_subscription_line'
  | 'invalid_amount'
  | 'account_mismatch'
  | 'not_paid';

/** Where it was seen. A closed set, so it is safe as a tag. */
export type UnlinkableInvoiceSource = 'webhook' | 'backfill';

export interface UnlinkableInvoiceReport {
  reason: UnlinkableInvoiceReason;
  source: UnlinkableInvoiceSource;
  /** How many invoices this report stands for. The backfill reports once per run. */
  count?: number;
}

const WHAT_HAPPENED: Record<UnlinkableInvoiceReason, string> = {
  no_subscription: 'names no subscription',
  no_subscription_line: 'has no subscription line with a readable period',
  invalid_amount: 'carries an amount paid that is not a whole non-negative number',
  account_mismatch: 'is already recorded against a different account',
  not_paid: 'arrived in a paid-invoice event but says itself that it is not paid',
};

/**
 * Send the alert. Returns true when an event was handed to the client, false
 * when there is no client. Never throws: the payment is already recorded, and
 * the webhook must be answered whether or not the alert could be sent.
 */
export function reportUnlinkableInvoice(
  sentry: Pick<SentryClient, 'captureMessage'> | undefined,
  report: UnlinkableInvoiceReport,
): boolean {
  if (sentry === undefined) return false;
  const count = report.count ?? 1;
  try {
    sentry.captureMessage({
      message:
        `A paid invoice ${WHAT_HAPPENED[report.reason]}, so it is tied to no billing period. ` +
        'Find the invoice id in the server log and repair the record.',
      level: 'error',
      fingerprint: ['billing', 'paid_invoice_unlinkable', report.reason],
      tags: { kind: 'paid_invoice_unlinkable', reason: report.reason, source: report.source },
      extra: { reason: report.reason, source: report.source, count },
    });
  } catch {
    // Fire-and-forget, like every Sentry call: the record stands regardless.
  }
  return true;
}
