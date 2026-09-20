// The Stripe client READS an invoice, a page of paid invoices, or a subscription
// — and refuses an answer that is for another id.
//
// Three read-only calls joined the client so that a paid invoice can be tied to
// its billing period: `getInvoice`, `listInvoices` and `getSubscription`. They
// are the first GETs in a client that only ever POSTed, so what has to be true of
// them is mostly what was already true of `post()`, held again:
//
//   · authenticated, version-pinned, redirect-refusing, time-bounded and
//     SIZE-bounded — a read is bounded like a write, and a list page gets its own
//     larger cap rather than none;
//   · a Stripe error comes back as the same normalised StripeApiError, carrying
//     the HTTP status (the backfill tells "Stripe does not know it" from an
//     outage by that status alone);
//   · and one thing new: the body must BE the object that was asked for. A record
//     keyed on one invoice id must never be filled from another invoice's body.

import { describe, expect, it, vi } from 'vitest';
import { createTestLogger } from '../../src/lib/logger.js';
import { StripeApiClient } from '../../src/lib/stripe-api.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function stubFetch(responses: Array<{ status: number; body: unknown }>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({
      url: typeof input === 'string' ? input : (input as Request).url,
      init: init ?? {},
    });
    const r = responses[i];
    i += 1;
    if (r === undefined) throw new Error('stub fetch ran out of responses');
    return Promise.resolve(
      new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetchImpl, calls };
}

function client(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof StripeApiClient>[0]> = {},
): StripeApiClient {
  return new StripeApiClient({
    secretKey: 'sk_test_dummy',
    logger: createTestLogger(),
    fetchImpl,
    ...overrides,
  });
}

