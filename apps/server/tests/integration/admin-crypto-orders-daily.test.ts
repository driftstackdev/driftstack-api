// V-666.O — integration tests for GET /v1/admin/crypto-orders/daily.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type { CryptoOrder } from '../../src/services/crypto-orders.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface DailyResponse {
  days: number;
  rows: Array<{ date: string; status: string; count: number }>;
  truncated: boolean;
}

async function seedAt(
  fx: TestAppFixture,
  args: { order_id: string; createdAt: Date; status?: CryptoOrder['status'] },
): Promise<void> {
  const ts = args.createdAt.getTime();
  const order: CryptoOrder = {
    order_id: args.order_id,
    account_id: fx.accountId,
    product: 'solo_manual',
    price_cents: 100,
    price_currency: 'EUR',
    payment_id: null,
    status: args.status ?? 'pending',
    customer_note: null,
    internal_note: null,
    events: [{ status: args.status ?? 'pending', at: ts, source: 'create' }],
    created_at: ts,
    updated_at: ts,
  };
  await fx.cryptoOrdersRepo.upsert(order);
}

describe('V-666.O GET /v1/admin/crypto-orders/daily', () => {
  it('403 for a customer key without driftstack_internal_admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/daily',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('200 + empty rows when no orders exist (default 7 days)', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/daily',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<DailyResponse>();
    expect(body.days).toBe(7);
    expect(body.rows).toEqual([]);
  });

  it('groups orders by (date, status) within the days window', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    // 2 yesterday, 1 today, 1 outside window (10d old).
    await seedAt(fx, { order_id: 'y1', createdAt: new Date(now - oneDayMs) });
    await seedAt(fx, { order_id: 'y2', createdAt: new Date(now - oneDayMs), status: 'paid' });
    await seedAt(fx, { order_id: 't1', createdAt: new Date(now) });
    await seedAt(fx, { order_id: 'old', createdAt: new Date(now - 10 * oneDayMs) });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/daily',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<DailyResponse>();
    // Should NOT include the old order; should have 3 (date, status) buckets.
    expect(body.rows.length).toBe(3);
    const allDates = body.rows.map((r) => r.date);
    expect(allDates).not.toContain(new Date(now - 10 * oneDayMs).toISOString().slice(0, 10));
  });

  it('400 on out-of-range days param', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/daily?days=500',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
