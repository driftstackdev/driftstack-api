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

  it('CRITICAL a real token gets its OWN sentence, not the generic fallback', async () => {
    // The fallback arm above only proves arbitrary text is suppressed. This proves
    // the token set is actually wired — without it, a route that answered the
    // generic sentence for EVERYTHING would pass.
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const nodeId = 'node-cookies-token';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    const conn = fx.fleetControlRegistry.register(nodeId, (data) => {
      const frame = JSON.parse(data) as { type?: string; requestId?: string; sessionId?: string };
      if (frame.type === 'cookiesRequest') {
        conn.handleInbound(
          JSON.stringify({
            type: 'cookiesResult',
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            error: 'too_large',
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
    expect(body.status).toBe('error');
    // Says REFUSED, not truncated — a customer who thinks it was shortened hunts
    // for partial state that does not exist.
    expect(body.reason).toMatch(/refused/i);
    expect(body.reason).not.toMatch(/truncat/i);
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
    // ⛔ CHANGED 2026-09-06 (N-COOKIE-ERROR-CONTRACT). This used to assert the
    // harness's own words reached the customer — which is the defect, not the
    // contract. `session has no cookie store` is an invented fixture: the harness
    // emits a CLOSED token set, verified in its source. Arbitrary device text must
    // now coerce to our own sentence, so this asserts the property the route has.
    expect(body.reason).not.toMatch(/no cookie store/);
    expect(body.reason).toMatch(/does not recognise/);
  });
});

// The cookies route exposes httpOnly cookies, so its per-session gui_control_key
// boundary matters: a key authorizes ONLY the one session it was minted for, and
// a wrong/cross-session/missing key 401s (never falls through to another
// session's jar). Mirrors the GET /:id control-auth pins.
describe('GET /v1/agent-sessions/:id/cookies gui_control_key auth', () => {
  const GCK_HEADER = 'x-driftstack-gui-control-key';
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function mintKey(sessionId: string): Promise<string> {
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${sessionId}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ gui_control_key: string }>().gui_control_key;
  }

  it('a control key reads its OWN session cookies (no account Authorization header)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const key = await mintKey(id);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/cookies`,
      headers: { [GCK_HEADER]: key },
    });
    // Authorized → reaches the handler → a discriminated 200 (unavailable here,
    // since no node is connected) rather than a 401.
    expect(res.statusCode).toBe(200);
    expect(res.json<CookiesBody>().status).toBe('unavailable');
  });

  it('a control key minted for session A is REJECTED on session B (401 — never leaks B’s jar)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const idA = await createSession(fx);
    const idB = await createSession(fx);
    const keyA = await mintKey(idA);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${idB}/cookies`,
      headers: { [GCK_HEADER]: keyA },
    });
    expect(res.statusCode).toBe(401);
  });

  it('a missing/garbage control key with NO account auth 401s (never falls through)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/cookies`,
      headers: { [GCK_HEADER]: 'gck_not_a_real_key' },
    });
    expect(res.statusCode).toBe(401);
  });
});
