// (o) O1 — an absent OS fingerprint must carry its CAUSE.
//
// ⛔ THE DEFECT. `osFields` was `{}` for three unlike reasons and the wire could
// not tell them apart, so the desktop client rendered ALL of them with one hint:
// "Run Test on a proxy that is stored on your account; the control plane
// fingerprints the proxy's own TCP stack". On a VPN row that advice can NEVER
// produce a value — `'host' in resolved` is false for every openvpn/wireguard
// wire (a tunnel has no SOCKS5 endpoint to dial through), so the arm that skips
// the observer is the arm every VPN row takes, every time. The owner pressed
// Check on a permanently blank chip under a hint promising it would fill.
//
// These arms pin the cause on the wire, one per real cause:
//   vpn_tunnel    — a VPN row measured from the fleet (the only vantage that can
//                   measure one at all). No retry can ever change it.
//   not_observed  — a socks5 row whose observer tunnel was refused. A retry may.
//   observer_off  — a deployment running no raw-socket observer. No retry can.
//   CONTROL       — a socks5 row with a REAL observation carries the fingerprint
//                   and NO cause.
//
// ⚠️ THE CONTROL IS THE VACUITY ARM AND IT FAILS IN THE DIRECTION THE REAL
// FAILURE GOES. The cheap wrong fix here is "always attach a cause", which reads
// green on all three arms above while telling every customer with a working
// fingerprint that fingerprinting is unavailable. The control reds on exactly
// that, because it asserts the cause key is ABSENT beside a real measurement.
//
// PRODUCTION LINES THIS GUARDS (reverting any one reds a named arm):
//   * `routes/account-me.ts` — the fleet branch's
//     `: { os_fingerprint_unavailable: 'vpn_tunnel' as const }` arm. Restore the
//     bare `{}` and the vpn_tunnel arm reds (the key is absent).
//   * `routes/account-me.ts` — `osFingerprintFields`'s `!os.observed` return.
//     Restore `return {}` and the not_observed AND observer_off arms red.
//   * `routes/account-me.ts` — the `os.reason === OBSERVER_NOT_CONFIGURED_REASON`
//     branch. Collapse it to a bare `'not_observed'` and the observer_off arm
//     reds with `'not_observed'` — the exact downgrade that would put a retry
//     hint under a deployment where retrying cannot work.
//   * `routes/account-me.ts` — the ORDER of the `osFields` ternary:
//     `'host' in resolved ? (usable ? … : {}) : { …'vpn_tunnel' }`. Restore the old
//     outer `!usable ? {} : …` gate and the FAILED-VERDICT VPN arm reds (the key is
//     absent on exactly the reply a VPN owner gets when the tunnel does not come up).
//     Widen it the other way — attach `vpn_tunnel` before the `'host' in resolved`
//     narrowing — and the socks5 VACUITY CONTROL reds, because a broken socks5 row
//     would be told its fingerprint is unavailable "because VPN".

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

const OVPN_BLOB = 'client\nremote vpn.example.com 1194 udp\ndev tun\n';

async function makeSocksProxy(host: string): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/account/me/proxies',
    headers: { ...auth(fx), 'content-type': 'application/json' },
    payload: { label: 'p', host, port: 1080 },
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

/** A probe whose observer answers with a given `observeOs` result. `probe()`
 *  always succeeds, so `ok` is never the thing under test here. */
const probeWith = (observeOs: () => Promise<unknown>): never =>
  ({ probe: () => Promise.resolve({ ok: true }), observeOs }) as unknown as never;

/** ONE node per fixture (the registry picks among the registered nodes, and a
 *  second would make WHICH node answered non-deterministic). Answers every leg
 *  true, so the row is USABLE and the fingerprint arm is the one under test. */
function registerHealthyNode(nodeId: string): void {
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
        latency_ms: 42,
        h2_ok: true,
        quic_ok: true,
        quic_detail: null,
        exit_ip: '198.51.100.44',
        error: null,
      }),
    );
  });
}

/** ONE node per fixture, answering a frame that REACHED A VERDICT and found the
 *  proxy unusable (`ok:true` on the node's frame means "the probe reached a
 *  verdict"; every leg false is "it answered nothing"). This is the reply a VPN
 *  owner actually gets when the tunnel does not come up — the state the cause
 *  used to be withheld in. */
function registerFailingNode(nodeId: string): void {
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
        quic_detail: null,
        exit_ip: null,
        error: null,
      }),
    );
  });
}

