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
