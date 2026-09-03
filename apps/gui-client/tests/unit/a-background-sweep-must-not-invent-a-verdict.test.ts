import { describe, expect, it, beforeEach } from 'vitest';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type { ProbeCacheMap } from '../../src/lib/proxy-probe-cache';
import { PROBE_TTL_MS, probeFreshness, isProbeStale } from '../../src/lib/proxy-probe-cache';
import { deriveProbeViewState } from '../../src/lib/proxy-probe-cache';
import type { SweepDeps } from '../../src/lib/proxy-probe-sweeper';
import {
  planSweep,
  runSweep,
  SWEEP_MAX_PER_RUN,
  __resetSweepLatchForTests,
  SWEEP_FAILURE_RETRY_MS,
} from '../../src/lib/proxy-probe-sweeper';

/**
 * A background sweep acts on the customer's behalf without being asked, against
 * infrastructure that is not ours. Every arm here pins a case where sweeping
 * would produce a verdict the customer did not ask for and should not believe.
 */

const NOW = 1_800_000_000_000;
// ⛔ Built from the REAL interface, not from what the assertions happen to read.
// An earlier version of this fixture omitted `can_route`, and `isProxyUsable`
// is `reachable && auth_ok && can_route` — so a "healthy" fixture silently
// tested the unhealthy path. `apps/gui-client/tsconfig.json` includes only
// `src`, so tests are NOT typechecked and nothing caught it but a failing arm.
const OK: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'ok',
};

