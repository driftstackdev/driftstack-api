// V-666.D — integration tests for the admin crypto-orders routes.
//
//   GET /v1/admin/crypto-orders
//   GET /v1/admin/crypto-orders/:order_id
//
// Auth gate is `driftstack_internal_admin`. Coverage: scope rejection
// for a plain customer key, happy-path list (default + filtered),
// happy-path get + 404, and the contract that orders are returned
// newest-first.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type { CryptoOrder } from '../../src/services/crypto-orders.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface AdminOrdersListResponse {
  orders: Array<{
    order_id: string;
    account_id: string | null;
    product: string;
    status: string;
    created_at: string;
  }>;
}

interface AdminOrderGetResponse {
  order_id: string;
  account_id: string | null;
  product: string;
  status: string;
  payment_id: string | null;
}

async function seedOrders(
  fx: TestAppFixture,
  rows: Array<{
    order_id: string;
    account_id: string | null;
    product: string;
    createdOffsetMs?: number;
  }>,
): Promise<void> {
  const baseNow = Date.now();
  for (const row of rows) {
    const order: CryptoOrder = {
      order_id: row.order_id,
      account_id: row.account_id,
      product: row.product,
      price_cents: 299,
      price_currency: 'USD',
      payment_id: null,
      status: 'pending',
      created_at: baseNow + (row.createdOffsetMs ?? 0),
      updated_at: baseNow + (row.createdOffsetMs ?? 0),
    };
    await fx.cryptoOrdersRepo.upsert(order);
  }
}

describe('V-666.D GET /v1/admin/crypto-orders — auth + list', () => {
  it('403 for a customer key without the internal-admin scope', async () => {
    // 'admin' satisfies driftstack_internal_admin via V-174 alias —
    // so a customer-facing rejection test uses read/write only.
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('200 + ordered newest-first when called by an internal-admin key', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedOrders(fx, [
      {
        order_id: 'ord_old',
        account_id: fx.accountId,
        product: 'trial_pack',
        createdOffsetMs: -5000,
      },
      {
        order_id: 'ord_mid',
        account_id: fx.accountId,
        product: 'solo_manual',
        createdOffsetMs: -1000,
      },
      {
        order_id: 'ord_new',
        account_id: fx.accountId,
        product: 'solo_automated',
        createdOffsetMs: 0,
      },
    ]);
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminOrdersListResponse>();
    expect(body.orders.map((o) => o.order_id)).toEqual(['ord_new', 'ord_mid', 'ord_old']);
  });

  it('filters by account_id when supplied', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedOrders(fx, [
      { order_id: 'ord_a1', account_id: fx.accountId, product: 'trial_pack' },
      { order_id: 'ord_b1', account_id: 'acc_other', product: 'trial_pack' },
    ]);
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders?account_id=acc_other',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminOrdersListResponse>();
    expect(body.orders.map((o) => o.order_id)).toEqual(['ord_b1']);
  });

  it('400 on out-of-range limit', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders?limit=500',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('V-666.D GET /v1/admin/crypto-orders/:order_id', () => {
  it('200 returns the order envelope', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedOrders(fx, [
      { order_id: 'ord_one', account_id: fx.accountId, product: 'trial_pack' },
    ]);
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/ord_one',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminOrderGetResponse>();
    expect(body.order_id).toBe('ord_one');
    expect(body.product).toBe('trial_pack');
    expect(body.payment_id).toBeNull();
  });

  it('404 for an unknown order_id', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/ord_missing',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
