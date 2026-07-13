// Integration test (app.inject) for the customer recipes route's read/
// management path: GET /v1/recipes (list), GET /:id (detail), DELETE /:id.
// Verifies the route scopes EVERY lookup by the AUTHED account (ctx.account.id)
// — a client can't reach another account's recipe by id — plus the 404-on-
// missing posture (existence not leaked). Content-parity pins the source; this
// exercises the actual route wiring (the gap class that hid the cost-route id
// bug). Extends the app.inject route-integration pattern to an authed route.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { registerRecipesRoutes } from '../../src/routes/recipes.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import type { RecipesRepo, RecipeRecord } from '../../src/services/recipes.js';
import type { AgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';

const ACC = '11111111-2222-3333-4444-555555555555';
const RECIPE = {
  id: 'rec_known1',
  accountId: ACC,
  agentSessionId: 'agt_x',
  label: 'checkout flow',
  description: null,
  intentLog: [
    { kind: 'navigate', url: 'https://example.com' },
    {
      kind: 'interact',
      action: 'type',
      selector: '#password',
      value: 'correct horse battery staple',
      sensitive: true,
    },
    {
      kind: 'interact',
      action: 'type',
      selector: '[autocomplete=one-time-code]',
      value: '839201',
      sensitive: false,
    },
    { kind: 'interact', action: 'type', selector: '#username', value: 'alice@example.com' },
    { kind: 'interact', action: 'tap', selector: '#submit', value: 'Submit' },
  ],
  transcriptSnapshot: [],
  createdAt: new Date('2026-05-20T10:00:00.000Z'),
  updatedAt: new Date('2026-05-20T10:00:00.000Z'),
} as unknown as RecipeRecord;

async function harness(sessionSource: unknown = null): Promise<{
  app: FastifyInstance;
  getByIdAccounts: string[];
  deleteAccounts: string[];
  listAccounts: string[];
}> {
  const getByIdAccounts: string[] = [];
  const deleteAccounts: string[] = [];
  const listAccounts: string[] = [];
  const recipes = {
    list: (args: { accountId: string }) => {
      listAccounts.push(args.accountId);
      return Promise.resolve({ data: [RECIPE], hasMore: false, nextCursor: null });
    },
    getById: (args: { accountId: string; id: string }) => {
      getByIdAccounts.push(args.accountId);
      return Promise.resolve(args.accountId === ACC && args.id === RECIPE.id ? RECIPE : null);
    },
    deleteById: (args: { accountId: string; id: string }) => {
      deleteAccounts.push(args.accountId);
      return Promise.resolve(args.accountId === ACC && args.id === RECIPE.id);
    },
    create: () => Promise.resolve(RECIPE),
  } as unknown as RecipesRepo;
  const agentSessions = {
    get: () => Promise.resolve(sessionSource),
  } as unknown as AgentSessionsRepo;

  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  // requireAuth stub sets the authed account context the route scopes by.
  app.decorate('requireAuth', (req: FastifyRequest) => {
    (req as { account: unknown }).account = { account: { id: ACC } };
    return Promise.resolve();
  });
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerRecipesRoutes(app, { recipes, agentSessions });
  await app.ready();
  return { app, getByIdAccounts, deleteAccounts, listAccounts };
}

describe('recipes route — read/management wiring (app.inject)', () => {
  it('GET /v1/recipes lists the authed account rows (scoped by ctx.account.id)', async () => {
    const { app, listAccounts } = await harness();
    const res = await app.inject({ method: 'GET', url: '/v1/recipes' });
    expect(res.statusCode).toBe(200);
    // Assert on the raw payload string (res.json() is any-typed).
    expect(res.payload).toContain(RECIPE.id);
    expect(res.payload).toContain('checkout flow');
    expect(listAccounts).toEqual([ACC]); // scoped by the AUTHED account
    await app.close();
  });

  it('GET /v1/recipes/:id omits sensitive type values without mutating the encrypted replay record', async () => {
    const { app, getByIdAccounts } = await harness();
    const res = await app.inject({ method: 'GET', url: `/v1/recipes/${RECIPE.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; intent_log: AgentIntent[] }>();
    expect(body.id).toBe(RECIPE.id);
    expect(body.intent_log).toEqual([
      { kind: 'navigate', url: 'https://example.com' },
      { kind: 'interact', action: 'type', selector: '#password', sensitive: true },
      {
        kind: 'interact',
        action: 'type',
        selector: '[autocomplete=one-time-code]',
        sensitive: true,
      },
      { kind: 'interact', action: 'type', selector: '#username', value: 'alice@example.com' },
      { kind: 'interact', action: 'tap', selector: '#submit', value: 'Submit' },
    ]);
    expect(res.payload).not.toContain('correct horse battery staple');
    expect(res.payload).not.toContain('839201');
    // Public serialization works on copies; future server-side replay still
    // has the original values inside the encrypted repository boundary.
    expect(RECIPE.intentLog[1]).toMatchObject({ value: 'correct horse battery staple' });
    expect(RECIPE.intentLog[2]).toMatchObject({ value: '839201', sensitive: false });
    expect(getByIdAccounts).toEqual([ACC]); // never a client-supplied account
    await app.close();
  });

  it('GET /v1/recipes/:id → 404 for an unknown id (existence not leaked)', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/v1/recipes/rec_missing' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('DELETE /v1/recipes/:id → 204 for the owner', async () => {
    const { app, deleteAccounts } = await harness();
    const res = await app.inject({ method: 'DELETE', url: `/v1/recipes/${RECIPE.id}` });
    expect(res.statusCode).toBe(204);
    expect(deleteAccounts).toEqual([ACC]);
    await app.close();
  });

  it('DELETE /v1/recipes/:id → 404 for an unknown id', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'DELETE', url: '/v1/recipes/rec_missing' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /v1/agent-sessions/:id/recipe-suggestion (doc-132 §5.2 v1.0 slice)', () => {
  it('derives a suggestion from the authed-owner session intent_log', async () => {
    const { app } = await harness({
      id: 'agt_1',
      accountId: ACC,
      transcript: [
        {
          intents: [
            { kind: 'navigate', url: 'https://shop.example.com/checkout' },
            { kind: 'interact', action: 'type', selector: '#email', value: 'x' },
            { kind: 'interact', action: 'tap', selector: '#submit' },
          ],
        },
      ],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_1/recipe-suggestion',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      suggested_label: string;
      suggested_description: string;
      intent_count: number;
    }>();
    expect(body.suggested_label).toContain('shop.example.com');
    expect(body.suggested_description).toContain('shop.example.com');
    expect(body.intent_count).toBe(3);
    await app.close();
  });

  it('→ 404 for a session owned by a different account (existence not leaked)', async () => {
    const { app } = await harness({ id: 'agt_1', accountId: 'someone-else', transcript: [] });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_1/recipe-suggestion',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('→ 404 for a missing session id', async () => {
    const { app } = await harness(null);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_missing/recipe-suggestion',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('an empty intent_log still returns a usable (generic) suggestion, not an error', async () => {
    const { app } = await harness({ id: 'agt_1', accountId: ACC, transcript: [] });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_1/recipe-suggestion',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ suggested_label: string; intent_count: number }>();
    expect(body.suggested_label.length).toBeGreaterThan(0);
    expect(body.intent_count).toBe(0);
    await app.close();
  });
});
