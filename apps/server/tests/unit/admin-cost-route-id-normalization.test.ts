// Integration test (app.inject) for the admin-cost route's account-id
// normalization. The cost lookups match accounts.id (a bare uuid) directly, so
// /v1/admin/cost/accounts/:id + /overview must accept EITHER the public
// acc_<uuid> form OR a bare uuid and forward the BARE uuid to the service.
//
// Regression guard for the account-detail cost drill-in that 404'd because it
// sent the prefixed id to the strip-less cost route. Content-parity pins alone
// missed that class of wiring bug (it pinned the buggy source as "correct"),
// so this exercises the actual route behavior. See
// project_admin_cost_id_prefix_inconsistency.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAdminCostRoutes } from '../../src/routes/admin-cost.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import type { CostMonitoringService } from '../../src/services/cost-monitoring.js';

const BARE = '11111111-2222-3333-4444-555555555555';

async function harness(): Promise<{
  app: FastifyInstance;
  summaryIds: string[];
  overviewIds: string[];
}> {
  const summaryIds: string[] = [];
  const overviewIds: string[] = [];
  const mockService = {
    getAccountSummary: (args: { accountId: string }) => {
      summaryIds.push(args.accountId);
      return Promise.resolve({
        account_id: args.accountId,
        billing_cycle: '2026-05',
        breakdown: {
          computeCents: 0,
          storageCents: 0,
          egressCents: 0,
          emailCents: 0,
          llmCents: 0,
          totalCents: 0,
          thresholdState: 'under-soft',
        },
        tier: 'api_builder',
        thresholds: { softCents: 0, hardCents: 0 },
      });
    },
    getOverview: (args: { accountIds: readonly string[] }) => {
      overviewIds.push(...args.accountIds);
      return Promise.resolve([]);
    },
    getConfig: () => ({ rates: {}, tierThresholds: {} }),
  } as unknown as CostMonitoringService;

  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  // The cost routes guard with app.requireScope (a decorator the full buildApp
  // factory wires). Stub a no-op so the routes bind; we're testing id wiring.
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  registerAdminCostRoutes(app, { service: mockService });
  await app.ready();
  return { app, summaryIds, overviewIds };
}

describe('admin-cost route — account-id normalization (bareAccountId, app.inject)', () => {
  it('GET /accounts/:id strips the acc_ prefix before the service (the account-detail bug)', async () => {
    const { app, summaryIds } = await harness();
    const res = await app.inject({ method: 'GET', url: `/v1/admin/cost/accounts/acc_${BARE}` });
    expect(res.statusCode).toBe(200);
    expect(summaryIds).toEqual([BARE]); // service saw the BARE uuid, not acc_<uuid>
    await app.close();
  });

  it('GET /accounts/:id passes a bare uuid through unchanged (the cost-page path)', async () => {
    const { app, summaryIds } = await harness();
    const res = await app.inject({ method: 'GET', url: `/v1/admin/cost/accounts/${BARE}` });
    expect(res.statusCode).toBe(200);
    expect(summaryIds).toEqual([BARE]);
    await app.close();
  });

  // V-1580 — the three arms above are all well-formed ids, so they could not see
  // that the route handed whatever it was given to a service backed by a uuid
  // column. A malformed id was a cast error there and surfaced as a 500 for what
  // is plainly a bad request. One negative per call site; the overview arm uses a
  // mixed list so it proves every element is checked, not just the first.
  it('GET /accounts/:id refuses a malformed id at the boundary rather than casting it', async () => {
    const { app, summaryIds } = await harness();
    const res = await app.inject({ method: 'GET', url: '/v1/admin/cost/accounts/acc_not-a-uuid' });
    expect(res.statusCode, 'a malformed id is a bad request, not a server error').toBe(400);
    expect(summaryIds, 'and it never reached the service').toEqual([]);
    await app.close();
  });

  it('GET /overview refuses the whole list when any single account_id is malformed', async () => {
    const { app, overviewIds } = await harness();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/cost/overview?account_ids=${BARE},not-a-uuid`,
    });
    expect(res.statusCode, 'a bad id anywhere in the CSV is refused').toBe(400);
    expect(overviewIds, 'and no partial query ran').toEqual([]);
    await app.close();
  });

  it('GET /overview normalizes every account_id (mixed prefixed + bare → bare)', async () => {
    const { app, overviewIds } = await harness();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/cost/overview?account_ids=acc_${BARE},${BARE}`,
    });
    expect(res.statusCode).toBe(200);
    expect(overviewIds).toEqual([BARE, BARE]);
    await app.close();
  });
});
