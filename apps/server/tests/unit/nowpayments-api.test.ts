// V-666: unit tests for the hand-rolled NowPayments API HTTP client.
//
// We don't hit real NowPayments — fetch is stubbed. Tests verify request
// shape (URL, headers, body), response mapping (success), 4xx error
// handling, and — the regression this file exists for — that a malformed
// 200 OK (missing/invalid required field) throws instead of silently
// coercing into a plausible-looking result (e.g. payment_id -> "undefined").

import { describe, expect, it, vi } from 'vitest';
import { NowPaymentsApiClient } from '../../src/lib/nowpayments-api.js';
import { createTestLogger } from '../../src/lib/logger.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeStubFetch(
  responses: Array<{ status: number; body: unknown } | { throwError: Error }>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    calls.push({ url, init: init ?? {} });
    const r = responses[i++];
    if (!r) throw new Error('stub fetch ran out of responses');
    if ('throwError' in r) return Promise.reject(r.throwError);
    return Promise.resolve(
      new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetchImpl, calls };
}

function makeClient(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof NowPaymentsApiClient>[0]> = {},
): NowPaymentsApiClient {
  return new NowPaymentsApiClient({
    apiKey: 'np_test_dummy',
    logger: createTestLogger(),
    fetchImpl,
    ...overrides,
  });
}

const VALID_CREATE_PAYMENT_ARGS = {
  priceAmount: 49.99,
  priceCurrency: 'USD',
  orderId: 'order-abc-123',
  ipnCallbackUrl: 'https://api.driftstack.dev/webhooks/nowpayments',
};

const VALID_CREATE_PAYMENT_BODY = {
  payment_id: 5077125051,
  pay_address: 'bc1qxyz...',
  pay_currency: 'btc',
  pay_amount: 0.00085,
  price_amount: 49.99,
  price_currency: 'usd',
  payment_status: 'waiting',
};

describe('NowPaymentsApiClient.createPayment', () => {
  it('POSTs to /v1/payment with x-api-key auth and maps the response (happy path)', async () => {
    const { fetchImpl, calls } = makeStubFetch([{ status: 200, body: VALID_CREATE_PAYMENT_BODY }]);
    const client = makeClient(fetchImpl);

    const result = await client.createPayment(VALID_CREATE_PAYMENT_ARGS);

    expect(result).toEqual({
      paymentId: '5077125051',
      payAddress: 'bc1qxyz...',
      payCurrency: 'btc',
      payAmount: 0.00085,
      priceAmount: 49.99,
      priceCurrency: 'usd',
      paymentStatus: 'waiting',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.nowpayments.io/v1/payment');
    const init = calls[0]!.init;
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('np_test_dummy');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.price_amount).toBe(49.99);
    expect(body.price_currency).toBe('usd'); // lowercased
    expect(body.order_id).toBe('order-abc-123');
    expect(body.ipn_callback_url).toBe(VALID_CREATE_PAYMENT_ARGS.ipnCallbackUrl);
  });

  it('accepts a numeric-string payment_id (NowPayments sometimes returns digits as a string)', async () => {
    const { fetchImpl } = makeStubFetch([
      { status: 200, body: { ...VALID_CREATE_PAYMENT_BODY, payment_id: '5077125051' } },
    ]);
    const client = makeClient(fetchImpl);
    const result = await client.createPayment(VALID_CREATE_PAYMENT_ARGS);
    expect(result.paymentId).toBe('5077125051');
  });

  it('includes optional order_description and pay_currency when provided', async () => {
    const { fetchImpl, calls } = makeStubFetch([{ status: 200, body: VALID_CREATE_PAYMENT_BODY }]);
    const client = makeClient(fetchImpl);
    await client.createPayment({
      ...VALID_CREATE_PAYMENT_ARGS,
      orderDescription: 'API Builder plan',
      payCurrency: 'ETH',
    });
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body.order_description).toBe('API Builder plan');
    expect(body.pay_currency).toBe('eth'); // lowercased
  });

  it('throws StripeApiError-shaped error on 4xx/5xx (unchanged upstream-error path)', async () => {
    const { fetchImpl } = makeStubFetch([
      { status: 400, body: { message: 'invalid price_currency' } },
    ]);
    const client = makeClient(fetchImpl);
    await expect(client.createPayment(VALID_CREATE_PAYMENT_ARGS)).rejects.toMatchObject({
      status: 400,
      message: 'NowPayments POST /v1/payment returned 400',
    });
  });

  // Regression: a malformed 200 OK (missing payment_id) used to silently
  // produce paymentId: "undefined" via String(res.payment_id) instead of
  // throwing. That poisoned value then gets persisted as the order's
  // payment_id, permanently breaking IPN matching for the customer's real
  // callback. This must now throw instead of returning a coerced result.
  it('throws when the upstream 200 OK response is missing payment_id, instead of coercing to the string "undefined"', async () => {
    const malformedBody = { ...VALID_CREATE_PAYMENT_BODY } as Record<string, unknown>;
    delete malformedBody.payment_id;
    const { fetchImpl } = makeStubFetch([{ status: 200, body: malformedBody }]);
    const client = makeClient(fetchImpl);

    await expect(client.createPayment(VALID_CREATE_PAYMENT_ARGS)).rejects.toThrow(/payment_id/);
  });

  it('throws when payment_id is null in an otherwise-well-formed 200 OK response', async () => {
    const { fetchImpl } = makeStubFetch([
      { status: 200, body: { ...VALID_CREATE_PAYMENT_BODY, payment_id: null } },
    ]);
    const client = makeClient(fetchImpl);
    await expect(client.createPayment(VALID_CREATE_PAYMENT_ARGS)).rejects.toThrow(/payment_id/);
  });

  it('throws when pay_address is missing from an otherwise-well-formed 200 OK response', async () => {
    const malformedBody = { ...VALID_CREATE_PAYMENT_BODY } as Record<string, unknown>;
    delete malformedBody.pay_address;
    const { fetchImpl } = makeStubFetch([{ status: 200, body: malformedBody }]);
    const client = makeClient(fetchImpl);
    await expect(client.createPayment(VALID_CREATE_PAYMENT_ARGS)).rejects.toThrow(/pay_address/);
  });
});

