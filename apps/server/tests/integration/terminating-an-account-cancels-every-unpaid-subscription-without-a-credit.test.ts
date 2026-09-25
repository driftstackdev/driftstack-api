// Terminating an account cancels every subscription that was not paid without a
// credit; a paid subscription is still prorated (owner decision of 2026-09-24:
// "terminating a subscription that was not paid → cancel with NO credit; paid
// subscriptions still prorate").
//
// Only a subscription whose STORED status was past_due was treated as unpaid. A
// suspended account's subscription stays `active` with its collection paused
// (behavior `void`: each renewal invoice is voided, so the period was never
// paid), and it was cancelled prorated: the customer was credited for time
// nobody paid for. "Not paid" is now one definition, read from Stripe at the
// moment of the cancel:
//   - status past_due or unpaid; or
//   - the latest invoice not paid (draft, open, void, uncollectible); or
//   - collection paused with behavior void or mark_uncollectible while the latest
//     invoice is not known to be paid.
// A subscription whose current period WAS paid is still prorated, even when the
// account was suspended (collection paused) part-way through that period.
// When Stripe cannot be read, the stored status decides; when only the latest
// invoice cannot be read, what was read decides. Either way the audit record
// names the subscription so staff can check it.
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
import { subscriptionWasNotPaid } from '../../src/services/subscription-payment-state.js';
import { InMemoryAccountsAdminRepo } from './_helpers/in-memory-admin-accounts-repo.js';
import { InMemoryAuthRepo } from './_helpers/in-memory-auth-repo.js';
import { InMemoryBillingRepo } from './_helpers/in-memory-billing.js';

const ADMIN_ID = '11111111-2222-4333-8444-555555555555';

/** What Stripe holds for one subscription when it is read. */
interface LiveState {
  status: string;
  /** `pause_collection.behavior`; null when collection is not paused. */
  pause: 'void' | 'mark_uncollectible' | 'keep_as_draft' | null;
  /** The latest invoice's status; null when the subscription has none. */
  invoice: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible' | null;
}

interface StripeCall {
  method: string;
  url: URL;
}

/**
 * Stripe over HTTP, doubled at `fetch`, answering from `live`; `unreadable` ids answer
 * 500 for the subscription and its invoice, `invoiceUnreadable` ids for the invoice only.
 */
function stripeDouble(): {
  client: StripeApiClient;
  calls: StripeCall[];
  live: Map<string, LiveState>;
  unreadable: Set<string>;
  invoiceUnreadable: Set<string>;
} {
  const calls: StripeCall[] = [];
  const live = new Map<string, LiveState>();
  const unreadable = new Set<string>();
  const invoiceUnreadable = new Set<string>();
  const reply = (body: unknown, status = 200): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const [, , kind, rawId] = url.pathname.split('/');
    const id = decodeURIComponent(rawId ?? '');
    if (kind === 'invoices') {
      const subId = id.replace(/^in_/, '');
      if (unreadable.has(subId) || invoiceUnreadable.has(subId)) {
        return reply({ error: { type: 'api_error', message: 'An unknown error occurred' } }, 500);
      }
      return reply({ id, object: 'invoice', status: live.get(subId)?.invoice ?? 'paid' });
    }
    if (method === 'GET') {
      if (unreadable.has(id)) {
        return reply({ error: { type: 'api_error', message: 'An unknown error occurred' } }, 500);
      }
      const state = live.get(id);
      return reply({
        id,
        object: 'subscription',
        status: state?.status ?? 'active',
        pause_collection: state?.pause ? { behavior: state.pause, resumes_at: null } : null,
        latest_invoice: state?.invoice === null ? null : `in_${id}`,
      });
    }
    return reply({ id, object: 'subscription', status: 'canceled' });
  }) as typeof fetch;
  const client = new StripeApiClient({
    secretKey: 'sk_test_double',
    baseUrl: 'https://stripe.invalid',
    fetchImpl,
    logger: createTestLogger(),
  });
  return { client, calls, live, unreadable, invoiceUnreadable };
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
  unreadable: Set<string>;
  invoiceUnreadable: Set<string>;
  alerts: SentryMessage[];
  accountId: string;
  /** A stored subscription with `stored` status, and what Stripe holds for it. */
  subscription: (stored: SubscriptionMirror['status'], live: LiveState) => string;
}

