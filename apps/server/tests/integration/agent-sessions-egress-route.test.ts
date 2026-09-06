// P-17 — integration tests for POST /v1/agent-sessions/:id/egress, the live
// egress swap. Mirrors the cookies-import route tests: the discriminated 200 in
// every relay case (never an HTTP error for an expected-inert state), the gated
// 503, the ownership 404, the malformed-body 422, and a live round-trip through
// the fleet control connection's SetEgressRequestCorrelator.
//
// Two arms here are not shape-pinning, they are the reason the route is written
// the way it is:
//
//   ⛔ AN UNPROBED PROXY IS REFUSED, NOT GUESSED. The wire frame requires an
//   exitIdentity, and that block is what the device shows in its new-tab IP panel
//   and what T-11 spoofs navigator.geolocation from. Synthesising one would put a
//   false IP and a mismatched timezone in front of the site under test — a
//   fingerprint inconsistency, which is the single thing this product exists not
//   to produce. So a proxy with no measured identity answers `unavailable`.
//
//   ⛔ A MISSING apply_point ECHO IS NOT A BARE SUCCESS. A device predating that
//   field accepts the request, drops the field, does whatever it does by default
//   and replies ok. Reporting that as a plain success would tell the caller they
//   bought a deferred swap while the device may have reset every connection
//   mid-page. The null is the information.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

interface EgressBody {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  apply_point?: 'next_navigation' | 'immediate' | null;
  reason?: string;
}

const IDENTITY = {
  ip: '203.0.113.7',
  country: 'NL',
  region: 'North Holland',
  city: 'Amsterdam',
  timezone: 'Europe/Amsterdam',
};

/** A probe that always connects. `withIdentity` decides whether it MEASURED an
 *  exit — the discriminator between the two behaviours above. */
const probeStub = (withIdentity: boolean): never =>
  ({
    probe: () =>
      Promise.resolve(withIdentity ? { ok: true, exitIdentity: IDENTITY } : { ok: true }),
    observeOs: () => Promise.resolve(undefined),
  }) as unknown as never;

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

async function createProxy(fx: TestAppFixture): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/account/me/proxies',
    headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
    // A routable public host: 198.51.100.0/24 is TEST-NET-2 and the SSRF guard
    // refuses reserved space at create time, which is correct and not what this
    // fixture is testing.
    payload: { label: 'egress-swap-target', host: 'proxy.example.net', port: 1080 },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

describe('POST /v1/agent-sessions/:id/egress (activation gate off — runtime not wired)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('→ 503 FeatureUnavailable (gated like the other agent-session routes, not a bare 404)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_xxx/egress',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { proxy_id: 'prx_whatever' },
    });
    expect(res.statusCode).toBe(503);
  });
});

