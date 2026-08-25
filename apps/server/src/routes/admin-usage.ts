// V-689 — admin usage-summary route.
//
//   GET /v1/admin/usage/accounts/:id
//
// Returns the same shape UsageService.currentPeriodSummary produces
// for the caller, but for an arbitrary account by id. Used by ops
// when triaging "is this customer hitting our infra harder than
// their tier suggests?" without needing a customer-side API key.
//
// Auth: driftstack_internal_admin. Tier lookup goes through
// AccountsAdminService (same source the admin accounts route uses)
// so the answer can't drift from what the admin dashboard shows.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BadRequestError } from '../lib/errors.js';
import type { AccountsAdminService } from '../services/admin-accounts.js';
import type { UsageService } from '../services/usage.js';

export interface RegisterAdminUsageRoutesDeps {
  usageService: UsageService;
  accountsAdminService: AccountsAdminService;
}

// account id is `acc_<36-char-uuid>` (40 chars); 100 cap matches
// the slice 116/117 defensive pattern.
const Params = z.object({ id: z.string().min(1).max(100) });

const ACCOUNT_ID_RE = /^(?:acc_)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * V-1580 — the `:id` param reaches a `uuid` column. A value that is not a uuid is
 * a cast error there, which surfaces as a 500 for what is really a bad request,
 * so the shape is checked at the boundary. `acc_` is accepted because that is the
 * id the API publishes; the bare form is accepted because operators paste it.
 */
function accountUuidFromParam(value: string): string {
  const match = ACCOUNT_ID_RE.exec(value);
  if (!match?.[1]) {
    throw new BadRequestError('Invalid id format. Expected "acc_<uuid>" or a bare UUID.');
  }
  return match[1];
}

export function registerAdminUsageRoutes(
  app: FastifyInstance,
  deps: RegisterAdminUsageRoutesDeps,
): void {
  app.get<{ Params: { id: string } }>(
    '/v1/admin/usage/accounts/:id',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const params = parseOrThrow(Params, req.params);
      // AccountsAdminService.getAccount enforces the same scope check
      // as our preHandler — kept to surface 404 on unknown ids using
      // the same NotFoundError shape every other admin route uses.
      const account = await deps.accountsAdminService.getAccount(
        req.account!,
        accountUuidFromParam(params.id),
      );
      const summary = await deps.usageService.summaryFor(account.id, account.tier);
      return reply.send({
        account_id: account.id,
        tier: account.tier,
        period_start: summary.periodStart.toISOString(),
        period_end: summary.periodEnd.toISOString(),
        totals: summary.totals,
        quotas: summary.quotas,
      });
    },
  );
}

function parseOrThrow<T>(schema: z.ZodSchema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestError(result.error.message);
  return result.data;
}
