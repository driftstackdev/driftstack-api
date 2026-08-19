// Cookie-import — integration tests for POST /v1/agent-sessions/:id/cookies/set
// (the WRITE-twin of GET /:id/cookies). Pins the discriminated body contract the
// GUI relies on (200 in every relay case, never an HTTP error for an expected-inert
// state), the gated 503, ownership 404, the malformed-body 422, and the live
// round-trip through the fleet control connection's SetCookiesRequestCorrelator.
// Mirrors the cookies + files route tests.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

interface SetCookiesBody {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  reason?: string;
}

// The exact CookieSchema jar shape the read/Export emits (round-trips 1:1).
const JAR = [
  {
    domain: '.example.com',
    name: 'sid',
    value: 'abc',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax' as const,
  },
  { domain: 'example.com', name: 'pref', value: 'dark' },
];
const IMPORT_BODY = { cookies: JAR };

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

describe('POST /v1/agent-sessions/:id/cookies/set (activation gate off — runtime not wired)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('→ 503 FeatureUnavailable (gated like the other agent-session routes, not a bare 404)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_xxx/cookies/set',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: IMPORT_BODY,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });
});

describe('POST /v1/agent-sessions/:id/cookies/set (wired)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('unknown/foreign session → 404 (never confirms another account’s session)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_00000000-0000-4000-8000-0000000000ff/cookies/set',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: IMPORT_BODY,
    });
    expect(res.statusCode).toBe(404);
  });

  it('malformed body (cookies not an array of cookies) → 422 ValidationFailed', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/cookies/set`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { cookies: [{ name: 'noDomain', value: 'x' }] }, // missing domain
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('empty jar → 422 (a write must carry at least one cookie)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/cookies/set`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { cookies: [] },
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('session with no assigned node → 200 { status:"unavailable", reason:"not live on a node" }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/cookies/set`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: IMPORT_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SetCookiesBody>();
    expect(body).toMatchObject({ status: 'unavailable' });
    expect(body.reason).toMatch(/not live on a node/);
  });

  it('node assigned but not connected → 200 { status:"unavailable", reason:"not connected" }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    await fx.agentSessionsRepo!.setNodeId(id, 'node-not-connected');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/cookies/set`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: IMPORT_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SetCookiesBody>();
    expect(body).toMatchObject({ status: 'unavailable' });
    expect(body.reason).toMatch(/not connected/);
  });

  it('connected node confirms the write → 200 { status:"ok" } (jar relayed verbatim)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const nodeId = 'node-set-cookies-1';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    let relayedCookies: unknown = null;
    // Register a node whose socket synchronously echoes a setCookiesResult ok:true
    // for the setCookies the route sends — exactly what A3's harness will do live.
    const conn = fx.fleetControlRegistry.register(nodeId, (data) => {
      const frame = JSON.parse(data) as {
        type?: string;
        requestId?: string;
        sessionId?: string;
        cookies?: unknown;
      };
      if (frame.type === 'setCookies') {
        relayedCookies = frame.cookies;
        conn.handleInbound(
          JSON.stringify({
            type: 'setCookiesResult',
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            ok: true,
          }),
        );
      }
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/cookies/set`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: IMPORT_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SetCookiesBody>().status).toBe('ok');
    // The jar crossed the wire 1:1 (the read/Export shape round-trips).
    expect(relayedCookies).toEqual(JAR);
  });

  it('connected node reports an error → 200 { status:"error", reason }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const nodeId = 'node-set-cookies-err';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    const conn = fx.fleetControlRegistry.register(nodeId, (data) => {
      const frame = JSON.parse(data) as { type?: string; requestId?: string; sessionId?: string };
      if (frame.type === 'setCookies') {
        conn.handleInbound(
          JSON.stringify({
            type: 'setCookiesResult',
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            error:
              'cookie write failed direct=10.0.0.7 https://user:pass@internal/?token=secret Bearer abcdefgh',
          }),
        );
      }
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/cookies/set`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: IMPORT_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SetCookiesBody>();
    expect(body).toMatchObject({ status: 'error' });
    expect(body.reason).toMatch(/write failed/);
    expect(body.reason).toContain('direct=[redacted]');
    expect(body.reason).toContain('token=[redacted]');
    expect(body.reason).toContain('Bearer [redacted]');
    expect(body.reason).not.toContain('10.0.0.7');
    expect(body.reason).not.toContain('pass');
    expect(body.reason).not.toContain('secret');
    expect(body.reason).not.toContain('abcdefgh');
  });

  it('connected node never replies → 200 { status:"timeout" } (no-ops gracefully pre-box-half)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const nodeId = 'node-set-cookies-silent';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    // A node that ACKs nothing (A3's setCookies extension not yet present) — short
    // timeout injected so the test doesn't wait the full 10s.
    fx.fleetControlRegistry.register(nodeId, () => {});
    const conn = fx.fleetControlRegistry.get(nodeId)!;
    const before = await conn.setCookies('rq_t', id, JAR, 1);
    expect(before).toEqual({ status: 'timeout' });
  });
});

// The import route mutates the session's cookie store, so its per-session
// gui_control_key boundary matters: a key authorizes ONLY the session it was minted
// for; a wrong/cross-session/missing key 401s. Mirrors the cookies + files route pins.
describe('POST /v1/agent-sessions/:id/cookies/set gui_control_key auth', () => {
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

  it('a control key imports into its OWN session (no account Authorization header)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const key = await mintKey(id);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/cookies/set`,
      headers: { [GCK_HEADER]: key },
      payload: IMPORT_BODY,
    });
    // Authorized → reaches the handler → a discriminated 200 (unavailable here, no
    // node connected) rather than 401.
    expect(res.statusCode).toBe(200);
    expect(res.json<SetCookiesBody>().status).toBe('unavailable');
  });

  it('CRITICAL when the owner-authority lookup fails, a control-key request is refused rather than let through unmetered. middleware/rate-limit.ts fails CLOSED here by design — its comment says so — and coverage showed the throw executed by no test while the UnauthorizedError fourteen lines above it is executed. A ForbiddenError (deleted or suspended owner) is deliberately rethrown as 403; anything else, a store blip included, must become a 429 and not a free pass.', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const key = await mintKey(id);

    // The lookup fails AFTER the account checks, so this is the non-Forbidden
    // branch: a capacity decision the middleware cannot make.
    vi.spyOn(fx.authRepo, 'findActiveRateLimitOverrides').mockRejectedValue(
      new Error('overrides store unavailable'),
    );

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/cookies/set`,
      headers: { [GCK_HEADER]: key },
      payload: IMPORT_BODY,
    });
    // The sibling arm above shows this exact request answering 200 when the
    // lookup is healthy, so the contrast isolates the failure path.
    expect(res.statusCode, 'the request is refused, not admitted unmetered').toBe(429);
    expect(res.headers['retry-after'], 'and it carries the Retry-After the refusal sets').toBe(
      '60',
    );
  });

  it('a control key minted for session A is REJECTED on session B (401)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const idA = await createSession(fx);
    const idB = await createSession(fx);
    const keyA = await mintKey(idA);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${idB}/cookies/set`,
      headers: { [GCK_HEADER]: keyA },
      payload: IMPORT_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it('a missing/garbage control key with NO account auth 401s (never falls through)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/cookies/set`,
      headers: { [GCK_HEADER]: 'gck_not_a_real_key' },
      payload: IMPORT_BODY,
    });
    expect(res.statusCode).toBe(401);
  });
});
