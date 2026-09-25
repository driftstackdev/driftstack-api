// Terminating an account cancels a past_due subscription without proration and
// without a final invoice (decision of 2026-09-24).
//
// A termination cancels every subscription Stripe still collects on (active,
// trialing, past_due) at once. It sent `invoice_now=true&prorate=true` for every
// one of them, so a past_due subscription, whose current period was never paid,
// had the "unused" part of that unpaid period credited to the Stripe customer.
// There is no credit for an unpaid period: a past_due subscription is now
// cancelled with `prorate=false&invoice_now=false`, the same way a past_due
// subscription replaced by a new plan already is. A PAID subscription keeps the
// prorated cancellation.
//
// Driven through the real AccountsAdminService, BillingService,
// StripeBillingProvider and StripeApiClient, with only `fetch` doubled, so the
// assertions are on the requests Stripe would actually receive.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApiKeyScope } from '@driftstack/api-types';

import { createTestLogger } from '../../src/lib/logger.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { StripeApiClient } from '../../src/lib/stripe-api.js';
import { AccountsAdminService } from '../../src/services/admin-accounts.js';
import type { AccountContext } from '../../src/services/auth.js';
import { BillingService, type SubscriptionMirror } from '../../src/services/billing.js';
import { StripeBillingProvider } from '../../src/services/stripe-billing-provider.js';
import { InMemoryAccountsAdminRepo } from './_helpers/in-memory-admin-accounts-repo.js';
import { InMemoryAuthRepo } from './_helpers/in-memory-auth-repo.js';
import { InMemoryBillingRepo } from './_helpers/in-memory-billing.js';

const ADMIN_ID = '11111111-2222-4333-8444-555555555555';

interface StripeCall {
  method: string;
  url: URL;
}

/**
 * Stripe over HTTP, doubled at `fetch`: records each request and answers with the object,
 * or, for a cancel of a subscription id in `failing`, with a Stripe API error. A read
 * answers with the status in `statuses` and a latest invoice that is open for a past_due
 * subscription and paid otherwise (the termination reads both before it cancels).
 */
function stripeDouble(): {
  client: StripeApiClient;
  calls: StripeCall[];
  failing: Set<string>;
  statuses: Map<string, string>;
} {
  const calls: StripeCall[] = [];
  const failing = new Set<string>();
  const statuses = new Map<string, string>();
  const json = (body: unknown): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    if (method === 'GET' && url.pathname.startsWith('/v1/invoices/')) {
      const status = statuses.get(id.replace(/^in_/, ''));
      return json({ id, object: 'invoice', status: status === 'past_due' ? 'open' : 'paid' });
    }
    if (method === 'GET') {
      return json({
        id,
        object: 'subscription',
        status: statuses.get(id) ?? 'active',
        pause_collection: null,
        latest_invoice: `in_${id}`,
      });
    }
    if (failing.has(id)) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { type: 'api_error', message: 'An unknown error occurred' } }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
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
  return { client, calls, failing, statuses };
}

function ctx(): AccountContext {
  return {
    account: { id: ADMIN_ID, tier: 'enterprise', status: 'active' },
    apiKey: { id: ADMIN_ID, scopes: ['driftstack_internal_admin'] as ApiKeyScope[] },
    teams: [],
    rateLimitOverrides: {},
  } as unknown as AccountContext;
}

interface Harness {
  admin: AccountsAdminService;
  calls: StripeCall[];
  /** Subscription ids whose cancel Stripe answers with an error. */
  failing: Set<string>;
  alerts: SentryMessage[];
  errors: Array<Record<string, unknown>>;
  accountId: string;
  subscription: (status: SubscriptionMirror['status'], createdAt: string) => string;
}

