// V-666.D — integration tests for the admin crypto-orders routes.
// V-666.T — extended with status + search query-param coverage.
// V-666.V — extended with CSV export coverage.
// V-666.AM — extended with cursor-pagination coverage.
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
  next_cursor?: string | null;
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
    status?: CryptoOrder['status'];
    customer_note?: string | null;
  }>,
): Promise<void> {
  const baseNow = Date.now();
  for (const row of rows) {
    const ts = baseNow + (row.createdOffsetMs ?? 0);
    const order: CryptoOrder = {
      order_id: row.order_id,
      account_id: row.account_id,
      product: row.product,
      price_cents: 299,
      price_currency: 'USD',
      payment_id: null,
      pay_amount: null,
      pay_currency: null,
      status: row.status ?? 'pending',
      customer_note: row.customer_note ?? null,
      internal_note: null,
      events: [{ status: row.status ?? 'pending', at: ts, source: 'create' }],
      created_at: ts,
      updated_at: ts,
    };
    await fx.cryptoOrdersRepo.upsert(order);
  }
}

describe('V-666.D GET /v1/admin/crypto-orders — auth + list', () => {
  it('403 for a legacy customer-admin key without exact internal staff authority', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write', 'admin'] });
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

describe('V-666.T GET /v1/admin/crypto-orders — status + search filters', () => {
  async function seedMixed(): Promise<void> {
    await seedOrders(fx, [
      {
        order_id: 'ord_paid',
        account_id: fx.accountId,
        product: 'team_growth',
        status: 'paid',
        createdOffsetMs: -3000,
      },
      {
        order_id: 'ord_pending',
        account_id: fx.accountId,
        product: 'solo_manual',
        status: 'pending',
        createdOffsetMs: -2000,
      },
      {
        order_id: 'ord_noted',
        account_id: fx.accountId,
        product: 'team_growth',
        status: 'pending',
        customer_note: 'PO-99 quarterly',
        createdOffsetMs: -1000,
      },
    ]);
  }

  it('filters by status=paid', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedMixed();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders?status=paid',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminOrdersListResponse>();
    expect(body.orders.map((o) => o.order_id)).toEqual(['ord_paid']);
  });

  it('400 on unknown status enum value', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders?status=hovering',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('searches order_id substring', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedMixed();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders?search=noted',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminOrdersListResponse>();
    expect(body.orders.map((o) => o.order_id)).toEqual(['ord_noted']);
  });

  it('searches customer_note substring', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedMixed();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders?search=PO-99',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminOrdersListResponse>();
    expect(body.orders.map((o) => o.order_id)).toEqual(['ord_noted']);
  });

  it('combines status + search (AND)', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedMixed();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders?status=pending&search=team_growth',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminOrdersListResponse>();
    expect(body.orders.map((o) => o.order_id)).toEqual(['ord_noted']);
  });
});

