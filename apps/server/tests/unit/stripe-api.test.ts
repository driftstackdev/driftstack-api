// V-088: unit tests for the hand-rolled Stripe API HTTP client.
//
// We don't hit real Stripe — fetch is stubbed. Tests verify request
// shape (URL, headers, urlencoded body), response handling (success,
// 4xx with stripe error envelope, malformed JSON, timeout), and the
// auth header construction.

import { describe, expect, it, vi } from 'vitest';
import { StripeApiClient, type StripeApiError } from '../../src/lib/stripe-api.js';
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
  overrides: Partial<ConstructorParameters<typeof StripeApiClient>[0]> = {},
): StripeApiClient {
  return new StripeApiClient({
    secretKey: 'sk_test_dummy',
    logger: createTestLogger(),
    fetchImpl,
    ...overrides,
  });
}

describe('StripeApiClient.createCustomer', () => {
  it('POSTs urlencoded body to /v1/customers with BasicAuth', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      { status: 200, body: { id: 'cus_test_123', email: 'test@driftstack.local' } },
    ]);
    const client = makeClient(fetchImpl);

    const result = await client.createCustomer({
      email: 'test@driftstack.local',
      name: 'Test User',
      metadata: { driftstack_account_id: 'acc-123' },
    });

    expect(result.id).toBe('cus_test_123');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/customers');
    const init = calls[0]!.init;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('sk_test_dummy:').toString('base64')}`);
    expect(headers['Stripe-Version']).toBe('2024-12-18.acacia');
    expect(init.body).toBe(
      'email=test%40driftstack.local&name=Test+User&metadata%5Bdriftstack_account_id%5D=acc-123',
    );
  });

  it('omits name + metadata when not provided', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      { status: 200, body: { id: 'cus_test_456', email: 'plain@driftstack.local' } },
    ]);
    const client = makeClient(fetchImpl);
    await client.createCustomer({ email: 'plain@driftstack.local' });
    expect(calls[0]!.init.body).toBe('email=plain%40driftstack.local');
  });

  it('forwards an Idempotency-Key header when idempotencyKey is provided (safe-retry / no-duplicate seam)', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      { status: 200, body: { id: 'cus_idem', email: 'i@driftstack.local' } },
    ]);
    const client = makeClient(fetchImpl);
    await client.createCustomer({
      email: 'i@driftstack.local',
      idempotencyKey: 'stripe-customer-create:acc-xyz',
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('stripe-customer-create:acc-xyz');
    // The key is a HEADER, never leaked into the form body.
    expect(calls[0]!.init.body).toBe('email=i%40driftstack.local');
  });

  it('omits the Idempotency-Key header when idempotencyKey is not provided', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      { status: 200, body: { id: 'cus_no_idem', email: 'n@driftstack.local' } },
    ]);
    const client = makeClient(fetchImpl);
    await client.createCustomer({ email: 'n@driftstack.local' });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeUndefined();
  });
});

describe('StripeApiClient.createSubscriptionCheckoutSession', () => {
  it('builds the subscription-mode body correctly', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        status: 200,
        body: { id: 'cs_test_abc', url: 'https://checkout.stripe.com/c/pay/cs_test_abc' },
      },
    ]);
    const client = makeClient(fetchImpl);

    const result = await client.createSubscriptionCheckoutSession({
      customerId: 'cus_x',
      priceId: 'price_y',
      successUrl: 'https://app.driftstack.dev/success',
      cancelUrl: 'https://app.driftstack.dev/cancel',
      clientReferenceId: 'acc_uuid',
      metadata: { plan: 'api_builder' },
      idempotencyKey: 'checkout-attempt-123',
    });
    expect(result.id).toBe('cs_test_abc');
    expect(result.url).toContain('checkout.stripe.com');
    const body = calls[0]!.init.body as string;
    expect(body).toContain('mode=subscription');
    expect(body).toContain('customer=cus_x');
    expect(body).toContain('line_items%5B0%5D%5Bprice%5D=price_y');
    expect(body).toContain('client_reference_id=acc_uuid');
    expect(body).toContain('automatic_tax%5Benabled%5D=true');
    expect(body).toContain('subscription_data%5Bmetadata%5D%5Bplan%5D=api_builder');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('checkout-attempt-123');
  });
});

describe('StripeApiClient.createOneTimeCheckoutSession', () => {
  it('builds the payment-mode body correctly', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        status: 200,
        body: { id: 'cs_test_one', url: 'https://checkout.stripe.com/c/pay/cs_test_one' },
      },
    ]);
    const client = makeClient(fetchImpl);
    await client.createOneTimeCheckoutSession({
      customerId: 'cus_y',
      priceId: 'price_trial',
      successUrl: 'https://app/x',
      cancelUrl: 'https://app/y',
      clientReferenceId: 'acc_uuid',
    });
    const body = calls[0]!.init.body as string;
    expect(body).toContain('mode=payment');
    expect(body).not.toContain('mode=subscription');
    expect(body).toContain('client_reference_id=acc_uuid');
  });
});

describe('StripeApiClient.createBillingPortalSession', () => {
  it('POSTs customer + return_url', async () => {
    const { fetchImpl, calls } = makeStubFetch([
      {
        status: 200,
        body: { id: 'bps_test_111', url: 'https://billing.stripe.com/p/session/bps_test_111' },
      },
    ]);
    const client = makeClient(fetchImpl);

    const result = await client.createBillingPortalSession({
      customerId: 'cus_z',
      returnUrl: 'https://app.driftstack.dev/billing',
    });
    expect(result.url).toContain('billing.stripe.com');
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
  });
});

describe('StripeApiClient — error handling', () => {
  it('throws StripeApiError on 4xx with stripe error envelope', async () => {
    const { fetchImpl } = makeStubFetch([
      {
        status: 400,
        body: {
          error: {
            type: 'invalid_request_error',
            code: 'parameter_invalid_empty',
            message: 'price is required',
            param: 'line_items[0][price]',
          },
        },
      },
    ]);
    const client = makeClient(fetchImpl);

    let caught: unknown;
    try {
      await client.createCustomer({ email: 'x@y.com' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as StripeApiError;
    expect(err.name).toBe('StripeApiError');
    expect(err.status).toBe(400);
    expect(err.stripeError.type).toBe('invalid_request_error');
    expect(err.stripeError.code).toBe('parameter_invalid_empty');
    expect(err.stripeError.message).toBeUndefined();
    expect(err.message).not.toContain('price is required');
  });

  it('normalizes a malformed Stripe error envelope without copying upstream content', async () => {
    const { fetchImpl } = makeStubFetch([
      { status: 502, body: { error: 'attacker-controlled body marker' } },
    ]);
    const client = makeClient(fetchImpl);

    await expect(client.createCustomer({ email: 'x@y.com' })).rejects.toMatchObject({
      name: 'StripeApiError',
      status: 502,
      message: 'Stripe /v1/customers failed: unknown_error',
      stripeError: { type: 'unknown_error' },
    });
  });

  it('throws StripeApiError when the response body is not JSON', async () => {
    // Stub the response to return text/plain malformed JSON.
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response('<html>500 internal</html>', {
          status: 500,
          headers: { 'content-type': 'text/html' },
        }),
      );
    const client = makeClient(fetchImpl);
    await expect(client.createCustomer({ email: 'x@y.com' })).rejects.toMatchObject({
      name: 'StripeApiError',
      status: 500,
      stripeError: {
        type: 'malformed_response',
        message: 'Stripe response was not JSON',
      },
    });
  });

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

    await expect(client.createCustomer({ email: 'x@y.com' })).rejects.toMatchObject({
      name: 'StripeApiError',
      status: 200,
      stripeError: {
        type: 'malformed_response',
        message: 'Stripe response exceeded 262144-byte limit',
      },
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
              controller.enqueue(new Uint8Array(200 * 1024));
              controller.enqueue(new Uint8Array(60 * 1024 + 1));
            },
            cancel,
          }),
          { status: 200 },
        ),
      );
    const client = makeClient(fetchImpl);

    await expect(client.createCustomer({ email: 'x@y.com' })).rejects.toMatchObject({
      name: 'StripeApiError',
      stripeError: { type: 'malformed_response' },
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('respects the per-request timeout', async () => {
    const fetchImpl: typeof fetch = (_input, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    const client = makeClient(fetchImpl, { timeoutMs: 50 });
    await expect(client.createCustomer({ email: 'x@y.com' })).rejects.toThrow();
  });

  it('the timeout also bounds the RESPONSE-BODY read (headers arrive, then the body stalls) — regression for the clearTimeout-before-res.text() bug', async () => {
    // fetch() resolves with headers immediately; the body read only settles when
    // the abort signal fires. With the timer cleared after fetch (the old bug)
    // this would hang past timeoutMs (up to undici's 300s body timeout); with
    // the timer armed through the body read it aborts at timeoutMs.
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
    await expect(client.createCustomer({ email: 'x@y.com' })).rejects.toThrow();
  });
});

describe('StripeApiClient — fetch is invoked once per call', () => {
  it('does not retry transient failures (caller responsibility)', async () => {
    const { fetchImpl, calls } = makeStubFetch([{ throwError: new Error('econnreset') }]);
    const client = makeClient(fetchImpl);
    await expect(client.createCustomer({ email: 'x@y.com' })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

// Sanity: silence the vi import linter when no spies.
void vi;
