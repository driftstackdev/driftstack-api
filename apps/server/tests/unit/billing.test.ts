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
  trialPackPriceId?: string;
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
    trialPackPriceId: args.trialPackPriceId ?? 'price_trial_pack',
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
    trialPackPurchasedAt: null,
    trialPackCreditCents: null,
    trialPackExpiresAt: null,
    trialPackRedeemed: false,
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

describe('BillingService.startTrialPack', () => {
  it('throws NotFound when account does not exist', async () => {
    const repo = new InMemoryBillingRepo();
    const provider = new InMemoryBillingProvider();
    const service = makeService(repo, provider);

    await expect(service.startTrialPack({ accountId: 'no-such-account' })).rejects.toMatchObject({
      status: 404,
    });
  });
});
