// T-20 (cache half) — a VPN/HTTP row's pre-flight is a DNS resolve, and what it
// stores must never read as a SOCKS5 verdict in either direction: not a fake
// pass, and not the un-gated probe's false "unreachable" either.
//
// Also the two cache rules that ride with it: the T-17 exit-identity TTL (the
// simulator clock is set from `exitTimezone` at launch, and it never expired),
// and the T-27 / W-30 one-time backfill of `quicMeasuredAt` for verdicts
// persisted before the stamp existed (which the not-fresh rule was silently
// discarding on every install that had ever seen a green chip).
//
// One property per assertion; every rule has a vacuity control beside it.

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

import {
  EXIT_IDENTITY_TTL_MS,
  PROBE_CACHE_SCHEMA_VERSION,
  backfillQuicMeasuredAt,
  deriveProbeViewState,
  endpointPlaceholderResult,
  isExitIdentityFresh,
  loadProbeCache,
  saveEndpointResult,
  saveExitResult,
  saveObservedQuic,
  saveProbeResult,
  saveServerProbeResult,
  verdictMatchesScheme,
  type ProbeCacheMap,
} from '../../src/lib/proxy-probe-cache';
import { isProxyUsable } from '../../src/lib/proxies';
import { endpointUnresolvedCopy, isSocks5Probeable, isVpnScheme } from '../../src/lib/proxy-scheme';

const STORE = 'proxy-probe-cache.json';
const OK = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 42,
  message: 'ok',
};
const RESOLVED = { resolved: true, ip: '203.0.113.9', message: 'Resolved vpn.example.com' };
const UNRESOLVED = { resolved: false, ip: '', message: 'DNS lookup failed' };

function rawStore(): Map<string, unknown> {
  const m = stores.get(STORE);
  if (m === undefined) throw new Error('store not created');
  return m;
}

beforeEach(() => {
  stores.clear();
});

describe('the one shared scheme predicate', () => {
  it('a SOCKS5 row, and a legacy row with no scheme, are SOCKS5-probeable', () => {
    expect(isSocks5Probeable('socks5')).toBe(true);
    expect(isSocks5Probeable(undefined)).toBe(true);
  });

  it('CRITICAL an OpenVPN, WireGuard or HTTP row is NOT — the handshake always fails there', () => {
    expect(isSocks5Probeable('openvpn')).toBe(false);
    expect(isSocks5Probeable('wireguard')).toBe(false);
    expect(isSocks5Probeable('http')).toBe(false);
  });

  it('the tunnel schemes are the two VPNs and nothing else', () => {
    expect(isVpnScheme('openvpn')).toBe(true);
    expect(isVpnScheme('wireguard')).toBe(true);
    expect(isVpnScheme('http')).toBe(false);
    expect(isVpnScheme('socks5')).toBe(false);
    expect(isVpnScheme(undefined)).toBe(false);
  });

  it('CRITICAL the VPN pre-flight copy names the endpoint and the config line, and nothing from the SOCKS5 ladder', () => {
    expect(endpointUnresolvedCopy('openvpn', 'vpn.example.com')).toBe(
      "The VPN endpoint vpn.example.com could not be resolved. Check the config's remote line.",
    );
    expect(endpointUnresolvedCopy('wireguard', 'wg.example.com')).toBe(
      "The VPN endpoint wg.example.com could not be resolved. Check the config's Endpoint line.",
    );
    for (const copy of [
      endpointUnresolvedCopy('openvpn', 'h'),
      endpointUnresolvedCopy('wireguard', 'h'),
      endpointUnresolvedCopy('http', 'h'),
    ]) {
      expect(copy).not.toMatch(/unreachable|credentials|route/i);
    }
  });
});

