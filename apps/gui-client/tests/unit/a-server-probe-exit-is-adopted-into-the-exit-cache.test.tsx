// (b) VPN exit parity — the control plane's fleet test now carries the exit the
// fleet Mac OBSERVED through the proxy (`exit_observed`, resolved to geo
// server-side), and the ONE shared step both proxy surfaces run
// (lib/proxy-server-test) adopts it into the SAME cache fields the native exit
// probe writes for a SOCKS5 row (exitIp / exitCountry / city / region /
// timezone / exitAt). For an OpenVPN/WireGuard row this is the only exit
// identity there can be: the native exit probe is a SOCKS5 request from this
// Mac and cannot run through a tunnel.
//
// Three layers, one property per arm:
//   1. the wire parse keeps a well-formed `exit_observed` beside a fleet vantage
//      and DROPS a malformed one (never the reply) or one beside a cp vantage;
//   2. persistServerProbe writes it via saveExitResult — MUTATION: delete that
//      call and the CRITICAL arm reds (the entry has no exitIp); the vacuity arm
//      (no exit_observed → no exitIp) stays green either way, so it cannot mask
//      that mutation;
//   3. the endpoint-row overlay surfaces the fleet fields of a resolved VPN row
//      that deriveProbeViewState (usable-only) hides — and leaves a SOCKS5-only
//      cache byte-identical (its vacuity control).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = new Map<string, Map<string, unknown>>();
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    private file: string;
    constructor(file: string) {
      this.file = file;
      if (!stores.has(file)) stores.set(file, new Map());
    }
    private map(): Map<string, unknown> {
      let m = stores.get(this.file);
      if (!m) {
        m = new Map();
        stores.set(this.file, m);
      }
      return m;
    }
    get(key: string): Promise<unknown> {
      return Promise.resolve(this.map().get(key));
    }
    set(key: string, value: unknown): Promise<void> {
      this.map().set(key, value);
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

let nextResponse: () => Response = () => new Response('{}', { status: 500 });
vi.mock('../../src/lib/fetch-with-deadline', () => ({
  DEFAULT_REQUEST_TIMEOUT_MS: 15_000,
  fetchWithDeadline: (): Promise<Response> => Promise.resolve(nextResponse()),
}));

import { cleanExitObserved, testAccountProxy } from '../../src/lib/account-proxies';
import {
  deriveProbeViewState,
  loadProbeCache,
  saveEndpointResult,
  saveProbeResult,
} from '../../src/lib/proxy-probe-cache';
import {
  deriveProbeViewWithEndpointRows,
  persistServerProbe,
  serverProbeOutcome,
  serverVerdictUsable,
} from '../../src/lib/proxy-server-test';

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const EXIT = {
  ip: '203.0.113.9',
  country: 'NL',
  timezone: 'Europe/Amsterdam',
  region: 'North Holland',
  city: 'Amsterdam',
};

const FLEET_BODY = {
  ok: true,
  latency_ms: 31,
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  h2_ok: true,
  quic_ok: true,
  exit_ip: '203.0.113.9',
  node_id: 'mac-mini-07',
  measured_from: 'fleet',
  exit_observed: EXIT,
};

const OK = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 42,
  message: 'ok',
};
const NOW = 1_800_000_000_000;

beforeEach(() => {
  stores.clear();
  nextResponse = () => new Response('{}', { status: 500 });
});