describe('POST /v1/agent-sessions/:id/egress (wired)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('unknown/foreign session → 404 (never confirms another account’s session)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_00000000-0000-4000-8000-0000000000ff/egress',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { proxy_id: 'prx_whatever' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('missing proxy_id → 422 (the swap has no target)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/egress`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('unknown apply_point → 422 (the enum is closed; a typo must not silently mean immediate)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/egress`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { proxy_id: 'prx_whatever', apply_point: 'right_now' },
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('session not live on a node → 200 unavailable (an expected-inert state, never an HTTP error)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/egress`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { proxy_id: 'prx_whatever' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<EgressBody>();
    expect(body.status).toBe('unavailable');
    expect(body.reason).toMatch(/not live on a node/);
  });

  it('CRITICAL an unresolvable proxy FAILS CLOSED with a 422 — never a silent fall back to the operator default', async () => {
    // Falling back would move a customer's live session onto shared egress they
    // never chose. That is an egress-identity leak, and it would look like success.
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableFleetControlPlane: true,
      proxyConnectivityProbe: probeStub(true),
    });
    const id = await createSession(fx);
    const nodeId = 'node-egress-unresolvable';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    fx.fleetControlRegistry.register(nodeId, () => {});
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/egress`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { proxy_id: '00000000-0000-4000-8000-0000000000aa' },
    });
    expect([400, 422]).toContain(res.statusCode);
    // Specifically NOT a 200 'ok' — the assertion above would also pass on a 4xx
    // for the wrong reason, so pin that no swap was reported.
    expect(res.statusCode).not.toBe(200);
  });

  it('CRITICAL a proxy with NO measured exit identity → unavailable, not a guessed identity', async () => {
    // The device would show whatever IP/timezone we sent it. Inventing one is a
    // fingerprint inconsistency in front of the site under test.
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableFleetControlPlane: true,
      proxyConnectivityProbe: probeStub(false), // connects, measures nothing
    });
    const id = await createSession(fx);
    const proxyId = await createProxy(fx);
    const nodeId = 'node-egress-no-identity';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    let framesSent = 0;
    fx.fleetControlRegistry.register(nodeId, () => {
      framesSent += 1;
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/egress`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { proxy_id: proxyId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<EgressBody>();
    expect(body.status).toBe('unavailable');
    expect(body.reason).toMatch(/exit identity/);
    // The load-bearing half: nothing was sent to the device. A reason string is
    // cheap; not having moved the session is the property.
    expect(framesSent).toBe(0);
  });
  /** A live node that echoes a setEgressResult. `applyPointEcho` of `undefined`
   *  is the OLD-DEVICE case: it accepts, drops the field, and replies ok. */
  async function swapAgainstLiveNode(
    nodeId: string,
    applyPointEcho: 'next_navigation' | 'immediate' | undefined,
    body: Record<string, unknown>,
  ): Promise<{ res: EgressBody; sent: Record<string, unknown> | null }> {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableFleetControlPlane: true,
      proxyConnectivityProbe: probeStub(true),
    });
    const id = await createSession(fx);
    const proxyId = await createProxy(fx);
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    let sent: Record<string, unknown> | null = null;
    const conn = fx.fleetControlRegistry.register(nodeId, (data) => {
      const frame = JSON.parse(data) as Record<string, unknown>;
      if (frame.type === 'setEgress') {
        sent = frame;
        conn.handleInbound(
          JSON.stringify({
            type: 'setEgressResult',
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            ok: true,
            ...(applyPointEcho !== undefined ? { applyPoint: applyPointEcho } : {}),
          }),
        );
      }
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/egress`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { proxy_id: proxyId, ...body },
    });
    expect(res.statusCode).toBe(200);
    return { res: res.json<EgressBody>(), sent };
  }

  it('CRITICAL a deferred swap the device confirms → ok + next_navigation, and the wire carries the measured exit', async () => {
    const { res, sent } = await swapAgainstLiveNode('node-egress-deferred', 'next_navigation', {});
    expect(res.status).toBe('ok');
    expect(res.apply_point).toBe('next_navigation');
    // Defaulted at the route, not left absent on the wire: the frame schema
    // requires it, and "what did the device do?" must not be answerable by guessing.
    expect(sent).not.toBeNull();
    expect((sent as Record<string, unknown>).applyPoint).toBe('next_navigation');
    // The exit identity crossed as MEASURED, in the wire's snake_case shape.
    const identity = (sent as Record<string, unknown>).exitIdentity as Record<string, unknown>;
    expect(identity.ip).toBe(IDENTITY.ip);
    expect(identity.timezone).toBe(IDENTITY.timezone);
    expect(identity.probed_at).toEqual(expect.any(String));
  });

  it('an immediate swap is passed through as asked, not silently deferred', async () => {
    const { res, sent } = await swapAgainstLiveNode('node-egress-immediate', 'immediate', {
      apply_point: 'immediate',
    });
    expect(res.status).toBe('ok');
    expect(res.apply_point).toBe('immediate');
    expect((sent as Record<string, unknown>).applyPoint).toBe('immediate');
  });

  it('CRITICAL a device that does NOT echo the apply point is not reported as a plain success', async () => {
    // The one outcome this frame exists to make deliberate. An old device accepts,
    // drops the field, does whatever it does by default and replies ok — so a bare
    // success would tell the caller they bought a deferred swap while every
    // in-flight connection may have been reset mid-page.
    const { res } = await swapAgainstLiveNode('node-egress-unconfirmed', undefined, {});
    expect(res.status).toBe('ok');
    expect(res.apply_point).toBeNull();
    expect(res.reason).toMatch(/did not confirm/);
    // Vacuity control: the confirmed case above returns a non-null apply_point, so
    // this arm measures the missing echo and not "apply_point is always null".
    expect(res.apply_point).not.toBe('next_navigation');
  });
});
