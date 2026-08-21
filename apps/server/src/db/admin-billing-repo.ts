// Drizzle-backed AdminBillingRepo — read-only billing analytics for the
// admin cockpit. Aggregates the `subscriptions` mirror; never mutates.

import { inArray, sql } from 'drizzle-orm';
import { AccountTierSchema, type AccountTier } from '@driftstack/api-types';
import type { AdminBillingRepo } from '../services/admin-billing.js';
import type { Database } from './client.js';
import { subscriptions } from './schema.js';

// Subscription statuses Stripe actively bills — the "paying" set.
//
// V-1238 — exported so the in-memory double can read THIS list rather than keep
// its own copy of it. The double used to hardcode `status === 'active' ||
// status === 'trialing'`, which agreed with this line only for as long as nobody
// edited either one. Adding a billed status here (Stripe grants `past_due` a
// retry window in which the subscription is still charged) would have changed the
// revenue figure the admin cockpit shows while every test using the double went
// on reporting the old number, and agreeing with itself.
export const ACTIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing'] as const;

// W197 — only the `db` handle is read; narrow the dependency so e2e
// fixtures stay composable without the full Database envelope.
export class DrizzleAdminBillingRepo implements AdminBillingRepo {
  constructor(private readonly database: Pick<Database, 'db'>) {}

  async countActiveSubscriptionsByTier(): Promise<Record<AccountTier, number>> {
    const rows = await this.database.db
      .select({ tier: subscriptions.tier, cnt: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(inArray(subscriptions.status, [...ACTIVE_SUBSCRIPTION_STATUSES]))
      .groupBy(subscriptions.tier);
    const out = emptyTierCounts();
    for (const row of rows) out[row.tier] = row.cnt;
    return out;
  }
}

/** Zero-filled count record over every AccountTier (canonical enum order). */
function emptyTierCounts(): Record<AccountTier, number> {
  const out = {} as Record<AccountTier, number>;
  for (const tier of AccountTierSchema.options) out[tier] = 0;
  return out;
}
