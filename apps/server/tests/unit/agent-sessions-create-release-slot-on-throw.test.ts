// #3 — a throw AFTER the concurrency slot is acquired (the active row is
// created) but before the create completes must RELEASE the slot, not leave a
// phantom 'active' row that counts against the per-account cap forever (→ new
// launches refused / the GUI spins on "launching").
//
// We force a throw on the post-dispatch `sessions.get` re-read (a plausible DB
// blip) and assert the create 500s but leaves ZERO active sessions — the row was
// closed (slot released) on the failure path.

import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAgentSessionsRoutes } from '../../src/routes/agent-sessions.js';
import type { AgentRuntime } from '../../src/services/agent-runtime.js';
import {
  InMemoryAgentSessionsRepo,
  type AgentSessionRecord,
} from '../../src/services/agent-sessions.js';

const ACC = 'acc_slot_release';

/** In-memory repo whose `get` throws exactly once — armed after the first
 *  create, so the post-acquire re-read on the create path blows up (a DB blip).
 *  Every other method (closeWithReason, countActive, …) keeps the real
 *  behaviour so the slot accounting is faithful. */
class ThrowOnceGetRepo extends InMemoryAgentSessionsRepo {
  private creates = 0;
  private armed = false;
  override createIfUnderActiveCap(
    ...args: Parameters<InMemoryAgentSessionsRepo['createIfUnderActiveCap']>
  ): ReturnType<InMemoryAgentSessionsRepo['createIfUnderActiveCap']> {
    const out = super.createIfUnderActiveCap(...args);
    this.creates += 1;
    // Only the FIRST create's post-dispatch re-read blows up — a one-shot blip.
    if (this.creates === 1) this.armed = true;
    return out;
  }
  override get(id: string): Promise<AgentSessionRecord | null> {
    if (this.armed) {
      this.armed = false;
      return Promise.reject(new Error('db blip on post-acquire re-read'));
    }
    return super.get(id);
  }
}

async function buildApp(repo: InMemoryAgentSessionsRepo) {
  const app = Fastify({ logger: false });
  app.decorateRequest('account', null);
  app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
    (req as { account: unknown }).account = {
      account: { id: ACC, tier: 'api_starter', region: 'eu' },
      apiKey: { id: 'key_slot', scopes: ['read', 'write'] },
    };
    done();
  });
  app.decorate('requireAuth', () => Promise.resolve());
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerAgentSessionsRoutes(app, {
    runtime: {} as unknown as AgentRuntime,
    sessions: repo,
  });
  await app.ready();
  return app;
}

describe('agent-sessions create — release the slot on a post-acquire throw (#3)', () => {
  it('a throw after the slot is acquired closes the row (zero active sessions remain)', async () => {
    const repo = new ThrowOnceGetRepo();
    const app = await buildApp(repo);

    const res = await app.inject({ method: 'POST', url: '/v1/agent-sessions', payload: {} });
    // The injected blip propagates as a 500 (the create couldn't complete)…
    expect(res.statusCode).toBe(500);
    // …but the slot was RELEASED: the active count is back to zero, so the next
    // launch isn't refused by a phantom slot.
    expect(await repo.countActive(ACC)).toBe(0);
    await app.close();
  });

  it('subsequent creates still succeed (no phantom slot accumulated)', async () => {
    const repo = new ThrowOnceGetRepo();
    const app = await buildApp(repo);

    await app.inject({ method: 'POST', url: '/v1/agent-sessions', payload: {} }); // throws → released
    // The throw is one-shot; the next create runs clean.
    const ok = await app.inject({ method: 'POST', url: '/v1/agent-sessions', payload: {} });
    expect(ok.statusCode).toBe(201);
    expect(await repo.countActive(ACC)).toBe(1);
    await app.close();
  });
});
