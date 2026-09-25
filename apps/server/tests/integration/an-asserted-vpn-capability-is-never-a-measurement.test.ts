// (V6 2026-09-16) ITEM 3 — an ASSERTED field must never reach a customer surface
// as a measurement.
//
// Read from the node source this session: on the VPN path the fleet Mac writes
// `udp_associate: true` and `h2_ok: true` as LITERALS about the tunnel's nature.
// Nothing is dialled, nothing times out, and neither could ever come back false.
// `quic_ok: false` beside `quic_detail: "skipped: …"` is the same class of
// non-fact under a different name: the node is saying IT DID NOT LOOK.
//
// A customer must never be told their tunnel lacks QUIC because we did not look,
// and must never be shown an "HTTP/2 ✓" no probe earned. So the reply OMITS
// every non-reading, and absence is the wire's "not measured".
//
// Three properties, one per guard:
//   G2  a literal true on the VPN path does not leave this route as a reading;
//   G1  a reply whose udp/quic fields are absent carries neither key (the client
//       suites render that absence as "not measured");
//   G3  a MEASURED false — the node's contracted three-state `udp_associate`,
//       with its `udp_detail` sentence — DOES leave as `false`, so a negative
//       verdict is distinguishable from an absence.
//
// VACUITY CONTROLS run in the same file and matter here more than usual: a route
// that dropped these fields unconditionally would pass every absence assertion.
// So each absence arm sends the SAME frame to a SOCKS5 row, where the same fields
// ARE measurements and must still be reported, and G3 has both polarities.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type { FleetControlConnection } from '../../src/services/fleet-control-registry.js';
import { capabilityReadingsForReply } from '../../src/routes/account-me.js';

let fx: TestAppFixture;
afterEach(async () => {
  vi.restoreAllMocks();
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

/** The control-plane probe stub. Never reached on the fleet-success arms; present
 *  so the route's own fallback is configured rather than absent. */
const cpProbeStub = (): never =>
  ({
    probe: () => Promise.resolve({ ok: true }),
    observeOs: () => Promise.resolve({ observed: false, reason: 'no SYN recorded' }),
  }) as unknown as never;

const WG_PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const WG_PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';

/**
 * A node that answers a probeEgress with a VERDICT frame whose legs the caller
 * chooses. The base is a healthy tunnel — reachable, authenticated, routing, with
 * an exit — so every arm below differs from its twin ONLY in the fields under
 * test, and an arm cannot pass because the probe failed for some other reason.
 */
function registerNode(nodeId: string, legs: Record<string, unknown> = {}): void {
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
        can_route: true,
        latency_ms: 42,
        exit_ip: '198.51.100.44',
        quic_detail: null,
        error: null,
        ...legs,
      }),
    );
  });
}

/** TODAY'S VPN FRAME, as the node really builds it: both literals asserted, the
 *  QUIC leg declared skipped. Nothing here was probed except the exit. */
const VPN_ASSERTED_LEGS = {
  udp_associate: true,
  h2_ok: true,
  quic_ok: false,
  quic_detail: 'skipped: quic leg not probed on the vpn path',
} as const;

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

async function makeSocks5Proxy(host: string): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/account/me/proxies',
    headers: { ...auth(fx), 'content-type': 'application/json' },
    payload: { label: 'p', host, port: 1080 },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

