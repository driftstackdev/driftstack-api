// V-666.G — integration tests for customer-facing crypto-orders routes.
//
//   GET /v1/billing/crypto-orders
//   GET /v1/billing/crypto-orders/:order_id
//
// Coverage: 401 without auth, list returns only caller's orders,
// single-id 404 on missing + on cross-account, happy path read-back.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface CryptoOrderResponse {
  order_id: string;
  product: string;
  price_cents: number;
  price_currency: string;
  payment_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ListResponse {
  orders: CryptoOrderResponse[];
}

describe('V-666.G GET /v1/billing/crypto-orders', () => {
  it('401 without auth', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/billing/crypto-orders' });
    expect(res.statusCode).toBe(401);
  });

  it('returns only the caller account orders, newest first', async () => {
    fx = await buildTestApp();
    // Seed: two orders for caller, one for a different account.
    await fx.cryptoOrdersService.create({
      order_id: 'ord_aaaaaaaaaaaa',
      account_id: fx.accountId,
      product: 'trial_pack',
      price_cents: 299,
      price_currency: 'USD',
    });
    await fx.cryptoOrdersService.create({
      order_id: 'ord_bbbbbbbbbbbb',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 1499,
      price_currency: 'USD',
    });
    await fx.cryptoOrdersService.create({
      order_id: 'ord_cccccccccccc',
      account_id: 'acc_someone_else',
      product: 'solo_manual',
      price_cents: 1499,
      price_currency: 'USD',
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    const ids = body.orders.map((o) => o.order_id);
    expect(ids).toContain('ord_aaaaaaaaaaaa');
    expect(ids).toContain('ord_bbbbbbbbbbbb');
    expect(ids).not.toContain('ord_cccccccccccc');
  });

  it('rejects limit > 100', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders?limit=500',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('V-666.G GET /v1/billing/crypto-orders/:order_id', () => {
  it('401 without auth', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_xyz',
    });
    expect(res.statusCode).toBe(401);
  });

  it('404 when the order does not exist', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_does_not_exist',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404 (not 403) for an order owned by a different account', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_other_owner',
      account_id: 'acc_someone_else',
      product: 'trial_pack',
      price_cents: 299,
      price_currency: 'USD',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_other_owner',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns the order on a same-account hit', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_owned',
      account_id: fx.accountId,
      product: 'trial_pack',
      price_cents: 299,
      price_currency: 'USD',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_owned',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CryptoOrderResponse>();
    expect(body.order_id).toBe('ord_owned');
    expect(body.product).toBe('trial_pack');
    expect(body.status).toBe('pending');
  });
});

describe('V-666.J POST /v1/billing/crypto-orders/:order_id/cancel', () => {
  it('401 without auth', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-orders/ord_x/cancel',
    });
    expect(res.statusCode).toBe(401);
  });

  it('404 when the order does not exist', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-orders/ord_missing/cancel',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404 (not 403) when the order belongs to another account', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_alien',
      account_id: 'acc_someone_else',
      product: 'trial_pack',
      price_cents: 299,
      price_currency: 'USD',
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-orders/ord_alien/cancel',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('200 + cancelled body when cancelling a pending order', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_cxl1',
      account_id: fx.accountId,
      product: 'trial_pack',
      price_cents: 299,
      price_currency: 'USD',
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-orders/ord_cxl1/cancel',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CryptoOrderResponse>();
    expect(body.status).toBe('cancelled');
  });

  it('409 when the order has already moved past pending', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_cxl2',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
    });
    await fx.cryptoOrdersService.applyIpnStatus({
      order_id: 'ord_cxl2',
      payment_id: 'np_seen',
      provider_status: 'confirming',
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-orders/ord_cxl2/cancel',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(409);
  });
});
