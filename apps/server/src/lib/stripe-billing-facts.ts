// What a Stripe payload says about a billing period, read without trusting its
// shape. Pure: no I/O, no clock, no logger.
//
// Two readers and one map builder:
//
//   buildStripePriceMaps          the configured price ids, inverted: price → plan
//                                 and price → billing interval.
//   readSubscriptionPeriodStart   when a subscription's current period began.
//   readPaidInvoice               which subscription LINE a paid invoice paid for,
//                                 and for which period.
//
// ⛔ THE PERIOD OF A PAID INVOICE IS ITS LINE'S, NEVER THE INVOICE'S OWN. An
// invoice also carries a top-level `period_start` / `period_end`, and on a
// renewal those describe the period that just ENDED, not the one being paid
// for. `readPaidInvoice` does not read them at all, and a test holds that.
//
// TWO PAYLOAD SHAPES ARE READ, because the shape a webhook delivers is set on
// the Stripe endpoint, not in this repository, and the two differ exactly where
// this file looks:
//
//                          older                       newer
//   subscription link      invoice.subscription        invoice.parent.subscription_details.subscription
//   a line's price         line.price.id               line.pricing.price_details.price
//   a line is a proration  line.proration              line.parent.<kind>_details.proration
//   a line's subscription  line.subscription           line.parent.<kind>_details.subscription
//   a line's kind          line.type                   line.parent.type
//   period start           subscription                subscription.items.data[0]
//                          .current_period_start       .current_period_start
//
// A value that is absent, or of the wrong type, reads as "not there". Nothing
// here throws on a malformed payload: the caller decides what a missing fact
// means, and for an invoice that is "record the payment, tie it to no period".

import type { AccountTier } from '@driftstack/api-types';

/** How often a price bills. The value set of `subscriptions.billing_interval`
 *  and `billing_invoice_payments.line_interval`. */
export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/** Where a stored period start came from: read from Stripe, or computed from the
 *  period's end and the interval. The value set of
 *  `subscriptions.period_start_source`. */
export const PERIOD_START_SOURCES = ['stripe', 'derived'] as const;
export type PeriodStartSource = (typeof PERIOD_START_SOURCES)[number];

/**
 * Which line of a paid invoice was read. The value set of
 * `billing_invoice_payments.line_kind`.
 *   'period'        the subscription's ordinary (non-proration) line
 *   'proration_up'  the positive proration line of a paid plan-change invoice
 */
export const BILLING_INVOICE_LINE_KINDS = ['period', 'proration_up'] as const;
export type BillingInvoiceLineKind = (typeof BILLING_INVOICE_LINE_KINDS)[number];

/** The `billing_reason` of an invoice raised by a plan change. */
const PLAN_CHANGE_BILLING_REASON = 'subscription_update';

export interface StripePriceMaps {
  priceToTier: Record<string, AccountTier>;
  priceToInterval: Record<string, BillingInterval>;
}

/**
 * Invert the configured tier prices. Each tier names a monthly and an annual
 * price id; both map back to the tier, and each maps to its own interval.
 *
 * The legacy flat configuration names ONE id per tier and config.ts reads it as
 * "monthly only", repeating it in the annual slot. Such an id is a monthly
 * price, so 'month' is written last and wins.
 */
export function buildStripePriceMaps(
  tierPrices: Record<string, { monthly: string; annual: string }> | undefined,
): StripePriceMaps {
  const priceToTier: Record<string, AccountTier> = {};
  const priceToInterval: Record<string, BillingInterval> = {};
  if (tierPrices === undefined) return { priceToTier, priceToInterval };
  for (const [tier, prices] of Object.entries(tierPrices) as Array<
    [AccountTier, { monthly: string; annual: string }]
  >) {
    priceToTier[prices.monthly] = tier;
    priceToTier[prices.annual] = tier;
    priceToInterval[prices.annual] = 'year';
    priceToInterval[prices.monthly] = 'month';
  }
  return { priceToTier, priceToInterval };
}

/** A map lookup that an id such as `constructor` cannot satisfy from the prototype. */
function lookup<T>(map: Record<string, T>, key: string | null): T | null {
  if (key === null || !Object.hasOwn(map, key)) return null;
  return map[key] ?? null;
}

// ─── field readers ───────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function asObject(v: unknown): Obj | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** A Stripe reference: the id itself, or the expanded object carrying it. */
function asId(v: unknown): string | null {
  return asString(v) ?? asString(asObject(v)?.id);
}

/**
 * Unix seconds → Date. Anything that is not a positive finite number is absent —
 * and so is one no Date can hold: `new Date(1e18)` is an Invalid Date, which is
 * not null, compares false with everything, and throws RangeError when the
 * database write serialises it. That would be a PERMANENT failure of the event.
 */
