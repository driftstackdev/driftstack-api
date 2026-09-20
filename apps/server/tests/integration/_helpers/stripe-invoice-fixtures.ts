// Stripe invoice payloads for tests, in BOTH shapes the server reads.
//
// The shape a webhook delivers is set on the Stripe endpoint, not in this
// repository, and the two differ exactly where a paid invoice is read:
//
//                          'older'                     'newer'
//   subscription link      invoice.subscription        invoice.parent.subscription_details.subscription
//   a line's price         line.price.id               line.pricing.price_details.price
//   a line is a proration  line.proration              line.parent.<kind>_details.proration
//   a line's subscription  line.subscription           line.parent.<kind>_details.subscription
//   a line's kind          line.type                   line.parent.type
//   payment reference      invoice.payment_intent      invoice.payments.data[].payment.payment_intent
//
// One spec builds either, so a test that says "both shapes are read" feeds the
// SAME facts through each and compares what came out.
//
// ⛔ EVERY INVOICE HERE CARRIES A TOP-LEVEL PERIOD THAT IS DELIBERATELY NOT ITS
// LINE'S (it is the period BEFORE, as on a real renewal). A reader that took the
// invoice's own period would therefore produce a visibly wrong row in every test
// that uses these fixtures, not only in the one written to catch it.

export type InvoiceShape = 'older' | 'newer';
export const INVOICE_SHAPES: readonly InvoiceShape[] = ['older', 'newer'];

export interface InvoiceLineSpec {
  priceId: string;
  amount: number;
  periodStartSec: number;
  periodEndSec: number;
  /** Default false. */
  proration?: boolean;
  /**
   * 'subscription' is the subscription's own line; 'invoiceitem' is a one-off
   * item or a proration. Defaults to 'invoiceitem' for a proration, else
   * 'subscription'.
   */
  kind?: 'subscription' | 'invoiceitem';
  /** Defaults to the invoice's subscription. `null` writes no reference at all. */
  subscriptionId?: string | null;
}

export interface InvoiceSpec {
  invoiceId: string;
  customerId: string;
  /** `null` builds an invoice that names no subscription (one raised by hand). */
  subscriptionId: string | null;
  billingReason?: string;
  amountPaid: number;
  currency?: string;
  lines: InvoiceLineSpec[];
  paidAtSec?: number;
  createdSec?: number;
  paymentIntentId?: string;
  chargeId?: string;
  hostedInvoiceUrl?: string;
  /** Override the decoy top-level period (default: the month before the first line). */
  topLevelPeriod?: { startSec: number; endSec: number };
  /**
   * The invoice's own `status`. Defaults to 'paid'. `null` writes no status at
   * all; any other value ('open', 'void', …) builds an invoice that was NOT paid.
   */
  status?: string | null;
}

const DAY = 24 * 60 * 60;

export function sec(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function buildLine(
  shape: InvoiceShape,
  line: InvoiceLineSpec,
  index: number,
  invoiceSubscriptionId: string | null,
): Record<string, unknown> {
  const proration = line.proration === true;
  const kind = line.kind ?? (proration ? 'invoiceitem' : 'subscription');
  const subscriptionId =
    line.subscriptionId === undefined ? invoiceSubscriptionId : line.subscriptionId;
  const common = {
    id: `il_${String(index)}`,
    object: 'line_item',
    amount: line.amount,
    currency: 'usd',
    period: { start: line.periodStartSec, end: line.periodEndSec },
  };
  if (shape === 'older') {
    return {
      ...common,
      type: kind,
      proration,
      ...(subscriptionId !== null ? { subscription: subscriptionId } : {}),
      price: { id: line.priceId, object: 'price' },
    };
  }
  const detailsKey = kind === 'subscription' ? 'subscription_item_details' : 'invoice_item_details';
  return {
    ...common,
    parent: {
      type: detailsKey,
      [detailsKey]: {
        proration,
        ...(subscriptionId !== null ? { subscription: subscriptionId } : {}),
      },
    },
    pricing: { type: 'price_details', price_details: { price: line.priceId, product: 'prod_x' } },
  };
}

/** One invoice object, as `event.data.object` or as a GET /v1/invoices/:id body. */
export function buildInvoice(shape: InvoiceShape, spec: InvoiceSpec): Record<string, unknown> {
  const first = spec.lines[0];
  const decoyEnd = first?.periodStartSec ?? sec('2026-01-01T00:00:00Z');
  const topLevel = spec.topLevelPeriod ?? { startSec: decoyEnd - 30 * DAY, endSec: decoyEnd };
  const paidAtSec = spec.paidAtSec ?? decoyEnd + 3600;
  const common = {
    id: spec.invoiceId,
    object: 'invoice',
    customer: spec.customerId,
    billing_reason: spec.billingReason ?? 'subscription_cycle',
    amount_paid: spec.amountPaid,
    currency: spec.currency ?? 'usd',
    ...(spec.status === null ? {} : { status: spec.status ?? 'paid' }),
    created: spec.createdSec ?? paidAtSec - 3600,
    status_transitions: { paid_at: paidAtSec },
    // The decoy: NOT the line's period.
    period_start: topLevel.startSec,
    period_end: topLevel.endSec,
    ...(spec.hostedInvoiceUrl !== undefined ? { hosted_invoice_url: spec.hostedInvoiceUrl } : {}),
    lines: {
      object: 'list',
      has_more: false,
      data: spec.lines.map((l, i) => buildLine(shape, l, i, spec.subscriptionId)),
    },
  };
  if (shape === 'older') {
    return {
      ...common,
      ...(spec.subscriptionId !== null ? { subscription: spec.subscriptionId } : {}),
      ...(spec.paymentIntentId !== undefined ? { payment_intent: spec.paymentIntentId } : {}),
      ...(spec.chargeId !== undefined ? { charge: spec.chargeId } : {}),
    };
  }
  return {
    ...common,
    ...(spec.subscriptionId !== null
      ? {
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: spec.subscriptionId },
          },
        }
      : {}),
    ...(spec.paymentIntentId !== undefined || spec.chargeId !== undefined
      ? {
          payments: {
            object: 'list',
            data: [
              {
                payment: {
                  type: 'payment_intent',
                  ...(spec.paymentIntentId !== undefined
                    ? { payment_intent: spec.paymentIntentId }
                    : {}),
                  ...(spec.chargeId !== undefined ? { charge: spec.chargeId } : {}),
                },
              },
            ],
          },
        }
      : {}),
  };
}

export type PaidInvoiceEventType = 'invoice.payment_succeeded' | 'invoice.paid';

/** A Stripe event carrying `invoice`, as the parsed object the service receives. */
export function buildInvoiceEvent(args: {
  eventId: string;
  type: PaidInvoiceEventType;
  invoice: Record<string, unknown>;
  createdSec?: number;
}): {
  id: string;
  type: string;
  api_version: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
} {
  return {
    id: args.eventId,
    type: args.type,
    api_version: '2024-12-18.acacia',
    created: args.createdSec ?? Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object: args.invoice },
  };
}
