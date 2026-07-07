// Unit test (app.inject, no Drizzle DB) for the BYOK-degrade-on-corrupt
// behaviour on agent-session create. A corrupted / rotated-but-not-rewrapped
// stored BYOK key makes byokService.getPlaintext() throw (AES-GCM auth fail).
// That MUST NOT fail the create: the session row already committed, so an
// uncaught throw would 500 the response AND leak the concurrency slot (the row
// counts against the per-account cap, but the caller never got a session id),
// locking the account out as every retry re-hits the same corrupted key.
//
// Expected behaviour: log + degrade to NO cached key (the AI resolves its key
// lazily from header / fallback at first use) and still return 201. Mirrors the
// socks5/DEK fail-closed degrade in the launch/dispatch path.

import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAgentSessionsRoutes } from '../../src/routes/agent-sessions.js';
import type { AgentRuntime } from '../../src/services/agent-runtime.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type { BYOKAnthropicService } from '../../src/services/byok-anthropic.js';
import { InMemoryByokKeyCache } from '../../src/services/byok-anthropic-key-cache.js';

const ACC = 'acc_byok_degrade';

async function buildApp(opts: {
  getPlaintext: () => Promise<string | null>;
  cache: InMemoryByokKeyCache;
}) {
  const sessions = new InMemoryAgentSessionsRepo();
  const byokService = {
    getPlaintext: opts.getPlaintext,
  } as unknown as BYOKAnthropicService;

  const app = Fastify({ logger: false });
  app.decorateRequest('account', null);
  app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
    (req as { account: unknown }).account = {
      account: { id: ACC, tier: 'api_starter', region: 'eu' },
      apiKey: { id: 'key_byok', scopes: ['read', 'write'] },
    };
    done();
  });
  app.decorate('requireAuth', () => Promise.resolve());
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerAgentSessionsRoutes(app, {
    runtime: {} as unknown as AgentRuntime,
    sessions,
    byokService,
    byokKeyCache: opts.cache,
  });
  await app.ready();
  return { app, sessions };
}

describe('agent-sessions create — BYOK hydration degrade-on-corrupt', () => {
  it('still returns 201 (degrades, no 500) when getPlaintext throws on a NEW create', async () => {
    const cache = new InMemoryByokKeyCache();
    const { app } = await buildApp({
      getPlaintext: () =>
        Promise.reject(new Error('Unsupported state or unable to authenticate data')),
      cache,
    });
    const res = await app.inject({ method: 'POST', url: '/v1/agent-sessions', payload: {} });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string }>();
    // The session created…
    expect(body.id).toMatch(/^agt_/);
    // …but no plaintext was cached (degraded to no cached key).
    expect(cache.get(body.id)).toBeUndefined();
    await app.close();
  });

  it('caches the plaintext on the happy path (degrade is corruption-only, not a no-op)', async () => {
    const cache = new InMemoryByokKeyCache();
    const { app } = await buildApp({
      getPlaintext: () => Promise.resolve('sk-ant-stored-key'),
      cache,
    });
    const res = await app.inject({ method: 'POST', url: '/v1/agent-sessions', payload: {} });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string }>();
    expect(cache.get(body.id)).toBe('sk-ant-stored-key');
    await app.close();
  });

  it('does not leak a concurrency slot — a 2nd create after a corrupt-key create still succeeds', async () => {
    const cache = new InMemoryByokKeyCache();
    const { app, sessions } = await buildApp({
      getPlaintext: () =>
        Promise.reject(new Error('Unsupported state or unable to authenticate data')),
      cache,
    });
    await app.inject({ method: 'POST', url: '/v1/agent-sessions', payload: {} });
    const second = await app.inject({ method: 'POST', url: '/v1/agent-sessions', payload: {} });
    expect(second.statusCode).toBe(201);
    // Two real sessions exist; neither create 500'd or stranded a phantom slot.
    expect(await sessions.countActive(ACC)).toBe(2);
    await app.close();
  });
});