describe('POST /v1/account/me/proxies/:id/test — os_fingerprint_unavailable', () => {
  it("CRITICAL a VPN row carries os_fingerprint_unavailable:'vpn_tunnel' and no fingerprint — the cause is PERMANENT for this row, so 'press Test again' is advice that can never terminate", async () => {
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      // An observer that WOULD answer if it were ever consulted. That is the
      // point: on a VPN row it must not be, because there is no SOCKS5 endpoint
      // to dial — so this stub proves the arm was taken, not that the observer
      // happened to miss.
      proxyConnectivityProbe: probeWith(() =>
        Promise.resolve({
          observed: true,
          observedIp: '198.51.100.7',
          via: 'proxy_host',
          signature: {},
          os: 'windows',
          confidence: 'medium',
          reason: 'initial TTL 128 with a Windows option layout',
        }),
      ),
    });
    registerHealthyNode('mac-vpn-001');
    const id = await makeOpenVpnProxy();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.ok).toBe(true);
    expect(body.measured_from).toBe('fleet');
    expect(body.os_fingerprint_unavailable).toBe('vpn_tunnel');
    // ⛔ A cause is NOT a measurement. The fingerprint stays absent — the whole
    // reason this field exists is that a miss must never be coloured in.
    expect('os_fingerprint' in body).toBe(false);
    // And it wrote nothing to the row: a cause must never touch the stored column.
    const persisted = await fx.accountProxiesRepo.findById({ id, accountId: fx.accountId });
    expect(persisted?.osFingerprint).toBeNull();
  });

  it("CRITICAL a VPN row whose tunnel FAILED still carries 'vpn_tunnel' — the cause belongs to the scheme, not to the verdict, and this is the state the owner presses Check in", async () => {
    // ⛔ The defect this arm pins: the cause used to sit behind `!usable ? {}`, so it
    // was emitted only on a tunnel that came UP. On the reply below — the one a
    // WireGuard/OpenVPN owner gets when the handshake fails — the key was absent, the
    // desktop dropped to its neutral branch, and the OS chip told the owner to press
    // "Run Test" (a button a VPN row does not have) for a TCP-stack fingerprint that
    // cannot exist for a tunnel. Two surfaces, two different stories about one row.
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: probeWith(() =>
        Promise.reject(new Error('the observer must never be consulted for a VPN row')),
      ),
    });
    registerFailingNode('mac-vpn-002');
    const id = await makeOpenVpnProxy();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    // A real verdict about the tunnel (not a `not_run`), and it is a FAILURE.
    expect(body.ok).toBe(false);
    expect(body.measured_from).toBe('fleet');
    expect('not_run' in body).toBe(false);
    expect(typeof body.reason).toBe('string');
    // …and it still says WHY there is no fingerprint.
    expect(body.os_fingerprint_unavailable).toBe('vpn_tunnel');
    expect('os_fingerprint' in body).toBe(false);
  });

  it('CONTROL a socks5 row whose fleet verdict FAILED carries NO cause at all — "unavailable because VPN" must never be said about a broken socks5 row', async () => {
    // ⛔ THE VACUITY ARM FOR THE ARM ABOVE, failing in the direction the real failure
    // goes: the cheap way to make a failed VPN row carry `vpn_tunnel` is to attach it
    // before the `'host' in resolved` narrowing, which would green the arm above and
    // label every broken socks5 proxy a tunnel. The key must be ABSENT here.
    fx = await buildTestApp({
      enableFleetControlPlane: true,
      proxyConnectivityProbe: probeWith(() =>
        Promise.resolve({ observed: false, reason: 'no SYN recorded' }),
      ),
    });
    registerFailingNode('mac-socks-002');
    const id = await makeSocksProxy('fp-fleet-failed.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test?vantage=fleet`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.ok).toBe(false);
    expect('os_fingerprint_unavailable' in body).toBe(false);
    expect('os_fingerprint' in body).toBe(false);
  });

  it("CRITICAL a socks5 row whose observer tunnel is refused carries 'not_observed' — the one cause a retry can actually change", async () => {
    fx = await buildTestApp({
      proxyConnectivityProbe: probeWith(() =>
        Promise.resolve({
          observed: false,
          reason: 'CONNECT refused: 0x02 not allowed by ruleset',
        }),
      ),
      proxyTcpProbe: () => Promise.reject(new Error('the TCP fallback must not be consulted')),
    });
    const id = await makeSocksProxy('fp-refused.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.ok).toBe(true);
    expect(body.os_fingerprint_unavailable).toBe('not_observed');
    expect('os_fingerprint' in body).toBe(false);
  });

  it("CRITICAL a deployment with the observer OFF carries 'observer_off', never 'not_observed' — the two take a customer to opposite places, and only one of them is worth retrying", async () => {
    // ⛔ The literal is the probe's own: `observeOs` returns exactly this when
    // `this.osObserver === undefined`. The unit arm in
    // `tests/unit/a-blank-os-chip-carries-its-cause.test.ts` pins it against the
    // REAL ProxyConnectivityProbe, so a reword there cannot silently downgrade
    // every observer-off deployment to "not observed" with this arm still green.
    fx = await buildTestApp({
      proxyConnectivityProbe: probeWith(() =>
        Promise.resolve({ observed: false, reason: 'observer not configured' }),
      ),
      proxyTcpProbe: () => Promise.reject(new Error('the TCP fallback must not be consulted')),
    });
    const id = await makeSocksProxy('fp-observer-off.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.os_fingerprint_unavailable).toBe('observer_off');
    expect('os_fingerprint' in body).toBe(false);
  });

  it('CONTROL a socks5 row with a REAL observation carries the fingerprint and NO cause — a fix that made every row say "unavailable" reds here', async () => {
    fx = await buildTestApp({
      proxyConnectivityProbe: probeWith(() =>
        Promise.resolve({
          observed: true,
          observedIp: '198.51.100.7',
          via: 'proxy_host',
          signature: {},
          os: 'windows',
          confidence: 'medium',
          reason: 'initial TTL 128 with a Windows option layout',
        }),
      ),
      proxyTcpProbe: () => Promise.reject(new Error('the TCP fallback must not be consulted')),
    });
    const id = await makeSocksProxy('fp-observed.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.os_fingerprint).toEqual({
      os: 'windows',
      confidence: 'medium',
      reason: 'initial TTL 128 with a Windows option layout',
      observed_ip: '198.51.100.7',
      observed_via: 'proxy_host',
    });
    // ⛔ THE VACUITY ARM. Not `!== 'vpn_tunnel'` — the KEY must be absent, so
    // "attach a cause unconditionally" cannot pass by attaching a different one.
    expect('os_fingerprint_unavailable' in body).toBe(false);
  });
});
