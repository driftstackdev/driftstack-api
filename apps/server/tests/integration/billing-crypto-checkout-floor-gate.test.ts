// V-666.SEC — crypto-checkout NowPayments floor gate. The existing
// billing-crypto-checkout suite runs without a NowPayments client wired
// (deps.nowpayments undefined), so its "stub" assertions never exercise
// the floor gate. This wires a mock client and pins the two branches of
//   `nowpayments !== undefined && ipnCallbackUrl !== undefined &&
//    serverPriceCents >= NOWPAYMENTS_MIN_USD_CENTS`
// : a below-floor product (trial_pack, $2.99) must short-circuit to the
// stub posture WITHOUT calling NowPayments (keeps trial-pack off crypto,
// avoids surfacing amount_too_low), and an above-floor product mints a
// real NowPayments payment.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type { NowPaymentsApiClient, CreatePaymentResult } from '../../src/lib/nowpayments-api.js';

function mockNowpayments(): {
  client: NowPaymentsApiClient;
  createPayment: ReturnType<typeof vi.fn>;
} {
  const createPayment = vi.fn(
    (): Promise<CreatePaymentResult> =>
      Promise.resolve({
        paymentId: 'pay_test_1',
        payAddress: '0xPAYADDRESS',
        payCurrency: 'btc',
        payAmount: 0.0012,
        priceAmount: 79,
        priceCurrency: 'usd',
        paymentStatus: 'waiting',
      }),
  );
  return { client: { createPayment } as unknown as NowPaymentsApiClient, createPayment };
}

describe('crypto checkout NowPayments floor gate (V-666.SEC)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  // 2026-05-27 — the below-floor branch is no longer reachable via the
  // product catalog: trial_pack ($2.99, the only sub-$19.16 product) was
  // retired and every remaining paid tier is ≥ $79 (above the floor). The
  // defensive `amount < NOWPAYMENTS_MIN_USD_CENTS` short-circuit stays in
  // the route but has no product that triggers it, so its dedicated test
  // was removed. The above-floor path below remains the live behaviour.
  it('above-floor product (solo_manual) → provider nowpayments, createPayment called once', async () => {
    const { client, createPayment } = mockNowpayments();
    fx = await buildTestApp({ nowpaymentsClient: client });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ provider: string; payment_address: string | null }>();
    expect(body.provider).toBe('nowpayments');
    expect(body.payment_address).toBe('0xPAYADDRESS');
    expect(createPayment).toHaveBeenCalledTimes(1);
  });

  it('above-floor product but NowPayments createPayment throws → soft-fails to stub, order still persists (V-666.D)', async () => {
    const createPayment = vi.fn(
      (): Promise<CreatePaymentResult> => Promise.reject(new Error('nowpayments 502')),
    );
    const client = { createPayment } as unknown as NowPaymentsApiClient;
    fx = await buildTestApp({ nowpaymentsClient: client });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' },
    });
    // The upstream failure must not break checkout: the local order is
    // created (customer-trackable order_id) and the response degrades to
    // the stub posture rather than 5xx-ing.
    expect(res.statusCode).toBe(201);
    expect(createPayment).toHaveBeenCalledTimes(1);
    const body = res.json<{ provider: string; payment_address: string | null; order_id: string }>();
    expect(body.provider).toBe('stub');
    expect(body.payment_address).toBeNull();
    expect(body.order_id).toMatch(/^ord_/);
  });
});