function proxy(id: string, over: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    id,
    label: id,
    host: `${id}.example`,
    port: 1080,
    username: null,
    password: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
const entry = (at: number): ProbeCacheMap[string] => ({ result: OK, at });
const failedEntry = (at: number): ProbeCacheMap[string] => ({
  result: { ...OK, reachable: false, auth_ok: false, can_route: false, message: 'no answer' },
  at,
});

describe('probeFreshness', () => {
  it('calls a probe younger than the TTL fresh', () => {
    expect(probeFreshness(NOW - PROBE_TTL_MS + 1, NOW)).toBe('fresh');
  });

  it('calls a probe exactly at the TTL stale — the boundary is inclusive', () => {
    expect(probeFreshness(NOW - PROBE_TTL_MS, NOW)).toBe('stale');
  });

  it('distinguishes untested from stale', () => {
    // Different words to the customer: one has no evidence, the other has
    // evidence we no longer trust.
    expect(probeFreshness(undefined, NOW)).toBe('untested');
    expect(isProbeStale(undefined, NOW)).toBe(false);
  });

  it('treats a FUTURE timestamp as fresh, not stale', () => {
    // The host clock moved backwards (DST, NTP, a VM resume). The one thing we
    // know is that the entry was written recently. Calling it stale would
    // re-probe every proxy the customer owns on every clock correction.
    expect(probeFreshness(NOW + 60_000, NOW)).toBe('fresh');
  });

  it('treats a non-finite timestamp as untested rather than ancient', () => {
    expect(probeFreshness(Number.NaN, NOW)).toBe('untested');
  });
});

describe('planSweep', () => {
  const stale = NOW - PROBE_TTL_MS - 1;

  it('picks a stale socks5 proxy', () => {
    const plan = planSweep({ a: entry(stale) }, [proxy('a')], NOW);
    expect(plan.map((p) => p.id)).toEqual(['a']);
  });

  it('⛔ V-2168: retries a FAILING verdict after one sweep interval instead of the 6h TTL', () => {
    // Negative caching must expire faster than positive: one transient
    // handshake failure wrote a durable "Not reachable" badge nothing would
    // revisit for six hours. Fresh-by-TTL but past the failure-retry window →
    // swept.
    const cache = { a: failedEntry(NOW - SWEEP_FAILURE_RETRY_MS) };
    expect(planSweep(cache, [proxy('a')], NOW).map((p) => p.id)).toEqual(['a']);
  });

  it('V-2168: a RECENT failure is not hammered — the retry window still gates it', () => {
    const cache = { a: failedEntry(NOW - SWEEP_FAILURE_RETRY_MS + 1_000) };
    expect(planSweep(cache, [proxy('a')], NOW)).toEqual([]);
  });

  it('V-2168: a healthy verdict of the same age stays un-swept — only failures retry early', () => {
    const cache = { a: entry(NOW - SWEEP_FAILURE_RETRY_MS) };
    expect(planSweep(cache, [proxy('a')], NOW)).toEqual([]);
  });

  it('leaves a fresh verdict alone', () => {
    expect(planSweep({ a: entry(NOW - 1000) }, [proxy('a')], NOW)).toEqual([]);
  });

  it('⛔ NEVER sweeps a wireguard or openvpn proxy', () => {
    // testProxy is a SOCKS5 handshake. Against a VPN endpoint it fails as
    // "unreachable" — so a sweep would silently mark a customer's whole VPN
    // fleet dead, unasked. A manual Test is one deliberate click; this is not.
    for (const scheme of ['wireguard', 'openvpn', 'http'] as const) {
      const plan = planSweep({ a: entry(stale) }, [proxy('a', { scheme })], NOW);
      expect(plan, scheme).toEqual([]);
    }
  });

  it('sweeps a proxy whose scheme is explicitly socks5, and one with none', () => {
    expect(planSweep({ a: entry(stale) }, [proxy('a', { scheme: 'socks5' })], NOW)).toHaveLength(1);
    expect(planSweep({ a: entry(stale) }, [proxy('a')], NOW)).toHaveLength(1);
  });

  it('⛔ never probes a proxy the customer has deleted', () => {
    // A cache entry can outlive its proxy between a failed invalidate and a
    // reload. Probing a host that was removed is indefensible.
    expect(planSweep({ gone: entry(stale) }, [], NOW)).toEqual([]);
  });

  it('⛔ never probes a proxy that has never been tested', () => {
    // Nothing has gone off. Probing unasked turns "untested" into a red the
    // customer never requested.
    expect(planSweep({}, [proxy('never')], NOW)).toEqual([]);
  });

  it('orders oldest verdict FIRST so a capped sweep spends its budget well', () => {
    const cache = { new: entry(stale), old: entry(stale - 100_000), mid: entry(stale - 50_000) };
    const plan = planSweep(cache, [proxy('new'), proxy('old'), proxy('mid')], NOW);
    expect(plan.map((p) => p.id)).toEqual(['old', 'mid', 'new']);
  });

  it('caps the sweep', () => {
    const cache: ProbeCacheMap = {};
    const proxies: ProxyConfig[] = [];
    for (let i = 0; i < SWEEP_MAX_PER_RUN + 4; i += 1) {
      cache[`p${String(i)}`] = entry(stale - i);
      proxies.push(proxy(`p${String(i)}`));
    }
    expect(planSweep(cache, proxies, NOW)).toHaveLength(SWEEP_MAX_PER_RUN);
    expect(planSweep(cache, proxies, NOW, 0)).toEqual([]);
  });
});

describe('runSweep', () => {
  beforeEach(() => __resetSweepLatchForTests());

  const STALE = NOW - PROBE_TTL_MS - 1;
  // Promise.resolve rather than `async` throughout: these doubles have nothing
  // to await, and the lint rule that forbids a bare `async` is right — an async
  // function with no await advertises a suspension point that does not exist.
  const deps = (over: Partial<SweepDeps> = {}): SweepDeps => ({
    loadCache: () => Promise.resolve({ a: entry(STALE) }),
    listProxies: () => Promise.resolve([proxy('a')]),
    testProxy: () => Promise.resolve(OK),
    saveResult: () => Promise.resolve({}),
    now: () => NOW,
    sleep: () => Promise.resolve(),
    ...over,
  });

  it('records a refreshed proxy', async () => {
    const saved: Array<[string, number]> = [];
    const r = await runSweep(
      deps({
        saveResult: (id, _res, at) => {
          saved.push([id, at]);
          return Promise.resolve({});
        },
      }),
    );
    expect(r.refreshed).toEqual(['a']);
    expect(r.skipped).toBe(false);
    expect(saved).toEqual([['a', NOW]]);
  });

  it('⛔ does NOT write a verdict when the probe throws', () => {
    // A probe that could not RUN is not a verdict. Writing one would record a
    // failure of OURS as a fact about the customer's proxy.
    const saved: string[] = [];
    return runSweep(
      deps({
        testProxy: () => Promise.reject(new Error('host down')),
        saveResult: (id) => {
          saved.push(id);
          return Promise.resolve({});
        },
      }),
    ).then((r) => {
      expect(r.failed).toEqual(['a']);
      expect(r.refreshed).toEqual([]);
      expect(saved).toEqual([]); // nothing persisted
    });
  });

  it('one failing proxy does not abandon the rest of the sweep', async () => {
    let n = 0;
    const r = await runSweep(
      deps({
        loadCache: () =>
          Promise.resolve({ a: entry(STALE - 2), b: entry(STALE - 1), c: entry(STALE) }),
        listProxies: () => Promise.resolve([proxy('a'), proxy('b'), proxy('c')]),
        testProxy: () => {
          n += 1;
          return n === 1 ? Promise.reject(new Error('first one is down')) : Promise.resolve(OK);
        },
      }),
    );
    expect(r.failed).toEqual(['a']);
    expect(r.refreshed).toEqual(['b', 'c']);
  });

  it('pauses BETWEEN probes but not before the first', async () => {
    let sleeps = 0;
    await runSweep(
      deps({
        loadCache: () => Promise.resolve({ a: entry(STALE - 1), b: entry(STALE) }),
        listProxies: () => Promise.resolve([proxy('a'), proxy('b')]),
        sleep: () => {
          sleeps += 1;
          return Promise.resolve();
        },
      }),
    );
    expect(sleeps).toBe(1); // two probes, one gap
  });

  it('is single-flight — a concurrent call does nothing rather than queueing', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = runSweep(deps({ testProxy: () => gate.then(() => OK) }));
    const second = await runSweep(deps());
    expect(second.skipped).toBe(true);
    expect(second.refreshed).toEqual([]);
    release();
    expect((await first).refreshed).toEqual(['a']);
  });

  it('releases the latch after a sweep that threw, so it cannot wedge forever', async () => {
    await expect(
      runSweep(deps({ loadCache: () => Promise.reject(new Error('store unavailable')) })),
    ).rejects.toThrow('store unavailable');
    // A latch left set would silently disable sweeping for the rest of the session.
    const after = await runSweep(deps());
    expect(after.skipped).toBe(false);
  });
});

