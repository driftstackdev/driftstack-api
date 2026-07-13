// Unit tests for BillingService internals (V-086 coverage audit).
//
// Most billing paths are covered by the integration tests in
// tests/integration/billing.test.ts via the route. This file tests
// service-level paths that are awkward to reach through the route:
// the BadRequestError raised when `tierPrices` is missing an entry
// for a self-serve tier.

import { describe, expect, it } from 'vitest';
import {
  BillingService,
  type BillingProvider,
  type BillingRepo,
} from '../../src/services/billing.js';
import {
  InMemoryBillingProvider,
  InMemoryBillingRepo,
} from '../integration/_helpers/in-memory-billing.js';

function makeService(
  repo: BillingRepo,
  provider: BillingProvider,
  config: Partial<Parameters<typeof makeServiceConfig>[0]> = {},
): BillingService {
  return new BillingService(repo, provider, makeServiceConfig(config));
}

function makeServiceConfig(args: {
  includeApiStarter?: boolean;
}): Parameters<typeof BillingService.prototype.createCheckoutSession>[0] extends never
  ? never
  : ConstructorParameters<typeof BillingService>[2] {
  const tierPrices: ConstructorParameters<typeof BillingService>[2]['tierPrices'] = {};
  if (args.includeApiStarter !== false) {
    tierPrices.api_starter = {
      monthly: 'price_api_starter_monthly',
      annual: 'price_api_starter_annual',
    };
  }
  return {
    tierPrices,
    defaultSuccessUrl: 'http://localhost/success',
    defaultCancelUrl: 'http://localhost/cancel',
    portalReturnUrl: 'http://localhost/billing',
  };
}

function seedAccount(repo: InMemoryBillingRepo, accountId: string): void {
  repo.upsertAccount({
    id: accountId,
    email: 'tester@driftstack.local',
    name: null,
    tier: 'api_builder',
    stripeCustomerId: null,
  });
}