describe('an endpoint verdict is stored as NOT a SOCKS5 verdict', () => {
  it('CRITICAL a resolved endpoint is never usable — nothing fakes reachable/auth_ok/can_route', async () => {
    const cache = await saveEndpointResult('vpn1', RESOLVED, 1000);
    const entry = cache['vpn1'];
    expect(entry?.endpoint).toEqual(RESOLVED);
    expect(entry !== undefined && isProxyUsable(entry.result)).toBe(false);
    expect(entry?.result).toMatchObject({ reachable: false, auth_ok: false, can_route: false });
  });

  it('the placeholder carries the resolve message so a raw reader still sees why', () => {
    expect(endpointPlaceholderResult(UNRESOLVED).message).toBe('DNS lookup failed');
  });

  it('the derivation surfaces no exit-geo, QUIC or server value for it', async () => {
    await saveEndpointResult('vpn1', RESOLVED, 1000);
    const view = deriveProbeViewState(await loadProbeCache(), 1000);
    expect(view.exitResults['vpn1']).toBeUndefined();
    expect(view.quicMeasured['vpn1']).toBeUndefined();
    expect(view.serverLatency['vpn1']).toBeUndefined();
    expect(view.testResults['vpn1']?.reachable).toBe(false);
  });

  it('round-trips through the store and the cleaner keeps the endpoint whole', async () => {
    await saveEndpointResult('vpn1', UNRESOLVED, 7);
    const again = await loadProbeCache();
    expect(again['vpn1']?.endpoint).toEqual(UNRESOLVED);
    expect(again['vpn1']?.at).toBe(7);
  });

  it('a half endpoint in the store is dropped, not coerced (the entry then reads as a non-usable SOCKS5 verdict)', async () => {
    await saveEndpointResult('vpn1', RESOLVED, 7);
    const probes = rawStore().get('probes') as Record<string, Record<string, unknown>>;
    probes['vpn1'] = { ...probes['vpn1'], endpoint: { resolved: true } };
    const again = await loadProbeCache();
    expect(again['vpn1']).toBeDefined();
    expect(again['vpn1']?.endpoint).toBeUndefined();
  });

  it('CRITICAL replaces the SOCKS5 verdict the un-gated probe wrote, and carries no exit-geo over', async () => {
    await saveProbeResult('vpn1', { ...OK, reachable: false, can_route: false }, 1);
    await saveExitResult('vpn1', '198.51.100.2', 'US', { timezone: 'America/New_York' }, 1);
    const cache = await saveEndpointResult('vpn1', RESOLVED, 2);
    expect(cache['vpn1']?.exitIp).toBeUndefined();
    expect(cache['vpn1']?.exitTimezone).toBeUndefined();
    expect(cache['vpn1']?.endpoint?.resolved).toBe(true);
  });

  it('VACUITY CONTROL — a SOCKS5 probe result is stored WITHOUT an endpoint, and the exit-geo path still works', async () => {
    await saveProbeResult('s1', OK, 1);
    const cache = await saveExitResult('s1', '198.51.100.2', 'US', {}, 1);
    expect(cache['s1']?.endpoint).toBeUndefined();
    expect(cache['s1']?.exitIp).toBe('198.51.100.2');
  });
});

describe('verdictMatchesScheme — a verdict of the wrong kind reads as untested', () => {
  const socks5Entry = { result: OK, at: 1 };
  const endpointEntry = { result: endpointPlaceholderResult(RESOLVED), at: 1, endpoint: RESOLVED };

  it('a SOCKS5-probeable row matches a SOCKS5 verdict', () => {
    expect(verdictMatchesScheme(true, socks5Entry)).toBe(true);
  });

  it('CRITICAL a VPN row does NOT match a SOCKS5 verdict — that is the false "unreachable"', () => {
    expect(verdictMatchesScheme(false, socks5Entry)).toBe(false);
  });

  it('a VPN row matches an endpoint verdict', () => {
    expect(verdictMatchesScheme(false, endpointEntry)).toBe(true);
  });

  it('a row switched back to SOCKS5 does not match its old endpoint verdict', () => {
    expect(verdictMatchesScheme(true, endpointEntry)).toBe(false);
  });
});

describe('T-17 — the exit identity expires', () => {
  it('a stamp younger than the TTL is fresh', () => {
    expect(isExitIdentityFresh(1_000_000, 1_000_000 + EXIT_IDENTITY_TTL_MS - 1)).toBe(true);
  });

  it('CRITICAL a stamp at or past the TTL is stale', () => {
    expect(isExitIdentityFresh(1_000_000, 1_000_000 + EXIT_IDENTITY_TTL_MS)).toBe(false);
  });

  it('CRITICAL an ABSENT stamp is not fresh — we cannot say when it was taken', () => {
    expect(isExitIdentityFresh(undefined, 1_000_000)).toBe(false);
  });

  it('VACUITY CONTROL — the helper is not simply always false', () => {
    expect(isExitIdentityFresh(5, 6)).toBe(true);
  });

  it('the TTL is thirty minutes, the same window as the measured-QUIC verdict', () => {
    expect(EXIT_IDENTITY_TTL_MS).toBe(30 * 60 * 1000);
  });

  it('saveExitResult stamps the exit with its own time, and a native re-test preserves it', async () => {
    await saveProbeResult('s1', OK, 1);
    await saveExitResult('s1', '198.51.100.2', 'US', { timezone: 'Europe/Amsterdam' }, 500);
    const stamped = await loadProbeCache();
    expect(stamped['s1']?.exitAt).toBe(500);
    const retested = await saveProbeResult('s1', OK, 900);
    expect(retested['s1']?.exitAt).toBe(500);
    expect(retested['s1']?.exitTimezone).toBe('Europe/Amsterdam');
  });

  it('VACUITY CONTROL — an entry that never had an exit probe has no stamp', async () => {
    const cache = await saveProbeResult('s1', OK, 1);
    expect(cache['s1']?.exitAt).toBeUndefined();
  });
});

