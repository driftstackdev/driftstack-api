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

  it('whole-store corruption degrades to empty', async () => {
    stores.set('proxy-probe-cache.json', new Map([['probes', 'garbage']]));
    expect(await loadProbeCache()).toEqual({});
  });
});
