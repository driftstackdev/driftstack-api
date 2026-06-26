// V-666.BB — CryptoOrdersResource unit tests.

import { describe, expect, it, vi } from 'vitest';
import { CryptoOrdersResource } from '../../src/resources/crypto-orders.js';
import type { HttpClient } from '../../src/http.js';

interface RequestOpts {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
}

function harness(): {
  http: HttpClient;
  calls: RequestOpts[];
  setResponse: (response: unknown) => void;
} {
  const calls: RequestOpts[] = [];
  let nextResponse: unknown = {};
  const request = vi.fn((opts: RequestOpts) => {
    calls.push(opts);
    return Promise.resolve(nextResponse);
  });
  return {
    http: { request } as unknown as HttpClient,
    calls,
    setResponse: (r) => {
      nextResponse = r;
    },
  };
}

describe('CryptoOrdersResource', () => {
  it('quote POSTs /v1/billing/crypto-checkout/quote with body', async () => {
    const h = harness();
    h.setResponse({ product: 'solo_manual', price_cents: 2500 });
    const r = new CryptoOrdersResource(h.http);
    await r.quote({ product: 'solo_manual' });
    expect(h.calls[0]?.method).toBe('POST');
    expect(h.calls[0]?.path).toBe('/v1/billing/crypto-checkout/quote');
    expect(h.calls[0]?.body).toEqual({ product: 'solo_manual' });
  });

  it('createCheckout POSTs without an idempotency header when none supplied', async () => {
    const h = harness();
    h.setResponse({ order_id: 'ord_a' });
    const r = new CryptoOrdersResource(h.http);
    await r.createCheckout({ product: 'solo_manual', price_cents: 7900, price_currency: 'USD' });
    expect(h.calls[0]?.path).toBe('/v1/billing/crypto-checkout');
    expect(h.calls[0]?.headers).toBeUndefined();
  });

  it('createCheckout passes Idempotency-Key when supplied', async () => {
    const h = harness();
    h.setResponse({ order_id: 'ord_a' });
    const r = new CryptoOrdersResource(h.http);
    await r.createCheckout(
      { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' },
      { idempotencyKey: 'k-123' },
    );
    expect(h.calls[0]?.headers).toEqual({ 'idempotency-key': 'k-123' });
  });

  it('list GETs the list endpoint', async () => {
    const h = harness();
    h.setResponse({ orders: [] });
    const r = new CryptoOrdersResource(h.http);
    await r.list();
    expect(h.calls[0]?.method).toBe('GET');
    expect(h.calls[0]?.path).toBe('/v1/billing/crypto-orders');
    expect(h.calls[0]?.query).toBeUndefined();
  });

  it('V-666.BU listAll walks pages until next_cursor is null', async () => {
    const calls: unknown[] = [];
    // Wire a custom request handler that emits two pages.
    const requestFn = vi.fn((opts: RequestOpts) => {
      calls.push(opts);
      if (opts.query?.cursor === undefined) {
        return Promise.resolve({
          orders: [{ order_id: 'ord_1' }, { order_id: 'ord_2' }],
          next_cursor: 'cur_x',
        });
      }
      return Promise.resolve({
        orders: [{ order_id: 'ord_3' }],
        next_cursor: null,
      });
    });
    const r = new CryptoOrdersResource({ request: requestFn } as unknown as HttpClient);
    const collected: string[] = [];
    for await (const o of r.listAll({ status: 'paid' })) {
      collected.push(o.order_id);
    }
    expect(collected).toEqual(['ord_1', 'ord_2', 'ord_3']);
    expect(calls.length).toBe(2);
    const first = calls[0] as RequestOpts;
    const second = calls[1] as RequestOpts;
    expect(first.query).toEqual({ status: 'paid' });
    expect(second.query).toEqual({ status: 'paid', cursor: 'cur_x' });
  });

  it('V-666.BU listAll handles a single page (next_cursor null) without a second fetch', async () => {
    let calls = 0;
    const requestFn = vi.fn(() => {
      calls++;
      return Promise.resolve({
        orders: [{ order_id: 'ord_only' }],
        next_cursor: null,
      });
    });
    const r = new CryptoOrdersResource({ request: requestFn } as unknown as HttpClient);
    const collected: string[] = [];
    for await (const o of r.listAll()) collected.push(o.order_id);
    expect(collected).toEqual(['ord_only']);
    expect(calls).toBe(1);
  });

  it('V-666.BU listAll yields nothing when the first page is empty', async () => {
    const requestFn = vi.fn(() => Promise.resolve({ orders: [], next_cursor: null }));
    const r = new CryptoOrdersResource({ request: requestFn } as unknown as HttpClient);
    const collected: string[] = [];
    for await (const o of r.listAll()) collected.push(o.order_id);
    expect(collected).toEqual([]);
  });

  it('V-666.BU listAll respects early break (no extra requests)', async () => {
    let calls = 0;
    const requestFn = vi.fn(() => {
      calls++;
      return Promise.resolve({
        orders: [
          { order_id: `ord_${calls.toString()}_a` },
          { order_id: `ord_${calls.toString()}_b` },
        ],
        next_cursor: 'cur_more',
      });
    });
    const r = new CryptoOrdersResource({ request: requestFn } as unknown as HttpClient);
    for await (const o of r.listAll()) {
      // Break after the very first yielded order.
      expect(o.order_id).toBe('ord_1_a');
      break;
    }
    expect(calls).toBe(1);
  });

  it('V-666.BU iterate alias walks pages identically to listAll (cross-SDK naming parity)', async () => {
    const calls: unknown[] = [];
    const requestFn = vi.fn((opts: RequestOpts) => {
      calls.push(opts);
      if (opts.query?.cursor === undefined) {
        return Promise.resolve({
          orders: [{ order_id: 'ord_1' }, { order_id: 'ord_2' }],
          next_cursor: 'cur_x',
        });
      }
      return Promise.resolve({ orders: [{ order_id: 'ord_3' }], next_cursor: null });
    });
    const r = new CryptoOrdersResource({ request: requestFn } as unknown as HttpClient);
    const collected: string[] = [];
    for await (const o of r.iterate({ status: 'paid' })) collected.push(o.order_id);
    expect(collected).toEqual(['ord_1', 'ord_2', 'ord_3']);
    expect(calls.length).toBe(2);
  });

  it('list passes status + limit as query params', async () => {
    const h = harness();
    h.setResponse({ orders: [] });
    const r = new CryptoOrdersResource(h.http);
    await r.list({ status: 'paid', limit: 25 });
    expect(h.calls[0]?.query).toEqual({ status: 'paid', limit: 25 });
  });

  it('V-666.BX list passes created_after / created_before through', async () => {
    const h = harness();
    h.setResponse({ orders: [] });
    const r = new CryptoOrdersResource(h.http);
    await r.list({
      created_after: '2026-05-01T00:00:00Z',
      created_before: '2026-05-12T00:00:00Z',
    });
    expect(h.calls[0]?.query).toEqual({
      created_after: '2026-05-01T00:00:00Z',
      created_before: '2026-05-12T00:00:00Z',
    });
  });

  it('get encodes order_id in the path', async () => {
    const h = harness();
    h.setResponse({ order_id: 'ord/with space' });
    const r = new CryptoOrdersResource(h.http);
    await r.get('ord/with space');
    expect(h.calls[0]?.path).toBe('/v1/billing/crypto-orders/ord%2Fwith%20space');
  });

  it('updateNote PATCHes with the customer_note body', async () => {
    const h = harness();
    h.setResponse({});
    const r = new CryptoOrdersResource(h.http);
    await r.updateNote('ord_a', { customer_note: 'PO-9' });
    expect(h.calls[0]?.method).toBe('PATCH');
    expect(h.calls[0]?.path).toBe('/v1/billing/crypto-orders/ord_a');
    expect(h.calls[0]?.body).toEqual({ customer_note: 'PO-9' });
  });

  it('cancel POSTs the cancel sub-route', async () => {
    const h = harness();
    h.setResponse({});
    const r = new CryptoOrdersResource(h.http);
    await r.cancel('ord_a');
    expect(h.calls[0]?.method).toBe('POST');
    expect(h.calls[0]?.path).toBe('/v1/billing/crypto-orders/ord_a/cancel');
  });

  it('receipt GETs the JSON receipt sub-route', async () => {
    const h = harness();
    h.setResponse({});
    const r = new CryptoOrdersResource(h.http);
    await r.receipt('ord_a');
    expect(h.calls[0]?.method).toBe('GET');
    expect(h.calls[0]?.path).toBe('/v1/billing/crypto-orders/ord_a/receipt');
  });
});