describe('T-27 / W-30 — a measured verdict persisted without a stamp is backfilled ONCE', () => {
  function seedLegacy(id: string, at: number): void {
    const probes = (rawStore().get('probes') as Record<string, unknown> | undefined) ?? {};
    probes[id] = { result: OK, at, quicMeasured: 'h3' };
    rawStore().set('probes', probes);
  }

  beforeEach(() => {
    stores.set(STORE, new Map());
  });

  it("CRITICAL a legacy 'h3' with no stamp is stamped with the entry's own `at`", async () => {
    seedLegacy('p1', 4_000);
    const cache = await loadProbeCache();
    expect(cache['p1']?.quicMeasuredAt).toBe(4_000);
  });

  it('the backfilled stamp is persisted, and the store records the schema version', async () => {
    seedLegacy('p1', 4_000);
    await loadProbeCache();
    const probes = rawStore().get('probes') as Record<string, Record<string, unknown>>;
    expect(probes['p1']?.quicMeasuredAt).toBe(4_000);
    expect(rawStore().get('probes_schema')).toBe(PROBE_CACHE_SCHEMA_VERSION);
  });

  it('CRITICAL it runs once: a stampless verdict that appears AFTER the migration stays not-fresh', async () => {
    seedLegacy('p1', 4_000);
    await loadProbeCache(); // migrates and bumps the version
    seedLegacy('p2', 5_000); // a later write with no stamp — the rule stands for it
    const cache = await loadProbeCache();
    expect(cache['p2']?.quicMeasuredAt).toBeUndefined();
    expect(deriveProbeViewState(cache, 5_001).quicMeasured['p2']).toBeUndefined();
  });

  it('the migrated verdict is now visible to the views, and ages from the backfilled time', async () => {
    seedLegacy('p1', 4_000);
    const cache = await loadProbeCache();
    expect(deriveProbeViewState(cache, 4_001).quicMeasured['p1']).toBe('h3');
    expect(deriveProbeViewState(cache, 4_000 + 31 * 60 * 1000).quicMeasured['p1']).toBeUndefined();
  });

  it('VACUITY CONTROL — an entry that already has a stamp is left exactly as it was', async () => {
    const probes = { p1: { result: OK, at: 4_000, quicMeasured: 'h3', quicMeasuredAt: 9 } };
    rawStore().set('probes', probes);
    const cache = await loadProbeCache();
    expect(cache['p1']?.quicMeasuredAt).toBe(9);
  });

  it('VACUITY CONTROL — an entry with no verdict gets no stamp, and the pure step reports nothing changed', async () => {
    await saveProbeResult('p1', OK, 4_000);
    const cache = await loadProbeCache();
    expect(cache['p1']?.quicMeasuredAt).toBeUndefined();
    expect(cache['p1']).toEqual({ result: OK, at: 4_000 });
    const map: ProbeCacheMap = { p1: { result: OK, at: 4_000 } };
    expect(backfillQuicMeasuredAt(map, 1)).toEqual([]);
  });

  it('a non-finite `at` falls back to the load time rather than a stamp nothing can age', () => {
    const map: ProbeCacheMap = { p1: { result: OK, at: Number.NaN, quicMeasured: 'h3' } };
    expect(backfillQuicMeasuredAt(map, 77)).toEqual(['p1']);
    expect(map['p1']?.quicMeasuredAt).toBe(77);
  });
});

describe('saveObservedQuic — a live observation touches only the verdict', () => {
  it('attaches the verdict and its stamp to an existing entry', async () => {
    await saveProbeResult('p1', OK, 1);
    const cache = await saveObservedQuic('p1', 'h3', 50);
    expect(cache['p1']?.quicMeasured).toBe('h3');
    expect(cache['p1']?.quicMeasuredAt).toBe(50);
  });

  it('CRITICAL leaves the fleet vantage, node and relay verdict in place (saveServerProbeResult would strip them)', async () => {
    await saveProbeResult('p1', OK, 1);
    await saveServerProbeResult(
      'p1',
      { latencyMs: 9, measuredFrom: 'fleet', nodeId: 'mac-07', quicProbe: true },
      2,
    );
    const cache = await saveObservedQuic('p1', 'h3', 50);
    expect(cache['p1']).toMatchObject({
      measuredFrom: 'fleet',
      nodeId: 'mac-07',
      quicProbe: true,
      serverLatencyMs: 9,
      quicMeasured: 'h3',
    });
    // The contrast that makes the arm above load-bearing.
    const stripped = await saveServerProbeResult(
      'p1',
      { quicMeasured: 'h3', quicMeasuredAt: 60 },
      60,
    );
    expect(stripped['p1']?.measuredFrom).toBeUndefined();
  });

  it('is monotone — an older stamp cannot rewind a fresher verdict', async () => {
    await saveProbeResult('p1', OK, 1);
    await saveObservedQuic('p1', 'h3', 50);
    const cache = await saveObservedQuic('p1', 'h2-only', 40);
    expect(cache['p1']?.quicMeasured).toBe('h3');
    expect(cache['p1']?.quicMeasuredAt).toBe(50);
  });

  it('VACUITY CONTROL — a proxy with no entry gets nothing invented', async () => {
    const cache = await saveObservedQuic('ghost', 'h3', 50);
    expect(cache['ghost']).toBeUndefined();
  });
});
