// V-666.L — integration tests for POST /v1/admin/crypto-orders/sweep-expired.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type { CryptoOrder } from '../../src/services/crypto-orders.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface SweepResponse {
  expired: number;
  capped: boolean;
  older_than_hours: number;
}

async function seedStale(
  fx: TestAppFixture,
  count: number,
  opts: { hoursAgo?: number; status?: CryptoOrder['status'] } = {},
): Promise<void> {
  const hoursAgo = opts.hoursAgo ?? 26; // > 24h cutoff by default
  const now = Date.now();
  const offset = hoursAgo * 60 * 60 * 1000;
  for (let i = 0; i < count; i += 1) {
    const ts = now - offset;
    const order: CryptoOrder = {
      order_id: `ord_stale_${i.toString()}`,
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
      payment_id: null,
      pay_amount: null,
      pay_currency: null,
      status: opts.status ?? 'pending',
      customer_note: null,
      internal_note: null,
      events: [{ status: opts.status ?? 'pending', at: ts, source: 'create' }],
      created_at: ts,
      updated_at: ts,
    };
    await fx.cryptoOrdersRepo.upsert(order);
  }
}

describe('V-666.L POST /v1/admin/crypto-orders/sweep-expired', () => {
  it('403 for a key without driftstack_internal_admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/sweep-expired',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('expires stale pending orders + reports the count', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedStale(fx, 3);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/sweep-expired',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SweepResponse>();
    expect(body.expired).toBe(3);
    expect(body.capped).toBe(false);
    expect(body.older_than_hours).toBe(24);
  });

  it('honours an explicit limit + flags capped=true when hit', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedStale(fx, 5);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/sweep-expired',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { limit: 2 },
    });
    const body = res.json<SweepResponse>();
    expect(body.expired).toBe(2);
    expect(body.capped).toBe(true);
  });

  it('honours older_than_hours override — skips fresher orders', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedStale(fx, 2, { hoursAgo: 5 }); // only 5h old
    // Default 24h cutoff would skip these.
    const noopRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/sweep-expired',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(noopRes.json<SweepResponse>().expired).toBe(0);
    // With a 1h cutoff they're now eligible.
    const sweepRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/sweep-expired',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { older_than_hours: 1 },
    });
    expect(sweepRes.json<SweepResponse>().expired).toBe(2);
  });

  it('ignores non-pending orders (already terminal/confirming/etc.)', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedStale(fx, 2, { status: 'confirming' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/sweep-expired',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.json<SweepResponse>().expired).toBe(0);
  });

  it('400 on a non-integer limit', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/sweep-expired',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { limit: 1.5 },
    });
    expect(res.statusCode).toBe(400);
  });
});
