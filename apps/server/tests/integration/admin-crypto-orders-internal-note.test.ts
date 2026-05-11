// V-666.AA — integration tests for PATCH /v1/admin/crypto-orders/:id/internal-note.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface OrderResponse {
  order_id: string;
  status: string;
  customer_note: string | null;
  internal_note: string | null;
}

async function seedPending(orderId: string): Promise<void> {
  await fx.cryptoOrdersService.create({
    order_id: orderId,
    account_id: fx.accountId,
    product: 'team_growth',
    price_cents: 14900,
    price_currency: 'EUR',
  });
}

describe('V-666.AA PATCH /v1/admin/crypto-orders/:id/internal-note', () => {
  it('403 for a customer key without driftstack_internal_admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    await seedPending('ord_ia_403');
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/admin/crypto-orders/ord_ia_403/internal-note',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { internal_note: 'support note' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404 when the order does not exist', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/admin/crypto-orders/ord_missing/internal-note',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { internal_note: 'note' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('200 sets the internal_note + surfaces it in the response', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedPending('ord_ia_set');
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/admin/crypto-orders/ord_ia_set/internal-note',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { internal_note: 'VIP — manual outreach scheduled' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<OrderResponse>();
    expect(body.internal_note).toBe('VIP — manual outreach scheduled');
  });

  it('clears the note when payload is { internal_note: null }', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedPending('ord_ia_clear');
    await fx.cryptoOrdersService.setInternalNote({
      order_id: 'ord_ia_clear',
      internal_note: 'first take',
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/admin/crypto-orders/ord_ia_clear/internal-note',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { internal_note: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<OrderResponse>().internal_note).toBeNull();
  });

  it('empty-string also clears (normalised to null server-side)', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedPending('ord_ia_empty');
    await fx.cryptoOrdersService.setInternalNote({
      order_id: 'ord_ia_empty',
      internal_note: 'will be cleared',
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/admin/crypto-orders/ord_ia_empty/internal-note',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { internal_note: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<OrderResponse>().internal_note).toBeNull();
  });

  it('400 when the note exceeds 2000 chars', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedPending('ord_ia_long');
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/admin/crypto-orders/ord_ia_long/internal-note',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { internal_note: 'x'.repeat(2001) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('internal_note + customer_note are independent fields', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedPending('ord_ia_both');
    await fx.cryptoOrdersService.updateCustomerNote({
      order_id: 'ord_ia_both',
      account_id: fx.accountId,
      customer_note: 'PO-12345',
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/admin/crypto-orders/ord_ia_both/internal-note',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { internal_note: 'looks legit, expedite if needed' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<OrderResponse>();
    expect(body.customer_note).toBe('PO-12345');
    expect(body.internal_note).toBe('looks legit, expedite if needed');
  });
});
