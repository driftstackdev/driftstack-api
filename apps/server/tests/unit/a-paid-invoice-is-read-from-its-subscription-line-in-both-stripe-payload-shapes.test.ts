// A paid invoice is read from its subscription LINE — in both payload shapes
// Stripe delivers — and never from the invoice's own top-level period.
//
// `readPaidInvoice` decides which billing period a payment stands for. A wrong
// answer is silent: the row is written, it looks complete, and it names the
// wrong month. On a renewal the invoice's top-level `period_start`/`period_end`
// describe the period that just ENDED, so a reader that took them would record
// every renewal one period late.
//
// Every fixture invoice therefore carries a top-level period that is NOT its
// line's (see stripe-invoice-fixtures.ts), and the arms below state the period
// they expect in full.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildStripePriceMaps,
  readPaidInvoice,
  readSubscriptionPeriodStart,
  type PaidInvoiceFacts,
} from '../../src/lib/stripe-billing-facts.js';
import {
  INVOICE_SHAPES,
  buildInvoice,
  sec,
  type InvoiceSpec,
} from '../integration/_helpers/stripe-invoice-fixtures.js';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const READER = resolve(HERE, '..', '..', 'src', 'lib', 'stripe-billing-facts.ts');

const MAPS = buildStripePriceMaps({
  api_starter: { monthly: 'price_starter_m', annual: 'price_starter_y' },
  api_scale: { monthly: 'price_scale_m', annual: 'price_scale_y' },
});

const MAR_1 = sec('2026-03-01T00:00:00Z');
const MAR_17 = sec('2026-03-17T09:30:00Z');
const APR_1 = sec('2026-04-01T00:00:00Z');
const MAR_1_2027 = sec('2027-03-01T00:00:00Z');

function renewal(overrides: Partial<InvoiceSpec> = {}): InvoiceSpec {
  return {
    invoiceId: 'in_renewal',
    customerId: 'cus_1',
    subscriptionId: 'sub_1',
    billingReason: 'subscription_cycle',
    amountPaid: 14900,
    paymentIntentId: 'pi_1',
    chargeId: 'ch_1',
    paidAtSec: MAR_1 + 3700,
    lines: [
      { priceId: 'price_starter_m', amount: 14900, periodStartSec: MAR_1, periodEndSec: APR_1 },
    ],
    ...overrides,
  };
}

/** Everything the record is built from, with Dates as ISO strings so a diff reads. */
function summary(facts: PaidInvoiceFacts): Record<string, unknown> {
  return {
    ...facts,
    paidAt: facts.paidAt?.toISOString() ?? null,
    createdAt: facts.createdAt?.toISOString() ?? null,
    line:
      facts.line === null
        ? null
        : {
            ...facts.line,
            periodStart: facts.line.periodStart.toISOString(),
            periodEnd: facts.line.periodEnd.toISOString(),
          },
  };
}