function headers(call: FetchCall | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

describe('the Stripe client reads an invoice or subscription, and refuses an answer for another id', () => {
  it('CRITICAL getInvoice is a GET to the invoice’s own path: authenticated, version-pinned, redirect-refusing, with no body and no content type', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { id: 'in_1', amount_paid: 5 } }]);
    const invoice = await client(fetchImpl).getInvoice('in_1');
    expect(invoice).toEqual({ id: 'in_1', amount_paid: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/invoices/in_1');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.body).toBeUndefined();
    expect(calls[0]?.init.redirect).toBe('error');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(headers(calls[0])).toEqual({
      Authorization: `Basic ${Buffer.from('sk_test_dummy:').toString('base64')}`,
      'Stripe-Version': '2024-12-18.acacia',
    });
  });

  it('the configured API version and base URL apply to a read as they do to a write, and an id is escaped into the path', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { id: 'sub_/../x?y' } }]);
    await client(fetchImpl, {
      apiVersion: '2025-01-01.test',
      baseUrl: 'http://stripe.local',
    }).getSubscription('sub_/../x?y');
    expect(calls[0]?.url).toBe('http://stripe.local/v1/subscriptions/sub_%2F..%2Fx%3Fy');
    expect(headers(calls[0])['Stripe-Version']).toBe('2025-01-01.test');
  });

  it('CRITICAL an answer for a DIFFERENT invoice or subscription is refused, not returned', async () => {
    for (const body of [{ id: 'in_OTHER' }, { id: 7 }, {}, { object: 'invoice' }]) {
      const { fetchImpl } = stubFetch([{ status: 200, body }]);
      await expect(
        client(fetchImpl).getInvoice('in_1'),
        JSON.stringify(body),
      ).rejects.toMatchObject({
        name: 'StripeApiError',
        stripeError: { type: 'malformed_response' },
      });
    }
    const { fetchImpl } = stubFetch([{ status: 200, body: { id: 'sub_OTHER' } }]);
    await expect(client(fetchImpl).getSubscription('sub_1')).rejects.toMatchObject({
      name: 'StripeApiError',
      stripeError: { type: 'malformed_response' },
    });
  });

  it('CRITICAL listInvoices asks for one status, a created-since bound in unix seconds, a page size and the cursor — and returns the page with whether more follows', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        status: 200,
        body: { object: 'list', data: [{ id: 'in_2' }, { id: 'in_1' }], has_more: true },
      },
      { status: 200, body: { object: 'list', data: [], has_more: false } },
    ]);
    const c = client(fetchImpl);
    const createdGte = new Date('2025-08-15T12:00:00.500Z');

    expect(await c.listInvoices({ status: 'paid', createdGte, limit: 25 })).toEqual({
      data: [{ id: 'in_2' }, { id: 'in_1' }],
      hasMore: true,
    });
    const first = new URL(calls[0]?.url ?? '');
    expect(first.pathname).toBe('/v1/invoices');
    expect(Object.fromEntries(first.searchParams)).toEqual({
      status: 'paid',
      'created[gte]': String(Math.floor(createdGte.getTime() / 1000)),
      limit: '25',
    });
    expect(calls[0]?.init.method).toBe('GET');

    expect(
      await c.listInvoices({ status: 'paid', createdGte, limit: 25, startingAfter: 'in_1' }),
    ).toEqual({ data: [], hasMore: false });
    expect(new URL(calls[1]?.url ?? '').searchParams.get('starting_after')).toBe('in_1');
  });

  it('a page size is held between 1 and Stripe’s own ceiling of 100', async () => {
    for (const [asked, sent] of [
      [0, '1'],
      [-5, '1'],
      [2.9, '2'],
      [100, '100'],
      [5000, '100'],
    ] as const) {
      const { fetchImpl, calls } = stubFetch([
        { status: 200, body: { data: [], has_more: false } },
      ]);
      await client(fetchImpl).listInvoices({
        status: 'paid',
        createdGte: new Date(0),
        limit: asked,
      });
      expect(new URL(calls[0]?.url ?? '').searchParams.get('limit'), String(asked)).toBe(sent);
    }
  });

  it('a list that is not a list is refused rather than read as an empty page', async () => {
    for (const body of [
      {},
      { data: 'nope', has_more: false },
      { data: [] },
      { data: [], has_more: 'false' },
      { data: [{ id: 'in_1' }, null], has_more: false },
      { data: [7], has_more: false },
    ]) {
      const { fetchImpl } = stubFetch([{ status: 200, body }]);
      await expect(
        client(fetchImpl).listInvoices({ status: 'paid', createdGte: new Date(0), limit: 10 }),
        JSON.stringify(body),
      ).rejects.toMatchObject({
        name: 'StripeApiError',
        stripeError: { type: 'malformed_response' },
      });
    }
  });

  it('CRITICAL a Stripe error on a read is the same normalised StripeApiError, carrying the HTTP status — 404 "unknown" and 503 "outage" are told apart by it', async () => {
    for (const status of [404, 503]) {
      const { fetchImpl } = stubFetch([
        {
          status,
          body: {
            error: {
              type: 'invalid_request_error',
              code: 'resource_missing',
              message: 'No such subscription: sub_secret_detail',
            },
          },
        },
      ]);
      const err: unknown = await client(fetchImpl)
        .getSubscription('sub_1')
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        name: 'StripeApiError',
        status,
        stripeError: { type: 'invalid_request_error', code: 'resource_missing' },
      });
      // The provider's free-form message is not copied into the Error.
      expect(JSON.stringify(err)).not.toContain('sub_secret_detail');
      expect((err as Error).message).not.toContain('sub_secret_detail');
    }
  });

  it('CRITICAL a read is SIZE-bounded like a write: a single object over 256 KiB is refused before its body is read', async () => {
    const cancel = vi.fn();
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status: 200,
          headers: { 'content-length': String(256 * 1024 + 1) },
        }),
      );
    for (const read of [
      (c: StripeApiClient) => c.getInvoice('in_1'),
      (c: StripeApiClient) => c.getSubscription('sub_1'),
    ]) {
      await expect(read(client(fetchImpl))).rejects.toMatchObject({
        name: 'StripeApiError',
        stripeError: {
          type: 'malformed_response',
          message: 'Stripe response exceeded 262144-byte limit',
        },
      });
    }
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('CRITICAL a page of invoices gets a larger cap, not no cap: 1 MiB is read, and one byte over 4 MiB is refused', async () => {
    const big = { data: [{ id: 'in_1', padding: 'x'.repeat(1024 * 1024) }], has_more: false };
    const { fetchImpl } = stubFetch([{ status: 200, body: big }]);
    const page = await client(fetchImpl).listInvoices({
      status: 'paid',
      createdGte: new Date(0),
      limit: 10,
    });
    expect(page.data).toHaveLength(1);

    const cancel = vi.fn();
    const tooBig: typeof fetch = () =>
      Promise.resolve(
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status: 200,
          headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
        }),
      );
    await expect(
      client(tooBig).listInvoices({ status: 'paid', createdGte: new Date(0), limit: 10 }),
    ).rejects.toMatchObject({
      stripeError: {
        type: 'malformed_response',
        message: 'Stripe response exceeded 4194304-byte limit',
      },
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('a read is TIME-bounded, through the body as well as the headers', async () => {
    const neverAnswers: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    await expect(client(neverAnswers, { timeoutMs: 40 }).getInvoice('in_1')).rejects.toThrow();

    const stallsInTheBody: typeof fetch = (_input, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () =>
                controller.error(new Error('aborted mid-body')),
              );
            },
          }),
          { status: 200 },
        ),
      );
    const started = Date.now();
    await expect(
      client(stallsInTheBody, { timeoutMs: 40 }).getSubscription('sub_1'),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
