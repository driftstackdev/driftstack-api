// (p) 2026-09-16 — the stored OS reading has a ROUTE OUT.
//
// The control plane has fingerprinted a proxy's own TCP stack since N-2, stored
// the measurement on the row (migration 0119) and, until this item, shown it to
// the customer NOWHERE: `proxyToMetadata` did not carry it, the metadata schema
// had no member for it, and a /test that observed nothing answered
// `os_fingerprint_unavailable` and dropped the reading the row was holding. The
// desktop chip was fed only by that Mac's own cache, so the reading vanished on a
// second machine and on a reinstall — the owner's "we are not saving the OS
// fingerprint of already checked proxies".
//
// Four properties, one arm each:
//   1. the LIST carries the stored reading and the date it was taken, and carries
//      nulls — never a default — for a row nobody has fingerprinted;
//   2. a /test that observed NOTHING carries the stored reading WITH its date AND
//      keeps the `os_fingerprint_unavailable` cause: the cause explains this test,
//      the date explains the reading, and a client needs both to tell them apart;
//   3. a FRESH observation wins and is undated (this reply measured it);
//   4. a reading this server cannot date, or cannot state inside the published
//      closed set, is withheld rather than sent looking current or unrenderable.

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

const probeWith = (observeOs: () => Promise<unknown>): never =>
  ({ probe: () => Promise.resolve({ ok: true }), observeOs }) as unknown as never;

/** A probe that reaches the proxy and observes NO SYN — the miss this item is
 *  about. `not_observed` is the cause it reports. */
const observesNothing = (): never =>
  probeWith(() => Promise.resolve({ observed: false, reason: 'no SYN recorded' }));

const MEASURED_AT = new Date('2026-09-16T08:00:00.000Z');

/** The full structured measurement the route itself writes (V-219 shape). */
const STORED = {
  os: 'macos-or-ios',
  confidence: 'high',
  reason: 'Based on how this proxy responds to a network connection.',
  observed_ip: '198.51.100.7',
  observed_via: 'exit_ip' as const,
  single_host_vantage: true,
  web_port_vantage: true,
};

const OVPN_BLOB = 'client\nremote vpn.example.com 1194 udp\ndev tun\n';

/** ONE node per fixture, answering a frame that reached a verdict. `usable` is the
 *  half of `...(usable ? storedOsForReply(osFields) : {})` under test, so each helper
 *  says which side it produces. Shape copied from
 *  a-blank-os-chip-carries-its-cause.test.ts, the other suite that drives this path. */
