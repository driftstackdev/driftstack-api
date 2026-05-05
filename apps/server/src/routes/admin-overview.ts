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

      const [activeAccounts, suspendedAccounts, dlqDepth] = await Promise.all([
        accountsAdmin.countByStatus(ctx, 'active'),
        accountsAdmin.countByStatus(ctx, 'suspended'),
        webhooksAdmin.countDlq(ctx),
      ]);

      return {
        accounts: {
          active: activeAccounts,
          suspended: suspendedAccounts,
        },
        webhooks: {
          dlq_depth: dlqDepth,
        },
      };
    },
  );
}
