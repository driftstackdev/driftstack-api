// Drives GET /v1/agent-sessions/:id/captures/:captureId (the #7 screenshot read).
// Drives GET /v1/agent-sessions/:id/captures/:captureId so the every-route-is-driven
// census sees it, and pins the route's honest behaviour (#7 screenshot viewer).
// Modeled on a-network-log-ring-is-bounded-and-owner-scoped.test.ts ROUTE section.
// Mirrors the SIBLING /network route exactly: same preHandler
// [controlKeyOrAccountAuth('read:sessions'), app.rateLimit('global')] + ownership gate.

import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAgentSessionsRoutes } from '../../src/routes/agent-sessions.js';
import { SessionCaptureStore } from '../../src/services/session-capture-store.js';
import type { AgentRuntime } from '../../src/services/agent-runtime.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../../src/services/agent-sessions.js';

const ACC = 'acc_cap';

function makeRecord(over: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: 'agt_cap',
    accountId: ACC,
    driftstackSessionId: null,
    proxyId: null,
    stopOnExitIpChange: false,
    firstExitIp: null,
    status: 'active',
    transcript: [],
    tokenBudgetTotal: 100_000,
    tokenBudgetRemaining: 100_000,
    closedReason: null,
    provisioningDetail: null,
    createdByUserId: null,
    closedAt: null,
    pairModeState: null,
    lastErrorEvent: null,
    mode: 'ai',
    model: 'claude-opus-4-7',
    nodeId: 'node-1',
    profileId: null,
    idempotencyKey: null,
    guiControlKeyExpiresAt: null,
    guiControlKeyCiphertext: null,
    createdAt: new Date('2026-09-03T00:00:00Z'),
    updatedAt: new Date('2026-09-03T00:00:00Z'),
    ...over,
  };
}

async function buildApp(opts: {
  store?: SessionCaptureStore;
  record?: AgentSessionRecord;
  callerAccountId?: string;
}) {
  const rec = opts.record ?? makeRecord();
  const sessions = {
    get: (id: string) => Promise.resolve(id === rec.id ? rec : null),
  } as unknown as AgentSessionsRepo;

  const app = Fastify({ logger: false });
  app.decorateRequest('account', null);
  app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
    (req as { account: unknown }).account = {
      account: { id: opts.callerAccountId ?? ACC, tier: 'starter' },
      apiKey: { id: 'key_cap', scopes: ['read', 'read:sessions'] },
      teams: [],
    };
    done();
  });
  app.decorate('requireAuth', () => Promise.resolve());
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerAgentSessionsRoutes(app, {
    runtime: {} as unknown as AgentRuntime,
    sessions,
    ...(opts.store !== undefined ? { sessionCaptureStore: opts.store } : {}),
  });
  await app.ready();
  return app;
}

// 1x1 PNG (the smallest valid), base64.
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('#7 route: GET /v1/agent-sessions/:id/captures/:captureId serves stored screenshot bytes', () => {
  it('returns the stored image bytes with the right content-type for a hit', async () => {
    const store = new SessionCaptureStore();
    const captureId = store.put('agt_cap', PNG_1x1_B64, 'png');
    const app = await buildApp({ store });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/agt_cap/captures/${captureId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.equals(Buffer.from(PNG_1x1_B64, 'base64'))).toBe(true);
    await app.close();
  });

  it('404s an unknown/evicted captureId (a miss is never a fabricated image)', async () => {
    const store = new SessionCaptureStore();
    const app = await buildApp({ store });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_cap/captures/cap_does_not_exist',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('404s when no capture store is wired on this deployment (honest miss, not a 500)', async () => {
    const app = await buildApp({});
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_cap/captures/cap_x',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('refuses a caller from another account with 404 (ownership gate), even for a real captureId', async () => {
    const store = new SessionCaptureStore();
    const captureId = store.put('agt_cap', PNG_1x1_B64, 'png');
    const app = await buildApp({ store, callerAccountId: 'acc_intruder' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/agt_cap/captures/${captureId}`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