function asUnixDate(v: unknown): Date | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  const date = new Date(v * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function at(obj: Obj | null, ...path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    const o = asObject(current);
    if (o === null) return undefined;
    current = o[key];
  }
  return current;
}

// ─── subscription ────────────────────────────────────────────────────

/**
 * When the subscription's current period began: the subscription's own
 * `current_period_start`, else its first item's. The first item is the one the
 * mirror already reads the price id from.
 */
export function readSubscriptionPeriodStart(subscription: Obj): Date | null {
  const own = asUnixDate(subscription.current_period_start);
  if (own !== null) return own;
  const items = at(subscription, 'items', 'data');
  if (!Array.isArray(items) || items.length === 0) return null;
  return asUnixDate(asObject(items[0])?.current_period_start);
}

// ─── paid invoice ────────────────────────────────────────────────────

export interface PaidInvoiceLine {
  kind: BillingInvoiceLineKind;
  stripePriceId: string | null;
  /** Null for a price the configuration does not name (a custom contract). */
  tier: AccountTier | null;
  interval: BillingInterval | null;
  periodStart: Date;
  periodEnd: Date;
}

/** Why a paid invoice could not be tied to a subscription line. */
export type InvoiceUnlinkedReason = 'no_subscription' | 'no_subscription_line';

export interface PaidInvoiceFacts {
  stripeInvoiceId: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  billingReason: string | null;
  /**
   * What the invoice says about itself: 'paid', or 'draft' | 'open' | 'void' |
   * 'uncollectible'; null when it says nothing. This reader does not judge it —
   * it reads an unpaid invoice as readily as a paid one. WHOEVER WRITES THE
   * PAID-INVOICE RECORD MUST: see `invoiceSaysItIsNotPaid` and the backfill.
   */
  status: string | null;
  /** Minor units. Null unless a non-negative whole number. */
  amountPaidMinor: number | null;
  currency: string | null;
  stripePaymentIntentId: string | null;
  stripeChargeId: string | null;
  /** `status_transitions.paid_at`; null when the payload does not say. */
  paidAt: Date | null;
  /** The invoice's own `created`: when it was raised, NOT a billing period. */
  createdAt: Date | null;
  line: PaidInvoiceLine | null;
  /** Set exactly when `line` is null. */
  unlinkedReason: InvoiceUnlinkedReason | null;
}

interface LineFacts {
  amount: number | null;
  proration: boolean;
  subscriptionId: string | null;
  priceId: string | null;
  /** True for a one-off invoice item, which is never the subscription's own line. */
  invoiceItem: boolean;
  periodStart: Date | null;
  periodEnd: Date | null;
}

function readLine(line: Obj): LineFacts {
  const parent = asObject(line.parent);
  const parentType = asString(parent?.type);
  const details =
    asObject(parent?.subscription_item_details) ?? asObject(parent?.invoice_item_details);
  const amount =
    typeof line.amount === 'number' && Number.isFinite(line.amount) ? line.amount : null;
  // A proration line raised by a plan change is an invoice item in BOTH shapes,
  // so "invoice item" only disqualifies a line that is not a proration.
  const invoiceItem = line.type === 'invoiceitem' || parentType === 'invoice_item_details';
  return {
    amount,
    proration: line.proration === true || details?.proration === true,
    subscriptionId: asId(line.subscription) ?? asId(details?.subscription),
    priceId: asId(line.price) ?? asId(at(line, 'pricing', 'price_details', 'price')),
    invoiceItem,
    periodStart: asUnixDate(at(line, 'period', 'start')),
    periodEnd: asUnixDate(at(line, 'period', 'end')),
  };
}

interface UsableLine extends LineFacts {
  periodStart: Date;
  periodEnd: Date;
}

/** The line names this invoice's subscription (or none), and its period runs forward. */
function usable(line: LineFacts, subscriptionId: string): line is UsableLine {
  if (line.subscriptionId !== null && line.subscriptionId !== subscriptionId) return false;
  if (line.periodStart === null || line.periodEnd === null) return false;
  return line.periodEnd.getTime() > line.periodStart.getTime();
}

function toLine(
  kind: BillingInvoiceLineKind,
  line: UsableLine,
  maps: StripePriceMaps,
): PaidInvoiceLine {
  return {
    kind,
    stripePriceId: line.priceId,
    tier: lookup(maps.priceToTier, line.priceId),
    interval: lookup(maps.priceToInterval, line.priceId),
    periodStart: line.periodStart,
    periodEnd: line.periodEnd,
  };
}

function isMapped(line: LineFacts, maps: StripePriceMaps): boolean {
  return lookup(maps.priceToTier, line.priceId) !== null;
}