describe('BillingService.createCheckoutSession — missing tier in price map', () => {
  it('throws BadRequest when the requested tier has no configured prices', async () => {
    const repo = new InMemoryBillingRepo();
    const provider = new InMemoryBillingProvider();
    const accountId = '00000000-0000-4000-8000-000000000abc';
    seedAccount(repo, accountId);

    const service = makeService(repo, provider, { includeApiStarter: false });

    await expect(
      service.createCheckoutSession({
        accountId,
        tier: 'api_starter',
        billingPeriod: 'monthly',
      }),
    ).rejects.toMatchObject({
      status: 400,
      title: 'Bad Request',
    });
  });

  it('throws NotFound when the account does not exist', async () => {
    const repo = new InMemoryBillingRepo();
    const provider = new InMemoryBillingProvider();
    const service = makeService(repo, provider);

    await expect(
      service.createCheckoutSession({
        accountId: 'no-such-account',
        tier: 'api_starter',
        billingPeriod: 'monthly',
      }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('BillingService.createCheckoutSession — idempotency propagation', () => {
  it('passes a supplied key unchanged to the billing provider', async () => {
    const repo = new InMemoryBillingRepo();
    const provider = new InMemoryBillingProvider();
    const accountId = '00000000-0000-4000-8000-000000000abd';
    seedAccount(repo, accountId);
    const original = provider.createSubscriptionCheckout.bind(provider);
    let receivedKey: string | undefined;
    provider.createSubscriptionCheckout = async (args) => {
      receivedKey = args.idempotencyKey;
      return original(args);
    };

    await makeService(repo, provider).createCheckoutSession({
      accountId,
      tier: 'api_starter',
      billingPeriod: 'monthly',
      idempotencyKey: 'checkout-attempt-123',
    });

    expect(receivedKey).toBe('checkout-attempt-123');
  });
});

// Double-subscribe guard — an already-subscribed customer hitting
// checkout-session again (e.g. a stale "Change plan" link routing
// through Checkout instead of the portal) must NOT be able to mint a
// second concurrent Stripe subscription. Covers both blocked statuses
// (active / trialing) and the statuses that must stay allowed through
// (past_due / canceled — not currently billed, so re-checkout is a
// legitimate recovery path) plus the no-prior-subscription happy path.
describe('BillingService.createCheckoutSession — double-subscribe guard', () => {
  const accountId = '00000000-0000-4000-8000-000000000def';

  function seed(repo: InMemoryBillingRepo): void {
    seedAccount(repo, accountId);
  }

  it('409 Conflict when the account already has an ACTIVE subscription', async () => {
    const repo = new InMemoryBillingRepo();
    const provider = new InMemoryBillingProvider();
    seed(repo);
    repo.upsertSubscription({
      id: 'sub_existing_active',
      accountId,
      stripeSubscriptionId: 'sub_test_existing_active',
      stripePriceId: 'price_api_builder_monthly',
      tier: 'api_builder',
      status: 'active',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      createdAt: new Date('2026-06-01T00:00:00Z'),
      updatedAt: new Date('2026-06-01T00:00:00Z'),
    });
    const service = makeService(repo, provider);

    await expect(
      service.createCheckoutSession({
        accountId,
        tier: 'api_starter',
        billingPeriod: 'monthly',
      }),
    ).rejects.toMatchObject({ status: 409 });

    // No checkout session was started — the guard short-circuits before
    // ever reaching the provider.
    expect(provider.state.checkoutSessions).toHaveLength(0);
  });

  it('409 Conflict when the account already has a TRIALING subscription', async () => {
    const repo = new InMemoryBillingRepo();
    const provider = new InMemoryBillingProvider();
    seed(repo);
    repo.upsertSubscription({
      id: 'sub_existing_trial',
      accountId,
      stripeSubscriptionId: 'sub_test_existing_trial',
      stripePriceId: 'price_api_builder_monthly',
      tier: 'api_builder',
      status: 'trialing',
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      createdAt: new Date('2026-06-01T00:00:00Z'),
      updatedAt: new Date('2026-06-01T00:00:00Z'),
    });
    const service = makeService(repo, provider);

    await expect(
      service.createCheckoutSession({
        accountId,
        tier: 'api_starter',
        billingPeriod: 'monthly',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it.each([
    'past_due',
    'canceled',
    'incomplete',
    'incomplete_expired',
    'unpaid',
    'paused',
  ] as const)(
    'allows a new checkout when the existing subscription is %s (not currently billed)',
    async (status) => {
      const repo = new InMemoryBillingRepo();
      const provider = new InMemoryBillingProvider();
      seed(repo);
      repo.upsertSubscription({
        id: `sub_existing_${status}`,
        accountId,
        stripeSubscriptionId: `sub_test_existing_${status}`,
        stripePriceId: 'price_api_builder_monthly',
        tier: 'api_builder',
        status,
        currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
        cancelAtPeriodEnd: false,
        canceledAt: status === 'canceled' ? new Date('2026-06-15T00:00:00Z') : null,
        createdAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-01T00:00:00Z'),
      });
      const service = makeService(repo, provider);

      const result = await service.createCheckoutSession({
        accountId,
        tier: 'api_starter',
        billingPeriod: 'monthly',
      });
      expect(result.url).toMatch(/^https:\/\/checkout\.stripe\.example\//);
    },
  );

  it('allows checkout when the account has no prior subscription at all', async () => {
    const repo = new InMemoryBillingRepo();
    const provider = new InMemoryBillingProvider();
    seed(repo);
    const service = makeService(repo, provider);

    const result = await service.createCheckoutSession({
      accountId,
      tier: 'api_starter',
      billingPeriod: 'monthly',
    });
    expect(result.url).toMatch(/^https:\/\/checkout\.stripe\.example\//);
  });
});

describe('BillingService.createPortalSession', () => {
  it('throws NotFound when account does not exist', async () => {
    const repo = new InMemoryBillingRepo();
    const provider = new InMemoryBillingProvider();
    const service = makeService(repo, provider);

    await expect(service.createPortalSession('no-such-account')).rejects.toMatchObject({
      status: 404,
    });
  });
});