describe('deriveProbeViewState', () => {
  const DOWN: ProxyTestResult = {
    reachable: false,
    auth_ok: false,
    udp_associate: false,
    can_route: false,
    connect_reply: 0x01,
    latency_ms: 0,
    message: 'unreachable',
  };

  it('⛔ drops exit-geo when the last capability probe FAILED', () => {
    // The rule the sweep makes newly reachable. `saveProbeResult` preserves
    // prior exit-geo across a failed re-test, so a proxy that was healthy and
    // has now gone down would otherwise render "exits from US 1.2.3.4" beside
    // a red unreachable pill — a confident location for a dead proxy. A
    // background sweep turns that from a reload-only edge into a routine one.
    const view = deriveProbeViewState({
      a: { result: DOWN, at: NOW, exitIp: '1.2.3.4', exitCountry: 'US' },
    });
    expect(view.exitResults.a).toBeUndefined();
    expect(view.testResults.a).toEqual(DOWN);
  });

  it('keeps exit-geo when the probe was healthy', () => {
    const view = deriveProbeViewState({
      a: { result: OK, at: NOW, exitIp: '1.2.3.4', exitCountry: 'US', exitCity: 'Denver' },
    });
    expect(view.exitResults.a).toMatchObject({ ip: '1.2.3.4', country: 'US', city: 'Denver' });
  });

  it('omits optional geo fields that were never recorded rather than nulling them', () => {
    // An absent city and a city explicitly known to be null are different
    // facts; flattening them would invent knowledge we do not have.
    const view = deriveProbeViewState({ a: { result: OK, at: NOW, exitIp: '9.9.9.9' } });
    expect(view.exitResults.a).toEqual({ ip: '9.9.9.9', country: null });
  });

  it('records testedAt so a verdict can be shown with its age', () => {
    expect(deriveProbeViewState({ a: { result: OK, at: NOW } }).testedAt).toEqual({ a: NOW });
  });

  it('is empty for an empty cache and never throws', () => {
    expect(deriveProbeViewState({})).toEqual({
      testResults: {},
      exitResults: {},
      testedAt: {},
      osFingerprints: {},
      serverLatency: {},
      quicMeasured: {},
      serverVantage: {},
      quicProbe: {},
    });
  });
});
