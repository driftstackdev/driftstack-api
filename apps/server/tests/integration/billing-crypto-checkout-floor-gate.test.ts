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

  it('below-floor product (trial_pack, $2.99) → stays stub, NowPayments NOT called even when wired', async () => {
    const { client, createPayment } = mockNowpayments();
    fx = await buildTestApp({ nowpaymentsClient: client });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'trial_pack', price_cents: 299, price_currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ provider: string; payment_address: string | null }>();
    expect(body.provider).toBe('stub');
    expect(body.payment_address).toBeNull();
    expect(createPayment).not.toHaveBeenCalled();
  });

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
});
