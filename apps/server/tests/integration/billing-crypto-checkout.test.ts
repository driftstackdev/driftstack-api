// V-666.C — integration tests for POST /v1/billing/crypto-checkout.
//
// Coverage: auth gate, happy path (201 + persisted order), input
// validation (bad product, bad currency, missing price), and that the
// minted order_id round-trips through the V-666.B IPN state machine.
// V-666.AO — appended tests for Idempotency-Key header.

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

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
      payload: { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('201 with stubbed provider payment context on happy path', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<CryptoCheckoutResponse>();
    expect(body.order_id).toMatch(/^ord_[0-9a-f]{12}$/);
    expect(body.product).toBe('solo_manual');
    expect(body.price_cents).toBe(7900);
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

  it('V-666.AO replays the same order on a duplicate Idempotency-Key', async () => {
    fx = await buildTestApp();
    const headers = {
      authorization: `Bearer ${fx.plaintext}`,
      'idempotency-key': 'client-retry-abc',
    };
    const payload = { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' };
    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers,
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const firstBody = first.json<CryptoCheckoutResponse>();

    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers,
      payload,
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('1');
    const secondBody = second.json<CryptoCheckoutResponse>();
    expect(secondBody.order_id).toBe(firstBody.order_id);
    expect(secondBody.created_at).toBe(firstBody.created_at);
  });

  it.each([
    ['paid', 'finished'],
    ['failed', 'failed'],
    ['cancelled', null],
  ] as const)(
    'V-666.AO replay returns the current %s terminal state without creating a successor order',
    async (expectedStatus, providerStatus) => {
      fx = await buildTestApp();
      const headers = {
        authorization: `Bearer ${fx.plaintext}`,
        'idempotency-key': `terminal-state-${expectedStatus}`,
      };
      const payload = { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' };
      const first = await fx.app.inject({
        method: 'POST',
        url: '/v1/billing/crypto-checkout',
        headers,
        payload,
      });
      const firstBody = first.json<CryptoCheckoutResponse>();

      if (providerStatus === null) {
        const cancelled = await fx.cryptoOrdersService.cancelOrder({
          order_id: firstBody.order_id,
          account_id: fx.accountId,
        });
        expect(cancelled?.ok).toBe('cancelled');
      } else {
        const transitioned = await fx.cryptoOrdersService.applyIpnStatus({
          order_id: firstBody.order_id,
          payment_id: `pay_${expectedStatus}`,
          provider_status: providerStatus,
        });
        expect(transitioned?.status).toBe(expectedStatus);
      }

      const replay = await fx.app.inject({
        method: 'POST',
        url: '/v1/billing/crypto-checkout',
        headers,
        payload,
      });
      expect(replay.statusCode).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('1');
      expect(replay.json<CryptoCheckoutResponse>()).toMatchObject({
        order_id: firstBody.order_id,
        status: expectedStatus,
        provider: 'stub',
        payment_address: null,
        pay_currency: null,
      });
      const all = await fx.cryptoOrdersService.listForAdminPage({ accountId: fx.accountId });
      expect(all.orders).toHaveLength(1);
    },
  );

  it('V-666.AO different Idempotency-Keys mint different orders', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const payload = { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' };
    const a = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { ...auth, 'idempotency-key': 'key-a' },
      payload,
    });
    const b = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { ...auth, 'idempotency-key': 'key-b' },
      payload,
    });
    expect(a.json<CryptoCheckoutResponse>().order_id).not.toBe(
      b.json<CryptoCheckoutResponse>().order_id,
    );
  });

  it('V-666.AO 400 on whitespace / oversize idempotency key', async () => {
    fx = await buildTestApp();
    const oversize = 'x'.repeat(256);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'idempotency-key': oversize,
      },
      payload: { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('V-666.AO Idempotency-Key collisions across accounts mint independent orders', async () => {
    fx = await buildTestApp();
    // Second account, fresh API key — but the same Idempotency-Key.
    const second = await seedAdditionalAccount(fx);
    const payload = { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' };
    const sharedKey = 'colliding-customer-retry';
    const a = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': sharedKey },
      payload,
    });
    expect(a.statusCode).toBe(201);
    expect(a.headers['idempotent-replayed']).toBeUndefined();
    const b = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${second.plaintext}`, 'idempotency-key': sharedKey },
      payload,
    });
    expect(b.statusCode).toBe(201);
    // Critical: account B must NOT see account A's order. Different
    // order ids; no replay header.
    expect(b.headers['idempotent-replayed']).toBeUndefined();
    expect(b.json<CryptoCheckoutResponse>().order_id).not.toBe(
      a.json<CryptoCheckoutResponse>().order_id,
    );
    // Account A's second call with the same key still replays its own order.
    const aReplay = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': sharedKey },
      payload,
    });
    expect(aReplay.headers['idempotent-replayed']).toBe('1');
    expect(aReplay.json<CryptoCheckoutResponse>().order_id).toBe(
      a.json<CryptoCheckoutResponse>().order_id,
    );
  });

  it('V-666.AO missing header still mints fresh on every call', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const payload = { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' };
    const a = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: auth,
      payload,
    });
    const b = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: auth,
      payload,
    });
    expect(a.json<CryptoCheckoutResponse>().order_id).not.toBe(
      b.json<CryptoCheckoutResponse>().order_id,
    );
  });

  it('minted order flows through V-666.B applyIpnStatus → paid', async () => {
    fx = await buildTestApp();
    const checkout = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' },
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
