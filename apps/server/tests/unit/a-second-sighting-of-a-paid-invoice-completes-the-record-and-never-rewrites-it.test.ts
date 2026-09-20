// A second sighting of a paid invoice may COMPLETE its record. It never
// rewrites one.
//
// One invoice is seen several times by design: two Stripe events, retries for
// days, the backfill. `completeInvoicePayment` is the one rule for what a later
// sighting changes, applied by both the Postgres repo and the in-memory double.
//
// Both directions matter. A rule that refuses everything leaves a payment that
// arrived unreadable tied to no period for ever. A rule that accepts everything
// lets an older or differently-configured sighting move a period a customer
// already has credit for.

import { describe, expect, it } from 'vitest';

import {
  completeInvoicePayment,
  type InvoicePaymentRecord,
} from '../../src/lib/invoice-payment-record.js';
import type { PaidInvoiceLine } from '../../src/lib/stripe-billing-facts.js';

const MARCH: PaidInvoiceLine = {
  kind: 'period',
  stripePriceId: 'price_starter_m',
  tier: 'api_starter',
  interval: 'month',
  periodStart: new Date('2026-03-01T00:00:00Z'),
  periodEnd: new Date('2026-04-01T00:00:00Z'),
};

function record(overrides: Partial<InvoicePaymentRecord> = {}): InvoicePaymentRecord {
  return {
    stripeInvoiceId: 'in_1',
    accountId: '00000000-0000-4000-8000-000000000001',
    stripeSubscriptionId: 'sub_1',
    billingReason: 'subscription_cycle',
    amountPaidMinor: 14900,
    currency: 'usd',
    stripePaymentIntentId: 'pi_1',
    stripeChargeId: 'ch_1',
    line: MARCH,
    paidAt: new Date('2026-03-01T01:00:00Z'),
    ...overrides,
  };
}

describe('a second sighting of a paid invoice completes the record and never rewrites it', () => {
  it('CRITICAL the same invoice seen again adds nothing, so nothing is written', () => {
    expect(completeInvoicePayment(record(), record())).toBeNull();
    // Not reference equality: a fresh, equal line is still "the same".
    expect(completeInvoicePayment(record(), record({ line: { ...MARCH } }))).toBeNull();
  });

  it('CRITICAL a record that named no line is tied to its line by a later sighting that can read it', () => {
    const stored = record({ line: null, stripeSubscriptionId: null, billingReason: null });
    const completed = completeInvoicePayment(stored, record());
    expect(completed).toEqual(record());
  });

  it('CRITICAL a known line is never replaced — not its period, its kind, its price or its plan', () => {
    const april: PaidInvoiceLine = {
      ...MARCH,
      periodStart: new Date('2026-04-01T00:00:00Z'),
      periodEnd: new Date('2026-05-01T00:00:00Z'),
    };
    const otherSightings: PaidInvoiceLine[] = [
      april,
      { ...MARCH, kind: 'proration_up' },
      { ...MARCH, stripePriceId: 'price_scale_m', tier: 'api_scale' },
      { ...MARCH, tier: 'api_scale' },
      { ...MARCH, interval: 'year' },
    ];
    for (const line of otherSightings) {
      expect(completeInvoicePayment(record(), record({ line })), JSON.stringify(line)).toBeNull();
    }
    // A sighting that can NOT read the line does not erase it either.
    expect(completeInvoicePayment(record(), record({ line: null }))).toBeNull();
  });

  it('a line whose price the configuration did not name gains its plan and interval once it does — for the SAME line only', () => {
    const unnamed: PaidInvoiceLine = { ...MARCH, tier: null, interval: null };
    const completed = completeInvoicePayment(record({ line: unnamed }), record());
    expect(completed?.line).toEqual(MARCH);

    // A different price, or a different kind, is a different line: nothing moves.
    const otherPrice = { ...MARCH, stripePriceId: 'price_scale_m', tier: 'api_scale' as const };
    expect(
      completeInvoicePayment(record({ line: unnamed }), record({ line: otherPrice })),
    ).toBeNull();
    const otherKind = { ...MARCH, kind: 'proration_up' as const };
    expect(
      completeInvoicePayment(record({ line: unnamed }), record({ line: otherKind })),
    ).toBeNull();
    // And a line with no price id at all can never be "the same line".
    const noPrice: PaidInvoiceLine = { ...unnamed, stripePriceId: null };
    expect(
      completeInvoicePayment(
        record({ line: noPrice }),
        record({ line: { ...MARCH, stripePriceId: null } }),
      ),
    ).toBeNull();
  });

  it('an absent subscription, billing reason, payment intent or charge is filled in; a present one is kept', () => {
    const bare = record({
      stripeSubscriptionId: null,
      billingReason: null,
      stripePaymentIntentId: null,
      stripeChargeId: null,
    });
    expect(completeInvoicePayment(bare, record())).toEqual(record());

    const different = record({
      stripeSubscriptionId: 'sub_OTHER',
      billingReason: 'manual',
      stripePaymentIntentId: 'pi_OTHER',
      stripeChargeId: 'ch_OTHER',
    });
    expect(completeInvoicePayment(record(), different)).toBeNull();
  });

  it('CRITICAL the amount paid only ever rises. A lower figure is an older sighting arriving late, and lowering it could put a recorded refund above what was paid.', () => {
    expect(completeInvoicePayment(record(), record({ amountPaidMinor: 100 }))).toBeNull();
    expect(
      completeInvoicePayment(record(), record({ amountPaidMinor: 20000 }))?.amountPaidMinor,
    ).toBe(20000);
  });

  it('CRITICAL the account, the currency and when it was paid are never touched, whatever the later sighting says', () => {
    const later = record({
      accountId: '00000000-0000-4000-8000-000000000002',
      currency: 'eur',
      paidAt: new Date('2030-01-01T00:00:00Z'),
      // Something that DOES complete, so a record comes back to inspect.
      amountPaidMinor: 99999,
    });
    const completed = completeInvoicePayment(record(), later);
    expect(completed).not.toBeNull();
    expect(completed?.accountId).toBe(record().accountId);
    expect(completed?.currency).toBe('usd');
    expect(completed?.paidAt.toISOString()).toBe('2026-03-01T01:00:00.000Z');
  });

  it('neither input is modified', () => {
    const stored = record({ line: null });
    const seen = record();
    const before = JSON.stringify([stored, seen]);
    completeInvoicePayment(stored, seen);
    expect(JSON.stringify([stored, seen])).toBe(before);
  });
});