function harness(): Harness {
  const authRepo = new InMemoryAuthRepo();
  const accountId = randomUUID();
  const at = new Date('2026-08-01T00:00:00Z');
  authRepo.upsertAccount({
    id: accountId,
    email: `unpaid-${accountId}@example.test`,
    name: null,
    tier: 'api_scale',
    status: 'suspended',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: at,
    updatedAt: at,
  });
  const billingRepo = new InMemoryBillingRepo();
  const { client, calls, live, unreadable, invoiceUnreadable } = stripeDouble();
  const billing = new BillingService(billingRepo, new StripeBillingProvider(client), {
    tierPrices: {},
    defaultSuccessUrl: 'https://app.driftstack.io/billing/success',
    defaultCancelUrl: 'https://app.driftstack.io/billing/cancel',
    portalReturnUrl: 'https://app.driftstack.io/billing',
  });
  const alerts: SentryMessage[] = [];
  const admin = new AccountsAdminService(
    new InMemoryAccountsAdminRepo(authRepo),
    null,
    null,
    null,
    null,
    null,
    { error: () => {}, warn: () => {} },
    billing,
    null,
    { captureMessage: (m: SentryMessage) => alerts.push(m) },
  );
  let n = 0;
  const subscription = (stored: SubscriptionMirror['status'], state: LiveState): string => {
    n += 1;
    const id = `sub_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const createdAt = new Date(Date.UTC(2026, 7, n));
    billingRepo.upsertSubscription({
      id: randomUUID(),
      accountId,
      stripeSubscriptionId: id,
      stripePriceId: 'price_scale_m',
      tier: 'api_scale',
      status: stored,
      currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    live.set(id, state);
    return id;
  };
  return { admin, calls, unreadable, invoiceUnreadable, alerts, accountId, subscription };
}

/** The `prorate` / `invoice_now` the one cancel of `subscriptionId` sent. */
function cancelOf(
  calls: readonly StripeCall[],
  subscriptionId: string,
): { prorate: string | null; invoiceNow: string | null } {
  const found = calls.filter(
    (c) => c.method === 'DELETE' && c.url.pathname === `/v1/subscriptions/${subscriptionId}`,
  );
  expect(found, `exactly one cancel of ${subscriptionId}`).toHaveLength(1);
  return {
    prorate: found[0]!.url.searchParams.get('prorate'),
    invoiceNow: found[0]!.url.searchParams.get('invoice_now'),
  };
}

const NO_CREDIT = { prorate: 'false', invoiceNow: 'false' };
const PRORATED = { prorate: 'true', invoiceNow: 'true' };

describe('"not paid" is one definition', () => {
  it.each([
    [{ status: 'past_due' }, true],
    [{ status: 'unpaid' }, true],
    [{ status: 'active', pauseCollectionBehavior: 'void' }, true],
    [{ status: 'active', pauseCollectionBehavior: 'mark_uncollectible' }, true],
    [{ status: 'active', latestInvoiceStatus: 'open' }, true],
    [{ status: 'active', latestInvoiceStatus: 'void' }, true],
    [{ status: 'active', latestInvoiceStatus: 'uncollectible' }, true],
    [{ status: 'active', latestInvoiceStatus: 'draft' }, true],
    [{ status: 'active', pauseCollectionBehavior: 'void', latestInvoiceStatus: 'void' }, true],
    [
      { status: 'active', pauseCollectionBehavior: 'keep_as_draft', latestInvoiceStatus: 'draft' },
      true,
    ],
    [{ status: 'active', pauseCollectionBehavior: 'void', latestInvoiceStatus: 'paid' }, false],
    [
      {
        status: 'active',
        pauseCollectionBehavior: 'mark_uncollectible',
        latestInvoiceStatus: 'paid',
      },
      false,
    ],
    [{ status: 'active', latestInvoiceStatus: 'paid' }, false],
    [{ status: 'trialing', latestInvoiceStatus: 'paid' }, false],
    [
      { status: 'active', pauseCollectionBehavior: 'keep_as_draft', latestInvoiceStatus: 'paid' },
      false,
    ],
    [{ status: 'active' }, false],
  ])('%o → not paid: %s', (state, expected) => {
    expect(subscriptionWasNotPaid(state)).toBe(expected);
  });
});

describe('terminating an account cancels every unpaid subscription without a credit', () => {
  it('CRITICAL a suspended account whose collection is paused with void is cancelled without a credit', async () => {
    const h = harness();
    const paused = h.subscription('active', { status: 'active', pause: 'void', invoice: 'void' });

    await h.admin.deleteAccount(ctx(), h.accountId, {});

    expect(cancelOf(h.calls, paused)).toEqual(NO_CREDIT);
  });

  it('CRITICAL a subscription paid for its current period and then suspended (paused with void) is still prorated', async () => {
    const h = harness();
    const paused = h.subscription('active', { status: 'active', pause: 'void', invoice: 'paid' });

    await h.admin.deleteAccount(ctx(), h.accountId, {});

    expect(
      cancelOf(h.calls, paused),
      'a paid period was refused its credit because collection was paused',
    ).toEqual(PRORATED);
  });

  it('CRITICAL a subscription paid for its current period and then paused with mark_uncollectible is still prorated', async () => {
    const h = harness();
    const paused = h.subscription('active', {
      status: 'active',
      pause: 'mark_uncollectible',
      invoice: 'paid',
    });

    await h.admin.deleteAccount(ctx(), h.accountId, {});

    expect(cancelOf(h.calls, paused)).toEqual(PRORATED);
  });

  it('collection paused with mark_uncollectible and its renewal written off is cancelled without a credit', async () => {
    const h = harness();
    const paused = h.subscription('active', {
      status: 'active',
      pause: 'mark_uncollectible',
      invoice: 'uncollectible',
    });

    await h.admin.deleteAccount(ctx(), h.accountId, {});

    expect(cancelOf(h.calls, paused)).toEqual(NO_CREDIT);
  });

  it('collection paused with void and no latest invoice to show a payment is cancelled without a credit', async () => {
    const h = harness();
    const paused = h.subscription('active', { status: 'active', pause: 'void', invoice: null });

    await h.admin.deleteAccount(ctx(), h.accountId, {});

    expect(cancelOf(h.calls, paused)).toEqual(NO_CREDIT);
  });

  it('CRITICAL a subscription whose renewal invoice is still a draft (not yet charged) is cancelled without a credit', async () => {
    const h = harness();
    const renewing = h.subscription('active', { status: 'active', pause: null, invoice: 'draft' });

    await h.admin.deleteAccount(ctx(), h.accountId, {});

    expect(
      cancelOf(h.calls, renewing),
      'a period not yet charged was credited as if it had been paid',
    ).toEqual(NO_CREDIT);
  });

  it.each(['open', 'void', 'uncollectible'] as const)(
    'CRITICAL an active subscription whose latest invoice is %s is cancelled without a credit',
    async (invoice) => {
      const h = harness();
      const sub = h.subscription('active', { status: 'active', pause: null, invoice });

      await h.admin.deleteAccount(ctx(), h.accountId, {});

      expect(cancelOf(h.calls, sub)).toEqual(NO_CREDIT);
    },
  );

  it('CRITICAL a subscription Stripe holds as unpaid is cancelled without a credit, whatever the stored status says', async () => {
    const h = harness();
    const sub = h.subscription('active', { status: 'unpaid', pause: null, invoice: 'open' });

    await h.admin.deleteAccount(ctx(), h.accountId, {});

    expect(cancelOf(h.calls, sub)).toEqual(NO_CREDIT);
  });

  it('a past_due subscription is still cancelled without a credit', async () => {
    const h = harness();
    const sub = h.subscription('past_due', { status: 'past_due', pause: null, invoice: 'open' });

    await h.admin.deleteAccount(ctx(), h.accountId, {});

    expect(cancelOf(h.calls, sub)).toEqual(NO_CREDIT);
  });

  it('control: a PAID active subscription is still prorated', async () => {
    const h = harness();
    const paid = h.subscription('active', { status: 'active', pause: null, invoice: 'paid' });

    await h.admin.deleteAccount(ctx(), h.accountId, {});

    expect(cancelOf(h.calls, paid)).toEqual(PRORATED);
  });

  it('control: a trialing subscription whose first invoice was settled is still prorated', async () => {
    const h = harness();
    const trial = h.subscription('trialing', { status: 'trialing', pause: null, invoice: 'paid' });

    await h.admin.deleteAccount(ctx(), h.accountId, {});

    expect(cancelOf(h.calls, trial)).toEqual(PRORATED);
  });

  it('control: a subscription stored past_due whose payment has since cleared is paid, and is prorated', async () => {
    const h = harness();
    const recovered = h.subscription('past_due', {
      status: 'active',
      pause: null,
      invoice: 'paid',
    });

    await h.admin.deleteAccount(ctx(), h.accountId, {});

    expect(cancelOf(h.calls, recovered)).toEqual(PRORATED);
  });

  it('CRITICAL the audit record names each subscription cancelled without a credit, and only those', async () => {
    const h = harness();
    const paid = h.subscription('active', { status: 'active', pause: null, invoice: 'paid' });
    const paused = h.subscription('active', { status: 'active', pause: 'void', invoice: 'void' });
    const open = h.subscription('active', { status: 'active', pause: null, invoice: 'open' });
    const auditRecord: Record<string, unknown> = {};

    await h.admin.deleteAccount(ctx(), h.accountId, auditRecord);

    expect([...(auditRecord.stripe_subscriptions_cancelled as string[])].sort()).toEqual(
      [paid, paused, open].sort(),
    );
    expect(
      [...(auditRecord.stripe_subscriptions_cancelled_without_proration as string[])].sort(),
    ).toEqual([paused, open].sort());
    expect(auditRecord).not.toHaveProperty('stripe_subscriptions_payment_state_unread');
  });

  it('CRITICAL when Stripe cannot be read, the stored status decides, the cancel still happens, and the audit record names it', async () => {
    const h = harness();
    const storedPaid = h.subscription('active', {
      status: 'active',
      pause: 'void',
      invoice: 'void',
    });
    const storedPastDue = h.subscription('past_due', {
      status: 'past_due',
      pause: null,
      invoice: 'open',
    });
    h.unreadable.add(storedPaid);
    h.unreadable.add(storedPastDue);
    const auditRecord: Record<string, unknown> = {};

    await h.admin.deleteAccount(ctx(), h.accountId, auditRecord);

    expect(cancelOf(h.calls, storedPaid)).toEqual(PRORATED);
    expect(cancelOf(h.calls, storedPastDue)).toEqual(NO_CREDIT);
    expect([...(auditRecord.stripe_subscriptions_payment_state_unread as string[])].sort()).toEqual(
      [storedPaid, storedPastDue].sort(),
    );
    expect(auditRecord.stripe_subscriptions_cancelled_without_proration).toEqual([storedPastDue]);
  });

  it('CRITICAL when only the latest invoice cannot be read, the live status still decides, and the audit record names it', async () => {
    const h = harness();
    const lapsed = h.subscription('active', { status: 'past_due', pause: null, invoice: 'open' });
    h.invoiceUnreadable.add(lapsed);
    const auditRecord: Record<string, unknown> = {};

    await h.admin.deleteAccount(ctx(), h.accountId, auditRecord);

    expect(
      cancelOf(h.calls, lapsed),
      'the live status read before the invoice failed was thrown away',
    ).toEqual(NO_CREDIT);
    expect(auditRecord.stripe_subscriptions_payment_state_unread).toEqual([lapsed]);
    expect(auditRecord.stripe_subscriptions_cancelled_without_proration).toEqual([lapsed]);
  });

  it('CRITICAL when only the latest invoice cannot be read, a collection paused with void still decides', async () => {
    const h = harness();
    const paused = h.subscription('active', { status: 'active', pause: 'void', invoice: 'void' });
    h.invoiceUnreadable.add(paused);
    const auditRecord: Record<string, unknown> = {};

    await h.admin.deleteAccount(ctx(), h.accountId, auditRecord);

    expect(
      cancelOf(h.calls, paused),
      'the pause read before the invoice failed was thrown away',
    ).toEqual(NO_CREDIT);
    expect(auditRecord.stripe_subscriptions_payment_state_unread).toEqual([paused]);
  });

  it('control: when only the latest invoice cannot be read, an active subscription not paused is prorated and named', async () => {
    const h = harness();
    const active = h.subscription('active', { status: 'active', pause: null, invoice: 'paid' });
    h.invoiceUnreadable.add(active);
    const auditRecord: Record<string, unknown> = {};

    await h.admin.deleteAccount(ctx(), h.accountId, auditRecord);

    expect(cancelOf(h.calls, active)).toEqual(PRORATED);
    expect(auditRecord.stripe_subscriptions_payment_state_unread).toEqual([active]);
    expect(auditRecord).not.toHaveProperty('stripe_subscriptions_cancelled_without_proration');
  });
});
