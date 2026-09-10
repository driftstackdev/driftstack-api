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

// VPN exit parity — an OpenVPN / WireGuard row now DISPATCHES to the fleet on
// vantage=fleet. Before this the route's guard refused every non-socks5 row and
// fell back to the control-plane TCP probe of the DISPLAY host, which measures
// nothing about the tunnel. The node is the only vantage that can see through
// one, so it is also the only source of a VPN row's exit IP / geo / timezone —
// which the route now (a) returns as `exit_observed` and (b) persists onto the
// row as `exit_observed` with `observed_via: 'probe'`, beside the relay's
// 'session' writes.
describe('POST /v1/account/me/proxies/:id/test?vantage=fleet — VPN rows dispatch, and the exit is persisted', () => {
  const WG_PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
  const WG_PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';
  const OVPN_BLOB = 'client\nremote vpn.example.com 1194 udp\ndev tun\n';

  async function makeWireGuardProxy(): Promise<string> {
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: {
        label: 'wg',
        scheme: 'wireguard',
        host: 'vpn.example.com',
        port: 51820,
        wireguard: {
          private_key: WG_PRIV,
          peer_public_key: WG_PUB,
          endpoint: 'vpn.example.com:51820',
          allowed_ips: '0.0.0.0/0',
          address: '10.7.0.2/32',
        },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function makeOpenVpnProxy(): Promise<string> {
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: {
        label: 'ovpn',
        scheme: 'openvpn',
        host: 'vpn.example.com',
        port: 1194,
        openvpn: { config_blob: OVPN_BLOB },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  /** The exit geo a migrated node resolves beside `exit_ip`. */
  const GEO = {
    exit_ip: '198.51.100.44',
    exit_country: 'DE',
    exit_timezone: 'Europe/Berlin',
    exit_region: 'Hesse',
    exit_city: 'Frankfurt am Main',
  };

  /** Register a node that records every probeEgress frame it is handed and
   *  answers with every leg true plus the given exit fields. */
  function registerGeoNode(
    nodeId: string,
    exit: Record<string, unknown>,
    frames: Array<{ type: string; requestId: string; inlineProxyConfig?: string }>,
  ): void {
    const conn: FleetControlConnection = fx.fleetControlRegistry.register(nodeId, (data) => {
      const f = JSON.parse(data) as { type: string; requestId: string; inlineProxyConfig?: string };
      if (f.type !== 'probeEgress') return;
      frames.push(f);
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
          latency_ms: 58,
          h2_ok: true,
          quic_ok: true,
          quic_detail: null,
          error: null,
          ...exit,
        }),
      );
    });
  }

  it('CRITICAL a wireguard row reaches fleetControlRegistry.probeEgress with the VPN inline wire, and the reply is measured_from:fleet with exit_observed', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    const frames: Array<{ type: string; requestId: string; inlineProxyConfig?: string }> = [];
    registerGeoNode('mac-eu-001', GEO, frames);
    const probeSpy = vi.spyOn(fx.fleetControlRegistry, 'probeEgress');
    const id = await makeWireGuardProxy();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    // (ii) The registry WAS asked — with the flat inline WireGuard wire, not a
    // socks5 descriptor and not nothing. Before this change the route returned
    // null before ever touching the registry, so a spy count of 1 is the change.
    expect(probeSpy).toHaveBeenCalledTimes(1);
    const dispatched = probeSpy.mock.calls[0]?.[0]?.inlineProxyConfig as
      | { type?: string; private_key?: string; endpoint?: string }
      | undefined;
    expect(dispatched?.type).toBe('wireguard');
    expect(dispatched?.endpoint).toBe('vpn.example.com:51820');
    expect(dispatched?.private_key).toBe(WG_PRIV);
    // …and the node really received a probeEgress frame carrying that wire.
    expect(frames).toHaveLength(1);
    expect(typeof frames[0]?.inlineProxyConfig).toBe('string');
    expect(frames[0]?.inlineProxyConfig?.length ?? 0).toBeGreaterThan(0);
    const body = res.json<Record<string, unknown>>();
    expect(body.measured_from).toBe('fleet');
    expect(body.node_id).toBe('mac-eu-001');
    expect(body.ok).toBe(true);
    expect(body.latency_ms).toBe(58);
    expect(body.exit_ip).toBe('198.51.100.44');
    expect(body.exit_observed).toEqual({
      ip: '198.51.100.44',
      country: 'DE',
      timezone: 'Europe/Berlin',
      region: 'Hesse',
      city: 'Frankfurt am Main',
    });
    // A VPN wire has no SOCKS5 endpoint for the cp observer to dial, so no chip —
    // absent, never a placeholder.
    expect('os_fingerprint' in body).toBe(false);
  });

  it('CRITICAL an openvpn row dispatches too — the same path, the openvpn wire', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    const frames: Array<{ type: string; requestId: string; inlineProxyConfig?: string }> = [];
    registerGeoNode('mac-eu-002', GEO, frames);
    const probeSpy = vi.spyOn(fx.fleetControlRegistry, 'probeEgress');
    const id = await makeOpenVpnProxy();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(probeSpy).toHaveBeenCalledTimes(1);
    const dispatched = probeSpy.mock.calls[0]?.[0]?.inlineProxyConfig as
      | { type?: string; config_blob?: string }
      | undefined;
    expect(dispatched?.type).toBe('openvpn');
    expect(dispatched?.config_blob).toBe(OVPN_BLOB);
    const body = res.json<Record<string, unknown>>();
    expect(body.measured_from).toBe('fleet');
    expect(body.node_id).toBe('mac-eu-002');
    expect((body.exit_observed as { ip?: string })?.ip).toBe('198.51.100.44');
  });

  it('CRITICAL (iii) the probe-observed exit is PERSISTED onto the row with observed_via:probe', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerGeoNode('mac-eu-003', GEO, []);
    const id = await makeWireGuardProxy();
    const before = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(before?.exitObserved, 'a fresh row has never been observed').toBeNull();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(after?.exitObserved).toEqual({
      ip: '198.51.100.44',
      country: 'DE',
      timezone: 'Europe/Berlin',
      observed_via: 'probe',
    });
    expect(after?.exitObservedAt).toBeInstanceOf(Date);
  });

  it('CRITICAL a node that saw NO exit persists NOTHING — a null exit_ip never nulls an earlier observation', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    const id = await makeWireGuardProxy();
    // Seed an earlier (session-observed) exit the way the relay writes it.
    await fx.accountProxiesRepo.update({
      id,
      accountId: fx.accountId,
      updates: {
        exitObserved: {
          ip: '203.0.113.9',
          country: 'NL',
          timezone: 'Europe/Amsterdam',
          observed_via: 'session',
        },
        exitObservedAt: new Date('2026-09-01T00:00:00Z'),
      },
    });
    registerDeadProxyNode('mac-eu-004'); // exit_ip: null, every leg false
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.measured_from, 'still a fleet measurement').toBe('fleet');
    expect(body.ok).toBe(false);
    expect('exit_observed' in body, 'no exit → no exit_observed key, not a null one').toBe(false);
    const after = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(after?.exitObserved).toEqual({
      ip: '203.0.113.9',
      country: 'NL',
      timezone: 'Europe/Amsterdam',
      observed_via: 'session',
    });
    expect(after?.exitObservedAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('a node that has NOT migrated (exit_ip only, no geo keys) still yields exit_observed with null geo — deployable CP-first', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerGeoNode('mac-eu-005', { exit_ip: '198.51.100.45' }, []);
    const id = await makeWireGuardProxy();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.exit_observed).toEqual({
      ip: '198.51.100.45',
      country: null,
      timezone: null,
      region: null,
      city: null,
    });
    const after = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(after?.exitObserved).toEqual({
      ip: '198.51.100.45',
      country: null,
      timezone: null,
      observed_via: 'probe',
    });
  });

  it('CRITICAL an un-migrated node (ip only) never DOWNGRADES a session observation of the same exit that has geo', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    const id = await makeWireGuardProxy();
    await fx.accountProxiesRepo.update({
      id,
      accountId: fx.accountId,
      updates: {
        exitObserved: {
          ip: '203.0.113.9',
          country: 'NL',
          timezone: 'Europe/Amsterdam',
          observed_via: 'session',
        },
        exitObservedAt: new Date('2026-09-01T00:00:00Z'),
      },
    });
    registerGeoNode('mac-eu-007', { exit_ip: '203.0.113.9' }, []);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    // The measurement is still REPORTED (the node did see the exit) …
    expect(body.exit_observed).toEqual({
      ip: '203.0.113.9',
      country: null,
      timezone: null,
      region: null,
      city: null,
    });
    // … but the stored observation keeps its geo and its timestamp.
    const after = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(after?.exitObserved).toEqual({
      ip: '203.0.113.9',
      country: 'NL',
      timezone: 'Europe/Amsterdam',
      observed_via: 'session',
    });
    expect(after?.exitObservedAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('(e) a QUIC leg the node SKIPPED is not reported as a QUIC verdict — quic_ok is absent, the detail stays', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerDeadProxyNode('mac-eu-020', {
      reachable: true,
      auth_ok: true,
      can_route: true,
      exit_ip: '203.0.113.20',
      quic_ok: false,
      quic_detail: 'skipped: quic leg not probed on the vpn path',
    });
    const id = await makeWireGuardProxy();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.measured_from).toBe('fleet');
    expect('quic_ok' in body, 'a skipped leg is not a false').toBe(false);
    expect(body.quic_detail).toBe('skipped: quic leg not probed on the vpn path');
  });

  it('(e) CONTROL — a MEASURED QUIC failure (no "skipped:" detail) still lands as quic_ok:false', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerDeadProxyNode('mac-eu-021', {
      reachable: true,
      auth_ok: true,
      can_route: true,
      exit_ip: '203.0.113.21',
      quic_ok: false,
      quic_detail: 'quic handshake failed',
    });
    const id2 = await makeWireGuardProxy();
    const res2 = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id2}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res2.json<Record<string, unknown>>().quic_ok).toBe(false);
  });

  it('(e) a VPN row never reports udp_associate (a tunnel carries UDP by nature); a socks5 row still does', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerGeoNode('mac-eu-022', GEO, []);
    const vpn = await makeWireGuardProxy();
    const r1 = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${vpn}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(r1.statusCode, r1.body).toBe(200);
    expect('udp_associate' in r1.json<Record<string, unknown>>()).toBe(false);
    const socks = await makeProxy('proxy-udp.example.com');
    const r2 = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${socks}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.json<Record<string, unknown>>().udp_associate).toBe(true);
  });

  it('(e) CRITICAL a node_busy refusal reads as a wait, carries NO measurement fields, and is still a fleet answer', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerDeadProxyNode('mac-eu-023', {
      ok: false,
      status: 'could_not_run',
      error: 'node_busy',
      quic_detail: null,
      exit_ip: null,
    });
    const id = await makeWireGuardProxy();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.ok).toBe(false);
    expect(body.measured_from).toBe('fleet');
    expect(body.reason).toMatch(/busy with another tunnel or test/);
    for (const k of [
      'reachable',
      'auth_ok',
      'udp_associate',
      'can_route',
      'h2_ok',
      'quic_ok',
      'quic_detail',
      'exit_ip',
      'exit_observed',
    ]) {
      expect(k in body, `${k} must be absent on a could_not_run result`).toBe(false);
    }
  });

  it('(e) CONTROL — a could_not_run WITHOUT the busy token keeps the generic could-not-complete sentence', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerDeadProxyNode('mac-eu-024', {
      ok: false,
      status: 'could_not_run',
      error: 'bad_config: missing remote',
      quic_detail: null,
      exit_ip: null,
    });
    const id2 = await makeWireGuardProxy();
    const res2 = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id2}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res2.json<Record<string, unknown>>().reason).toMatch(
      /could not be completed on the measuring Mac/,
    );
  });

  it('(e) CONTROL — a socks5 row with a node that could not run the probe still gets the control-plane fallback (a real SOCKS5 measurement)', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerDeadProxyNode('mac-eu-025', {
      ok: false,
      status: 'could_not_run',
      error: 'node_busy',
      quic_detail: null,
      exit_ip: null,
    });
    const socks = await makeProxy('proxy-busy.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${socks}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<Record<string, unknown>>().measured_from).toBe('control_plane');
  });

  it('a socks5 row carries exit_observed on the same path — parity is one implementation, not a VPN branch', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerGeoNode('mac-eu-006', GEO, []);
    const id = await makeProxy('fleet-socks-geo.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.measured_from).toBe('fleet');
    expect((body.exit_observed as { city?: string })?.city).toBe('Frankfurt am Main');
    const after = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(after?.exitObserved?.observed_via).toBe('probe');
  });

  it('VACUITY CONTROL — with NO node connected a wireguard row still falls back to the control plane, labelled honestly', async () => {
    // Proves the arms above measure the dispatch and not a route that now always
    // reports `fleet` for a VPN row.
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    const probeSpy = vi.spyOn(fx.fleetControlRegistry, 'probeEgress');
    const id = await makeWireGuardProxy();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(probeSpy).toHaveBeenCalledTimes(1); // asked, and told "no node"
    const body = res.json<Record<string, unknown>>();
    expect(body.measured_from).toBe('control_plane');
    expect('exit_observed' in body).toBe(false);
    expect('node_id' in body).toBe(false);
  });
});