describe('a paid invoice is read from its subscription line, in both Stripe payload shapes', () => {
  it('CRITICAL a paid renewal records its subscription line’s period and plan — the period being PAID FOR, not the one the invoice’s top-level fields describe', () => {
    for (const shape of INVOICE_SHAPES) {
      const invoice = buildInvoice(shape, renewal());
      // The decoy is really there, and really different: February, not March.
      expect(invoice.period_end, `${shape}: fixture lost its decoy period`).toBe(MAR_1);
      expect(summary(readPaidInvoice(invoice, MAPS)), shape).toEqual({
        stripeInvoiceId: 'in_renewal',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        billingReason: 'subscription_cycle',
        status: 'paid',
        amountPaidMinor: 14900,
        currency: 'usd',
        stripePaymentIntentId: 'pi_1',
        stripeChargeId: 'ch_1',
        paidAt: new Date((MAR_1 + 3700) * 1000).toISOString(),
        createdAt: new Date((MAR_1 + 100) * 1000).toISOString(),
        line: {
          kind: 'period',
          stripePriceId: 'price_starter_m',
          tier: 'api_starter',
          interval: 'month',
          periodStart: '2026-03-01T00:00:00.000Z',
          periodEnd: '2026-04-01T00:00:00.000Z',
        },
        unlinkedReason: null,
      });
    }
  });

  it('CRITICAL both API shapes are read, and read to the SAME facts. A reader that knew one shape would record every invoice of the other as tied to no period.', () => {
    const specs: InvoiceSpec[] = [
      renewal(),
      renewal({
        invoiceId: 'in_annual',
        lines: [
          {
            priceId: 'price_scale_y',
            amount: 1_439_000,
            periodStartSec: MAR_1,
            periodEndSec: MAR_1_2027,
          },
        ],
      }),
      renewal({
        invoiceId: 'in_upgrade',
        billingReason: 'subscription_update',
        lines: [
          {
            priceId: 'price_starter_m',
            amount: -7000,
            proration: true,
            periodStartSec: MAR_17,
            periodEndSec: APR_1,
          },
          {
            priceId: 'price_scale_m',
            amount: 70000,
            proration: true,
            periodStartSec: MAR_17,
            periodEndSec: APR_1,
          },
        ],
      }),
    ];
    for (const spec of specs) {
      const [older, newer] = INVOICE_SHAPES.map((shape) =>
        summary(readPaidInvoice(buildInvoice(shape, spec), MAPS)),
      );
      expect(older?.line, `${spec.invoiceId}: the older shape was not read`).not.toBeNull();
      expect(newer, spec.invoiceId).toEqual(older);
    }
  });

  it('CRITICAL the invoice’s top-level period is NEVER used: whatever it says, the recorded period does not move', () => {
    for (const shape of INVOICE_SHAPES) {
      const baseline = summary(readPaidInvoice(buildInvoice(shape, renewal()), MAPS));
      const topLevels = [
        { startSec: MAR_1, endSec: APR_1 }, // equal to the line
        { startSec: sec('2020-01-01T00:00:00Z'), endSec: sec('2020-02-01T00:00:00Z') },
        { startSec: APR_1, endSec: MAR_1 }, // backwards
        { startSec: MAR_1, endSec: MAR_1 }, // empty, as Stripe writes on a first invoice
      ];
      for (const topLevelPeriod of topLevels) {
        const read = summary(
          readPaidInvoice(buildInvoice(shape, renewal({ topLevelPeriod })), MAPS),
        );
        expect(read, `${shape} with top-level ${JSON.stringify(topLevelPeriod)}`).toEqual(baseline);
      }
      // And with the line gone, the top-level period is not a fallback either.
      const lineless = readPaidInvoice(buildInvoice(shape, renewal({ lines: [] })), MAPS);
      expect(lineless.line, `${shape}: a period appeared from nowhere`).toBeNull();
      expect(lineless.unlinkedReason).toBe('no_subscription_line');
    }
  });

  it('CRITICAL the reader’s CODE never names the invoice’s top-level period fields. The behavioural arm above proves today’s reader ignores them; this one fails the day somebody adds a "helpful" fallback to them.', () => {
    const code = codeOnly(readFileSync(READER, 'utf8'));
    // The invoice's own fields are `period_start` / `period_end`. The
    // SUBSCRIPTION's `current_period_start`, which this file legitimately reads,
    // contains the same letters, so the pattern excludes that prefix.
    const TOP_LEVEL_PERIOD = /(?<!current_)period_(?:start|end)/;
    // The scan reached real code: the fields it DOES read are there.
    expect(code).toContain("'status_transitions'");
    expect(code).toContain("'period'");
    expect(code).toContain('current_period_start');
    expect(code).not.toMatch(TOP_LEVEL_PERIOD);
    // The pattern discriminates, in both directions.
    expect('asUnixDate(invoice.period_start)').toMatch(TOP_LEVEL_PERIOD);
    expect("at(invoice, 'period_end')").toMatch(TOP_LEVEL_PERIOD);
    expect('asUnixDate(subscription.current_period_start)').not.toMatch(TOP_LEVEL_PERIOD);
  });

  it('a paid plan-change invoice records its POSITIVE proration line: the rest of the period, on the new plan', () => {
    for (const shape of INVOICE_SHAPES) {
      const facts = readPaidInvoice(
        buildInvoice(
          shape,
          renewal({
            billingReason: 'subscription_update',
            amountPaid: 63000,
            lines: [
              {
                priceId: 'price_starter_m',
                amount: -7000,
                proration: true,
                periodStartSec: MAR_17,
                periodEndSec: APR_1,
              },
              {
                priceId: 'price_scale_m',
                amount: 70000,
                proration: true,
                periodStartSec: MAR_17,
                periodEndSec: APR_1,
              },
            ],
          }),
        ),
        MAPS,
      );
      expect(summary(facts).line, shape).toEqual({
        kind: 'proration_up',
        stripePriceId: 'price_scale_m',
        tier: 'api_scale',
        interval: 'month',
        periodStart: '2026-03-17T09:30:00.000Z',
        periodEnd: '2026-04-01T00:00:00.000Z',
      });
    }
  });

  it('CRITICAL a proration line counts ONLY on a plan-change invoice. When a plan change is not invoiced at once its proration rides on the next renewal, where the ordinary line is the period and the change was never separately paid for.', () => {
    for (const shape of INVOICE_SHAPES) {
      const prorationOnly = [
        {
          priceId: 'price_scale_m',
          amount: 70000,
          proration: true,
          periodStartSec: MAR_17,
          periodEndSec: APR_1,
        },
      ];
      // On a renewal, beside the ordinary line: the ordinary line wins.
      const rode = readPaidInvoice(
        buildInvoice(
          shape,
          renewal({
            lines: [
              ...prorationOnly,
              {
                priceId: 'price_scale_m',
                amount: 149900,
                periodStartSec: APR_1,
                periodEndSec: sec('2026-05-01T00:00:00Z'),
              },
            ],
          }),
        ),
        MAPS,
      );
      expect(rode.line?.kind, shape).toBe('period');
      expect(rode.line?.periodStart.toISOString(), shape).toBe('2026-04-01T00:00:00.000Z');
      // Alone on anything but a plan-change invoice: not a period at all.
      for (const billingReason of ['subscription_cycle', 'subscription_create', 'manual']) {
        const alone = readPaidInvoice(
          buildInvoice(shape, renewal({ billingReason, lines: prorationOnly })),
          MAPS,
        );
        expect(alone.line, `${shape}/${billingReason}`).toBeNull();
      }
      // Control: the SAME line on a plan-change invoice is read.
      const onChange = readPaidInvoice(
        buildInvoice(
          shape,
          renewal({ billingReason: 'subscription_update', lines: prorationOnly }),
        ),
        MAPS,
      );
      expect(onChange.line?.kind, shape).toBe('proration_up');
    }
  });

  it('a credit (negative) proration is never the line, and the most recent change wins among several', () => {
    for (const shape of INVOICE_SHAPES) {
      const credit = readPaidInvoice(
        buildInvoice(
          shape,
          renewal({
            billingReason: 'subscription_update',
            amountPaid: 0,
            lines: [
              {
                priceId: 'price_scale_m',
                amount: -70000,
                proration: true,
                periodStartSec: MAR_17,
                periodEndSec: APR_1,
              },
            ],
          }),
        ),
        MAPS,
      );
      expect(credit.line, shape).toBeNull();

      const later = sec('2026-03-20T00:00:00Z');
      const two = readPaidInvoice(
        buildInvoice(
          shape,
          renewal({
            billingReason: 'subscription_update',
            lines: [
              {
                priceId: 'price_starter_y',
                amount: 99000,
                proration: true,
                periodStartSec: MAR_17,
                periodEndSec: APR_1,
              },
              {
                priceId: 'price_scale_m',
                amount: 50000,
                proration: true,
                periodStartSec: later,
                periodEndSec: APR_1,
              },
            ],
          }),
        ),
        MAPS,
      );
      expect(two.line?.stripePriceId, shape).toBe('price_scale_m');
    }
  });

  it('a one-off invoice item is never the subscription’s period, even with a plan’s price and a period that runs forward', () => {
    for (const shape of INVOICE_SHAPES) {
      const facts = readPaidInvoice(
        buildInvoice(
          shape,
          renewal({
            lines: [
              {
                priceId: 'price_scale_m',
                amount: 500,
                kind: 'invoiceitem',
                periodStartSec: MAR_1,
                periodEndSec: APR_1,
              },
            ],
          }),
        ),
        MAPS,
      );
      expect(facts.line, shape).toBeNull();
      expect(facts.unlinkedReason, shape).toBe('no_subscription_line');
    }
  });

  it('a line that belongs to ANOTHER subscription is not this invoice’s period; a line naming none is', () => {
    for (const shape of INVOICE_SHAPES) {
      const line = {
        priceId: 'price_starter_m',
        amount: 14900,
        periodStartSec: MAR_1,
        periodEndSec: APR_1,
      };
      const other = readPaidInvoice(
        buildInvoice(shape, renewal({ lines: [{ ...line, subscriptionId: 'sub_other' }] })),
        MAPS,
      );
      expect(other.line, shape).toBeNull();
      const unnamed = readPaidInvoice(
        buildInvoice(shape, renewal({ lines: [{ ...line, subscriptionId: null }] })),
        MAPS,
      );
      expect(unnamed.line?.kind, shape).toBe('period');
    }
  });

  it('a line whose period does not run forward is no period', () => {
    for (const shape of INVOICE_SHAPES) {
      for (const [start, end] of [
        [MAR_1, MAR_1],
        [APR_1, MAR_1],
      ] as const) {
        const facts = readPaidInvoice(
          buildInvoice(
            shape,
            renewal({
              lines: [
                {
                  priceId: 'price_starter_m',
                  amount: 14900,
                  periodStartSec: start,
                  periodEndSec: end,
                },
              ],
            }),
          ),
          MAPS,
        );
        expect(facts.line, `${shape} ${String(start)}→${String(end)}`).toBeNull();
      }
    }
  });

  it('a price the configuration does not name keeps its line and period, with no plan and no interval; a configured line is preferred over it', () => {
    for (const shape of INVOICE_SHAPES) {
      const custom = {
        priceId: 'price_custom_contract',
        amount: 500000,
        periodStartSec: MAR_1,
        periodEndSec: APR_1,
      };
      const facts = readPaidInvoice(buildInvoice(shape, renewal({ lines: [custom] })), MAPS);
      expect(summary(facts).line, shape).toEqual({
        kind: 'period',
        stripePriceId: 'price_custom_contract',
        tier: null,
        interval: null,
        periodStart: '2026-03-01T00:00:00.000Z',
        periodEnd: '2026-04-01T00:00:00.000Z',
      });
      expect(facts.unlinkedReason).toBeNull();

      const both = readPaidInvoice(
        buildInvoice(
          shape,
          renewal({
            lines: [
              custom,
              {
                priceId: 'price_scale_y',
                amount: 1,
                periodStartSec: MAR_1,
                periodEndSec: MAR_1_2027,
              },
            ],
          }),
        ),
        MAPS,
      );
      expect(both.line?.tier, shape).toBe('api_scale');
      expect(both.line?.interval, shape).toBe('year');
    }
  });

  it('a price id that names a property of every object ("constructor", "__proto__") is not a configured price', () => {
    for (const priceId of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const facts = readPaidInvoice(
        buildInvoice(
          'older',
          renewal({
            lines: [{ priceId, amount: 1, periodStartSec: MAR_1, periodEndSec: APR_1 }],
          }),
        ),
        MAPS,
      );
      expect(facts.line?.tier, priceId).toBeNull();
      expect(facts.line?.interval, priceId).toBeNull();
    }
  });

  it('an invoice that names no subscription is tied to no line, however good its lines look', () => {
    for (const shape of INVOICE_SHAPES) {
      const facts = readPaidInvoice(
        buildInvoice(shape, renewal({ subscriptionId: null, billingReason: 'manual' })),
        MAPS,
      );
      expect(facts.stripeSubscriptionId, shape).toBeNull();
      expect(facts.line, shape).toBeNull();
      expect(facts.unlinkedReason, shape).toBe('no_subscription');
      // The payment itself is still fully read.
      expect(facts.amountPaidMinor, shape).toBe(14900);
      expect(facts.stripePaymentIntentId, shape).toBe('pi_1');
    }
  });

  it('expanded references are read as their ids', () => {
    const invoice = buildInvoice('older', renewal());
    invoice.subscription = { id: 'sub_1', object: 'subscription' };
    invoice.customer = { id: 'cus_1', object: 'customer' };
    invoice.payment_intent = { id: 'pi_1', object: 'payment_intent' };
    invoice.charge = { id: 'ch_1', object: 'charge' };
    const facts = readPaidInvoice(invoice, MAPS);
    expect(facts.stripeSubscriptionId).toBe('sub_1');
    expect(facts.stripeCustomerId).toBe('cus_1');
    expect(facts.stripePaymentIntentId).toBe('pi_1');
    expect(facts.stripeChargeId).toBe('ch_1');
    expect(facts.line?.kind).toBe('period');
  });

  it('the amount paid is a whole non-negative number of minor units, or it is not an amount', () => {
    const read = (amount: unknown): number | null => {
      const invoice = buildInvoice('older', renewal());
      invoice.amount_paid = amount;
      return readPaidInvoice(invoice, MAPS).amountPaidMinor;
    };
    expect(read(0)).toBe(0);
    expect(read(14900)).toBe(14900);
    for (const bad of [-1, 12.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '14900', null]) {
      expect(read(bad), String(bad)).toBeNull();
    }
  });

  it('a malformed payload reads as absent facts and never throws', () => {
    const shapes: unknown[] = [
      {},
      { id: 7, lines: 'no' },
      { id: 'in_x', subscription: 'sub_1', lines: { data: [null, 3, 'x', [], {}] } },
      { id: 'in_x', subscription: 'sub_1', lines: { data: [{ period: { start: 'a', end: {} } }] } },
      { id: 'in_x', parent: 'nope', lines: { data: [{ parent: 3, pricing: [], price: 9 }] } },
    ];
    for (const invoice of shapes) {
      const facts = readPaidInvoice(invoice as Record<string, unknown>, MAPS);
      expect(facts.line, JSON.stringify(invoice)).toBeNull();
      expect(facts.unlinkedReason, JSON.stringify(invoice)).not.toBeNull();
    }
  });

  it('a time no calendar can hold is ABSENT, never an Invalid Date. "Finite and positive" is not enough: 1e15 seconds is both, and the Date it makes throws RangeError inside the database write — a permanent failure, so the payment would be lost with its receipt, and a subscription event would lose its plan change', () => {
    // Just past what a JavaScript Date can hold (±8.64e15 ms), and far past it.
    for (const tooLate of [8.64e12 + 1, 1e15, Number.MAX_VALUE]) {
      const invoice = buildInvoice('older', renewal());
      invoice.status_transitions = { paid_at: tooLate };
      invoice.created = tooLate;
      const facts = readPaidInvoice(invoice, MAPS);
      expect(facts.paidAt, String(tooLate)).toBeNull();
      expect(facts.createdAt, String(tooLate)).toBeNull();
      // The rest of the invoice is still read.
      expect(facts.line?.kind, String(tooLate)).toBe('period');

      expect(readSubscriptionPeriodStart({ current_period_start: tooLate })).toBeNull();
      expect(
        readSubscriptionPeriodStart({
          current_period_start: tooLate,
          items: { data: [{ current_period_start: MAR_1 }] },
        })?.toISOString(),
        'the item’s start is still the fallback',
      ).toBe('2026-03-01T00:00:00.000Z');

      // A line whose period cannot be held is no line at all.
      const line = buildInvoice('older', renewal());
      (line.lines as { data: Array<{ period: { end: number } }> }).data[0]!.period.end = tooLate;
      expect(readPaidInvoice(line, MAPS).line, String(tooLate)).toBeNull();
    }
    // CONTROL: the last second a Date can hold is still a time.
    const invoice = buildInvoice('older', renewal());
    invoice.status_transitions = { paid_at: 8.64e12 };
    expect(readPaidInvoice(invoice, MAPS).paidAt?.getTime()).toBe(8.64e15);
  });
});
