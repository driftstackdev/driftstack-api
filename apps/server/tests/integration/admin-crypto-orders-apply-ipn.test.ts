// V-666.F — integration tests for the manual IPN apply admin route.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type { CryptoOrder } from '../../src/services/crypto-orders.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

async function seed(
  fx: TestAppFixture,
  order: Partial<CryptoOrder> & { order_id: string },
): Promise<void> {
  const now = Date.now();
  await fx.cryptoOrdersRepo.upsert({
    account_id: fx.accountId,
    product: 'trial_pack',
    price_cents: 299,
    price_currency: 'USD',
    payment_id: null,
    status: 'pending',
    created_at: now,
    updated_at: now,
    ...order,
  });
}

interface OrderResponse {
  order_id: string;
  status: string;
  payment_id: string | null;
}

describe('V-666.F POST /v1/admin/crypto-orders/:id/apply-ipn', () => {
  it('403 for a non-admin caller', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_x/apply-ipn',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: { provider_status: 'finished', payment_id: 'pay_1' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404 when the order does not exist', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_missing/apply-ipn',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: { provider_status: 'finished', payment_id: 'pay_1' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('happy path: pending → paid via finished status', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seed(fx, { order_id: 'ord_apply', status: 'pending' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_apply/apply-ipn',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: { provider_status: 'finished', payment_id: 'pay_manual_1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<OrderResponse>();
    expect(body.status).toBe('paid');
    expect(body.payment_id).toBe('pay_manual_1');
  });

  it('reverse transition rejected by the state machine — paid stays paid', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seed(fx, { order_id: 'ord_paid', status: 'paid', payment_id: 'pay_x' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_paid/apply-ipn',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: { provider_status: 'waiting', payment_id: 'pay_x' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<OrderResponse>();
    expect(body.status).toBe('paid');
  });

  it('400 when required body fields are missing', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seed(fx, { order_id: 'ord_a' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_a/apply-ipn',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: { provider_status: 'finished' }, // missing payment_id
    });
    expect(res.statusCode).toBe(400);
  });
});
