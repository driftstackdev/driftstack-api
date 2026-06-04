// Unit tests for AdminBillingService — the admin-cockpit billing
// analytics service backing GET /v1/admin/billing/subscriptions/stats.
//
// Surface under test:
//   - countActiveSubscriptionsByTier: scope gate (driftstack_internal_admin)
//     + repo pass-through
//   - "active" filter = status in ('active','trialing'); other statuses
//     (canceled / past_due / incomplete / paused) are excluded
//   - every AccountTier present (zero-filled), counts subscription rows

import { describe, expect, it } from 'vitest';
import { AccountTierSchema, type ApiKeyScope } from '@driftstack/api-types';
import { AdminBillingService } from '../../src/services/admin-billing.js';
import type { AccountContext } from '../../src/services/auth.js';
import { InMemoryAdminBillingRepo } from '../integration/_helpers/in-memory-admin-billing-repo.js';
import { ForbiddenError } from '../../src/lib/errors.js';

function ctxWith(scopes: ApiKeyScope[]): AccountContext {
  return {
    account: { id: 'acc_admin' },
    apiKey: { id: 'key_admin', scopes },
  } as unknown as AccountContext;
}

const ADMIN = ctxWith(['driftstack_internal_admin']);

describe('AdminBillingService.countActiveSubscriptionsByTier', () => {
  it('requires the driftstack_internal_admin scope (non-admin → ForbiddenError)', async () => {
    const svc = new AdminBillingService(new InMemoryAdminBillingRepo());
    await expect(svc.countActiveSubscriptionsByTier(ctxWith(['read:sessions']))).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('zero-fills every AccountTier when there are no subscriptions', async () => {
    const svc = new AdminBillingService(new InMemoryAdminBillingRepo());
    const byTier = await svc.countActiveSubscriptionsByTier(ADMIN);
    expect(Object.keys(byTier).sort()).toEqual([...AccountTierSchema.options].sort());
    for (const tier of AccountTierSchema.options) expect(byTier[tier]).toBe(0);
  });

  it('counts only active+trialing subscriptions, grouped by tier', async () => {
    const repo = new InMemoryAdminBillingRepo();
    repo.upsertSubscription({ tier: 'solo_manual', status: 'active' });
    repo.upsertSubscription({ tier: 'solo_manual', status: 'trialing' });
    repo.upsertSubscription({ tier: 'team_manual', status: 'active' });
    // Excluded statuses — must not be counted.
    repo.upsertSubscription({ tier: 'team_manual', status: 'canceled' });
    repo.upsertSubscription({ tier: 'api_scale', status: 'past_due' });
    repo.upsertSubscription({ tier: 'api_scale', status: 'incomplete' });

    const byTier = await new AdminBillingService(repo).countActiveSubscriptionsByTier(ADMIN);
    expect(byTier.solo_manual).toBe(2);
    expect(byTier.team_manual).toBe(1);
    expect(byTier.api_scale).toBe(0);
  });
});