describe('NowPaymentsApiClient.getPayment', () => {
  it('GETs /v1/payment/:id and maps payment_status (+ pay address/quote when present)', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        status: 200,
        body: {
          payment_status: 'confirmed',
          pay_address: '0xORIG',
          pay_currency: 'btc',
          pay_amount: 0.0012,
        },
      },
    ]);
    const client = makeClient(fetchImpl);
    const result = await client.getPayment('5077125051');
    expect(result).toEqual({
      paymentStatus: 'confirmed',
      payAddress: '0xORIG',
      payCurrency: 'btc',
      payAmount: 0.0012,
    });
    expect(calls[0]!.url).toBe('https://api.nowpayments.io/v1/payment/5077125051');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.redirect).toBe('error');
  });

  it('maps the address/quote fields to null when the payment response omits them', async () => {
    const { fetchImpl } = makeStubFetch([{ status: 200, body: { payment_status: 'waiting' } }]);
    const client = makeClient(fetchImpl);
    const result = await client.getPayment('5077125051');
    expect(result).toEqual({
      paymentStatus: 'waiting',
      payAddress: null,
      payCurrency: null,
      payAmount: null,
    });
  });

  it('URL-encodes the payment id path segment', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      { status: 200, body: { payment_status: 'waiting' } },
    ]);
    const client = makeClient(fetchImpl);
    await client.getPayment('some id/with?chars');
    expect(calls[0]!.url).toBe(
      `https://api.nowpayments.io/v1/payment/${encodeURIComponent('some id/with?chars')}`,
    );
  });
});

describe('NowPaymentsApiClient — bounded response handling', () => {
  it('rejects an oversized declared response before reading its body', async () => {
    const cancel = vi.fn();
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel,
          }),
          {
            status: 200,
            headers: { 'content-length': String(256 * 1024 + 1) },
          },
        ),
      );
    const client = makeClient(fetchImpl);

    await expect(client.createPayment(VALID_CREATE_PAYMENT_ARGS)).rejects.toMatchObject({
      status: 200,
      message: 'NowPayments POST /v1/payment response exceeded 262144-byte limit',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels an unknown-length response when streamed bytes cross the limit', async () => {
    const cancel = vi.fn();
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(256 * 1024));
              controller.enqueue(new Uint8Array(1));
            },
            cancel,
          }),
          { status: 502 },
        ),
      );
    const client = makeClient(fetchImpl);

    await expect(client.createPayment(VALID_CREATE_PAYMENT_ARGS)).rejects.toMatchObject({
      status: 502,
      message: 'NowPayments POST /v1/payment response exceeded 262144-byte limit',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('keeps the timeout armed while an otherwise-valid response body stalls', async () => {
    const fetchImpl: typeof fetch = (_input, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal?.addEventListener('abort', () => {
                controller.error(new Error('body aborted'));
              });
            },
          }),
          { status: 200 },
        ),
      );
    };
    const client = makeClient(fetchImpl, { timeoutMs: 50 });

    await expect(client.createPayment(VALID_CREATE_PAYMENT_ARGS)).rejects.toThrow('body aborted');
  });

  it('returns a fixed protocol error for malformed success JSON', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response('<html>bad gateway</html>', { status: 200 }));
    const client = makeClient(fetchImpl);

    await expect(client.createPayment(VALID_CREATE_PAYMENT_ARGS)).rejects.toMatchObject({
      status: 200,
      message: 'NowPayments POST /v1/payment response was not JSON',
    });
  });
});
