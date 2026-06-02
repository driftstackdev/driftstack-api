// Admin overview route — single endpoint returning the headline counts
// the admin panel renders on its index page (active accounts,
// suspended accounts, DLQ depth). Read-only; no audit row written.
//
// Adding individual count methods (countByStatus, countDlqDeliveries)
// keeps this endpoint single-roundtrip rather than asking the
// dashboard to iterate the list endpoints. Open-leads count is not
// included today — leads tracking has no Postgres surface yet (the
// admin /leads page is mock-only). When the leads endpoint lands,
// extend this response with `leads: { open: number }`.

import type { FastifyInstance } from 'fastify';
import type { AccountsAdminService } from '../services/admin-accounts.js';
import type { WebhooksAdminService } from '../services/webhooks.js';

export interface AdminOverviewRoutesOptions {
  accountsAdmin: AccountsAdminService;
  webhooksAdmin: WebhooksAdminService;
}

export function registerAdminOverviewRoutes(
  app: FastifyInstance,
  opts: AdminOverviewRoutesOptions,
): void {
  const { accountsAdmin, webhooksAdmin } = opts;

  app.get(
    '/v1/admin/overview',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');

      // V-515 — also surface deleted-account count + computed total
      // so the admin panel can show "X of Y accounts active" without
      // a second roundtrip.
      //
      // by_tier — account distribution across every AccountTier (one
      // GROUP BY count, zero-filled). Lets the dashboard render the
      // tier-mix stat without a separate roundtrip; sum equals total.
      //
      // signups — new-account counts over rolling windows (today/7d/30d,
      // UTC) so the dashboard can show the growth trend in the same
      // roundtrip. `now` is injected for deterministic windowing.
      const [activeAccounts, suspendedAccounts, deletedAccounts, byTier, signups, dlqDepth] =
        await Promise.all([
          accountsAdmin.countByStatus(ctx, 'active'),
          accountsAdmin.countByStatus(ctx, 'suspended'),
          accountsAdmin.countByStatus(ctx, 'deleted'),
          accountsAdmin.countByTier(ctx),
          accountsAdmin.signupCounts(ctx, new Date()),
          webhooksAdmin.countDlq(ctx),
        ]);

      return {
        accounts: {
          active: activeAccounts,
          suspended: suspendedAccounts,
          deleted: deletedAccounts,
          total: activeAccounts + suspendedAccounts + deletedAccounts,
          by_tier: byTier,
          signups,
        },
        webhooks: {
          dlq_depth: dlqDepth,
        },
      };
    },
  );
}
