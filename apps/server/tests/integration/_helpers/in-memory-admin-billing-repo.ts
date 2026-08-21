// In-memory AdminBillingRepo for integration tests. Mirrors the Drizzle
// repo's active-subscription-by-tier aggregate over a seeded set of
// subscription rows.

import { AccountTierSchema, type AccountTier } from '@driftstack/api-types';
import type { AdminBillingRepo } from '../../../src/services/admin-billing.js';
import { ACTIVE_SUBSCRIPTION_STATUSES } from '../../../src/db/admin-billing-repo.js';

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
    // V-1238 — the billed-status set is read from the Drizzle repo rather than
    // restated here. It used to be `s.status === 'active' || s.status ===
    // 'trialing'`: the same two values, and correct only until one side moved.
    const billed: readonly string[] = ACTIVE_SUBSCRIPTION_STATUSES;
    for (const s of this.subs) {
      if (billed.includes(s.status)) out[s.tier] += 1;
    }
    return Promise.resolve(out);
  }
}
