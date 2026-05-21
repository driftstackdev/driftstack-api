// V-666.N — integration tests for GET /v1/admin/crypto-orders/stats.
// V-666.W — extended with avg_time_to_paid_ms coverage.
// V-666.AE — extended with paid_revenue_by_product + paid_count_by_product.
// V-666.AP — extended with idempotency-metrics route coverage.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface StatsResponse {
  total: number;
  by_status: Record<string, number>;
  paid_revenue_cents: Record<string, number>;
  avg_time_to_paid_ms: number | null;
  paid_sample: number;
  paid_revenue_by_product: Record<string, Record<string, number>>;
  paid_count_by_product: Record<string, number>;
  truncated: boolean;
  scanned: number;
}

describe('V-666.N GET /v1/admin/crypto-orders/stats', () => {
  it('403 for a customer key without driftstack_internal_admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/stats',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('200 + zero counts when no orders exist yet', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/stats',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<StatsResponse>();
    expect(body.total).toBe(0);
    expect(body.by_status.pending).toBe(0);
    expect(body.by_status.paid).toBe(0);
    expect(body.paid_revenue_cents).toEqual({});
    expect(body.avg_time_to_paid_ms).toBeNull();
    expect(body.paid_sample).toBe(0);
    expect(body.paid_revenue_by_product).toEqual({});
    expect(body.paid_count_by_product).toEqual({});
  });

  it('counts orders per status + sums paid revenue per currency', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    // 2 pending, 1 paid (EUR), 1 paid (USD).
    await fx.cryptoOrdersService.create({
      order_id: 'ord_p1',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 100,
      price_currency: 'EUR',
    });
    await fx.cryptoOrdersService.create({
      order_id: 'ord_p2',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 100,
      price_currency: 'EUR',
    });
    await fx.cryptoOrdersService.create({
      order_id: 'ord_paid_eur',
      account_id: fx.accountId,
      product: 'team_manual',
      price_cents: 8000,
      price_currency: 'EUR',
    });
    await fx.cryptoOrdersService.applyIpnStatus({
      order_id: 'ord_paid_eur',
      payment_id: 'np_1',
      provider_status: 'finished',
    });
    await fx.cryptoOrdersService.create({
      order_id: 'ord_paid_usd',
      account_id: fx.accountId,
      product: 'api_starter',
      price_cents: 5000,
      price_currency: 'USD',
    });
    await fx.cryptoOrdersService.applyIpnStatus({
      order_id: 'ord_paid_usd',
      payment_id: 'np_2',
      provider_status: 'finished',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/stats',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<StatsResponse>();
    expect(body.total).toBe(4);
    expect(body.by_status.pending).toBe(2);
    expect(body.by_status.paid).toBe(2);
    expect(body.paid_revenue_cents).toEqual({ EUR: 8000, USD: 5000 });
    expect(body.truncated).toBe(false);
    // V-666.W — 2 paid orders in scope; avg_time_to_paid_ms is non-null
    // and paid_sample matches the paid-count above.
    expect(body.paid_sample).toBe(2);
    expect(body.avg_time_to_paid_ms).not.toBeNull();
  });

  it('paid_revenue_by_product + paid_count_by_product break down paid revenue per tier (V-666.AE)', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await fx.cryptoOrdersService.create({
      order_id: 'ord_tg_a',
      account_id: fx.accountId,
      product: 'team_growth',
      price_cents: 14900,
      price_currency: 'EUR',
    });
    await fx.cryptoOrdersService.applyIpnStatus({
      order_id: 'ord_tg_a',
      payment_id: 'np_tg_a',
      provider_status: 'finished',
    });
    await fx.cryptoOrdersService.create({
      order_id: 'ord_tg_b',
      account_id: fx.accountId,
      product: 'team_growth',
      price_cents: 16000,
      price_currency: 'USD',
    });
    await fx.cryptoOrdersService.applyIpnStatus({
      order_id: 'ord_tg_b',
      payment_id: 'np_tg_b',
      provider_status: 'finished',
    });
    await fx.cryptoOrdersService.create({
      order_id: 'ord_api',
      account_id: fx.accountId,
      product: 'api_starter',
      price_cents: 5000,
      price_currency: 'EUR',
    });
    await fx.cryptoOrdersService.applyIpnStatus({
      order_id: 'ord_api',
      payment_id: 'np_api',
      provider_status: 'finished',
    });
    // Pending order — must not contribute to the per-product totals.
    await fx.cryptoOrdersService.create({
      order_id: 'ord_pending',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/stats',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<StatsResponse>();
    expect(body.paid_revenue_by_product).toEqual({
      team_growth: { EUR: 14900, USD: 16000 },
      api_starter: { EUR: 5000 },
    });
    expect(body.paid_count_by_product).toEqual({
      team_growth: 2,
      api_starter: 1,
    });
  });
});

describe('V-666.AP GET /v1/admin/crypto-orders/idempotency-metrics', () => {
  it('403 without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/idempotency-metrics',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('zero counts on a fresh app', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/idempotency-metrics',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ replays: 0, first_writes: 0, body_mismatches: 0 });
  });

  it('reflects first-write + replay after checkout calls', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const headers = {
      authorization: `Bearer ${fx.plaintext}`,
      'idempotency-key': 'metrics-key',
    };
    const payload = { product: 'trial_pack', price_cents: 299, price_currency: 'USD' };
    // First call: first_writes += 1.
    await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers,
      payload,
    });
    // Second call (same key): replays += 1.
    await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers,
      payload,
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/idempotency-metrics',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.json()).toEqual({ replays: 1, first_writes: 1, body_mismatches: 0 });
  });

  it('V-666.AR increments body_mismatches when the replayed body differs', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const headers = {
      authorization: `Bearer ${fx.plaintext}`,
      'idempotency-key': 'reused-key',
    };
    await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers,
      payload: { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' },
    });
    // Same key, DIFFERENT PRODUCT — intent mismatch. (Prior version
    // used same product + different price_cents to trigger the
    // fingerprint mismatch, but V-666.SEC made the server ignore
    // client-supplied price_cents → fingerprint only diverges via
    // product slug now.)
    await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers,
      payload: { product: 'team_manual', price_cents: 24900, price_currency: 'USD' },
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/idempotency-metrics',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<{ replays: number; first_writes: number; body_mismatches: number }>();
    expect(body.replays).toBe(1);
    expect(body.first_writes).toBe(1);
    expect(body.body_mismatches).toBe(1);
  });
});