function registerNode(nodeId: string, usable: boolean): void {
  const conn: FleetControlConnection = fx.fleetControlRegistry.register(nodeId, (data) => {
    const f = JSON.parse(data) as { type: string; requestId: string };
    if (f.type !== 'probeEgress') return;
    conn.handleInbound(
      JSON.stringify({
        type: 'probeEgressResult',
        requestId: f.requestId,
        node_id: nodeId,
        ok: true,
        reachable: usable,
        auth_ok: usable,
        udp_associate: usable,
        can_route: usable,
        latency_ms: usable ? 42 : null,
        h2_ok: usable,
        quic_ok: usable,
        quic_detail: null,
        exit_ip: usable ? '198.51.100.44' : null,
        error: null,
      }),
    );
  });
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

async function testFleet(id: string): Promise<Record<string, unknown>> {
  const res = await fx.app.inject({
    method: 'POST',
    url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
    headers: auth(fx),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Record<string, unknown>>();
}

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

/** Put a reading on the row exactly as a previous test would have. */
async function storeReading(
  id: string,
  osFingerprint: Record<string, unknown> | null,
  osFingerprintAt: Date | null,
): Promise<void> {
  await fx.accountProxiesRepo.update({
    id,
    accountId: fx.accountId,
    updates: {
      osFingerprint: osFingerprint as never,
      osFingerprintAt,
    },
  });
}

async function listOne(id: string): Promise<Record<string, unknown>> {
  const res = await fx.app.inject({
    method: 'GET',
    url: '/v1/account/me/proxies',
    headers: auth(fx),
  });
  expect(res.statusCode).toBe(200);
  const row = res.json<{ data: Record<string, unknown>[] }>().data.find((r) => r.id === id);
  expect(row, 'the listed row').toBeDefined();
  return row as Record<string, unknown>;
}

async function test(id: string): Promise<Record<string, unknown>> {
  const res = await fx.app.inject({
    method: 'POST',
    url: `/v1/account/me/proxies/${id}/test`,
    headers: auth(fx),
  });
  expect(res.statusCode).toBe(200);
  return res.json<Record<string, unknown>>();
}

describe('GET /v1/account/me/proxies — the stored OS reading', () => {
  it('CRITICAL carries the stored reading AND the date it was taken, so a machine that never ran the test can show it and can age it. MUTATION: drop `os_fingerprint: storedOsFingerprint(r)` from proxyToMetadata (routes/account-me.ts) and this reds — which is precisely the state that shipped, with the column written and unreadable', async () => {
    fx = await buildTestApp({});
    const id = await makeProxy('stored-list.example.com');
    await storeReading(id, STORED, MEASURED_AT);

    const row = await listOne(id);
    expect(row.os_fingerprint).toEqual(STORED);
    expect(row.os_fingerprint_at).toBe(MEASURED_AT.toISOString());
  });

  it('carries NULL for a proxy nobody has fingerprinted — never a placeholder OS, and never a date for a measurement that did not happen', async () => {
    fx = await buildTestApp({});
    const id = await makeProxy('never-measured.example.com');

    const row = await listOne(id);
    expect(row.os_fingerprint).toBeNull();
    expect(row.os_fingerprint_at).toBeNull();
  });

  it('normalises a PRE-V-219 reading (no vantage flags stored) to false rather than promoting it: absent must never become the claim that unlocks a green chip', async () => {
    fx = await buildTestApp({});
    const id = await makeProxy('legacy-reading.example.com');
    const { single_host_vantage: _s, web_port_vantage: _w, ...legacy } = STORED;
    await storeReading(id, legacy, MEASURED_AT);

    const row = await listOne(id);
    expect(row.os_fingerprint).toEqual({
      ...legacy,
      single_host_vantage: false,
      web_port_vantage: false,
    });
  });

  it('withholds a stored reading it cannot state inside the published closed set — a corrupt or newer value is "never measured", never an OS a client cannot render', async () => {
    fx = await buildTestApp({});
    const id = await makeProxy('corrupt-reading.example.com');
    await storeReading(id, { ...STORED, os: 'plan9' }, MEASURED_AT);

    const row = await listOne(id);
    expect(row.os_fingerprint).toBeNull();
  });
});

describe('POST /v1/account/me/proxies/:id/test — a miss still answers with what the row holds', () => {
  it('CRITICAL returns the stored reading WITH its date AND the unavailable cause together, so the client can tell a stored reading from a fresh one. MUTATION: drop `...storedOsForReply(osFields)` from the control-plane success return (routes/account-me.ts) and this reds — the reply then says only "unavailable" about a proxy this deployment fingerprinted minutes earlier', async () => {
    fx = await buildTestApp({
      proxyConnectivityProbe: observesNothing(),
      proxyTcpProbe: () => Promise.reject(new Error('the TCP fallback must not be consulted')),
    });
    const id = await makeProxy('miss-with-stored.example.com');
    await storeReading(id, STORED, MEASURED_AT);

    const body = await test(id);
    expect(body.ok).toBe(true);
    expect(body.os_fingerprint).toEqual(STORED);
    expect(body.os_fingerprint_at).toBe(MEASURED_AT.toISOString());
    // ⛔ The cause stays. It is about THIS test, not about the reading.
    expect(body.os_fingerprint_unavailable).toBe('not_observed');
  });

  it('a FRESH observation wins and carries no date — this reply measured it, and attaching a stale stamp to a fresh reading would age it from the wrong moment', async () => {
    fx = await buildTestApp({
      proxyConnectivityProbe: probeWith(() =>
        Promise.resolve({
          observed: true,
          observedIp: '203.0.113.9',
          via: 'exit_ip',
          signature: {},
          os: 'linux',
          confidence: 'high',
          reason: 'initial TTL 64 with a Linux option layout',
          singleHostVantage: true,
          webPortVantage: false,
        }),
      ),
      proxyTcpProbe: () => Promise.reject(new Error('the TCP fallback must not be consulted')),
    });
    const id = await makeProxy('fresh-wins.example.com');
    await storeReading(id, STORED, MEASURED_AT);

    const body = await test(id);
    expect(body.ok).toBe(true);
    expect(body.os_fingerprint).toEqual({
      os: 'linux',
      confidence: 'high',
      reason: 'Based on how this proxy responds to a network connection.',
      observed_ip: '203.0.113.9',
      observed_via: 'exit_ip',
      single_host_vantage: true,
      web_port_vantage: false,
    });
    expect('os_fingerprint_at' in body).toBe(false);
    expect('os_fingerprint_unavailable' in body).toBe(false);
  });

  it('withholds a stored reading it cannot DATE: an undatable reading cannot be aged, and the one thing it must never do is arrive looking freshly measured', async () => {
    fx = await buildTestApp({
      proxyConnectivityProbe: observesNothing(),
      proxyTcpProbe: () => Promise.reject(new Error('the TCP fallback must not be consulted')),
    });
    const id = await makeProxy('undatable.example.com');
    await storeReading(id, STORED, null);

    const body = await test(id);
    expect(body.ok).toBe(true);
    expect('os_fingerprint' in body).toBe(false);
    expect('os_fingerprint_at' in body).toBe(false);
    expect(body.os_fingerprint_unavailable).toBe('not_observed');
  });

  it('CONTROL — a row with NO stored reading is unchanged by all of this: the miss is still a bare cause, never an invented reading', async () => {
    fx = await buildTestApp({
      proxyConnectivityProbe: observesNothing(),
      proxyTcpProbe: () => Promise.reject(new Error('the TCP fallback must not be consulted')),
    });
    const id = await makeProxy('miss-no-stored.example.com');

    const body = await test(id);
    expect(body.ok).toBe(true);
    expect('os_fingerprint' in body).toBe(false);
    expect('os_fingerprint_at' in body).toBe(false);
    expect(body.os_fingerprint_unavailable).toBe('not_observed');
  });
});

// (p) review — THE OTHER ATTACH SITES. `storedOsForReply` is spread in four places and
// the arms above reach exactly one of them (the control-plane socks5 success return),
// so deleting either of the two below left the whole suite green. The fleet one matters
// most: it is the ONLY path for the entire openvpn/wireguard population — the control
// plane cannot bring a tunnel up — and it is the branch that would silently revert to a
// bare `vpn_tunnel` cause on a row the fleet has fingerprinted.
describe('POST /v1/account/me/proxies/:id/test — the reading rides every reply that can carry it', () => {
  it('CRITICAL a VPN row tested from the FLEET carries the stored reading and its date BESIDE the vpn_tunnel cause — the cause says no reading can be taken here, not that the row has none. MUTATION: delete `...(usable ? storedOsForReply(osFields) : {})` from the fleet return (routes/account-me.ts) and this reds', async () => {
    fx = await buildTestApp({ enableFleetControlPlane: true });
    registerNode('mac-vpn-101', true);
    const id = await makeOpenVpnProxy();
    await storeReading(id, STORED, MEASURED_AT);

    const body = await testFleet(id);
    expect(body.ok).toBe(true);
    expect(body.measured_from).toBe('fleet');
    expect(body.os_fingerprint).toEqual(STORED);
    expect(body.os_fingerprint_at).toBe(MEASURED_AT.toISOString());
    // ⛔ The cause is about THIS test and stays; the pair is how the client tells a
    // stored reading from a fresh one.
    expect(body.os_fingerprint_unavailable).toBe('vpn_tunnel');
  });

  it('CRITICAL VACUITY CONTROL — a fleet verdict that found the proxy UNUSABLE carries no reading: the OS half of an `ok:false` reply is not part of the published shape, so attaching it there would put a reading where no client reads one. MUTATION: drop the `usable ?` guard on that spread and this reds', async () => {
    fx = await buildTestApp({ enableFleetControlPlane: true });
    registerNode('mac-socks-101', false);
    const id = await makeProxy('fleet-unusable.example.com');
    await storeReading(id, STORED, MEASURED_AT);

    const body = await testFleet(id);
    expect(body.ok).toBe(false);
    expect(body.measured_from).toBe('fleet');
    expect('os_fingerprint' in body).toBe(false);
    expect('os_fingerprint_at' in body).toBe(false);
  });

  it('CRITICAL the TCP-fallback reply carries it too — a reachability check looks at no SYN at all, so the row’s stored reading is the only OS answer there is. MUTATION: delete `...storedOsForReply({})` from the TCP-fallback return (routes/account-me.ts) and this reds', async () => {
    // No `proxyConnectivityProbe` is wired: the deployment state in which the route
    // falls back to a bare TCP connect (V-1344 — and the fixture's default probe
    // resolves for exactly this host).
    fx = await buildTestApp({});
    const id = await makeProxy('reachable-proxy.example.com');
    await storeReading(id, STORED, MEASURED_AT);

    const body = await test(id);
    expect(body.ok).toBe(true);
    expect(body.os_fingerprint).toEqual(STORED);
    expect(body.os_fingerprint_at).toBe(MEASURED_AT.toISOString());
    // Nothing observed a SYN here, and nothing claims one was: the reachability
    // check reports no cause of its own, and the reading is dated.
    expect('os_fingerprint_unavailable' in body).toBe(false);
  });
});
