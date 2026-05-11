// V-666.C — integration tests for POST /v1/billing/crypto-checkout.
//
// Coverage: auth gate, happy path (201 + persisted order), input
// validation (bad product, bad currency, missing price), and that the
// minted order_id round-trips through the V-666.B IPN state machine.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface CryptoCheckoutResponse {
  order_id: string;
  product: string;
  price_cents: number;
  price_currency: string;
  status: string;
  provider: string;
  payment_address: string | null;
  pay_currency: string | null;
  created_at: string;
}

describe('V-666.C POST /v1/billing/crypto-checkout', () => {
  it('401 without auth', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      payload: { product: 'trial_pack', price_cents: 299, price_currency: 'USD' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('201 with stubbed provider payment context on happy path', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'trial_pack', price_cents: 299, price_currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<CryptoCheckoutResponse>();
    expect(body.order_id).toMatch(/^ord_[0-9a-f]{12}$/);
    expect(body.product).toBe('trial_pack');
    expect(body.price_cents).toBe(299);
    expect(body.price_currency).toBe('USD');
    expect(body.status).toBe('pending');
    // V-666.D follow-up will populate these via the NowPayments client.
    expect(body.provider).toBe('stub');
    expect(body.payment_address).toBeNull();
    expect(body.pay_currency).toBeNull();
    // The order is persisted in the in-memory repo so the IPN route
    // can transition its state on subsequent webhook calls.
    const stored = await fx.cryptoOrdersRepo.getById(body.order_id);
    expect(stored).not.toBeNull();
    expect(stored?.account_id).toBe(fx.accountId);
  });

  it('400 on unknown product', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'not_a_tier', price_cents: 999, price_currency: 'USD' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 on non-uppercase / non-3-letter currency', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'solo_manual', price_cents: 1499, price_currency: 'usd' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 on missing / non-positive price_cents', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'solo_manual', price_cents: 0, price_currency: 'USD' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('minted order flows through V-666.B applyIpnStatus → paid', async () => {
    fx = await buildTestApp();
    const checkout = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'trial_pack', price_cents: 299, price_currency: 'USD' },
    });
    const body = checkout.json<CryptoCheckoutResponse>();

    const transitioned = await fx.cryptoOrdersService.applyIpnStatus({
      order_id: body.order_id,
      payment_id: 'pay_test_123',
      provider_status: 'finished',
    });
    expect(transitioned?.status).toBe('paid');
    expect(transitioned?.payment_id).toBe('pay_test_123');
  });
});
