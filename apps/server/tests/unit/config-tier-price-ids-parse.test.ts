// Which Stripe price a customer is actually charged.
//
// `DRIFTSTACK_TIER_PRICE_IDS` is parsed at boot into the map
// `BillingService.createCheckoutSession` reads, and that read is
// `args.billingPeriod === 'monthly' ? prices.monthly : prices.annual`. So this
// parser decides the price id on every self-serve subscription. It is one of the
// last substantial branch gaps in `lib/config.ts` (67.6% branches) and none of
// its four paths were exercised.
//
// Its contract, per its own header, is to throw on malformed input "so a
// misconfigured deploy fails fast at boot" — which is the right posture: a
// billing map that is silently wrong is far worse than a container that refuses
// to start. The arms below pin both halves of that: what is accepted, and that
// everything else is rejected loudly rather than skipped.
//
// ⚠️ One arm pins behaviour that may not be intended, and is written to say so
// rather than to bless it. The parser accepts a LEGACY flat shape
// (`{"tier":"price_x"}`) and expands it to `{ monthly: x, annual: x }`, while the
// comment directly above that line says the flat form is "synthesised as MONTHLY
// ONLY". Those disagree, and the disagreement has a price attached: because
// annual checkout reads `prices.annual`, a deploy still using the flat shape
// sells an ANNUAL subscription at the MONTHLY price id. The alternative reading —
// leaving `annual` absent — would instead make annual checkout fail loudly, which
// matches the "fail fast" posture the rest of this function takes.
//
// The current `docs/deployment/env-vars.md` documents the nested shape, so this
// needs an out-of-date config to reach; it is latent, not live. It is pinned here
// as CURRENT BEHAVIOUR, deliberately not changed: which way it should resolve is
// a decision about charging customers, and that belongs to whoever owns billing.

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/config.js';

const BASE: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

const tierPrices = (raw: string): Record<string, { monthly: string; annual: string }> | undefined =>
  loadConfig({ ...BASE, DRIFTSTACK_TIER_PRICE_IDS: raw }).stripe?.tierPrices;

describe('DRIFTSTACK_TIER_PRICE_IDS parsing', () => {
  it('CRITICAL the documented nested shape maps each cadence to its own price', () => {
    const parsed = tierPrices(
      JSON.stringify({
        solo_manual: { monthly: 'price_solo_m', annual: 'price_solo_a' },
        api_starter: { monthly: 'price_api_m', annual: 'price_api_a' },
      }),
    );
    expect(parsed?.solo_manual).toEqual({ monthly: 'price_solo_m', annual: 'price_solo_a' });
    expect(
      parsed?.api_starter?.annual,
      'the annual price id was not carried through — annual checkout reads exactly this field',
    ).toBe('price_api_a');
  });

  it('CRITICAL an absent variable leaves the price map unset rather than empty', () => {
    // An empty map would let checkout resolve a tier to `undefined` and hand a
    // missing price id to Stripe; absent is what the caller checks for.
    expect(loadConfig({ ...BASE }).stripe?.tierPrices).toBeUndefined();
  });

  it('CRITICAL the legacy flat shape currently bills ANNUAL at the MONTHLY price id', () => {
    const parsed = tierPrices(JSON.stringify({ solo_manual: 'price_only_monthly' }));
    expect(parsed?.solo_manual?.monthly).toBe('price_only_monthly');
    // Pinned as-is, NOT endorsed. The comment above this branch in config.ts says
    // the flat form is "synthesised as monthly only"; the code assigns the same id
    // to annual, and createCheckoutSession reads `prices.annual` for annual
    // billing. So a deploy on the flat shape sells a year at the monthly price.
    // If that is wrong, the fix is to leave `annual` absent so annual checkout
    // fails loudly — matching this function's own fail-fast posture — and this
    // expectation is what should change with it.
    expect(
      parsed?.solo_manual?.annual,
      'flat-shape handling changed. Confirm which is intended: billing annual at the monthly ' +
        'price (current), or leaving annual unset so annual checkout fails loudly',
    ).toBe('price_only_monthly');
  });

  it('CRITICAL a price id mapped to TWO tiers is rejected at boot. Bootstrap builds the reverse map as priceToTier[id] = tier, so a duplicate resolves to whichever tier is iterated last and the Stripe webhook writes THAT tier onto the subscriber — a customer silently placed on the wrong plan by a copy-paste in one env var.', () => {
    expect(() =>
      tierPrices(
        JSON.stringify({
          solo_manual: { monthly: 'price_shared', annual: 'price_solo_a' },
          api_starter: { monthly: 'price_shared', annual: 'price_api_a' },
        }),
      ),
    ).toThrow(/mapped to both solo_manual and api_starter/);
  });

  it('CRITICAL the duplicate check is ACROSS tiers only — one tier may legally reuse a single price id for both cadences. The legacy flat shape synthesises monthly === annual on purpose, so a check that merely counted repeats would reject the shape this parser exists to accept.', () => {
    const parsed = tierPrices(JSON.stringify({ solo_manual: 'price_solo_only' }));
    expect(
      parsed?.solo_manual,
      'the legacy flat shape stopped parsing — the duplicate check is counting repeats rather than distinct tiers',
    ).toEqual({ monthly: 'price_solo_only', annual: 'price_solo_only' });
  });

  it('CRITICAL a non-object JSON payload is rejected at boot', () => {
    expect(
      () => tierPrices('"just-a-string"'),
      'a scalar was accepted as the price map — every tier would resolve to undefined and checkout ' +
        'would hand Stripe a missing price id at runtime instead of failing at boot',
    ).toThrow(/must be a JSON object/);
  });

  it('CRITICAL a tier whose value is neither a string nor {monthly, annual} is rejected', () => {
    expect(
      () => tierPrices(JSON.stringify({ solo_manual: { monthly: 'price_m' } })),
      'a half-filled tier entry was accepted, so annual checkout for that tier would send undefined',
    ).toThrow(/solo_manual/);
    expect(() => tierPrices(JSON.stringify({ api_starter: 42 }))).toThrow(/api_starter/);
    expect(() => tierPrices(JSON.stringify({ api_starter: null }))).toThrow(/api_starter/);
  });

  it('CRITICAL the rejection names the offending tier, so a bad deploy is diagnosable', () => {
    // Boot failures are read from a container log with no debugger attached; the
    // tier name is the difference between a one-line fix and bisecting the JSON.
    expect(() => tierPrices(JSON.stringify({ good: 'price_x', bad_tier: [] }))).toThrow(/bad_tier/);
  });

  it('CRITICAL malformed JSON fails at boot rather than yielding an empty map', () => {
    expect(() => tierPrices('{not json')).toThrow();
  });
});
