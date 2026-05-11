// V-541.B — admin cost-monitoring routes.
//
//   GET /v1/admin/cost/accounts/:id?billing_cycle=YYYY-MM
//   GET /v1/admin/cost/overview?account_ids=a,b,c&billing_cycle=YYYY-MM
//
// Auth: driftstack_internal_admin scope (V-326e6 pattern).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NotFoundError, BadRequestError } from '../lib/errors.js';
import { type CostMonitoringService, billingCycleFromDate } from '../services/cost-monitoring.js';

const AccountSummaryParams = z.object({
  id: z.string().min(1),
});
const AccountSummaryQuery = z.object({
  billing_cycle: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
});
const OverviewQuery = z.object({
  account_ids: z.string().min(1),
  billing_cycle: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
});

export interface RegisterAdminCostRoutesDeps {
  service: CostMonitoringService;
  /** Time source — defaults to `Date.now`. Test seam. */
  nowFn?: () => number;
}

export function registerAdminCostRoutes(
  app: FastifyInstance,
  deps: RegisterAdminCostRoutesDeps,
): void {
  const now = deps.nowFn ?? Date.now;

  app.get<{ Params: { id: string }; Querystring: { billing_cycle?: string } }>(
    '/v1/admin/cost/accounts/:id',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (
      req: FastifyRequest<{ Params: { id: string }; Querystring: { billing_cycle?: string } }>,
      reply,
    ) => {
      const params = parseOrThrow(AccountSummaryParams, req.params);
      const query = parseOrThrow(AccountSummaryQuery, req.query);
      const summary = await deps.service.getAccountSummary({
        accountId: params.id,
        billingCycle: query.billing_cycle ?? billingCycleFromDate(new Date(now())),
      });
      if (summary === null) {
        throw new NotFoundError('Account has no usage in the requested billing cycle.');
      }
      return reply.send(summary);
    },
  );

  app.get<{ Querystring: { account_ids: string; billing_cycle?: string } }>(
    '/v1/admin/cost/overview',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (
      req: FastifyRequest<{ Querystring: { account_ids: string; billing_cycle?: string } }>,
      reply,
    ) => {
      const query = parseOrThrow(OverviewQuery, req.query);
      const ids = query.account_ids
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) {
        throw new BadRequestError('account_ids must contain at least one id.');
      }
      const summaries = await deps.service.getOverview({
        accountIds: ids,
        billingCycle: query.billing_cycle ?? billingCycleFromDate(new Date(now())),
      });
      return reply.send({ summaries });
    },
  );
}

function parseOrThrow<T>(schema: z.ZodSchema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestError(result.error.message);
  return result.data;
}
