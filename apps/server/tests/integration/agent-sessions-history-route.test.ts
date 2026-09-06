// Sim back/forward (A3 W2870) — integration tests for POST /v1/agent-sessions/:id/history
// (the sibling of POST /:id/cookies/set). Pins the discriminated body contract the GUI
// relies on (200 in every relay case, never an HTTP error for an expected-inert state),
// the gated 503, ownership 404, the malformed-body 422, and the live round-trip through
// the fleet control connection's NavigateHistoryRequestCorrelator. Mirrors the
// cookies-import route tests.

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

interface NavigateHistoryBody {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  reason?: string;
}

const HISTORY_BODY = { direction: 'back' as const };

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

describe('POST /v1/agent-sessions/:id/history (activation gate off — runtime not wired)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('→ 503 FeatureUnavailable (gated like the other agent-session routes, not a bare 404)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_xxx/history',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: HISTORY_BODY,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });
});

describe('POST /v1/agent-sessions/:id/history (wired)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('unknown/foreign session → 404 (never confirms another account’s session)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_00000000-0000-4000-8000-0000000000ff/history',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: HISTORY_BODY,
    });
    expect(res.statusCode).toBe(404);
  });

  it('malformed body (direction not back|forward) → 422 ValidationFailed', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/history`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { direction: 'sideways' },
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('missing direction → 422 (a step must say which way)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/history`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('session with no assigned node → 200 { status:"unavailable", reason:"not live on a node" }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/history`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: HISTORY_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<NavigateHistoryBody>();
    expect(body).toMatchObject({ status: 'unavailable' });
    expect(body.reason).toMatch(/not live on a node/);
  });

  it('node assigned but not connected → 200 { status:"unavailable", reason:"not connected" }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    await fx.agentSessionsRepo!.setNodeId(id, 'node-not-connected');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/history`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: HISTORY_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<NavigateHistoryBody>();
    expect(body).toMatchObject({ status: 'unavailable' });
    expect(body.reason).toMatch(/not connected/);
  });

  it('connected node confirms the step → 200 { status:"ok" } (direction relayed verbatim)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const nodeId = 'node-history-1';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    let relayedDirection: unknown = null;
    // Register a node whose socket synchronously echoes a navigateHistoryResult ok:true
    // for the navigateHistory the route sends — exactly what A3's harness will do live.
    const conn = fx.fleetControlRegistry.register(nodeId, (data) => {
      const frame = JSON.parse(data) as {
        type?: string;
        requestId?: string;
        sessionId?: string;
        direction?: unknown;
      };
      if (frame.type === 'navigateHistory') {
        relayedDirection = frame.direction;
        conn.handleInbound(
          JSON.stringify({
            type: 'navigateHistoryResult',
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            ok: true,
          }),
        );
      }
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/history`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { direction: 'forward' as const },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<NavigateHistoryBody>().status).toBe('ok');
    // The direction crossed the wire verbatim.
    expect(relayedDirection).toBe('forward');
  });

  // ⛔ REMOVED 2026-09-06: an arm that pinned `tabId` crossing the wire verbatim
  // from the ROUTE. It asserted the forward-compat plumbing worked, and it did —
  // but the plumbing forwarded a field no device decodes, so the customer-visible
  // result was a 200 and the session's CURRENT tab stepped. The arm was true and
  // the behaviour it protected was a wrong answer, which is why it had to go
  // rather than be worked around: keeping it would have made the refusal look like
  // the regression. The route now refuses `tabId` (see the arms at the end of this
  // file); the codec-level serialization is unchanged and still exercised where it
  // belongs, at the codec.

  it('connected node reports an error → 200 { status:"error", reason }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const nodeId = 'node-history-err';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    const conn = fx.fleetControlRegistry.register(nodeId, (data) => {
      const frame = JSON.parse(data) as { type?: string; requestId?: string; sessionId?: string };
      if (frame.type === 'navigateHistory') {
        conn.handleInbound(
          JSON.stringify({
            type: 'navigateHistoryResult',
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            error: 'no entry in that direction',
          }),
        );
      }
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/history`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: HISTORY_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<NavigateHistoryBody>();
    expect(body).toMatchObject({ status: 'error' });
    expect(body.reason).toMatch(/no entry/);
  });

  it('connected node never replies → 200 { status:"timeout" } (no-ops gracefully pre-box-half)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const nodeId = 'node-history-silent';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    // A node that ACKs nothing (A3's navigateHistory extension not yet present) — short
    // timeout injected so the test doesn't wait the full 10s.
    fx.fleetControlRegistry.register(nodeId, () => {});
    const conn = fx.fleetControlRegistry.get(nodeId)!;
    const before = await conn.navigateHistory('rq_t', id, 'back', 1);
    expect(before).toEqual({ status: 'timeout' });
  });
});

// The history route drives the running session (state-changing), so its per-session
// gui_control_key boundary matters: a key authorizes ONLY the session it was minted
// for; a wrong/cross-session/missing key 401s. Mirrors the cookies-import route pins.
describe('POST /v1/agent-sessions/:id/history — tabId is refused, not ignored', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('CRITICAL a supplied tabId is a 422 naming the field — never a 200 stepping the wrong tab', () => {
    // The defect this replaces: the CP forwards `tabId`, but the harness decodes
    // only requestId/sessionId/direction and a synthesized Codable decoder drops
    // unknown keys. So the field vanished and the session's CURRENT tab was
    // stepped — the caller got a 200 and the wrong tab, with no way to detect it.
    // An explicit refusal is recoverable; a wrong tab is not.
    return (async () => {
      fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
      const id = await createSession(fx);
      const res = await fx.app.inject({
        method: 'POST',
        url: `/v1/agent-sessions/${id}/history`,
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { direction: 'back', tabId: 'tab_other' },
      });
      expect([400, 422]).toContain(res.statusCode);
      // Specifically NOT a success: the old behaviour was a 200.
      expect(res.statusCode).not.toBe(200);
      // And it must name the field, or the caller cannot tell which input to drop.
      expect(res.body).toMatch(/tabId/);
    })();
  });

  it('omitting tabId still works — the refusal is scoped to the unsupported field', () => {
    // Control: without this the arm above would pass against a route that rejects
    // every history request, which would be a worse regression than the defect.
    return (async () => {
      fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
      const id = await createSession(fx);
      const res = await fx.app.inject({
        method: 'POST',
        url: `/v1/agent-sessions/${id}/history`,
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { direction: 'back' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<NavigateHistoryBody>().status).toBeDefined();
    })();
  });
});

describe('POST /v1/agent-sessions/:id/history gui_control_key auth', () => {
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

  it('a control key steps its OWN session (no account Authorization header)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const key = await mintKey(id);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/history`,
      headers: { [GCK_HEADER]: key },
      payload: HISTORY_BODY,
    });
    // Authorized → reaches the handler → a discriminated 200 (unavailable here, no
    // node connected) rather than 401.
    expect(res.statusCode).toBe(200);
    expect(res.json<NavigateHistoryBody>().status).toBe('unavailable');
  });

  it('a control key minted for session A is REJECTED on session B (401)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const idA = await createSession(fx);
    const idB = await createSession(fx);
    const keyA = await mintKey(idA);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${idB}/history`,
      headers: { [GCK_HEADER]: keyA },
      payload: HISTORY_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it('a missing/garbage control key with NO account auth 401s (never falls through)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/history`,
      headers: { [GCK_HEADER]: 'gck_not_a_real_key' },
      payload: HISTORY_BODY,
    });
    expect(res.statusCode).toBe(401);
  });
});