describe('the wire parse — exit_observed rides beside the fleet vantage', () => {
  it('CRITICAL a well-formed exit_observed on a fleet reply is kept, every member typed', async () => {
    nextResponse = () => json(FLEET_BODY);
    const r = await testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.exit_observed).toEqual(EXIT);
    expect(r.measured_from).toBe('fleet');
  });

  it('null geo members arrive as null (the server could not say), ip alone is required', async () => {
    nextResponse = () =>
      json({
        ...FLEET_BODY,
        exit_observed: {
          ip: '203.0.113.9',
          country: null,
          timezone: null,
          region: null,
          city: null,
        },
      });
    const r = await testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' });
    expect(r.ok && r.exit_observed).toEqual({
      ip: '203.0.113.9',
      country: null,
      timezone: null,
      region: null,
      city: null,
    });
  });

  it('a malformed exit_observed drops the FIELD, never the reply (no throw, still ok)', async () => {
    for (const bad of [
      'not-an-object',
      ['203.0.113.9'],
      { country: 'NL' },
      { ip: '' },
      { ip: '203.0.113.9', country: 42 },
    ]) {
      nextResponse = () => json({ ...FLEET_BODY, exit_observed: bad });
      const r = await testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' });
      expect(r.ok).toBe(true);
      expect(r.ok && 'exit_observed' in r).toBe(false);
      expect(r.ok && r.latency_ms).toBe(31);
    }
  });

  it('VACUITY CONTROL — a reply without exit_observed parses exactly as before (no key grown)', async () => {
    const { exit_observed: _dropped, ...withoutExit } = FLEET_BODY;
    nextResponse = () => json(withoutExit);
    const r = await testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' });
    expect(r.ok && 'exit_observed' in r).toBe(false);
  });

  it("(e) a QUIC leg the node SKIPPED never becomes quic_probe:false — the chip must not read 'does not relay QUIC'", async () => {
    nextResponse = () =>
      json({
        ...FLEET_BODY,
        quic_ok: false,
        quic_detail: 'skipped: quic leg not probed on the vpn path',
      });
    const r = await testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' });
    expect(r.ok && 'quic_probe' in r).toBe(false);
    // …and a server that already OMITS quic_ok beside the detail parses the same way.
    const { quic_ok: _omitted, ...withoutQuic } = {
      ...FLEET_BODY,
      quic_detail: 'skipped: endpoint_unreachable',
    };
    nextResponse = () => json(withoutQuic);
    const r2 = await testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' });
    expect(r2.ok && 'quic_probe' in r2).toBe(false);
  });

  it('(e) CONTROL — a MEASURED QUIC failure (no "skipped:" detail) still lands as quic_probe:false', async () => {
    nextResponse = () =>
      json({ ...FLEET_BODY, quic_ok: false, quic_detail: 'quic handshake failed' });
    const r = await testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' });
    expect(r.ok && r.quic_probe).toBe(false);
  });

  it('FLEET-ONLY — an exit_observed beside a control-plane vantage is dropped like the other fleet fields', async () => {
    nextResponse = () => json({ ...FLEET_BODY, measured_from: 'control_plane' });
    const r = await testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' });
    expect(r.ok && r.measured_from).toBe('control_plane');
    expect(r.ok && 'exit_observed' in r).toBe(false);
  });

  it('cleanExitObserved — absent geo members read as null; a non-string member refuses the object', () => {
    expect(cleanExitObserved({ ip: '203.0.113.9' })).toEqual({
      ip: '203.0.113.9',
      country: null,
      timezone: null,
      region: null,
      city: null,
    });
    expect(cleanExitObserved({ ip: '203.0.113.9', city: { name: 'x' } })).toBeUndefined();
    expect(cleanExitObserved(null)).toBeUndefined();
    expect(cleanExitObserved(undefined)).toBeUndefined();
  });
});

describe('serverProbeOutcome — the outcome carries the observed exit', () => {
  it('maps exit_observed → exitObserved on the ok arm, and only when present', () => {
    const withExit = serverProbeOutcome(
      { ok: true, latency_ms: 31, measured_from: 'fleet', exit_observed: EXIT },
      NOW,
    );
    expect(withExit.kind === 'ok' && withExit.exitObserved).toEqual(EXIT);
    const without = serverProbeOutcome({ ok: true, latency_ms: 31, measured_from: 'fleet' }, NOW);
    expect(without.kind === 'ok' && 'exitObserved' in without).toBe(false);
  });
});

