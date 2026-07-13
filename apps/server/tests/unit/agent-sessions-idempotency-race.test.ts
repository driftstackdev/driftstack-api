// Unit test (app.inject, no Drizzle DB) for the agent-sessions create
// idempotency CONCURRENT-race handling (v2-#19). When two POSTs share an
// Idempotency-Key and race, the findByIdempotencyKey pre-check can miss the
// uncommitted sibling, so both reach create(); the partial unique index
// `agent_sessions_idempotency_key_unique` lets one win and raises 23505 on
// the loser. The route catches the 23505 + replays the winner's 201 instead
// of surfacing a 500 (matches the Stripe idempotency contract + the
// pre-check replay path). A non-23505 error must still surface — the catch
// is precise, not a catch-all.

import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAgentSessionsRoutes } from '../../src/routes/agent-sessions.js';
import type { AgentRuntime } from '../../src/services/agent-runtime.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../../src/services/agent-sessions.js';

const ACC = 'acc_idem_race';

function makeWinner(): AgentSessionRecord {
  return {
    id: 'agt_winner',
    accountId: ACC,
    driftstackSessionId: null,
    status: 'active',
    transcript: [],
    tokenBudgetTotal: 100_000,
    tokenBudgetRemaining: 100_000,
    closedReason: null,
    createdByUserId: null,
    closedAt: null,
    pairModeState: null,
    lastErrorEvent: null,
    mode: 'ai',
    model: 'claude-opus-4-7',
    nodeId: null,
    profileId: null,
    idempotencyKey: 'race-key-1',
    guiControlKeyExpiresAt: null,
    guiControlKeyCiphertext: null,
    createdAt: new Date('2026-05-31T00:00:00Z'),
    updatedAt: new Date('2026-05-31T00:00:00Z'),
  };
}

function unique23505(): Error {
  return Object.assign(
    new Error(
      'duplicate key value violates unique constraint "agent_sessions_idempotency_key_unique"',
    ),
    { code: '23505' },
  );
}

async function buildApp(opts: { createError: Error; winner: AgentSessionRecord | null }) {
  let findCalls = 0;
  const sessions = {
    // 1st call = the pre-check (race miss → null); subsequent calls = the
    // post-conflict re-find (returns the winner row the sibling committed).
    findByIdempotencyKey: () => {
      findCalls += 1;
      return Promise.resolve(findCalls === 1 ? null : opts.winner);
    },
    // audit #8 — the create handler now enforces the per-account active-session
    // cap atomically INSIDE createIfUnderActiveCap (count+insert under one lock),
    // so the route calls that instead of countActive + create. Rejecting it with
    // the createError keeps this race test exercising the 23505 conflict path
    // (the cap itself isn't hit — a non-null return would mean "under cap").
    countActive: () => Promise.resolve(0),
    create: () => Promise.reject(opts.createError),
    createIfUnderActiveCap: () => Promise.reject(opts.createError),
  } as unknown as AgentSessionsRepo;

  const app = Fastify({ logger: false });
  app.decorateRequest('account', null);
  app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
    (req as { account: unknown }).account = {
      account: { id: ACC, tier: 'api_starter' },
      apiKey: { id: 'key_idem', scopes: ['read', 'write'] },
    };
    done();
  });
  app.decorate('requireAuth', () => Promise.resolve());
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerAgentSessionsRoutes(app, { runtime: {} as unknown as AgentRuntime, sessions });
  await app.ready();
  return app;
}

describe('agent-sessions create — idempotency concurrent-race', () => {
  it('replays the winner 201 (not a 500) when create raises 23505 on a same-key race loser', async () => {
    const app = await buildApp({ createError: unique23505(), winner: makeWinner() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { 'idempotency-key': 'race-key-1' },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body: { id: string } = res.json();
    expect(body.id).toBe('agt_winner');
    await app.close();
  });

  it('re-throws a non-23505 create error (the idempotency catch is precise, not a catch-all)', async () => {
    const app = await buildApp({ createError: new Error('driver exploded'), winner: makeWinner() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { 'idempotency-key': 'race-key-2' },
      payload: {},
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    await app.close();
  });
});
