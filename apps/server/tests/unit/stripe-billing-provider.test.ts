// V-088: unit tests for StripeBillingProvider — verifies it correctly
// composes StripeApiClient calls and surfaces results in the
// BillingProvider shape.

import { describe, expect, it } from 'vitest';
import { StripeBillingProvider } from '../../src/services/stripe-billing-provider.js';
import { StripeApiClient } from '../../src/lib/stripe-api.js';
import { createTestLogger } from '../../src/lib/logger.js';

function makeClient(fetchImpl: typeof fetch): {
  client: StripeApiClient;
  calls: Array<{ url: string; body: string }>;
} {
  const calls: Array<{ url: string; body: string }> = [];
  const wrappedFetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    calls.push({ url, body: (init?.body as string) ?? '' });
    return fetchImpl(input, init);
  };
  const client = new StripeApiClient({
    secretKey: 'sk_test_dummy',
    logger: createTestLogger(),
    fetchImpl: wrappedFetch,
  });
  return { client, calls };
}

const stubOk =
  (body: unknown): typeof fetch =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

describe('StripeBillingProvider.ensureCustomer', () => {
  it('creates a customer with metadata + returns the id', async () => {
    const { client, calls } = makeClient(stubOk({ id: 'cus_new', email: 'a@b.com' }));
    const provider = new StripeBillingProvider(client);

    const id = await provider.ensureCustomer({
      accountId: 'acc-uuid',
      email: 'a@b.com',
      name: 'Acme',
    });
    expect(id).toBe('cus_new');
    expect(calls[0]!.body).toContain('metadata%5Bdriftstack_account_id%5D=acc-uuid');
    expect(calls[0]!.body).toContain('email=a%40b.com');
    expect(calls[0]!.body).toContain('name=Acme');
  });
});

describe('StripeBillingProvider.createSubscriptionCheckout', () => {
  it('returns url + sessionId from the Stripe response', async () => {
    const { client, calls } = makeClient(
      stubOk({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }),
    );
    const provider = new StripeBillingProvider(client);

    const result = await provider.createSubscriptionCheckout({
      customerId: 'cus_x',
      priceId: 'price_y',
      successUrl: 'https://app/s',
      cancelUrl: 'https://app/c',
      accountId: 'acc-uuid',
    });
    expect(result.sessionId).toBe('cs_test_1');
    expect(result.url).toContain('checkout.stripe.com');
    expect(calls[0]!.body).toContain('mode=subscription');
    expect(calls[0]!.body).toContain('client_reference_id=acc-uuid');
  });
});

// StripeBillingProvider.createTrialPackCheckout was removed 2026-05-27 with
// the trial_pack retirement (replaced by the perpetual free tier).

describe('StripeBillingProvider.createPortalSession', () => {
  it('returns the portal url', async () => {
    const { client, calls } = makeClient(
      stubOk({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/bps_1' }),
    );
    const provider = new StripeBillingProvider(client);

    const result = await provider.createPortalSession({
      customerId: 'cus_x',
      returnUrl: 'https://app.driftstack.dev/billing',
    });
    expect(result.url).toContain('billing.stripe.com');
    expect(calls[0]!.body).toContain('return_url=https%3A%2F%2Fapp.driftstack.dev%2Fbilling');
  });
});
