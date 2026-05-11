// V-666.X — integration tests for POST /v1/admin/crypto-orders/:id/request-refund.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface OrderResponse {
  order_id: string;
  status: string;
  refund_requested_at: string | null;
  refund_reason: string | null;
}

async function seedPaid(orderId: string): Promise<void> {
  await fx.cryptoOrdersService.create({
    order_id: orderId,
    account_id: fx.accountId,
    product: 'team_growth',
    price_cents: 14900,
    price_currency: 'EUR',
  });
  await fx.cryptoOrdersService.applyIpnStatus({
    order_id: orderId,
    payment_id: 'np_x',
    provider_status: 'finished',
  });
}

describe('V-666.X POST /v1/admin/crypto-orders/:id/request-refund', () => {
  it('403 for a customer key without driftstack_internal_admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    await seedPaid('ord_x');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_x/request-refund',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { reason: 'charge dispute' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404 when the order does not exist', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_missing/request-refund',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { reason: 'whatever' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('200 records the refund + surfaces refund_requested_at + refund_reason', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedPaid('ord_refund');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_refund/request-refund',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { reason: 'Customer charged in error' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<OrderResponse>();
    expect(body.order_id).toBe('ord_refund');
    expect(body.status).toBe('paid');
    expect(body.refund_requested_at).not.toBeNull();
    expect(body.refund_reason).toBe('Customer charged in error');
  });

  it('409 when the order is not in paid state', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await fx.cryptoOrdersService.create({
      order_id: 'ord_pending',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_pending/request-refund',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { reason: 'too early' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('400 when reason is missing or empty', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedPaid('ord_for_bad_request');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_for_bad_request/request-refund',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { reason: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when reason exceeds 500 chars', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedPaid('ord_for_long_reason');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_for_long_reason/request-refund',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { reason: 'x'.repeat(501) },
    });
    expect(res.statusCode).toBe(400);
  });
});
