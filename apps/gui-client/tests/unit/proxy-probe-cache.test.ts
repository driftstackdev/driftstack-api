// proxy-probe-cache — round-trip, corrupt-entry degrade, last-write-wins.
// The store is mocked (same plugin-store mock pattern as profiles-meta).

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

import { loadProbeCache, saveProbeResult } from '../../src/lib/proxy-probe-cache';

const OK = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 42,
  message: 'ok',
};

describe('proxy-probe-cache', () => {
  beforeEach(() => {
    stores.clear();
  });

  it('round-trips a result and stamps the caller-provided time', async () => {
    await saveProbeResult('p1', OK, 1234);
    const cache = await loadProbeCache();
    expect(cache['p1']).toEqual({ result: OK, at: 1234 });
  });

  it('last write wins per proxy; other proxies untouched', async () => {
    await saveProbeResult('p1', OK, 1);
    await saveProbeResult('p2', { ...OK, udp_associate: false }, 2);
    await saveProbeResult('p1', { ...OK, latency_ms: 99 }, 3);
    const cache = await loadProbeCache();
    expect(cache['p1']?.result.latency_ms).toBe(99);
    expect(cache['p1']?.at).toBe(3);
    expect(cache['p2']?.result.udp_associate).toBe(false);
  });

  it('corrupt entries degrade to absent (honest untested state), valid ones survive', async () => {
    await saveProbeResult('good', OK, 5);
    const m = stores.get('proxy-probe-cache.json');
    const existing = (m?.get('probes') ?? {}) as Record<string, unknown>;
    m?.set('probes', {
      ...existing,
      bad1: 'not-an-object',
      bad2: { at: 'NaN', result: OK },
      bad3: { at: 6, result: { reachable: 'yes' } },
    });
    const cache = await loadProbeCache();
    expect(cache['good']).toBeDefined();
    expect(cache['bad1']).toBeUndefined();
    expect(cache['bad2']).toBeUndefined();
    expect(cache['bad3']).toBeUndefined();
  });

  it('exit-geo: saveExitResult attaches to an existing entry; capability re-test preserves it; no-entry is a no-op', async () => {
    const { saveExitResult } = await import('../../src/lib/proxy-probe-cache');
    // no capability entry yet → no-op
    let cache = await saveExitResult('ghost', '1.2.3.4', 'NL');
    expect(cache['ghost']).toBeUndefined();
    // attach after a capability probe
    await saveProbeResult('p1', OK, 1);
    cache = await saveExitResult('p1', '5.6.7.8', 'NL');
    expect(cache['p1']?.exitIp).toBe('5.6.7.8');
    expect(cache['p1']?.exitCountry).toBe('NL');
    // capability RE-test must not erase known geo
    cache = await saveProbeResult('p1', { ...OK, latency_ms: 80 }, 2);
    expect(cache['p1']?.result.latency_ms).toBe(80);
    expect(cache['p1']?.exitIp).toBe('5.6.7.8');
    // null country round-trips (probed, country unknown)
    cache = await saveExitResult('p1', '5.6.7.8', null);
    expect(cache['p1']?.exitCountry).toBeNull();
    const reloaded = await loadProbeCache();
    expect(reloaded['p1']?.exitCountry).toBeNull();
  });

  it('exit-geo: lumtest enrichment (city/region/timezone/asn) persists, round-trips, and a capability re-test preserves it', async () => {
    const { saveExitResult } = await import('../../src/lib/proxy-probe-cache');
    await saveProbeResult('p1', OK, 1);
    let cache = await saveExitResult('p1', '5.6.7.8', 'NL', {
      city: 'Strijen',
      region: 'South Holland',
      timezone: 'Europe/Amsterdam',
      asnOrg: 'Odido Netherlands B.V.',
    });
    expect(cache['p1']?.exitCity).toBe('Strijen');
    expect(cache['p1']?.exitRegion).toBe('South Holland');
    expect(cache['p1']?.exitTimezone).toBe('Europe/Amsterdam');
    expect(cache['p1']?.exitAsnOrg).toBe('Odido Netherlands B.V.');
    // a capability re-test must not erase the enriched geo
    cache = await saveProbeResult('p1', { ...OK, latency_ms: 90 }, 2);
    expect(cache['p1']?.exitCity).toBe('Strijen');
    // round-trips through the store deserializer
    const reloaded = await loadProbeCache();
    expect(reloaded['p1']?.exitRegion).toBe('South Holland');
    // best-effort: omitting geo (lumtest unreachable) records null, not stale
    cache = await saveExitResult('p1', '5.6.7.8', 'NL');
    expect(cache['p1']?.exitCity).toBeNull();
  });

  it('invalidateProbe drops a proxy entry (capability + exit-geo), persists, is idempotent, and leaves other proxies untouched', async () => {
    const { invalidateProbe, saveExitResult } = await import('../../src/lib/proxy-probe-cache');
    await saveProbeResult('p1', OK, 1);
    await saveExitResult('p1', '5.6.7.8', 'NL');
    await saveProbeResult('p2', OK, 2);
    // drops p1 entirely — result AND the attached exit-geo
    let cache = await invalidateProbe('p1');
    expect(cache['p1']).toBeUndefined();
    expect(cache['p2']?.result.latency_ms).toBe(42);
    // persisted to the store
    const reloaded = await loadProbeCache();
    expect(reloaded['p1']).toBeUndefined();
    expect(reloaded['p2']).toBeDefined();
    // idempotent — invalidating an already-absent id is a no-op
    cache = await invalidateProbe('p1');
    expect(cache['p1']).toBeUndefined();
    expect(cache['p2']).toBeDefined();
  });

  it('whole-store corruption degrades to empty', async () => {
    stores.set('proxy-probe-cache.json', new Map([['probes', 'garbage']]));
    expect(await loadProbeCache()).toEqual({});
  });
});
