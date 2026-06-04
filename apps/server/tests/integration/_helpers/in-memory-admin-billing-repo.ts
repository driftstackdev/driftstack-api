// In-memory AdminBillingRepo for integration tests. Mirrors the Drizzle
// repo's active-subscription-by-tier aggregate over a seeded set of
// subscription rows.

import { AccountTierSchema, type AccountTier } from '@driftstack/api-types';
import type { AdminBillingRepo } from '../../../src/services/admin-billing.js';

interface SeedSubscription {
  tier: AccountTier;
  status: string;
}

export class InMemoryAdminBillingRepo implements AdminBillingRepo {
  private readonly subs: SeedSubscription[] = [];

  /** Test seam: record a subscription mirror row. */
  upsertSubscription(s: SeedSubscription): void {
    this.subs.push(s);
  }

  countActiveSubscriptionsByTier(): Promise<Record<AccountTier, number>> {
    const out = {} as Record<AccountTier, number>;
    for (const tier of AccountTierSchema.options) out[tier] = 0;
    for (const s of this.subs) {
      if (s.status === 'active' || s.status === 'trialing') out[s.tier] += 1;
    }
    return Promise.resolve(out);
  }
}