describe('persistServerProbe — the observed exit lands in the exit-geo cache fields', () => {
  it('CRITICAL a VPN row (endpoint entry) gets exitIp/country/geo + exitAt from the fleet test', async () => {
    // The VPN row's pre-flight wrote the endpoint entry; the fleet test follows.
    await saveEndpointResult('vpn1', { resolved: true, ip: '198.51.100.1', message: 'ok' }, 1);
    const outcome = serverProbeOutcome(
      { ok: true, latency_ms: 31, measured_from: 'fleet', node_id: 'mac-07', exit_observed: EXIT },
      NOW,
    );
    const cache = await persistServerProbe('vpn1', outcome, { adoptExit: true });
    expect(cache?.['vpn1']).toMatchObject({
      endpoint: { resolved: true },
      serverLatencyMs: 31,
      measuredFrom: 'fleet',
      nodeId: 'mac-07',
      exitIp: '203.0.113.9',
      exitCountry: 'NL',
      exitCity: 'Amsterdam',
      exitRegion: 'North Holland',
      exitTimezone: 'Europe/Amsterdam',
      exitAt: NOW,
    });
    // And the persisted store agrees — not only the returned map.
    expect((await loadProbeCache())['vpn1']?.exitIp).toBe('203.0.113.9');
  });

  it('CRITICAL a geo-less observation of the SAME exit never DOWNGRADES a cached geo (an un-migrated node sends the ip alone)', async () => {
    await saveEndpointResult('vpn1', { resolved: true, ip: '198.51.100.1', message: 'ok' }, 1);
    await persistServerProbe(
      'vpn1',
      serverProbeOutcome(
        { ok: true, latency_ms: 31, measured_from: 'fleet', exit_observed: EXIT },
        NOW,
      ),
      { adoptExit: true },
    );
    const cache = await persistServerProbe(
      'vpn1',
      serverProbeOutcome(
        {
          ok: true,
          latency_ms: 31,
          measured_from: 'fleet',
          exit_observed: { ip: EXIT.ip, country: null, timezone: null, region: null, city: null },
        },
        NOW + 1,
      ),
      { adoptExit: true },
    );
    expect(cache?.['vpn1']).toMatchObject({
      exitIp: '203.0.113.9',
      exitTimezone: 'Europe/Amsterdam',
    });
  });

  it("a SOCKS5 row does NOT adopt it — its exit is measured natively from this Mac (geo + ASN); adopting the server's geo-less exit_observed overwrote real geo with nulls", async () => {
    await saveProbeResult('p1', OK, 1);
    const cache = await persistServerProbe(
      'p1',
      serverProbeOutcome(
        { ok: true, latency_ms: 31, measured_from: 'fleet', exit_observed: EXIT },
        NOW,
      ),
    );
    expect(cache?.['p1']?.exitIp).toBeUndefined();
    expect(cache?.['p1']?.exitTimezone).toBeUndefined();
  });

  it('VACUITY CONTROL — an ok outcome WITHOUT an observed exit writes no exit fields', async () => {
    await saveEndpointResult('vpn1', { resolved: true, ip: '198.51.100.1', message: 'ok' }, 1);
    const cache = await persistServerProbe(
      'vpn1',
      serverProbeOutcome({ ok: true, latency_ms: 31, measured_from: 'fleet' }, NOW),
    );
    expect(cache?.['vpn1']?.serverLatencyMs).toBe(31);
    expect(cache?.['vpn1']?.exitIp).toBeUndefined();
    expect(cache?.['vpn1']?.exitAt).toBeUndefined();
  });

  it('a failed outcome writes nothing — no exit is invented for a tunnel that did not come up', async () => {
    await saveEndpointResult('vpn1', { resolved: true, ip: '198.51.100.1', message: 'ok' }, 1);
    expect(await persistServerProbe('vpn1', { kind: 'failed', at: NOW, reason: 'no' })).toBeNull();
    expect((await loadProbeCache())['vpn1']?.exitIp).toBeUndefined();
  });
});

