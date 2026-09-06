// T-1 — the proxy Test route's vantage half. The owner asked that proxy
// latency/ping/QUIC be measured from the Mac that will run the profile, not from
// the customer's laptop or the control plane. These arms pin the wire contract:
//   vantage=fleet + a connected node → the node's measurement, labelled
//                                       measured_from:'fleet'
//   vantage=fleet + NO free node     → the control-plane probe instead, HONESTLY
//                                       labelled measured_from:'control_plane', 200
//                                       (never a 500, never a fleet label on a cp result)
//   default (vantage=cp)             → today's response, unchanged (no measured_from)
//
// The registry-level provenance + cordon-skip logic is unit-tested in
// probe-egress-request-correlator.test.ts; this is the route wiring end-to-end.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type { FleetControlConnection } from '../../src/services/fleet-control-registry.js';

let fx: TestAppFixture;
afterEach(async () => {
  vi.restoreAllMocks();
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

async function makeProxy(host: string): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/account/me/proxies',
    headers: { ...auth(fx), 'content-type': 'application/json' },
    payload: { label: 'p', host, port: 1080 },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

/** A deterministic control-plane probe stub for the fallback arm (never reached on
 *  the fleet-success arm). */
const cpProbeStub = (): never =>
  ({
    probe: () => Promise.resolve({ ok: true }),
    observeOs: () => Promise.resolve({ observed: false, reason: 'no SYN recorded' }),
  }) as unknown as never;

/** N-2 — a cp probe whose observer DOES record a SYN. The fingerprint is a
 *  CONTROL-PLANE measurement on BOTH vantages (the cp dials through the proxy to
 *  its own raw-socket observer), so a fleet result must carry it alongside the
 *  node's latency. */
const observingProbeStub = (): never =>
  ({
    probe: () => Promise.resolve({ ok: true }),
    observeOs: () =>
      Promise.resolve({
        observed: true,
        observedIp: '198.51.100.7',
        via: 'proxy_host',
        signature: {},
        os: 'windows',
        confidence: 'medium',
        reason: 'initial TTL 128 with a Windows option layout',
      }),
  }) as unknown as never;

/** An observer that THROWS rather than answering `{observed:false}` — the case the
 *  fleet branch must survive without losing the node's measurement. */
const throwingObserverStub = (): never =>
  ({
    probe: () => Promise.resolve({ ok: true }),
    observeOs: () => Promise.reject(new Error('observer socket exploded')),
  }) as unknown as never;

/** Register a node that answers with the shape a DEAD proxy really produces:
 *  `ok:true` (the probe reached a verdict) and every leg false. Measured on a live
 *  proxy 2026-09-06 — including `quic_detail: 'skipped: endpoint_unreachable'`. */
function registerDeadProxyNode(nodeId: string, legs: Record<string, unknown> = {}): void {
  const conn: FleetControlConnection = fx.fleetControlRegistry.register(nodeId, (data) => {
    const f = JSON.parse(data) as { type: string; requestId: string };
    if (f.type !== 'probeEgress') return;
    conn.handleInbound(
      JSON.stringify({
        type: 'probeEgressResult',
        requestId: f.requestId,
        node_id: nodeId,
        ok: true,
        reachable: false,
        auth_ok: false,
        udp_associate: false,
        can_route: false,
        latency_ms: null,
        h2_ok: false,
        quic_ok: false,
        quic_detail: 'skipped: endpoint_unreachable',
        exit_ip: null,
        error: null,
        ...legs,
      }),
    );
  });
}

/** Register a fleet node that auto-answers a probeEgress with a node-measured
 *  result carrying its OWN node id (so the registry's provenance check passes). */
function registerReplyingNode(nodeId: string, latencyMs: number): void {
  const conn: FleetControlConnection = fx.fleetControlRegistry.register(nodeId, (data) => {
    const f = JSON.parse(data) as { type: string; requestId: string };
    if (f.type !== 'probeEgress') return;
    conn.handleInbound(
      JSON.stringify({
        type: 'probeEgressResult',
        requestId: f.requestId,
        node_id: nodeId,
        ok: true,
        reachable: true,
        auth_ok: true,
        udp_associate: true,
        can_route: true,
        latency_ms: latencyMs,
        h2_ok: true,
        quic_ok: true,
        quic_detail: null,
        exit_ip: '198.51.100.22',
        error: null,
      }),
    );
  });
}

describe('POST /v1/account/me/proxies/:id/test — vantage', () => {
  it('vantage=fleet with a connected node returns the node measurement, labelled measured_from:fleet', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerReplyingNode('mac-us-001', 123);
    const id = await makeProxy('fleet-ok.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.measured_from).toBe('fleet');
    expect(body.node_id).toBe('mac-us-001');
    expect(body.latency_ms).toBe(123);
    expect(body.reachable).toBe(true);
    expect(body.quic_ok).toBe(true);
    expect(body.exit_ip).toBe('198.51.100.22');
  });

  it('vantage=fleet with NO free node falls back to the control plane, labelled measured_from:control_plane (never a 500)', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    // no node registered → the registry has nothing to dispatch to
    const id = await makeProxy('fleet-nonode.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.measured_from).toBe('control_plane');
    expect(body.ok).toBe(true);
    // a cp result carries no node-measured fields
    expect('node_id' in body).toBe(false);
  });

  it('the default vantage (cp) is unchanged — today response, no measured_from field', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerReplyingNode('mac-us-001', 123); // present, but a cp request must not consult it
    const id = await makeProxy('cp-default.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect('measured_from' in body).toBe(false);
    expect(body.ok).toBe(true);
  });

  // ⛔ N-2 REGRESSION GUARD. The OS-fingerprint chip worked on the cp vantage and
  // vanished the moment the GUI started asking for `fleet`, because the attachment
  // lived in the cp branch alone. Nothing failed — the field was simply absent, and
  // absence is the documented "not observed" answer, so the wire looked correct.
  // These two arms are the reason it cannot be dropped again silently.
  it('CRITICAL vantage=fleet carries the control-plane OS fingerprint too', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: observingProbeStub(),
    });
    registerReplyingNode('mac-us-002', 77);
    const id = await makeProxy('fleet-fp.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    // The node still measured the latency — the fingerprint rides ALONGSIDE it,
    // which is the whole claim: two vantages in one response, each labelled.
    expect(body.measured_from).toBe('fleet');
    expect(body.node_id).toBe('mac-us-002');
    expect(body.latency_ms).toBe(77);
    expect(body.os_fingerprint).toEqual({
      os: 'windows',
      confidence: 'medium',
      reason: 'initial TTL 128 with a Windows option layout',
      observed_ip: '198.51.100.7',
      observed_via: 'proxy_host',
    });
  });

  it('CRITICAL an observer that THROWS costs the chip, never the node measurement', async () => {
    // ⛔ The subtle failure: an exception inside `runFleetProbe` is caught by its
    // own handler, which returns null and falls the request back to the control
    // plane. A fingerprint failure would then relabel a node measurement as
    // `control_plane` — a WRONG provenance, and worse than no chip at all.
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: throwingObserverStub(),
    });
    registerReplyingNode('mac-us-003', 91);
    const id = await makeProxy('fleet-fp-throw.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.measured_from).toBe('fleet');
    expect(body.node_id).toBe('mac-us-003');
    expect(body.latency_ms).toBe(91);
    expect('os_fingerprint' in body).toBe(false);
  });

  // ⛔ THE NODE'S `ok` IS NOT THE CUSTOMER'S `ok`. On the node's frame it means
  // "the probe reached a verdict"; a proxy that answers nothing comes back ok:true
  // with every leg false. Forwarding that flag under the same name published a
  // PASS for a dead proxy — measured live on 2026-09-06, four identical results —
  // while the other two members of this union use `ok` to mean "usable".
  it('CRITICAL a node ok:true with every leg false is a FAILED test, not a pass', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerDeadProxyNode('mac-us-004');
    const id = await makeProxy('fleet-dead.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.ok, 'a proxy that answered nothing must not read as a pass').toBe(false);
    expect(body.reason).toMatch(/did not answer/i);
    // Still honestly labelled as a fleet measurement — the verdict changed, not
    // the provenance, and the customer is owed both.
    expect(body.measured_from).toBe('fleet');
    expect(body.node_id).toBe('mac-us-004');
  });

  it('CRITICAL the failing LEG picks the sentence, in the order the probe establishes them', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    // Reachable and authenticated, but it cannot route — the condition that
    // blocked every launch on 2026-08-18 while reachability checks read healthy.
    registerDeadProxyNode('mac-us-005', { reachable: true, auth_ok: true, udp_associate: true });
    const id = await makeProxy('fleet-noroute.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    const body = res.json<Record<string, unknown>>();
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/could not reach the internet/i);
    // NOT the earlier sentence — the legs are ordered, and reporting the last
    // failure instead of the first would send a customer to the wrong setting.
    expect(body.reason).not.toMatch(/did not answer/i);
  });

  it('VACUITY CONTROL — a node with every leg TRUE is still a pass', async () => {
    // Proves the two arms above measure the legs and not a verdict that now
    // always fails. `registerReplyingNode` answers with every leg true.
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerReplyingNode('mac-us-006', 42);
    const id = await makeProxy('fleet-good.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    const body = res.json<Record<string, unknown>>();
    expect(body.ok).toBe(true);
    expect('reason' in body, 'a passing test carries no failure sentence').toBe(false);
  });

  it('an unknown vantage value is a 400, not a silent default', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    const id = await makeProxy('cp-badvantage.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=laptop`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(400);
  });
});