async function testFleet(id: string): Promise<Record<string, unknown>> {
  const res = await fx.app.inject({
    method: 'POST',
    url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
    headers: auth(fx),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Record<string, unknown>>();
}

describe('the route reports a capability only when the node MEASURED it', () => {
  it('G2 CRITICAL a VPN row drops the node’s asserted udp_associate AND h2_ok — a SOCKS5 row keeps h2_ok and, since S1, drops the bare udp_associate too (it is the node’s own gost grant)', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerNode('mac-v6-001', VPN_ASSERTED_LEGS);
    const vpn = await makeWireGuardProxy();
    const vpnBody = await testFleet(vpn);
    // The probe DID reach a verdict and the tunnel IS up — so this arm is about
    // the fields, not about a failed test.
    expect(vpnBody.ok, JSON.stringify(vpnBody)).toBe(true);
    expect(vpnBody.measured_from).toBe('fleet');
    expect(vpnBody.reachable).toBe(true);
    expect(vpnBody.can_route).toBe(true);
    // ⛔ The three non-readings. `h2_ok` is the one this item fixed: it was
    // forwarded for every VPN row, so a tunnel nobody probed for HTTP/2 shipped
    // `h2_ok: true` to the customer beside fields that ARE measurements.
    expect('udp_associate' in vpnBody, 'the tunnel literal is not a reading').toBe(false);
    expect('h2_ok' in vpnBody, 'the HTTP/2 literal is not a reading').toBe(false);
    expect('quic_ok' in vpnBody, 'a skipped leg is not a false').toBe(false);
    // …and the node's own sentence survives, because it is the only thing on the
    // wire that can say WHY there is no QUIC verdict.
    expect(vpnBody.quic_detail).toBe('skipped: quic leg not probed on the vpn path');

    // VACUITY CONTROL — the IDENTICAL frame, from the SAME node, on a SOCKS5
    // row, where h2_ok really is probed: still reported. Without this the arm
    // above would pass on a route that had simply stopped emitting it. ⛔ One node
    // per fixture: the registry dispatches to whichever node is free, so a second
    // `registerNode` here would never answer and these assertions would quietly
    // re-read the first node's frame anyway.
    //
    // ⛔ S1 (proxy-accuracy audit) — the bare `udp_associate` is NOT a reading on
    // the SOCKS5 row either: the node's QUIC tool asks its own local gost, which
    // grants UDP before the upstream is contacted. Its vacuity control (the echo
    // IS reported) is the next arm.
    const socks = await makeSocks5Proxy('socks-v6-002.example.com');
    const socksBody = await testFleet(socks);
    expect(socksBody.ok, JSON.stringify(socksBody)).toBe(true);
    expect('udp_associate' in socksBody, 'the local gost grant is not a reading').toBe(false);
    expect(socksBody.h2_ok).toBe(true);
  });

  it('G2 VACUITY CONTROL — S1: a completed handshake’s `udp_echo_ok: true` IS reported as UDP on both schemes', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerNode('mac-v6-001b', {
      udp_associate: true,
      h2_ok: true,
      quic_ok: true,
      quic_detail: null,
      udp_echo_ok: true,
    });
    for (const id of [
      await makeWireGuardProxy(),
      await makeSocks5Proxy('socks-v6-002b.example.com'),
    ]) {
      const body = await testFleet(id);
      expect(body.ok, JSON.stringify(body)).toBe(true);
      expect(body.udp_associate).toBe(true);
    }
  });

  it('G1 a three-state null / an absent key is NOT MEASURED — the frame parses and the reply omits it', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    // The CONTRACTED node change: explicit nulls plus the *_detail sentences.
    // ⛔ This is also the schema's vacuity control. `udp_associate` and `quic_ok`
    // were REQUIRED booleans on `ProbeEgressResultSchema`; a node that started
    // sending null would have failed validation, the correlator would have
    // dropped every frame, and the customer would have got "no Mac was free" for
    // every proxy on the account. `ok: true` below is only reachable because the
    // schema now accepts the three-state shape.
    registerNode('mac-v6-003', {
      udp_associate: null,
      udp_detail: 'skipped: udp leg not probed on the vpn path',
      h2_ok: true,
      quic_ok: null,
      quic_detail: 'skipped: quic leg not probed on the vpn path',
    });
    const vpn = await makeWireGuardProxy();
    const body = await testFleet(vpn);
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.measured_from).toBe('fleet');
    expect('udp_associate' in body, 'null is not a reading').toBe(false);
    expect('quic_ok' in body, 'null is not a reading').toBe(false);
    expect('h2_ok' in body).toBe(false);
    // The detail rides without the boolean: the absence has a cause and the wire
    // carries it, which is what lets a surface say "not measured" rather than
    // guessing between "no UDP" and "nobody looked".
    expect(body.udp_detail).toBe('skipped: udp leg not probed on the vpn path');

    // VACUITY CONTROL — the SAME frame on a SOCKS5 row. ⛔ One node per fixture:
    // the registry dispatches to whichever node is free, so a second
    // `registerNode` in one arm is a node that never answers and an assertion
    // that silently describes the first one's frame.
    //
    // A null is not a false on a SOCKS5 row either — and `h2_ok`, which IS
    // probed on that path, is still reported. Without this half the arm above
    // would pass on a route that had simply stopped emitting all three.
    const socks = await makeSocks5Proxy('socks-v6-003.example.com');
    const socksBody = await testFleet(socks);
    expect(socksBody.ok, JSON.stringify(socksBody)).toBe(true);
    expect('udp_associate' in socksBody, 'a null is not a false').toBe(false);
    expect('quic_ok' in socksBody, 'a null is not a false').toBe(false);
    expect(socksBody.h2_ok, 'h2 is a measurement on the socks5 path').toBe(true);
  });

  it('G3 CRITICAL a MEASURED udp false on the VPN path IS reported — distinguishable from the absence above', async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    // The migrated node: it RAN the leg through the tunnel, it failed, and it
    // says so. This must reach the customer as a negative verdict — the whole
    // point of dropping the literals is that what survives is real.
    registerNode('mac-v6-005', {
      udp_associate: false,
      udp_detail: 'udp relay refused by the tunnel peer',
      h2_ok: true,
      quic_ok: false,
      quic_detail: 'quic handshake timed out',
    });
    const vpn = await makeWireGuardProxy();
    const body = await testFleet(vpn);
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.udp_associate, 'a measured false is a verdict, not an absence').toBe(false);
    expect(body.udp_detail).toBe('udp relay refused by the tunnel peer');
    expect(body.quic_ok).toBe(false);
    // …and h2_ok is STILL absent: no three-state contract exists for it, nothing
    // probes it on this path, and a measured UDP verdict does not make the HTTP/2
    // literal beside it a measurement.
    expect('h2_ok' in body, 'h2 is asserted on this path whatever else was measured').toBe(false);
  });

  it('G3 VACUITY CONTROL — a MEASURED udp true on the VPN path is reported too', async () => {
    // Its own fixture, and the reason is the trap the arm above walked into: the
    // registry dispatches to whichever node is free, so a second `registerNode`
    // inside one arm never answers and its assertions quietly re-read the first
    // node's frame. Here it also proves the arm above is not passing on "a false
    // survives" alone — the rule reports what the node measured, either way.
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: cpProbeStub(),
    });
    registerNode('mac-v6-006', {
      udp_associate: true,
      udp_detail: 'udp relayed through the tunnel',
      h2_ok: true,
      quic_ok: true,
      quic_detail: 'h3 relayed',
    });
    const vpn = await makeWireGuardProxy();
    const body = await testFleet(vpn);
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.udp_associate).toBe(true);
    expect(body.udp_detail).toBe('udp relayed through the tunnel');
    expect(body.quic_ok).toBe(true);
    expect('h2_ok' in body).toBe(false);
  });
});

