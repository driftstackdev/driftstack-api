// V-666.AC — integration tests for GET /v1/admin/crypto-orders/pending-age.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type { CryptoOrder } from '../../src/services/crypto-orders.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface PendingAgeResponse {
  buckets: {
    under_1h: number;
    h1_to_6h: number;
    h6_to_24h: number;
    over_24h: number;
  };
  pending_value_cents: Record<string, number>;
  total: number;
  truncated: boolean;
  scanned: number;
}

const HOUR = 60 * 60 * 1_000;

async function seed(
  fx: TestAppFixture,
  rows: Array<{
    order_id: string;
    ageMs: number;
    currency?: string;
    status?: CryptoOrder['status'];
  }>,
): Promise<void> {
  const now = Date.now();
  for (const row of rows) {
    const ts = now - row.ageMs;
    await fx.cryptoOrdersRepo.upsert({
      order_id: row.order_id,
      account_id: fx.accountId,
      product: 'team_growth',
      price_cents: 14900,
      price_currency: row.currency ?? 'EUR',
      payment_id: null,
      pay_amount: null,
      pay_currency: null,
      status: row.status ?? 'pending',
      customer_note: null,
      internal_note: null,
      events: [{ status: row.status ?? 'pending', at: ts, source: 'create' }],
      created_at: ts,
      updated_at: ts,
    });
  }
}

describe('V-666.AC GET /v1/admin/crypto-orders/pending-age', () => {
  it('403 for a customer key without driftstack_internal_admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/pending-age',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('200 with all-zero buckets when no pending orders exist', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/pending-age',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<PendingAgeResponse>();
    expect(body.total).toBe(0);
    expect(body.buckets).toEqual({
      under_1h: 0,
      h1_to_6h: 0,
      h6_to_24h: 0,
      over_24h: 0,
    });
    expect(body.pending_value_cents).toEqual({});
  });

  it('buckets pending orders by age + sums pending value by currency', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seed(fx, [
      { order_id: 'p_fresh', ageMs: 30 * 60_000 },
      { order_id: 'p_mid', ageMs: 3 * HOUR },
      { order_id: 'p_old', ageMs: 12 * HOUR, currency: 'USD' },
      { order_id: 'p_stale', ageMs: 36 * HOUR },
      // a paid order should be excluded.
      { order_id: 'p_paid', ageMs: 30 * 60_000, status: 'paid' },
    ]);
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/pending-age',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<PendingAgeResponse>();
    expect(body.total).toBe(4);
    expect(body.buckets.under_1h).toBe(1);
    expect(body.buckets.h1_to_6h).toBe(1);
    expect(body.buckets.h6_to_24h).toBe(1);
    expect(body.buckets.over_24h).toBe(1);
    expect(body.pending_value_cents).toEqual({ EUR: 14900 * 3, USD: 14900 });
  });
});
