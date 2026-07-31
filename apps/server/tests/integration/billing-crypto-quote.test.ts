// V-666.H — integration tests for POST /v1/billing/crypto-checkout/quote.
//
// Coverage: auth gate, happy path price preview, unsupported product
// (400), default + override currency.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface QuoteResponse {
  product: string;
  price_cents: number;
  price_currency: string;
}

describe('V-666.H POST /v1/billing/crypto-checkout/quote', () => {
  it('401 without auth', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout/quote',
      payload: { product: 'solo_manual' },
    });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ['zero-scope', []],
    ['write-only', ['write']],
    ['unrelated granular', ['read:sessions']],
  ] as const)('403 for a %s key', async (_label, scopes) => {
    fx = await buildTestApp({ scopes: [...scopes] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout/quote',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'solo_manual' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toBe(
      'This action requires the "read:billing" scope.',
    );
  });

  it.each(['read:billing', 'read', 'account_owner'] as const)(
    'allows a %s key to request a quote',
    async (scope) => {
      fx = await buildTestApp({ scopes: [scope] });
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/billing/crypto-checkout/quote',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { product: 'solo_manual' },
      });
      expect(res.statusCode, res.body).toBe(200);
    },
  );

  it('quotes in the SETTLEMENT currency (USD), which is what the order actually charges', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout/quote',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'solo_manual' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<QuoteResponse>();
    expect(body.product).toBe('solo_manual');
    expect(body.price_cents).toBe(7900);
    // billing-crypto.ts locks serverPriceCurrency = 'USD' and never settles in
    // EUR/GBP. Quoting EUR meant a dashboard or SDK rendered "€79.00" for an
    // order that then charged $79 USD — a misstated price, not a display nit.
    expect(body.price_currency).toBe('USD');
    expect(body).toEqual({
      product: 'solo_manual',
      price_cents: 7900,
      price_currency: 'USD',
    });
  });

  it('IGNORES a caller-supplied price_currency — the charge cannot be relabelled', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout/quote',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'team_manual', price_currency: 'EUR' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<QuoteResponse>();
    // The field is still accepted for compatibility and still ignored, exactly
    // as the checkout route ignores it. Echoing it back was what let a caller
    // put a currency label on a price it does not control.
    expect(body.price_currency).toBe('USD');
    expect(body.price_cents).toBe(24900);
  });

  it('400 on unsupported product', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout/quote',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'trial_pack' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 on non-uppercase price_currency', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout/quote',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'solo_manual', price_currency: 'eur' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns the api_scale price (sanity for highest-tier mapping)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout/quote',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'api_scale' },
    });
    const body = res.json<QuoteResponse>();
    expect(body.price_cents).toBe(149900);
  });

  it('quote tracks an owner price edit (pricing-as-data: quote == charge source)', async () => {
    // Regression for the pricing-as-data incomplete-migration bug: the charge
    // path was rewired to PricingService.listEffective() but the quote was
    // left reading the static TIER_PRICE_CENTS constant, so an owner price
    // edit moved the charge while the quote still showed the seed price.
    // The quote MUST now reflect the edited DB price.
    fx = await buildTestApp();
    // Seed price is 7900; owner edits solo_manual to 6500.
    await fx.pricingService.setPrice('solo_manual', 6500);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout/quote',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'solo_manual' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<QuoteResponse>();
    expect(body.price_cents).toBe(6500);
  });
});