/**
 * The rule itself, pinned directly. The route arms above prove it is WIRED; these
 * prove what it DECIDES, including the two combinations a node has never sent and
 * that an end-to-end arm would therefore not cover.
 */
describe('capabilityReadingsForReply', () => {
  const base = { h2_ok: true, quic_ok: true, quic_detail: null } as const;

  it('keys UDP on the DETAIL, not on the boolean, for a VPN row', () => {
    // The legacy literal: a boolean with no sentence behind it.
    expect(
      capabilityReadingsForReply('wireguard', { ...base, udp_associate: true }).udp_associate,
    ).toBeUndefined();
    // The same boolean WITH the node's sentence is a measurement.
    expect(
      capabilityReadingsForReply('wireguard', {
        ...base,
        udp_associate: true,
        udp_detail: 'udp relayed',
      }).udp_associate,
    ).toBe(true);
    // A skipped leg is never a reading, sentence or not.
    expect(
      capabilityReadingsForReply('wireguard', {
        ...base,
        udp_associate: false,
        udp_detail: 'skipped: not probed',
      }).udp_associate,
    ).toBeUndefined();
    // ⛔ S1 (proxy-accuracy audit) — a SOCKS5 row's bare boolean is not a reading
    // either: the node's QUIC tool asks its OWN local gost listener, which grants
    // UDP ASSOCIATE before the upstream is ever contacted (a proxy that refuses
    // UDP read ✓), and reads `false` when the tool itself did not run.
    expect(
      capabilityReadingsForReply('socks5', { ...base, udp_associate: true }).udp_associate,
    ).toBeUndefined();
    expect(
      capabilityReadingsForReply('socks5', {
        ...base,
        quic_ok: null,
        quic_detail: 'probe_unavailable',
        udp_associate: false,
      }).udp_associate,
    ).toBeUndefined();
    // …the datagram round trip is: a COMPLETED QUIC handshake through the proxy
    // (`udp_echo_ok`), on either scheme. True or absent — never a measured false.
    for (const scheme of ['socks5', 'wireguard', 'openvpn']) {
      expect(
        capabilityReadingsForReply(scheme, { ...base, udp_associate: true, udp_echo_ok: true })
          .udp_associate,
      ).toBe(true);
      expect(
        capabilityReadingsForReply(scheme, { ...base, udp_associate: false, udp_echo_ok: true })
          .udp_associate,
      ).toBe(true);
      for (const echo of [false, null, undefined]) {
        expect(
          capabilityReadingsForReply(scheme, { ...base, udp_associate: true, udp_echo_ok: echo })
            .udp_associate,
        ).toBeUndefined();
      }
    }
    // A SOCKS5 measurement WITH its sentence (the device's own datagram leg, D1)
    // is a reading like a VPN's — including the only honest ⤵, a refusal.
    expect(
      capabilityReadingsForReply('socks5', {
        ...base,
        udp_associate: false,
        udp_detail: 'upstream refused udp associate (0x07)',
      }).udp_associate,
    ).toBe(false);
    // …but a skipped leg or a null is not a reading there either.
    expect(
      capabilityReadingsForReply('socks5', {
        ...base,
        udp_associate: true,
        udp_detail: 'skipped: node did not run the leg',
      }).udp_associate,
    ).toBeUndefined();
    expect(
      capabilityReadingsForReply('socks5', { ...base, udp_associate: null }).udp_associate,
    ).toBeUndefined();
  });

  it('never reports h2_ok for a tunnel and always reports it for a socks5 row', () => {
    for (const scheme of ['openvpn', 'wireguard']) {
      expect(capabilityReadingsForReply(scheme, { ...base, udp_associate: true }).h2_ok).toBe(
        undefined,
      );
    }
    for (const value of [true, false]) {
      expect(
        capabilityReadingsForReply('socks5', { ...base, h2_ok: value, udp_associate: true }).h2_ok,
      ).toBe(value);
    }
  });

  it('drops quic on a null or a skipped leg and keeps a measured one on either scheme', () => {
    expect(
      capabilityReadingsForReply('wireguard', {
        ...base,
        udp_associate: null,
        quic_ok: null,
      }).quic_ok,
    ).toBeUndefined();
    expect(
      capabilityReadingsForReply('wireguard', {
        ...base,
        udp_associate: null,
        quic_ok: false,
        quic_detail: 'skipped: quic leg not probed on the vpn path',
      }).quic_ok,
    ).toBeUndefined();
    // ⛔ The measured negative, on the SAME scheme: a "skipped:" prefix is the
    // only thing that disqualifies it, never the scheme.
    expect(
      capabilityReadingsForReply('wireguard', {
        ...base,
        udp_associate: null,
        quic_ok: false,
        quic_detail: 'quic handshake failed',
      }).quic_ok,
    ).toBe(false);
  });

  it('carries the udp_detail sentence even when the boolean is dropped', () => {
    const out = capabilityReadingsForReply('wireguard', {
      ...base,
      udp_associate: null,
      udp_detail: 'skipped: udp leg not probed on the vpn path',
    });
    expect(out.udp_associate).toBeUndefined();
    expect(out.udp_detail).toBe('skipped: udp leg not probed on the vpn path');
    // A node that sends no sentence produces no key — never an empty string,
    // which a surface would have to guess the meaning of.
    expect('udp_detail' in capabilityReadingsForReply('wireguard', { ...base })).toBe(false);
  });
});