describe('deriveProbeViewWithEndpointRows — the fleet fields of a resolved VPN row are visible', () => {
  it('CRITICAL surfaces exit + latency + vantage for a resolved endpoint row that the usable-only derivation hides', async () => {
    await saveEndpointResult('vpn1', { resolved: true, ip: '198.51.100.1', message: 'ok' }, 1);
    await persistServerProbe(
      'vpn1',
      serverProbeOutcome(
        {
          ok: true,
          latency_ms: 31,
          measured_from: 'fleet',
          node_id: 'mac-07',
          quic_probe: true,
          exit_observed: EXIT,
        },
        NOW,
      ),
      { adoptExit: true },
    );
    const cache = await loadProbeCache();
    // The placeholder result is never usable BY DESIGN, so the base derivation
    // hides every server field — which is exactly why the overlay exists.
    const base = deriveProbeViewState(cache, NOW);
    expect(base.exitResults['vpn1']).toBeUndefined();
    expect(base.serverLatency['vpn1']).toBeUndefined();

    const view = deriveProbeViewWithEndpointRows(cache, NOW);
    expect(view.exitResults['vpn1']).toEqual({
      ip: '203.0.113.9',
      country: 'NL',
      city: 'Amsterdam',
      region: 'North Holland',
      timezone: 'Europe/Amsterdam',
      asn_org: null,
    });
    expect(view.serverLatency['vpn1']).toBe(31);
    expect(view.serverVantage['vpn1']).toEqual({ measuredFrom: 'fleet', nodeId: 'mac-07' });
    expect(view.quicProbe['vpn1']).toBe(true);
    expect(view.endpointResults['vpn1']).toEqual({
      resolved: true,
      ip: '198.51.100.1',
      message: 'ok',
    });
    // The fail-closed placeholder is NOT a SOCKS5 verdict: it must not count as
    // a tested-but-unhealthy proxy anywhere.
    expect(view.testResults['vpn1']).toBeUndefined();
    expect(view.testedAt['vpn1']).toBe(1);
  });

  it('an UNRESOLVED endpoint row surfaces nothing server-side (the pre-flight failed)', async () => {
    await saveEndpointResult('vpn1', { resolved: false, ip: '', message: 'NXDOMAIN' }, 1);
    const cache = await loadProbeCache();
    const entry = cache['vpn1'];
    expect(entry !== undefined && serverVerdictUsable(entry)).toBe(false);
    const view = deriveProbeViewWithEndpointRows(cache, NOW);
    expect(view.exitResults['vpn1']).toBeUndefined();
    expect(view.serverLatency['vpn1']).toBeUndefined();
    expect(view.endpointResults['vpn1']?.resolved).toBe(false);
  });

  it('VACUITY CONTROL — a SOCKS5-only cache comes back identical to the base derivation', async () => {
    await saveProbeResult('p1', OK, 1);
    await persistServerProbe(
      'p1',
      serverProbeOutcome(
        { ok: true, latency_ms: 31, measured_from: 'fleet', exit_observed: EXIT },
        NOW,
      ),
    );
    const cache = await loadProbeCache();
    const { endpointResults, ...overlaid } = deriveProbeViewWithEndpointRows(cache, NOW);
    expect(overlaid).toEqual(deriveProbeViewState(cache, NOW));
    expect(endpointResults).toEqual({});
    // serverVerdictUsable is the native predicate for a SOCKS5 entry.
    const usable = cache['p1'];
    expect(usable !== undefined && serverVerdictUsable(usable)).toBe(true);
    await saveProbeResult('p1', { ...OK, reachable: false }, 2);
    const down = (await loadProbeCache())['p1'];
    expect(down !== undefined && serverVerdictUsable(down)).toBe(false);
  });
});
