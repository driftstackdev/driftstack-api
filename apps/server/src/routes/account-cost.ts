// V-541.D — customer-facing cost surface.
// GET /v1/account/cost?billing_cycle=YYYY-MM
//
// Scoped to the calling account via requireAuth — the service is
// reused from the admin path (V-541.B) but the account id is pinned
// to ctx.account.id, not pulled from a URL param.
//
// #122 read:billing floor (2026-07-08) — the cost breakdown is billing
// data, so this read requires read:billing (a broad `read` / account_owner
// key satisfies it via V-481; a narrow non-billing key is refused).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type CostMonitoringService, billingCycleFromDate } from '../services/cost-monitoring.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';

const Query = z.object({
  billing_cycle: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
});

export interface RegisterAccountCostRoutesDeps {
  service: CostMonitoringService;
  /** Test seam. Defaults to Date.now. */
  nowFn?: () => number;
}

export function registerAccountCostRoutes(
  app: FastifyInstance,
  deps: RegisterAccountCostRoutesDeps,
): void {
  const now = deps.nowFn ?? Date.now;

  app.get<{ Querystring: { billing_cycle?: string } }>(
    '/v1/account/cost',
    { preHandler: [app.requireAuth, app.requireScope('read:billing'), app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const query = parseOrThrow(Query, request.query);
      const summary = await deps.service.getAccountSummary({
        accountId: ctx.account.id,
        billingCycle: query.billing_cycle ?? billingCycleFromDate(new Date(now())),
      });
      if (summary === null) {
        // Not 404 — for a fresh account with no usage in the cycle the
        // customer should see "you've spent €0 this cycle", not "not
        // found". Synthesize a zero breakdown response.
        return reply.send({
          // S46 2026-07-07 (founder-approved) — canonical acc_ prefix, mirroring
          // GET /v1/account/me (routes/account-me.ts). Was the bare uuid — the
          // one customer surface leaking the unprefixed internal id.
          account_id: `acc_${ctx.account.id}`,
          billing_cycle: query.billing_cycle ?? billingCycleFromDate(new Date(now())),
          tier: ctx.account.tier,
          breakdown: {
            computeCents: 0,
            storageCents: 0,
            egressCents: 0,
            emailCents: 0,
            llmCents: 0,
            totalCents: 0,
            thresholdState: 'under-soft' as const,
          },
        });
      }
      // Customer surface omits the operator-tuned threshold values
      // (those are admin-only configuration; we don't surface the
      // numeric caps to customers — they see only their actual spend).
      return reply.send({
        // S46 2026-07-07 (founder-approved) — acc_ prefix (see the zero-usage
        // branch above). The service echoes the bare uuid it was queried with.
        account_id: `acc_${summary.account_id}`,
        billing_cycle: summary.billing_cycle,
        tier: summary.tier,
        breakdown: summary.breakdown,
      });
    },
  );

  // Make the 404 reachable explicitly for clients that want to
  // distinguish "account exists, no data" from "account doesn't
  // exist". Not currently routed; left as a hook for V-541.E
  // detailed-view scope.
  void NotFoundError;
}

function parseOrThrow<T>(schema: z.ZodSchema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  // Don't leak the raw zod error JSON into the customer-facing problem detail;
  // the only validated query is billing_cycle (YYYY-MM).
  if (!result.success) throw new BadRequestError('Invalid query: billing_cycle must be YYYY-MM.');
  return result.data;
}
