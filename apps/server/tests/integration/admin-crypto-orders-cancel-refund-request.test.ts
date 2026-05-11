// V-666.Y — integration tests for POST /v1/admin/crypto-orders/:id/cancel-refund-request.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface CancelRefundResponse {
  order_id: string;
  status: string;
  refund_requested_at: string | null;
  refund_reason: string | null;
  noop: boolean;
}

async function seedRefunded(orderId: string): Promise<void> {
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
  await fx.cryptoOrdersService.requestRefund({
    order_id: orderId,
    reason: 'customer asked',
  });
}

async function seedPaidWithoutRefund(orderId: string): Promise<void> {
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

describe('V-666.Y POST /v1/admin/crypto-orders/:id/cancel-refund-request', () => {
  it('403 for a customer key without driftstack_internal_admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    await seedRefunded('ord_y_403');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_y_403/cancel-refund-request',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404 when the order does not exist', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_missing/cancel-refund-request',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('200 clears refund_requested_at + refund_reason + sets noop=false', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedRefunded('ord_y_clear');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_y_clear/cancel-refund-request',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CancelRefundResponse>();
    expect(body.order_id).toBe('ord_y_clear');
    expect(body.refund_requested_at).toBeNull();
    expect(body.refund_reason).toBeNull();
    expect(body.noop).toBe(false);
    expect(body.status).toBe('paid');
  });

  it('200 noop=true when no refund was previously set', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedPaidWithoutRefund('ord_y_noop');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_y_noop/cancel-refund-request',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CancelRefundResponse>();
    expect(body.noop).toBe(true);
    expect(body.refund_requested_at).toBeNull();
  });

  it('is idempotent — a second call returns noop=true', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedRefunded('ord_y_idempotent');
    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_y_idempotent/cancel-refund-request',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(first.json<CancelRefundResponse>().noop).toBe(false);
    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_y_idempotent/cancel-refund-request',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(second.json<CancelRefundResponse>().noop).toBe(true);
  });
});