function harness(): Harness {
  const authRepo = new InMemoryAuthRepo();
  const accountId = randomUUID();
  const at = new Date('2026-08-01T00:00:00Z');
  authRepo.upsertAccount({
    id: accountId,
    email: `terminated-${accountId}@example.test`,
    name: null,
    tier: 'api_scale',
    status: 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: at,
    updatedAt: at,
  });
  const billingRepo = new InMemoryBillingRepo();
  const { client, calls, failing, statuses } = stripeDouble();
  const billing = new BillingService(billingRepo, new StripeBillingProvider(client), {
    tierPrices: {},
    defaultSuccessUrl: 'https://app.driftstack.io/billing/success',
    defaultCancelUrl: 'https://app.driftstack.io/billing/cancel',
    portalReturnUrl: 'https://app.driftstack.io/billing',
  });
  const alerts: SentryMessage[] = [];
  const errors: Array<Record<string, unknown>> = [];
  const admin = new AccountsAdminService(
    new InMemoryAccountsAdminRepo(authRepo),
    null,
    null,
    null,
    null,
    null,
    {
      error: (obj: Record<string, unknown>) => {
        errors.push(obj);
      },
      warn: () => {},
    },
    billing,
    null,
    { captureMessage: (m: SentryMessage) => alerts.push(m) },
  );
  const subscription = (status: SubscriptionMirror['status'], createdAt: string): string => {
    const id = `sub_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    billingRepo.upsertSubscription({
      id: randomUUID(),
      accountId,
      stripeSubscriptionId: id,
      stripePriceId: 'price_scale_m',
      tier: 'api_scale',
      status,
      currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    });
    statuses.set(id, status);
    return id;
  };
  return { admin, calls, failing, alerts, errors, accountId, subscription };
}

function cancelOf(calls: readonly StripeCall[], subscriptionId: string): StripeCall {
  const found = calls.filter(
    (c) => c.method === 'DELETE' && c.url.pathname === `/v1/subscriptions/${subscriptionId}`,
  );
  expect(found, `exactly one cancel of ${subscriptionId}`).toHaveLength(1);
  return found[0]!;
}

describe('terminating an account cancels a past_due subscription without a credit', () => {
  it('CRITICAL a past_due subscription of a terminated account is cancelled with prorate=false and no final invoice, so Stripe credits nothing for the unpaid period', async () => {
    const h = harness();
    const pastDue = h.subscription('past_due', '2026-08-01T00:00:00Z');

    await h.admin.deleteAccount(ctx(), h.accountId, {});

    const call = cancelOf(h.calls, pastDue);
    expect(call.url.searchParams.get('prorate'), call.url.toString()).toBe('false');
    expect(call.url.searchParams.get('invoice_now'), call.url.toString()).toBe('false');
    expect(h.errors).toEqual([]);
  });

  it('CRITICAL a PAID subscription of the same terminated account keeps the prorated cancel, with the unused paid time settled on a final invoice', async () => {
    const h = harness();
    const paid = h.subscription('active', '2026-08-20T00:00:00Z');
    const pastDue = h.subscription('past_due', '2026-08-01T00:00:00Z');

    await h.admin.deleteAccount(ctx(), h.accountId, {});

    expect(h.calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
    const paidCall = cancelOf(h.calls, paid);
    expect(paidCall.url.searchParams.get('prorate')).toBe('true');
    expect(paidCall.url.searchParams.get('invoice_now')).toBe('true');
    const unpaidCall = cancelOf(h.calls, pastDue);
    expect(unpaidCall.url.searchParams.get('prorate')).toBe('false');
    expect(unpaidCall.url.searchParams.get('invoice_now')).toBe('false');
  });

  it('a trialing subscription is not past due, so it keeps the prorated cancel', async () => {
    const h = harness();
    const trial = h.subscription('trialing', '2026-08-20T00:00:00Z');

    await h.admin.deleteAccount(ctx(), h.accountId, {});

    const call = cancelOf(h.calls, trial);
    expect(call.url.searchParams.get('prorate')).toBe('true');
    expect(call.url.searchParams.get('invoice_now')).toBe('true');
  });

  it('CRITICAL the audit record says which subscriptions were cancelled without proration', async () => {
    const h = harness();
    const paid = h.subscription('active', '2026-08-20T00:00:00Z');
    const pastDue = h.subscription('past_due', '2026-08-01T00:00:00Z');
    const auditRecord: Record<string, unknown> = { reason: 'terms violation' };

    await h.admin.deleteAccount(ctx(), h.accountId, auditRecord);

    expect([...(auditRecord.stripe_subscriptions_cancelled as string[])].sort()).toEqual(
      [paid, pastDue].sort(),
    );
    expect(auditRecord.stripe_subscriptions_cancelled_without_proration).toEqual([pastDue]);
    expect(auditRecord.reason).toBe('terms violation');
  });

  it('CRITICAL when every cancelled subscription was past due, the staff alert does not claim unused time was credited, and names no identifier', async () => {
    const h = harness();
    const pastDue = h.subscription('past_due', '2026-08-01T00:00:00Z');

    await h.admin.deleteAccount(ctx(), h.accountId, {});

    expect(h.alerts).toHaveLength(1);
    const alert = h.alerts[0]!;
    expect(alert.level).toBe('warning');
    expect(alert.message).not.toMatch(/credited/);
    expect(alert.message).toMatch(/past due/);
    const everything = JSON.stringify(alert);
    for (const id of [h.accountId, pastDue]) {
      expect(everything, `the alert carries an identifier (${id})`).not.toContain(id);
    }
  });

  it('CRITICAL when another cancel fails, the audit record still says which cancelled subscriptions got no proration', async () => {
    const h = harness();
    const paid = h.subscription('active', '2026-08-20T00:00:00Z');
    const pastDue = h.subscription('past_due', '2026-08-01T00:00:00Z');
    h.failing.add(paid);
    const auditRecord: Record<string, unknown> = {};

    await h.admin.deleteAccount(ctx(), h.accountId, auditRecord);

    expect(cancelOf(h.calls, pastDue).url.searchParams.get('prorate')).toBe('false');
    expect(auditRecord.stripe_subscriptions_cancelled).toEqual([pastDue]);
    expect(auditRecord.stripe_subscriptions_not_cancelled).toEqual([paid]);
    expect(
      auditRecord.stripe_subscriptions_cancelled_without_proration,
      'the failure branch dropped the no-credit record of a subscription it did cancel',
    ).toEqual([pastDue]);
    expect(h.alerts.map((a) => a.level)).toEqual(['error']);
  });

  it('control: when the only cancel that went through was prorated, the failure record names none as unprorated', async () => {
    const h = harness();
    const paid = h.subscription('active', '2026-08-20T00:00:00Z');
    const pastDue = h.subscription('past_due', '2026-08-01T00:00:00Z');
    h.failing.add(pastDue);
    const auditRecord: Record<string, unknown> = {};

    await h.admin.deleteAccount(ctx(), h.accountId, auditRecord);

    expect(auditRecord.stripe_subscriptions_cancelled).toEqual([paid]);
    expect(auditRecord.stripe_subscriptions_not_cancelled).toEqual([pastDue]);
    expect(auditRecord).not.toHaveProperty('stripe_subscriptions_cancelled_without_proration');
  });

  it('control: when a paid subscription was cancelled too, the alert still asks staff to check whether a refund is owed', async () => {
    const h = harness();
    h.subscription('active', '2026-08-20T00:00:00Z');
    h.subscription('past_due', '2026-08-01T00:00:00Z');

    await h.admin.deleteAccount(ctx(), h.accountId, {});

    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.message).toMatch(/refund/i);
    expect(h.alerts[0]!.message).toMatch(/14\.5/);
  });
});
