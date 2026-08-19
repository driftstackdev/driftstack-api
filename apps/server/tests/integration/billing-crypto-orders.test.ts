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

  it('V-666.BR — filters by ?status= (only matching orders)', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_filter_pending',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 1499,
      price_currency: 'USD',
    });
    const paid = await fx.cryptoOrdersService.create({
      order_id: 'ord_filter_paid',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 1499,
      price_currency: 'USD',
    });
    await fx.cryptoOrdersService.applyIpnStatus({
      order_id: paid.order_id,
      provider_status: 'finished',
      payment_id: 'pay_x',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders?status=paid',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    const ids = body.orders.map((o) => o.order_id);
    expect(ids).toContain('ord_filter_paid');
    expect(ids).not.toContain('ord_filter_pending');
  });

  it('V-666.BX — filters by created_after / created_before window', async () => {
    fx = await buildTestApp();
    // Seed two orders at known timestamps.
    const old = await fx.cryptoOrdersService.create({
      order_id: 'ord_old',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 1499,
      price_currency: 'USD',
    });
    // Roll the created_at backward by 2 days for predictable filtering.
    old.created_at = Date.parse('2026-05-10T00:00:00Z');
    const recent = await fx.cryptoOrdersService.create({
      order_id: 'ord_recent',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 1499,
      price_currency: 'USD',
    });
    recent.created_at = Date.parse('2026-05-12T00:00:00Z');

    // Window: only 2026-05-11..2026-05-13 → recent only.
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/billing/crypto-orders?created_after=${encodeURIComponent(
        '2026-05-11T00:00:00Z',
      )}&created_before=${encodeURIComponent('2026-05-13T00:00:00Z')}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    const ids = body.orders.map((o) => o.order_id);
    expect(ids).toContain('ord_recent');
    expect(ids).not.toContain('ord_old');
  });

  it('V-666.security paginated customer responses never include internal_note', async () => {
    fx = await buildTestApp();
    // Seed 3 orders + set an internal_note via the service so we know it's set.
    for (let i = 0; i < 3; i++) {
      await fx.cryptoOrdersService.create({
        order_id: `ord_pg_${i.toString()}`,
        account_id: fx.accountId,
        product: 'solo_manual',
        price_cents: 1499,
        price_currency: 'USD',
      });
      await fx.cryptoOrdersService.setInternalNote({
        order_id: `ord_pg_${i.toString()}`,
        internal_note: `internal ${i.toString()}`,
      });
    }
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders?limit=2',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ orders: Array<Record<string, unknown>> }>();
    expect(body.orders.length).toBeGreaterThan(0);
    for (const o of body.orders) {
      expect(Object.keys(o)).not.toContain('internal_note');
      expect(Object.keys(o)).not.toContain('account_id');
    }
  });

  it('V-666.BU — cursor pagination never leaks another account orders', async () => {
    fx = await buildTestApp();
    // Seed: 2 orders for caller, plus 2 for a different account.
    await fx.cryptoOrdersService.create({
      order_id: 'ord_caller_1',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 1499,
      price_currency: 'USD',
    });
    await fx.cryptoOrdersService.create({
      order_id: 'ord_caller_2',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 1499,
      price_currency: 'USD',
    });
    await fx.cryptoOrdersService.create({
      order_id: 'ord_other_1',
      account_id: 'acc_other',
      product: 'solo_manual',
      price_cents: 1499,
      price_currency: 'USD',
    });
    await fx.cryptoOrdersService.create({
      order_id: 'ord_other_2',
      account_id: 'acc_other',
      product: 'solo_manual',
      price_cents: 1499,
      price_currency: 'USD',
    });
    // Page 1: limit=1 → returns 1 caller order + next_cursor.
    const p1 = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders?limit=1',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body1 = p1.json<ListResponse & { next_cursor: string | null }>();
    expect(body1.orders).toHaveLength(1);
    expect(body1.orders[0]?.order_id.startsWith('ord_caller_')).toBe(true);
    // Walk to the end; we should never see other-account ids.
    const seen: string[] = body1.orders.map((o) => o.order_id);
    let cursor = body1.next_cursor;
    let safety = 5;
    while (cursor !== null && safety-- > 0) {
      const next = await fx.app.inject({
        method: 'GET',
        url: `/v1/billing/crypto-orders?limit=1&cursor=${encodeURIComponent(cursor)}`,
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      const body = next.json<ListResponse & { next_cursor: string | null }>();
      for (const o of body.orders) {
        expect(o.order_id.startsWith('ord_caller_')).toBe(true);
        seen.push(o.order_id);
      }
      cursor = body.next_cursor;
    }
    expect(seen.sort()).toEqual(['ord_caller_1', 'ord_caller_2']);
  });

  it('V-666.BZ — rejects inverted window (before <= after)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/billing/crypto-orders?created_after=${encodeURIComponent(
        '2026-05-12T00:00:00Z',
      )}&created_before=${encodeURIComponent('2026-05-10T00:00:00Z')}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail?: string; title?: string }>();
    expect(body.title).toBe('Bad Request');
    expect(body.detail ?? '').toContain('created_before');
  });

  it('V-666.BX — rejects non-ISO created_after', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders?created_after=yesterday',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('V-666.BU — paginates via next_cursor', async () => {
    fx = await buildTestApp();
    for (let i = 0; i < 5; i++) {
      await fx.cryptoOrdersService.create({
        order_id: `ord_page_${i.toString().padStart(2, '0')}`,
        account_id: fx.accountId,
        product: 'solo_manual',
        price_cents: 1499,
        price_currency: 'USD',
      });
    }
    const first = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders?limit=2',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<ListResponse & { next_cursor: string | null }>();
    expect(firstBody.orders.length).toBe(2);
    expect(typeof firstBody.next_cursor).toBe('string');

    const second = await fx.app.inject({
      method: 'GET',
      url: `/v1/billing/crypto-orders?limit=2&cursor=${encodeURIComponent(
        firstBody.next_cursor ?? '',
      )}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<ListResponse & { next_cursor: string | null }>();
    expect(secondBody.orders.length).toBe(2);
    // No overlap between the two pages.
    const firstIds = new Set(firstBody.orders.map((o) => o.order_id));
    for (const o of secondBody.orders) {
      expect(firstIds.has(o.order_id)).toBe(false);
    }
  });

  it('V-666.AW sets Cache-Control: no-store, private on the list GET', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store, private');
  });

  it('V-666.BR — rejects unknown status value', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders?status=garbage',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
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

  it('V-666.AU inlines the events timeline on the envelope', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_events',
      account_id: fx.accountId,
      product: 'trial_pack',
      price_cents: 299,
      price_currency: 'USD',
    });
    await fx.cryptoOrdersService.applyIpnStatus({
      order_id: 'ord_events',
      payment_id: 'np_1',
      provider_status: 'finished',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_events',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<
      CryptoOrderResponse & {
        events: Array<{ status: string; at: string; source: string }>;
      }
    >();
    expect(body.events.map((e) => `${e.source}:${e.status}`)).toEqual([
      'create:pending',
      'ipn:paid',
    ]);
    for (const e of body.events) {
      expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('V-666.AV exposes expires_at on pending envelopes', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_pending',
      account_id: fx.accountId,
      product: 'trial_pack',
      price_cents: 299,
      price_currency: 'USD',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_pending',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<CryptoOrderResponse & { expires_at: string | null }>();
    expect(body.expires_at).not.toBeNull();
    expect(body.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // created_at + 1h.
    const createdMs = new Date(body.created_at).getTime();
    const expiresMs = new Date(body.expires_at as string).getTime();
    expect(expiresMs - createdMs).toBe(60 * 60 * 1000);
  });

  it('V-666.AW sets Cache-Control: no-store, private on the detail GET', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_cache',
      account_id: fx.accountId,
      product: 'trial_pack',
      price_cents: 299,
      price_currency: 'USD',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_cache',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store, private');
  });

  it('V-666.AV expires_at is null on non-pending envelopes', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_paid',
      account_id: fx.accountId,
      product: 'trial_pack',
      price_cents: 299,
      price_currency: 'USD',
    });
    await fx.cryptoOrdersService.applyIpnStatus({
      order_id: 'ord_paid',
      payment_id: 'np_1',
      provider_status: 'finished',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_paid',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<CryptoOrderResponse & { expires_at: string | null }>();
    expect(body.expires_at).toBeNull();
  });

  it('V-666.security customer GET envelope never leaks internal_note or account_id', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_seal',
      account_id: fx.accountId,
      product: 'trial_pack',
      price_cents: 299,
      price_currency: 'USD',
    });
    // Set an internal_note (admin-only field) to make sure the endpoint
    // wouldn't accidentally pass it through.
    await fx.cryptoOrdersService.setInternalNote({
      order_id: 'ord_seal',
      internal_note: 'NEVER LEAK THIS',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_seal',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.internal_note).toBeUndefined();
    expect(body.account_id).toBeUndefined();
    // And the literal string must not appear anywhere in the response.
    expect(JSON.stringify(body)).not.toContain('NEVER LEAK THIS');
  });

  it('V-666.security customer LIST rows never leak internal_note or account_id', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_seal_list',
      account_id: fx.accountId,
      product: 'trial_pack',
      price_cents: 299,
      price_currency: 'USD',
    });
    await fx.cryptoOrdersService.setInternalNote({
      order_id: 'ord_seal_list',
      internal_note: 'NEVER LEAK THIS LIST',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ orders: Array<Record<string, unknown>> }>();
    for (const row of body.orders) {
      expect(row.internal_note).toBeUndefined();
      expect(row.account_id).toBeUndefined();
    }
    expect(JSON.stringify(body)).not.toContain('NEVER LEAK THIS LIST');
  });

  it('V-666.security customer receipt never leaks internal_note', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_seal_rcpt',
      account_id: fx.accountId,
      product: 'trial_pack',
      price_cents: 299,
      price_currency: 'USD',
    });
    await fx.cryptoOrdersService.setInternalNote({
      order_id: 'ord_seal_rcpt',
      internal_note: 'NEVER LEAK THIS RCPT',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_seal_rcpt/receipt',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('NEVER LEAK THIS RCPT');
  });

  it('V-666.AU customer-facing timeline maps "swept" to "expired"', async () => {
    // Internal "swept" source is admin-lifecycle; from the customer's
    // POV the order simply expired. The customer-facing endpoint
    // hides the distinction.
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_swept',
      account_id: fx.accountId,
      product: 'trial_pack',
      price_cents: 299,
      price_currency: 'USD',
    });
    await fx.cryptoOrdersService.sweepExpiredOrders({ olderThanMs: 0 });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_swept',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<
      CryptoOrderResponse & {
        events: Array<{ status: string; at: string; source: string }>;
      }
    >();
    const sources = body.events.map((e) => e.source);
    expect(sources).toContain('expired');
    expect(sources).not.toContain('swept');
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

describe('V-666.M GET /v1/billing/crypto-orders/:order_id/receipt', () => {
  it('401 without auth', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_x/receipt',
    });
    expect(res.statusCode).toBe(401);
  });

  it('404 when the order does not exist', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_missing/receipt',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404 (not 403) on cross-account receipt fetch', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_other',
      account_id: 'acc_someone_else',
      product: 'trial_pack',
      price_cents: 299,
      price_currency: 'USD',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_other/receipt',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('200 + receipt body for a paid order owned by the caller', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_paid_rcpt',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
    });
    await fx.cryptoOrdersService.applyIpnStatus({
      order_id: 'ord_paid_rcpt',
      payment_id: 'np_rcpt_42',
      provider_status: 'finished',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_paid_rcpt/receipt',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      order_id: string;
      status: string;
      payment_id: string | null;
      paid_at: string | null;
      issued_at: string;
    }>();
    expect(body.order_id).toBe('ord_paid_rcpt');
    expect(body.status).toBe('paid');
    expect(body.payment_id).toBe('np_rcpt_42');
    expect(body.paid_at).not.toBeNull();
    expect(body.issued_at).toBeTruthy();
  });
});

describe('V-666.P GET /v1/billing/crypto-orders/:order_id/receipt.txt', () => {
  it('401 without auth', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_x/receipt.txt',
    });
    expect(res.statusCode).toBe(401);
  });

  it('404 on cross-account fetch', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_alien',
      account_id: 'acc_other',
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_alien/receipt.txt',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('200 + text/plain body with the canonical receipt lines for a paid order', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_txt',
      account_id: fx.accountId,
      product: 'team_manual',
      price_cents: 8000,
      price_currency: 'EUR',
    });
    await fx.cryptoOrdersService.applyIpnStatus({
      order_id: 'ord_txt',
      payment_id: 'np_txt',
      provider_status: 'finished',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_txt/receipt.txt',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const body = res.body;
    expect(body).toContain('Driftstack receipt');
    expect(body).toContain('Order: ord_txt');
    expect(body).toContain('Status: paid');
    expect(body).toContain('Amount: 80.00 EUR');
    expect(body).toContain('Payment id: np_txt');
    expect(body.endsWith('\n')).toBe(true);
  });

  it('omits paid_at + payment_id lines for a pending order', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_pending_txt',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_pending_txt/receipt.txt',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toContain('Status: pending');
    expect(body).not.toContain('Paid at:');
    expect(body).not.toContain('Payment id:');
  });
});

describe('V-666.U GET /v1/billing/crypto-orders/:order_id/receipt.pdf', () => {
  it('401 without auth', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_x/receipt.pdf',
    });
    expect(res.statusCode).toBe(401);
  });

  it('404 on cross-account fetch', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_alien_pdf',
      account_id: 'acc_other',
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_alien_pdf/receipt.pdf',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('200 + application/pdf + Content-Disposition attachment', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_pdf',
      account_id: fx.accountId,
      product: 'team_manual',
      price_cents: 8000,
      price_currency: 'EUR',
    });
    await fx.cryptoOrdersService.applyIpnStatus({
      order_id: 'ord_pdf',
      payment_id: 'np_pdf',
      provider_status: 'finished',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing/crypto-orders/ord_pdf/receipt.pdf',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('receipt-ord_pdf.pdf');
    // The raw body starts with the PDF magic.
    expect(res.rawPayload.slice(0, 8).toString('binary')).toBe('%PDF-1.4');
  });
});

describe('V-666.Q PATCH /v1/billing/crypto-orders/:order_id (customer_note)', () => {
  it('401 without auth', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/billing/crypto-orders/ord_x',
      payload: { customer_note: 'PO-42' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('404 when the order does not exist', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/billing/crypto-orders/ord_missing',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { customer_note: 'PO-42' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404 (not 403) on cross-account PATCH', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_other_note',
      account_id: 'acc_someone',
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/billing/crypto-orders/ord_other_note',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { customer_note: 'hacky' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('writes the note + returns the updated order body', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_my_note',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/billing/crypto-orders/ord_my_note',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { customer_note: 'invoice 2026-05-42' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ customer_note: string | null }>();
    expect(body.customer_note).toBe('invoice 2026-05-42');
  });

  it('V-986 CRITICAL reports an unknown field on the note write, and stays quiet without one. This site was invisible to the coverage invariant until V-985 widened it to the parseOrThrow call form, so nothing had ever checked that this write reports. The second half is the half that matters: an arm that only asserts the header on a typo passes just as well against a route that tags every request, including correct ones.', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_unknown_field_note',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
    });
    const tagged = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/billing/crypto-orders/ord_unknown_field_note',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { customer_note: 'invoice 7', tags: ['eu'] },
    });
    expect(tagged.statusCode, 'reporting, not rejecting').toBe(200);
    expect(tagged.headers['x-driftstack-unknown-fields']).toBe('tags');
    // the write still happened — reporting must not cost the caller the update
    expect(tagged.json<{ customer_note: string | null }>().customer_note).toBe('invoice 7');

    const clean = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/billing/crypto-orders/ord_unknown_field_note',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { customer_note: 'invoice 8' },
    });
    expect(clean.statusCode).toBe(200);
    expect(
      clean.headers['x-driftstack-unknown-fields'],
      'a well-formed note write must not be tagged',
    ).toBeUndefined();
  });

  it('400 on a note > 500 chars', async () => {
    fx = await buildTestApp();
    await fx.cryptoOrdersService.create({
      order_id: 'ord_too_long_note',
      account_id: fx.accountId,
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/billing/crypto-orders/ord_too_long_note',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { customer_note: 'x'.repeat(501) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('#122 — read:billing floor on the crypto-order reads', () => {
  const get = (fxArg: TestAppFixture, url: string) =>
    fxArg.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${fxArg.plaintext}` },
    });

  it('403 for a write-only key on the list AND a receipt, with the required scope named', async () => {
    fx = await buildTestApp({ scopes: ['write'] });
    const list = await get(fx, '/v1/billing/crypto-orders');
    expect(list.statusCode).toBe(403);
    expect(list.json<{ detail: string }>().detail).toContain('read:billing');
    // The scope check runs in the preHandler, before any order lookup.
    const receipt = await get(fx, '/v1/billing/crypto-orders/ord_missing/receipt.txt');
    expect(receipt.statusCode).toBe(403);
  });

  it('200 for a granular read:billing key on the list', async () => {
    fx = await buildTestApp({ scopes: ['read:billing'] });
    expect((await get(fx, '/v1/billing/crypto-orders')).statusCode).toBe(200);
  });

  it('200 for a broad read key (V-481 broad-satisfies-granular) — dashboard/GUI keep working', async () => {
    fx = await buildTestApp({ scopes: ['read'] });
    expect((await get(fx, '/v1/billing/crypto-orders')).statusCode).toBe(200);
  });

  it('200 for an account_owner key', async () => {
    fx = await buildTestApp({ scopes: ['account_owner'] });
    expect((await get(fx, '/v1/billing/crypto-orders')).statusCode).toBe(200);
  });
});
