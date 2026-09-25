// Security sweep 2026-09-24, finding #11 — a replaced past_due subscription was
// cancelled with proration, so Stripe credited the customer for a period they
// never paid.
//
// When a new plan subscription starts collecting, every older subscription the
// account still collects on is cancelled at once (live-billing audit #4). That set
// includes `past_due` ones, whose current-period invoice is unpaid, and the cancel
// always sent `invoice_now=true&prorate=true`: Stripe then credits the "unused"
// part of a period nobody paid for to the customer's balance. The path is driven
// here through the real StripeWebhooksService, StripeBillingProvider and
// StripeApiClient, with only `fetch` doubled, so the assertion is on the request
// Stripe would actually receive.
//
// A subscription that WAS paid keeps the prorated cancel (the customer is owed the
// unused time). A provider call that says nothing about payment still prorates;
// account termination now says so per subscription (decision of 2026-09-24, see
// terminating-an-account-cancels-a-past-due-subscription-without-a-credit.test.ts).

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createTestLogger } from '../../src/lib/logger.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { StripeApiClient } from '../../src/lib/stripe-api.js';
import { buildStripePriceMaps } from '../../src/lib/stripe-billing-facts.js';
import { StripeBillingProvider } from '../../src/services/stripe-billing-provider.js';
import { StripeWebhooksService, type StripeEvent } from '../../src/services/stripe-webhooks.js';
import { InMemoryStripeWebhooksRepo } from './_helpers/in-memory-stripe-webhooks-repo.js';

const MAPS = buildStripePriceMaps({
  api_starter: { monthly: 'price_starter_m', annual: 'price_starter_y' },
  api_scale: { monthly: 'price_scale_m', annual: 'price_scale_y' },
});

const DAY_S = 24 * 60 * 60;

interface StripeCall {
  method: string;
  url: URL;
}

/** Stripe over HTTP, doubled at `fetch`: records each request and answers with the object. */
function stripeDouble(): { client: StripeApiClient; calls: StripeCall[] } {
  const calls: StripeCall[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({ method: init?.method ?? 'GET', url });
    const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    return Promise.resolve(
      new Response(JSON.stringify({ id, object: 'subscription', status: 'canceled' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  const client = new StripeApiClient({
    secretKey: 'sk_test_double',
    baseUrl: 'https://stripe.invalid',
    fetchImpl,
    logger: createTestLogger(),
  });
  return { client, calls };
}

function harness(): {
  webhooks: StripeWebhooksService;
  repo: InMemoryStripeWebhooksRepo;
  calls: StripeCall[];
  alerts: SentryMessage[];
  provider: StripeBillingProvider;
} {
  const repo = new InMemoryStripeWebhooksRepo();
  const { client, calls } = stripeDouble();
  const provider = new StripeBillingProvider(client);
  const alerts: SentryMessage[] = [];
  const webhooks = new StripeWebhooksService(repo, {
    logger: createTestLogger(),
    priceToTier: MAPS.priceToTier,
    priceToInterval: MAPS.priceToInterval,
    sentry: { captureMessage: (m) => alerts.push(m) },
    subscriptionCanceller: provider,
  });
  return { webhooks, repo, calls, alerts, provider };
}

let seq = 0;
function subscriptionEvent(
  type: 'customer.subscription.created' | 'customer.subscription.updated',
  createdSec: number,
  spec: { id: string; customerId: string; status: string; priceId: string },
): StripeEvent {
  seq += 1;
  return {
    id: `evt_unpaid_replaced_${String(seq)}_${randomUUID()}`,
    type,
    created: createdSec,
    livemode: false,
    data: {
      object: {
        id: spec.id,
        object: 'subscription',
        customer: spec.customerId,
        status: spec.status,
        cancel_at_period_end: false,
        canceled_at: null,
        current_period_start: createdSec,
        current_period_end: createdSec + 30 * DAY_S,
        items: { data: [{ id: 'si_1', price: { id: spec.priceId } }] },
      },
    },
  };
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

/**
 * An api_scale subscription created 40 days ago, then either left paying
 * (`active`) or moved to `past_due` two days ago by a failed renewal, and a new
 * solo purchase whose `created` event arrives active — the re-checkout the
 * billing page allows while a subscription is past_due.
 */
async function replace(oldStatus: 'active' | 'past_due'): Promise<{
  h: ReturnType<typeof harness>;
  oldSub: string;
}> {
  const h = harness();
  const accountId = randomUUID();
  const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
  h.repo.registerAccount({ accountId, stripeCustomerId: customerId, tier: 'free' });
  const oldSub = `sub_old_${randomUUID()}`;
  const now = nowSec();
  const deliver = async (event: StripeEvent): Promise<void> => {
    expect(await h.webhooks.handle(event, JSON.stringify(event))).toBe('handled');
  };
  await deliver(
    subscriptionEvent('customer.subscription.created', now - 40 * DAY_S, {
      id: oldSub,
      customerId,
      status: 'active',
      priceId: 'price_scale_m',
    }),
  );
  if (oldStatus === 'past_due') {
    await deliver(
      subscriptionEvent('customer.subscription.updated', now - 2 * DAY_S, {
        id: oldSub,
        customerId,
        status: 'past_due',
        priceId: 'price_scale_m',
      }),
    );
  }
  expect(h.calls, 'nothing was cancelled before the new purchase').toEqual([]);
  await deliver(
    subscriptionEvent('customer.subscription.created', now, {
      id: `sub_new_${randomUUID()}`,
      customerId,
      status: 'active',
      priceId: 'price_starter_m',
    }),
  );
  return { h, oldSub };
}

describe('a replaced subscription that was never paid is cancelled without a credit', () => {
  it('CRITICAL a past_due subscription replaced by a new plan is cancelled at once with prorate=false and no final invoice, so Stripe credits nothing for the unpaid period', async () => {
    const { h, oldSub } = await replace('past_due');
    expect(h.calls, 'exactly one Stripe call: the cancel of the old subscription').toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.method).toBe('DELETE');
    expect(call.url.pathname).toBe(`/v1/subscriptions/${oldSub}`);
    expect(call.url.searchParams.get('prorate'), call.url.toString()).toBe('false');
    expect(call.url.searchParams.get('invoice_now'), call.url.toString()).toBe('false');
  });

  it('CRITICAL the staff alert for an unpaid replacement does not claim unused time was credited', async () => {
    const { h } = await replace('past_due');
    const kinds = h.alerts.map((a) => a.tags?.kind);
    expect(kinds).toEqual(['replaced_subscription_cancelled']);
    const text = JSON.stringify(h.alerts[0]);
    expect(text).not.toMatch(/credited/);
    expect(text).toMatch(/past due/);
  });

  it('control: a subscription that was PAID up is still cancelled prorated, with the unused time settled on a final invoice', async () => {
    const { h, oldSub } = await replace('active');
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.url.pathname).toBe(`/v1/subscriptions/${oldSub}`);
    expect(call.url.searchParams.get('prorate')).toBe('true');
    expect(call.url.searchParams.get('invoice_now')).toBe('true');
  });

  it('control: a provider cancel that says nothing about payment still cancels prorated', async () => {
    const h = harness();
    await h.provider.cancelSubscriptionNow({ subscriptionId: 'sub_terminated' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url.searchParams.get('prorate')).toBe('true');
    expect(h.calls[0]!.url.searchParams.get('invoice_now')).toBe('true');
  });
});