describe('V-666.AM GET /v1/admin/crypto-orders — cursor pagination', () => {
  async function seedSeq(count: number): Promise<void> {
    const rows: Array<Parameters<typeof seedOrders>[1][number]> = [];
    for (let i = 0; i < count; i += 1) {
      rows.push({
        order_id: `ord_p${i.toString().padStart(2, '0')}`,
        account_id: fx.accountId,
        product: 'team_growth',
        createdOffsetMs: -1000 * (count - i),
      });
    }
    await seedOrders(fx, rows);
  }

  it('returns next_cursor on the first page when more rows exist', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedSeq(8);
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders?limit=3',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminOrdersListResponse>();
    expect(body.orders).toHaveLength(3);
    expect(body.next_cursor).toBeTruthy();
  });

  it('next_cursor is null on the terminal page', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedSeq(2);
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders?limit=5',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<AdminOrdersListResponse>();
    expect(body.orders).toHaveLength(2);
    expect(body.next_cursor).toBeNull();
  });

  it('walks pages via cursor without duplicates or gaps', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedSeq(7);
    const collected: string[] = [];
    let cursor: string | null | undefined = undefined;
    let safety = 5;
    while (safety > 0) {
      safety -= 1;
      const url =
        cursor != null
          ? `/v1/admin/crypto-orders?limit=3&cursor=${encodeURIComponent(cursor)}`
          : '/v1/admin/crypto-orders?limit=3';
      const res = await fx.app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      const body: AdminOrdersListResponse = res.json();
      collected.push(...body.orders.map((o) => o.order_id));
      cursor = body.next_cursor ?? null;
      if (cursor === null) break;
    }
    expect(collected).toHaveLength(7);
    // No duplicates.
    expect(new Set(collected).size).toBe(7);
    // Walking newest-first, so the last collected id is the oldest seed.
    expect(collected[collected.length - 1]).toBe('ord_p00');
  });

  it('cursor combines with status filter', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedOrders(fx, [
      {
        order_id: 'p_pa',
        account_id: fx.accountId,
        product: 'p',
        status: 'paid',
        createdOffsetMs: -5000,
      },
      {
        order_id: 'p_pb',
        account_id: fx.accountId,
        product: 'p',
        status: 'paid',
        createdOffsetMs: -4000,
      },
      {
        order_id: 'p_pen',
        account_id: fx.accountId,
        product: 'p',
        status: 'pending',
        createdOffsetMs: -3000,
      },
      {
        order_id: 'p_pc',
        account_id: fx.accountId,
        product: 'p',
        status: 'paid',
        createdOffsetMs: -2000,
      },
      {
        order_id: 'p_pd',
        account_id: fx.accountId,
        product: 'p',
        status: 'paid',
        createdOffsetMs: -1000,
      },
    ]);
    const first = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders?status=paid&limit=2',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const p1 = first.json<AdminOrdersListResponse>();
    expect(p1.orders.map((o) => o.order_id)).toEqual(['p_pd', 'p_pc']);
    expect(p1.next_cursor).toBeTruthy();
    const next = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/crypto-orders?status=paid&limit=2&cursor=${encodeURIComponent(p1.next_cursor as string)}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const p2 = next.json<AdminOrdersListResponse>();
    // p_pen is pending → skipped. The next paid pair is p_pb, p_pa.
    expect(p2.orders.map((o) => o.order_id)).toEqual(['p_pb', 'p_pa']);
    expect(p2.next_cursor).toBeNull();
  });

  it('400 on a cursor longer than the route ceiling', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const huge = 'x'.repeat(600);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/crypto-orders?cursor=${huge}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('cursor combines with search filter across multiple pages', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    // Mix in three matching + two non-matching rows; the search
    // term hits product=team_growth.
    await seedOrders(fx, [
      { order_id: 'g_a', account_id: fx.accountId, product: 'team_growth', createdOffsetMs: -5000 },
      { order_id: 'g_b', account_id: fx.accountId, product: 'team_growth', createdOffsetMs: -4000 },
      { order_id: 'g_c', account_id: fx.accountId, product: 'solo_manual', createdOffsetMs: -3000 },
      { order_id: 'g_d', account_id: fx.accountId, product: 'team_growth', createdOffsetMs: -2000 },
      { order_id: 'g_e', account_id: fx.accountId, product: 'solo_manual', createdOffsetMs: -1000 },
    ]);
    const first = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders?search=team_growth&limit=2',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const p1 = first.json<AdminOrdersListResponse>();
    expect(p1.orders.map((o) => o.order_id)).toEqual(['g_d', 'g_b']);
    expect(p1.next_cursor).toBeTruthy();
    const second = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/crypto-orders?search=team_growth&limit=2&cursor=${encodeURIComponent(
        p1.next_cursor as string,
      )}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const p2 = second.json<AdminOrdersListResponse>();
    expect(p2.orders.map((o) => o.order_id)).toEqual(['g_a']);
    expect(p2.next_cursor).toBeNull();
  });

  it('cursor combines with account_id filter, isolating across accounts', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    // Two accounts with overlapping created_at offsets. The cursor
    // walk over account A must never see B's rows even when the
    // tiebreaker order_id collides timing-wise.
    await seedOrders(fx, [
      { order_id: 'a_one', account_id: fx.accountId, product: 'p', createdOffsetMs: -5000 },
      { order_id: 'b_one', account_id: 'acc_other', product: 'p', createdOffsetMs: -4500 },
      { order_id: 'a_two', account_id: fx.accountId, product: 'p', createdOffsetMs: -4000 },
      { order_id: 'b_two', account_id: 'acc_other', product: 'p', createdOffsetMs: -3500 },
      { order_id: 'a_three', account_id: fx.accountId, product: 'p', createdOffsetMs: -3000 },
    ]);
    const first = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/crypto-orders?account_id=${fx.accountId}&limit=2`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const p1 = first.json<AdminOrdersListResponse>();
    expect(p1.orders.map((o) => o.order_id)).toEqual(['a_three', 'a_two']);
    expect(p1.next_cursor).toBeTruthy();
    const second = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/crypto-orders?account_id=${fx.accountId}&limit=2&cursor=${encodeURIComponent(
        p1.next_cursor as string,
      )}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const p2 = second.json<AdminOrdersListResponse>();
    expect(p2.orders.map((o) => o.order_id)).toEqual(['a_one']);
    expect(p2.next_cursor).toBeNull();
  });

  it('V-666.BE sets Cache-Control: no-store, private on admin GET', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store, private');
  });

  it('V-666.AT returns the order events timeline', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedOrders(fx, [{ order_id: 'ord_events', account_id: fx.accountId, product: 'p' }]);
    await fx.cryptoOrdersService.applyIpnStatus({
      order_id: 'ord_events',
      payment_id: 'np_1',
      provider_status: 'finished',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/ord_events/events',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      events: Array<{ status: string; at: string; source: string }>;
    }>();
    expect(body.events.map((e) => `${e.source}:${e.status}`)).toEqual([
      'create:pending',
      'ipn:paid',
    ]);
    // at is an ISO-8601 string.
    for (const e of body.events) {
      expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('V-666.AT returns 404 for an unknown order id', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/ord_nope/events',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('V-666.AT 403 for a non-admin key', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders/ord_anything/events',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('V-666.AS exact-match payment_id filter narrows to one order', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedOrders(fx, [
      { order_id: 'ord_p1', account_id: fx.accountId, product: 'p', createdOffsetMs: -3000 },
      { order_id: 'ord_p2', account_id: fx.accountId, product: 'p', createdOffsetMs: -2000 },
      { order_id: 'ord_p3', account_id: fx.accountId, product: 'p', createdOffsetMs: -1000 },
    ]);
    // Manually attach a payment_id to ord_p2 only.
    await fx.cryptoOrdersService.applyIpnStatus({
      order_id: 'ord_p2',
      payment_id: 'np_target',
      provider_status: 'finished',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders?payment_id=np_target',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminOrdersListResponse>();
    expect(body.orders.map((o) => o.order_id)).toEqual(['ord_p2']);
    expect(body.next_cursor).toBeNull();
  });

  it('V-666.AS payment_id over the ceiling returns 400', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const oversize = 'x'.repeat(200);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/crypto-orders?payment_id=${oversize}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('malformed cursor returns empty page with next_cursor null', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedSeq(3);
    // Random non-base64-json string that fits under the size cap.
    const malformed = 'not-a-valid-cursor';
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/crypto-orders?cursor=${malformed}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminOrdersListResponse>();
    expect(body.orders).toHaveLength(0);
    expect(body.next_cursor).toBeNull();
  });
});

describe('V-666.V GET /v1/admin/crypto-orders.csv', () => {
  it('403 for a customer key without internal-admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders.csv',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('200 text/csv with header row and one row per order, newest-first', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedOrders(fx, [
      {
        order_id: 'ord_csv_a',
        account_id: fx.accountId,
        product: 'solo_manual',
        createdOffsetMs: -2000,
      },
      {
        order_id: 'ord_csv_b',
        account_id: fx.accountId,
        product: 'team_growth',
        createdOffsetMs: -1000,
        customer_note: 'note,with,commas',
      },
    ]);
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders.csv',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('crypto-orders.csv');
    const lines = res.body.split('\r\n');
    expect(lines[0]).toBe(
      'order_id,account_id,product,price_cents,price_currency,status,payment_id,customer_note,internal_note,created_at,updated_at',
    );
    expect(lines[1]?.startsWith('ord_csv_b,')).toBe(true);
    expect(lines[2]?.startsWith('ord_csv_a,')).toBe(true);
    // The comma-laden customer_note got quoted properly.
    expect(lines[1]).toContain('"note,with,commas"');
  });

  it('applies status filter (V-666.T compatibility)', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seedOrders(fx, [
      {
        order_id: 'ord_csv_paid',
        account_id: fx.accountId,
        product: 'solo_manual',
        status: 'paid',
      },
      {
        order_id: 'ord_csv_pending',
        account_id: fx.accountId,
        product: 'solo_manual',
        status: 'pending',
      },
    ]);
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders.csv?status=paid',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const lines = res.body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2); // header + 1 row
    expect(lines[1]?.startsWith('ord_csv_paid,')).toBe(true);
  });

  it('400 on out-of-range limit (raised ceiling 1000)', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/crypto-orders.csv?limit=2000',
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
