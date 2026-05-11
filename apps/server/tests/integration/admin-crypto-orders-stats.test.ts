// V-666.N — integration tests for GET /v1/admin/crypto-orders/stats.
// V-666.W — extended with avg_time_to_paid_ms coverage.

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
});
