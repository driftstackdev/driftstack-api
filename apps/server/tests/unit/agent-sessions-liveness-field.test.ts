// Unit test (app.inject, no Drizzle DB) for the agent-session read-shape
// `liveness` field (A2 W2679). The load-bearing regression guard is the
// prod-no-fleet-control-plane case: when the SessionLivenessStore is NOT wired
// (prod has no fleet control plane), the field must be OMITTED (= "unknown,
// trust the binding"), NEVER defaulted to a dead/idle value — else every
// running session would flip to "not live" on a deployment without the store.

import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAgentSessionsRoutes } from '../../src/routes/agent-sessions.js';
import type { AgentRuntime } from '../../src/services/agent-runtime.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { SessionLivenessStore } from '../../src/services/session-liveness-store.js';
import { SessionCapabilityReportStore } from '../../src/services/session-capability-report-store.js';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';

const ACC = 'acc_liveness';

function makeRecord(id: string, overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id,
    accountId: ACC,
    driftstackSessionId: null,
    proxyId: null,
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
    idempotencyKey: null,
    guiControlKeyExpiresAt: null,
    guiControlKeyCiphertext: null,
    createdAt: new Date('2026-06-19T00:00:00Z'),
    updatedAt: new Date('2026-06-19T00:00:00Z'),
    ...overrides,
  };
}

async function buildApp(opts: {
  livenessStore?: SessionLivenessStore;
  capabilityReportStore?: SessionCapabilityReportStore;
  record?: AgentSessionRecord;
}) {
  const rec = opts.record ?? makeRecord('agt_live');
  const sessions = {
    get: (id: string) => Promise.resolve(id === rec.id ? rec : null),
  } as unknown as AgentSessionsRepo;

  const app = Fastify({ logger: false });
  app.decorateRequest('account', null);
  app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
    (req as { account: unknown }).account = {
      account: { id: ACC, tier: 'starter' },
      apiKey: { id: 'key_liveness', scopes: ['read', 'write'] },
    };
    done();
  });
  app.decorate('requireAuth', () => Promise.resolve());
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerAgentSessionsRoutes(app, {
    runtime: {} as unknown as AgentRuntime,
    sessions,
    ...(opts.livenessStore !== undefined ? { sessionLivenessStore: opts.livenessStore } : {}),
    ...(opts.capabilityReportStore !== undefined
      ? { sessionCapabilityReportStore: opts.capabilityReportStore }
      : {}),
  });
  await app.ready();
  return app;
}

describe('agent-sessions read shape — liveness field (W2679)', () => {
  it('OMITS liveness when the store is not wired (prod no-fleet-CP regression guard — never default to dead)', async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/v1/agent-sessions/agt_live' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect('liveness' in body).toBe(false);
    await app.close();
  });

  it('OMITS liveness when the store is wired but no beat has reported the session (unknown → trust the binding)', async () => {
    const app = await buildApp({ livenessStore: new SessionLivenessStore() });
    const res = await app.inject({ method: 'GET', url: '/v1/agent-sessions/agt_live' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect('liveness' in body).toBe(false);
    await app.close();
  });

  it('surfaces { state, fresh } when the store has a fresh beat for the session', async () => {
    const store = new SessionLivenessStore();
    store.recordBeat('node-1', { agt_live: 'active' }, Date.now());
    const app = await buildApp({ livenessStore: store });
    const res = await app.inject({ method: 'GET', url: '/v1/agent-sessions/agt_live' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ liveness?: { state: string | null; fresh: boolean } }>();
    expect(body.liveness).toEqual({ state: 'active', fresh: true });
    await app.close();
  });

  it('reports fresh:false for a stale beat (silent node) — the state survives but the GUI can de-trust it', async () => {
    const store = new SessionLivenessStore();
    // A beat far enough in the past to be stale.
    store.recordBeat('node-1', { agt_live: 'active' }, Date.now() - 10 * 60_000);
    const app = await buildApp({ livenessStore: store });
    const res = await app.inject({ method: 'GET', url: '/v1/agent-sessions/agt_live' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ liveness?: { state: string | null; fresh: boolean } }>();
    expect(body.liveness).toEqual({ state: 'active', fresh: false });
    await app.close();
  });
});

describe('agent-sessions read shape — capability_report', () => {
  it('omits an unknown report and exposes the latest customer-safe report when present', async () => {
    const store = new SessionCapabilityReportStore();
    const appWithoutReport = await buildApp({ capabilityReportStore: store });
    const unknown = await appWithoutReport.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_live',
    });
    expect(unknown.statusCode).toBe(200);
    expect('capability_report' in unknown.json<Record<string, unknown>>()).toBe(false);
    await appWithoutReport.close();

    store.set({
      type: 'capabilityReport',
      sessionId: 'agt_live',
      timestamp: '2026-07-13T06:00:00.000Z',
      egressPhase: 'phase_1_socks5',
      proxyKind: 'socks5',
      proxyUdpSupported: false,
      proxyIpv4Supported: true,
      proxyIpv6Supported: false,
      transportModeRequested: 'h2-and-h3',
      transportModeActive: 'h2-only',
      h3InterposeLoaded: false,
      httpsSkipActive: true,
      safeguardChecks: [{ layer: 'dns', passed: true, timestamp: 't' }],
      archetypeId: 'iphone16pro_ios18_6_safari18_6',
      manualInputAvailable: false,
      streamingState: 'blank',
      egressState: 'dead_proxy',
    } satisfies CapabilityReport);
    const app = await buildApp({ capabilityReportStore: store });
    const res = await app.inject({ method: 'GET', url: '/v1/agent-sessions/agt_live' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ capability_report?: unknown }>().capability_report).toEqual({
      timestamp: '2026-07-13T06:00:00.000Z',
      manual_input_available: false,
      streaming_state: 'blank',
      egress_state: 'dead_proxy',
      proxy_kind: 'socks5',
      proxy_udp_supported: false,
      transport_mode_requested: 'h2-and-h3',
      transport_mode_active: 'h2-only',
      safeguards_passed: true,
      // T-6 — null, not false: the node reports this only once it has OBSERVED a
      // completed QUIC handshake, so absent stays NOT-OBSERVED. The internal
      // interpose diagnostic is deliberately not here.
      h3_connection_observed: null,
    });
    await app.close();
  });
});

describe('agent-sessions read shape — durable error_event', () => {
  it('returns null before a report and projects the persisted customer-safe event after terminal close', async () => {
    const without = await buildApp({});
    const empty = await without.inject({ method: 'GET', url: '/v1/agent-sessions/agt_live' });
    expect(empty.json<{ error_event: unknown }>().error_event).toBeNull();
    await without.close();

    const rec = makeRecord('agt_live', {
      status: 'closed',
      closedReason: 'session_errored',
      closedAt: new Date('2026-07-13T06:00:01.000Z'),
      lastErrorEvent: {
        timestamp: '2026-07-13T06:00:00.000Z',
        code: 'launch_timeout',
        severity: 'error',
        summary: 'The live browser did not become ready in time.',
        detail: null,
        customerActionable: false,
        retryable: true,
      },
    });
    const app = await buildApp({ record: rec });
    const res = await app.inject({ method: 'GET', url: '/v1/agent-sessions/agt_live' });
    expect(res.json<{ error_event: unknown }>().error_event).toEqual({
      timestamp: '2026-07-13T06:00:00.000Z',
      code: 'launch_timeout',
      severity: 'error',
      summary: 'The live browser did not become ready in time.',
      detail: null,
      customer_actionable: false,
      retryable: true,
    });
    await app.close();
  });
});
