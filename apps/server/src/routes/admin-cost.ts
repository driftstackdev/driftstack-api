// V-541.B — admin cost-monitoring routes.
//
//   GET /v1/admin/cost/accounts/:id?billing_cycle=YYYY-MM
//   GET /v1/admin/cost/overview?account_ids=a,b,c&billing_cycle=YYYY-MM
//
// Auth: driftstack_internal_admin scope (V-326e6 pattern).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NotFoundError, BadRequestError } from '../lib/errors.js';
import {
  BILLING_CYCLE_PATTERN,
  type CostMonitoringService,
  billingCycleFromDate,
} from '../services/cost-monitoring.js';

const AccountSummaryParams = z.object({
  // account id is `acc_<36-char-uuid>` (40 chars); 100 cap matches
  // the slice 116/117 defensive pattern.
  id: z.string().min(1).max(100),
});
const AccountSummaryQuery = z.object({
  billing_cycle: z.string().regex(BILLING_CYCLE_PATTERN).optional(),
});
const OverviewQuery = z.object({
  // Comma-separated list of account ids. Cap at 4096 chars — fits
  // ~100 ids at 40 chars + separators; abuse beyond that crosses
  // into HTTP-header / URL-length territory anyway.
  account_ids: z.string().min(1).max(4096),
  billing_cycle: z.string().regex(BILLING_CYCLE_PATTERN).optional(),
});

// Normalize to the bare uuid the cost lookups need: accept either the public
// `acc_<uuid>` form (every other admin /:id route's convention, via
// uuidFromPrefixedId) or a bare uuid. The cost service matches accounts.id
// (a bare uuid) directly, so strip the prefix here. Safe: a bare uuid can't
// start with `acc_` (uuids contain no underscore). Without this, an operator
// pasting the public `acc_<uuid>` id 404'd — the account-detail cost drill-in
// hit exactly that. See project_admin_cost_id_prefix_inconsistency.
export function bareAccountId(id: string): string {
  return id.startsWith('acc_') ? id.slice(4) : id;
}

// V-1580 — `bareAccountId` STRIPS; it does not validate, and its own tests pin
// that (`bareAccountId('ses_<uuid>')` returns the value unchanged). Stripping
// and validating are different jobs, so the shape check belongs here, at the
// call site, on the normalised result. `cost_daily.account_id` is a `uuid`
// column: without this a malformed id reaches Postgres as an invalid cast
// (22P02) and the route answers 500 where the boundary owes 400.
const BARE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function accountUuidFromParam(value: string): string {
  const bare = bareAccountId(value);
  if (!BARE_UUID_RE.test(bare)) {
    throw new BadRequestError('Invalid id format. Expected "acc_<uuid>" or a bare UUID.');
  }
  return bare;
}

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
        accountId: accountUuidFromParam(params.id),
        billingCycle: query.billing_cycle ?? billingCycleFromDate(new Date(now())),
      });
      if (summary === null) {
        throw new NotFoundError('Account has no usage in the requested billing cycle.');
      }
      return reply.send(summary);
    },
  );

  // V-683 — config inspector. Returns the wired rate card + tier
  // thresholds without touching usage data. Useful for ops to verify
  // a deploy + for the "what did we ship?" admin dashboard.
  app.get(
    '/v1/admin/cost/config',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    (_req, reply) => {
      return reply.send(deps.service.getConfig());
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
        .filter(Boolean)
        .map(accountUuidFromParam);
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
