// Admin billing analytics routes (admin-only, read-only).
//
//   GET /v1/admin/billing/subscriptions/stats
//
// Returns the active-subscription distribution by tier — the
// paying-customer mix for the admin cockpit. "Active" = a
// Stripe-billed status (active/trialing). DISTINCT from
// /v1/admin/overview's accounts.by_tier, which counts each account's
// ASSIGNED tier (free-tier accounts included, no subscription required).
// Read-only; no audit row written.

import type { FastifyInstance } from 'fastify';
import type { AdminBillingService } from '../services/admin-billing.js';

export interface AdminBillingRoutesOptions {
  adminBilling: AdminBillingService;
}

export function registerAdminBillingRoutes(
  app: FastifyInstance,
  opts: AdminBillingRoutesOptions,
): void {
  const { adminBilling } = opts;

  app.get(
    '/v1/admin/billing/subscriptions/stats',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');

      // total_active is derived from by_tier so the two can never
      // disagree (the dashboard renders both without a second roundtrip).
      const byTier = await adminBilling.countActiveSubscriptionsByTier(ctx);
      const totalActive = Object.values(byTier).reduce((sum, n) => sum + n, 0);

      return {
        by_tier: byTier,
        total_active: totalActive,
      };
    },
  );
}
