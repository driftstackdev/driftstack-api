// Admin billing analytics (admin-only, read-only).
//
// Backs GET /v1/admin/billing/subscriptions/stats — the paying-customer
// mix the admin cockpit renders: active subscriptions grouped by tier.
// "Active" means a subscription Stripe currently bills: status in
// ('active','trialing'). This is DISTINCT from the accounts-by-tier
// count on /v1/admin/overview, which reflects each account's ASSIGNED
// tier (including free-tier accounts that have no subscription at all) —
// so this endpoint answers "who is actually paying, and at what tier".
//
// Read-only: no audit row, no mutation. Scope-gated to
// driftstack_internal_admin (revenue VISIBILITY, not an owner-only
// control) — the gate lives here in the service so every caller route
// goes through the same check.

import type { AccountTier } from '@driftstack/api-types';
import type { AccountContext } from './auth.js';
import { requireScope as throwIfMissingScope } from '../lib/errors-helpers.js';

export interface AdminBillingRepo {
  /**
   * Active-subscription count grouped by tier — every AccountTier present,
   * zero-filled (canonical enum order). "Active" = status in
   * ('active','trialing'). Counts subscription rows, not accounts.
   */
  countActiveSubscriptionsByTier(): Promise<Record<AccountTier, number>>;
}

export class AdminBillingService {
  constructor(private readonly repo: AdminBillingRepo) {}

  async countActiveSubscriptionsByTier(ctx: AccountContext): Promise<Record<AccountTier, number>> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    return this.repo.countActiveSubscriptionsByTier();
  }
}
