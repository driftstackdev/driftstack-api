// What crypto checkout CHARGES must equal what the pricing page ADVERTISES.
//
// Two independent sources hold the same money:
//
//   apps/marketing-site/src/data/pricing.ts  API_TIERS[].monthlyUsd   (advertised)
//   apps/server/src/routes/billing-crypto.ts TIER_PRICE_CENTS         (charged)
//
// They agreed when this landed, and nothing made them agree. Measured both
// directions against the whole suite:
//
//   • charged 7900 → 8900 reds 3, all of them inside the billing-crypto family
//     and all quoting the literal back to itself. None mentions the advertised
//     price.
//   • advertised 79 → 89 reds 8, and NOT ONE is in billing-crypto. Every red is
//     a marketing-side pin saying "update this literal" — including
//     pricing-crypto-doc-parity, which guards the /pricing/crypto PAGE and so
//     reads as though checkout were covered.
//
// So a repricing that dutifully clears every failing test still ships a site
// advertising $89 while crypto checkout charges $79. The customer is quoted one
// number and billed another, and the suite stays green.
//
// This is not hypothetical: pricing-crypto-doc-parity exists because those
// prices HAD already drifted once — its header records the crypto page listing
// $25/$80/$300/$50/$250 against a canonical ladder of $79/$249/$699/$149/$499.
// That fix derived the page's LABELS from API_TIERS; the amount actually
// charged stayed an independent hardcoded map, which is the half still exposed.
//
// The pairing below is derived, not quoted: no dollar figure is written here,
// so a legitimate reprice needs no edit to this file, and an illegitimate one
// cannot pass by updating a literal.

import { describe, expect, it } from 'vitest';
import { TIER_PRICE_CENTS } from '../../src/routes/billing-crypto.js';
import { API_TIERS } from '../../../marketing-site/src/data/pricing.ts';

const CENTS_PER_USD = 100;

/** Tiers a customer can buy outright at a listed monthly price. */
function advertisedTiers(): { id: string; monthlyUsd: number }[] {
  return API_TIERS.filter(
    (t): t is typeof t & { monthlyUsd: number } =>
      typeof t.monthlyUsd === 'number' && t.monthlyUsd > 0,
  ).map((t) => ({ id: t.id, monthlyUsd: t.monthlyUsd }));
}

describe('the price charged matches the price advertised', () => {
  it('CRITICAL both sources are real and non-empty, so agreement below is measured', () => {
    const advertised = advertisedTiers();
    expect(
      advertised.length,
      'no advertised paid tier found — the pricing import is broken and every check below is vacuous',
    ).toBeGreaterThanOrEqual(6);
    expect(
      Object.keys(TIER_PRICE_CENTS).length,
      'the charged-price map is empty — the route import is broken',
    ).toBeGreaterThanOrEqual(6);
    // Free and Enterprise are deliberately absent from checkout: one costs
    // nothing, the other is a negotiated annual contract with no listed
    // monthly. Both must therefore be excluded by the filter, not by luck.
    expect(advertised.map((t) => t.id)).not.toContain('free');
    expect(advertised.map((t) => t.id)).not.toContain('enterprise');
  });

  it('CRITICAL every tier crypto charges for is charged the advertised price', () => {
    const advertised = new Map(advertisedTiers().map((t) => [t.id, t.monthlyUsd]));
    const wrong = Object.entries(TIER_PRICE_CENTS)
      .filter(([id]) => advertised.has(id))
      .filter(([id, cents]) => cents !== advertised.get(id)! * CENTS_PER_USD)
      .map(
        ([id, cents]) =>
          `${id}: checkout charges ${cents} cents but the pricing page advertises ` +
          `$${advertised.get(id)}/mo (${advertised.get(id)! * CENTS_PER_USD} cents)`,
      );
    expect(
      wrong.sort(),
      'a customer would be quoted one price on the site and billed another at checkout',
    ).toEqual([]);
  });

  it('CRITICAL the two ladders name the same tiers — none purchasable-but-unsellable, none stale', () => {
    const advertisedIds = advertisedTiers()
      .map((t) => t.id)
      .sort();
    const chargedIds = Object.keys(TIER_PRICE_CENTS).sort();
    // A new paid tier that checkout cannot sell, or a retired tier checkout
    // still prices, are both failures worth a deliberate decision rather than
    // a silent divergence — so this compares the sets rather than one side.
    expect(chargedIds, 'the tiers crypto can sell differ from the tiers the site sells').toEqual(
      advertisedIds,
    );
  });

  it('CRITICAL the comparison rejects a mismatch (it is not satisfied by anything)', () => {
    const advertised = new Map([['solo_manual', 79]]);
    const mismatch = Object.entries({ solo_manual: 8900 }).filter(
      ([id, cents]) => cents !== advertised.get(id)! * CENTS_PER_USD,
    );
    expect(mismatch.length, 'the dollars-to-cents comparison would accept a wrong charge').toBe(1);
    const match = Object.entries({ solo_manual: 7900 }).filter(
      ([id, cents]) => cents !== advertised.get(id)! * CENTS_PER_USD,
    );
    expect(match.length, 'the comparison rejects a CORRECT charge').toBe(0);
  });
});
