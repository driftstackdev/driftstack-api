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
    pay_amount: null,
    pay_currency: null,
    status: 'pending',
    customer_note: null,
    internal_note: null,
    events: [{ status: 'pending', at: now, source: 'create' }],
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

  // D-025 audit-gap fix — apply-ipn had zero audit wiring; these prove
  // the new crypto_order.ipn_applied audit row on both the success and
  // 404-not-found path.
  it('D-025 writes a crypto_order.ipn_applied audit row on success', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seed(fx, { order_id: 'ord_audit_ok', status: 'pending' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_audit_ok/apply-ipn',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: { provider_status: 'finished', payment_id: 'pay_audit_1' },
    });
    expect(res.statusCode).toBe(200);
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.action).toBe('crypto_order.ipn_applied');
    expect(all[0]?.adminAccountId).toBe(fx.accountId);
    expect(all[0]?.adminKeyId).toBe(fx.apiKeyId);
    expect(all[0]?.targetResourceId).toBe('ord_audit_ok');
    expect(all[0]?.result).toBe('success');
    expect(all[0]?.inputPayload).toEqual({
      provider_status: 'finished',
      payment_id: 'pay_audit_1',
    });
  });

  it('D-025 writes a crypto_order.ipn_applied audit row with an error: notfound result when the order does not exist', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_audit_missing/apply-ipn',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: { provider_status: 'finished', payment_id: 'pay_1' },
    });
    expect(res.statusCode).toBe(404);
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.action).toBe('crypto_order.ipn_applied');
    expect(all[0]?.targetResourceId).toBe('ord_audit_missing');
    expect(all[0]?.result).toMatch(/^error: notfound/);
  });

  it('403 for a non-admin caller writes no audit row (preHandler rejection, before the handler runs)', async () => {
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
    expect(fx.adminAuditRepo.getAll()).toHaveLength(0);
  });
});