/**
 * The line a paid invoice paid for.
 *
 *   1. The subscription's ordinary line: not a proration, not a one-off invoice
 *      item. A line whose price the configuration names is preferred.
 *   2. Otherwise, on a plan-change invoice only, the positive proration line:
 *      the customer paid for the rest of the period on the new plan. With more
 *      than one, the most recent change wins, then the larger amount.
 *
 * Proration lines on any OTHER invoice are ignored. When a plan change is not
 * invoiced at once, its proration rides on the next renewal, whose ordinary
 * line is rule 1; the change itself was never separately paid for.
 */
function pickLine(
  lines: LineFacts[],
  subscriptionId: string,
  billingReason: string | null,
  maps: StripePriceMaps,
): PaidInvoiceLine | null {
  const candidates = lines.filter((l): l is UsableLine => usable(l, subscriptionId));

  const ordinary = candidates.filter((l) => !l.proration && !l.invoiceItem);
  const period = ordinary.find((l) => isMapped(l, maps)) ?? ordinary[0];
  if (period !== undefined) return toLine('period', period, maps);

  if (billingReason !== PLAN_CHANGE_BILLING_REASON) return null;
  const prorations = candidates
    .filter((l) => l.proration && l.amount !== null && l.amount > 0)
    .sort((a, b) => {
      const mapped = Number(isMapped(b, maps)) - Number(isMapped(a, maps));
      if (mapped !== 0) return mapped;
      const recent = b.periodStart.getTime() - a.periodStart.getTime();
      if (recent !== 0) return recent;
      return (b.amount ?? 0) - (a.amount ?? 0);
    });
  const up = prorations[0];
  return up === undefined ? null : toLine('proration_up', up, maps);
}

/** `invoice.payment_intent` / `invoice.charge`, else the first of `invoice.payments`. */
function readPaymentRef(invoice: Obj, field: 'payment_intent' | 'charge'): string | null {
  const direct = asId(invoice[field]);
  if (direct !== null) return direct;
  const payments = at(invoice, 'payments', 'data');
  if (!Array.isArray(payments)) return null;
  for (const p of payments) {
    const ref = asId(at(asObject(p), 'payment', field));
    if (ref !== null) return ref;
  }
  return null;
}

/** The one status that is evidence of payment. */
export const PAID_INVOICE_STATUS = 'paid';

/**
 * True when the invoice itself says it is NOT paid — a status is present and it
 * is not 'paid'. False for a paid invoice AND for one that carries no status.
 *
 * That asymmetry is for a caller holding OTHER evidence of payment (a webhook
 * told so by its event's type): silence is then no contradiction. A caller with
 * no other evidence (the backfill, which reads whatever invoice it is handed)
 * must require `status === PAID_INVOICE_STATUS` instead, where silence refuses.
 */
export function invoiceSaysItIsNotPaid(facts: Pick<PaidInvoiceFacts, 'status'>): boolean {
  return facts.status !== null && facts.status !== PAID_INVOICE_STATUS;
}

/**
 * Everything the paid-invoice record needs, from one invoice object in either
 * shape. Never reads the invoice's top-level `period_start` / `period_end`.
 */
export function readPaidInvoice(invoice: Obj, maps: StripePriceMaps): PaidInvoiceFacts {
  const amountPaid = invoice.amount_paid;
  const stripeSubscriptionId =
    asId(invoice.subscription) ??
    asId(at(invoice, 'parent', 'subscription_details', 'subscription'));
  const billingReason = asString(invoice.billing_reason);

  const rawLines = at(invoice, 'lines', 'data');
  const lines = Array.isArray(rawLines)
    ? rawLines.map(asObject).filter((l): l is Obj => l !== null)
    : [];

  const line =
    stripeSubscriptionId === null
      ? null
      : pickLine(lines.map(readLine), stripeSubscriptionId, billingReason, maps);

  return {
    stripeInvoiceId: asString(invoice.id),
    stripeCustomerId: asId(invoice.customer),
    stripeSubscriptionId,
    billingReason,
    status: asString(invoice.status),
    amountPaidMinor:
      typeof amountPaid === 'number' && Number.isSafeInteger(amountPaid) && amountPaid >= 0
        ? amountPaid
        : null,
    currency: asString(invoice.currency),
    stripePaymentIntentId: readPaymentRef(invoice, 'payment_intent'),
    stripeChargeId: readPaymentRef(invoice, 'charge'),
    paidAt: asUnixDate(at(invoice, 'status_transitions', 'paid_at')),
    createdAt: asUnixDate(invoice.created),
    line,
    unlinkedReason:
      line !== null
        ? null
        : stripeSubscriptionId === null
          ? 'no_subscription'
          : 'no_subscription_line',
  };
}
