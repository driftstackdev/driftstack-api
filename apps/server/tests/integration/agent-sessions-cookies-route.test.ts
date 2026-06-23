// Founder #48 — integration tests for GET /v1/agent-sessions/:id/cookies (live
// cookie-jar view for the simulator drawer). Pins the discriminated body
// contract the GUI relies on (200 in every case, never an HTTP error for an
// expected-inert state), the gated 503, ownership 404, and the live round-trip
// through the fleet control connection's CookiesRequestCorrelator.

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

interface CookiesBody {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  cookies: Array<Record<string, unknown>> | null;
  reason?: string;
}

/** Create an agent session (status='active') and return its id. */
async function createSession(fx: TestAppFixture): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: { authorization: `Bearer ${fx.plaintext}` },
    payload: { token_budget: 50_000 },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

describe('GET /v1/agent-sessions/:id/cookies (activation gate off — runtime not wired)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('→ 503 FeatureUnavailable (gated like the other agent-session reads, not a bare 404)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_xxx/cookies',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });
});

describe('GET /v1/agent-sessions/:id/cookies (wired)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('unknown/foreign session → 404 (never confirms another account’s session)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_00000000-0000-4000-8000-0000000000ff/cookies',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('session with no assigned node → 200 { status:"unavailable", reason:"not live on a node" }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    // No dispatch happened (no fleet node with livekit in the test) → node_id is NULL.
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/cookies`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CookiesBody>();
    expect(body).toMatchObject({ status: 'unavailable', cookies: null });
    expect(body.reason).toMatch(/not live on a node/);
  });

  it('node assigned but not connected → 200 { status:"unavailable", reason:"node is not connected" }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    await fx.agentSessionsRepo!.setNodeId(id, 'node-not-connected');
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/cookies`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CookiesBody>();
    expect(body).toMatchObject({ status: 'unavailable', cookies: null });
    expect(body.reason).toMatch(/not connected/);
  });

  it('connected node echoes the jar → 200 { status:"ok", cookies:[...] }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const nodeId = 'node-cookies-1';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    const jar = [
      {
        domain: '.example.com',
        name: 'sid',
        value: 'abc',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
      { domain: 'example.com', name: 'pref', value: 'dark' },
    ];
    // Register a node connection whose socket synchronously echoes a cookiesResult
    // for the request the route sends — exactly what A3's harness will do live.
    const conn = fx.fleetControlRegistry.register(nodeId, (data) => {
      const frame = JSON.parse(data) as { type?: string; requestId?: string; sessionId?: string };
      if (frame.type === 'cookiesRequest') {
        conn.handleInbound(
          JSON.stringify({
            type: 'cookiesResult',
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            cookies: jar,
          }),
        );
      }
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/cookies`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CookiesBody>();
    expect(body.status).toBe('ok');
    expect(body.cookies).toEqual(jar);
  });

  it('connected node reports an error → 200 { status:"error", reason }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const nodeId = 'node-cookies-err';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    const conn = fx.fleetControlRegistry.register(nodeId, (data) => {
      const frame = JSON.parse(data) as { type?: string; requestId?: string; sessionId?: string };
      if (frame.type === 'cookiesRequest') {
        conn.handleInbound(
          JSON.stringify({
            type: 'cookiesResult',
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            error: 'session has no cookie store',
          }),
        );
      }
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/cookies`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CookiesBody>();
    expect(body).toMatchObject({ status: 'error', cookies: null });
    expect(body.reason).toMatch(/no cookie store/);
  });
});
