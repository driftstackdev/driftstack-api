// A configured Stripe price names its plan AND how often it bills.
//
// `buildStripePriceMaps` inverts DRIFTSTACK_TIER_PRICE_IDS. The plan half used to
// be a loop inline in bootstrap; it moved here so the interval half could be
// built beside it from the same entries, and so either could be tested at all.
// Two things can therefore go wrong, and both are silent:
//
//   · the plan map changes in the move, and a subscriber is mirrored onto a
//     different tier than before;
//   · the interval map is wrong, and an annual subscriber's periods are read as
//     monthly (or the reverse).
//
// The last arm holds the WIRING: a correct builder that bootstrap does not pass
// to the webhook service records no interval for anyone, and nothing else fails.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';

import { buildStripePriceMaps } from '../../src/lib/stripe-billing-facts.js';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = resolve(HERE, '..', '..', 'src', 'lib', 'bootstrap.ts');

type TierPrices = Record<string, { monthly: string; annual: string }>;

const FULL: TierPrices = {
  solo_manual: { monthly: 'price_solo_m', annual: 'price_solo_y' },
  team_manual: { monthly: 'price_team_m', annual: 'price_team_y' },
  agency_manual: { monthly: 'price_agency_m', annual: 'price_agency_y' },
  api_starter: { monthly: 'price_starter_m', annual: 'price_starter_y' },
  api_builder: { monthly: 'price_builder_m', annual: 'price_builder_y' },
  api_scale: { monthly: 'price_scale_m', annual: 'price_scale_y' },
};

/** The loop bootstrap ran before the builder existed, verbatim. */
function priceToTierAsBootstrapBuiltIt(
  tierPrices: TierPrices | undefined,
): Record<string, AccountTier> {
  const priceToTier: Record<string, AccountTier> = {};
  if (tierPrices !== undefined) {
    for (const [tier, prices] of Object.entries(tierPrices) as Array<
      [AccountTier, { monthly: string; annual: string }]
    >) {
      priceToTier[prices.monthly] = tier;
      priceToTier[prices.annual] = tier;
    }
  }
  return priceToTier;
}

describe('a configured Stripe price names its plan and how often it bills', () => {
  it('CRITICAL the monthly id bills by the month and the annual id by the year, for every tier', () => {
    const { priceToInterval } = buildStripePriceMaps(FULL);
    const expected: Record<string, string> = {};
    for (const prices of Object.values(FULL)) {
      expected[prices.monthly] = 'month';
      expected[prices.annual] = 'year';
    }
    expect(priceToInterval).toEqual(expected);
    expect(Object.keys(priceToInterval)).toHaveLength(Object.keys(FULL).length * 2);
  });

  it('CRITICAL the plan map is exactly what bootstrap built before the move: no subscriber resolves to a different tier', () => {
    const configs: Array<TierPrices | undefined> = [
      undefined,
      {},
      FULL,
      { api_starter: { monthly: 'price_only', annual: 'price_only' } },
      { solo_manual: { monthly: 'a', annual: 'b' }, api_scale: { monthly: 'c', annual: 'd' } },
    ];
    for (const config of configs) {
      expect(buildStripePriceMaps(config).priceToTier, JSON.stringify(config)).toEqual(
        priceToTierAsBootstrapBuiltIt(config),
      );
    }
    // The comparison compared something.
    expect(Object.keys(buildStripePriceMaps(FULL).priceToTier)).toHaveLength(12);
  });

  it('the legacy one-id-per-tier configuration is a MONTHLY price. config.ts reads that form as "monthly only" and repeats the id in the annual slot; calling it yearly would read every such subscriber’s month as a year.', () => {
    const { priceToInterval, priceToTier } = buildStripePriceMaps({
      solo_manual: { monthly: 'price_flat', annual: 'price_flat' },
    });
    expect(priceToInterval).toEqual({ price_flat: 'month' });
    expect(priceToTier).toEqual({ price_flat: 'solo_manual' });
  });

  it('no configuration is no prices, not an error', () => {
    expect(buildStripePriceMaps(undefined)).toEqual({ priceToTier: {}, priceToInterval: {} });
  });

  it('CRITICAL bootstrap builds BOTH maps with the builder and hands the webhook service the interval map, the invoice reader and the alert client. A builder nobody calls, or a map nobody passes, fails nothing else: the mirror would simply record no interval.', () => {
    const code = codeOnly(readFileSync(BOOTSTRAP, 'utf8'));
    expect(code).toMatch(
      /const \{ priceToTier, priceToInterval \} = buildStripePriceMaps\(config\.stripe\?\.tierPrices\);/,
    );
    // The config object is everything between the constructor's first argument
    // and its third; sliced by position, not matched by a brace-counting regex.
    const from = code.indexOf('new StripeWebhooksService(');
    const to = code.indexOf('accountLifecycleService,', from);
    expect(from, 'the StripeWebhooksService construction was not found').toBeGreaterThan(-1);
    expect(to, 'the construction no longer passes accountLifecycleService').toBeGreaterThan(from);
    const config = code.slice(from, to);
    expect(config).toMatch(/\bpriceToTier,/);
    expect(config).toMatch(/\bpriceToInterval,/);
    expect(config).toMatch(/invoiceFetcher: stripeInvoiceFetcher/);
    expect(config).toMatch(/\bsentry,/);
    // The old inline loop is gone, so there is one builder and not two.
    expect(code).not.toMatch(/priceToTier\[prices\.(?:monthly|annual)\] = tier/);
  });
});
