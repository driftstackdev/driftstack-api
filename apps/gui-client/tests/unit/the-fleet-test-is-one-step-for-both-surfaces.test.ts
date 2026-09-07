// T-27 (drops 1 and 5) — the control plane's fleet test is ONE shared step for
// the Proxies grid and the profile card (lib/proxy-server-test), so the card can
// no longer be missing it; and the measured-QUIC stamp it stores is the
// SERVER's `quic_measured_at`, not this Mac's clock at reply time.
//
// One property per assertion; the `unavailable` / `failed` outcomes are the
// vacuity controls for the persistence — they must write nothing.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';

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

const { testAccountProxy } = vi.hoisted(() => ({
  testAccountProxy:
    vi.fn<
      (
        baseUrl: string,
        apiKey: string,
        id: string,
        opts?: { vantage?: 'cp' | 'fleet' },
      ) => Promise<AccountProxiesModule.AccountProxyTestResult>
    >(),
}));

// Partial mock: every real export stays (the cache imports cleanMeasuredQuic
// from here); only the network call is replaced.
vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  testAccountProxy: (
    baseUrl: string,
    apiKey: string,
    id: string,
    opts?: { vantage?: 'cp' | 'fleet' },
  ) => testAccountProxy(baseUrl, apiKey, id, opts),
}));

import {
  persistServerProbe,
  quicVerdictStamp,
  serverProbeOutcome,
  testProxyOnServer,
} from '../../src/lib/proxy-server-test';
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
const NOW = 1_800_000_000_000;
const SERVER_TS = '2026-09-07T08:00:00.000Z';
const SERVER_MS = Date.parse(SERVER_TS);

beforeEach(() => {
  stores.clear();
  testAccountProxy.mockReset();
});

describe('quicVerdictStamp — the server clock wins', () => {
  it('CRITICAL a parseable `quic_measured_at` is the stamp, not the reply time', () => {
    expect(quicVerdictStamp(SERVER_TS, NOW)).toBe(SERVER_MS);
    expect(quicVerdictStamp(SERVER_TS, NOW)).not.toBe(NOW);
  });

  it('VACUITY CONTROL — null, absent or garbage falls back to the reply time', () => {
    expect(quicVerdictStamp(null, NOW)).toBe(NOW);
    expect(quicVerdictStamp(undefined, NOW)).toBe(NOW);
    expect(quicVerdictStamp('not a date', NOW)).toBe(NOW);
  });
});

describe('serverProbeOutcome — the wire result, translated once', () => {
  it('no answer at all is `unavailable`', () => {
    expect(serverProbeOutcome(null, NOW)).toEqual({ kind: 'unavailable' });
  });

  it('a server that says NOT usable is `failed`, with its reason and vantage', () => {
    expect(
      serverProbeOutcome({ ok: false, reason: 'did not answer', measured_from: 'fleet' }, NOW),
    ).toEqual({
      kind: 'failed',
      at: NOW,
      reason: 'did not answer',
      vantage: { measuredFrom: 'fleet' },
    });
  });

  it("CRITICAL a measured 'h3' carries the SERVER's stamp", () => {
    const outcome = serverProbeOutcome(
      { ok: true, latency_ms: 31, quic_measured: 'h3', quic_measured_at: SERVER_TS },
      NOW,
    );
    expect(outcome).toMatchObject({ kind: 'ok', quicMeasured: 'h3', quicMeasuredAt: SERVER_MS });
  });

  it('a measured verdict with no server stamp is stamped at reply time', () => {
    const outcome = serverProbeOutcome(
      { ok: true, latency_ms: 31, quic_measured: 'h2-only', quic_measured_at: null },
      NOW,
    );
    expect(outcome).toMatchObject({ kind: 'ok', quicMeasured: 'h2-only', quicMeasuredAt: NOW });
  });

  it('VACUITY CONTROL — no QUIC field means no verdict and no stamp', () => {
    const outcome = serverProbeOutcome({ ok: true, latency_ms: 31 }, NOW);
    expect(outcome).toEqual({ kind: 'ok', at: NOW, latencyMs: 31 });
  });

  it('T-1 — a fleet result with null latency is a real answer: latencyMs is null, not dropped', () => {
    const outcome = serverProbeOutcome(
      { ok: true, latency_ms: null, measured_from: 'fleet', node_id: 'mac-07', quic_probe: true },
      NOW,
    );
    expect(outcome).toEqual({
      kind: 'ok',
      at: NOW,
      latencyMs: null,
      vantage: { measuredFrom: 'fleet', nodeId: 'mac-07' },
      quicProbe: true,
    });
  });

  it('the node id survives only beside a fleet vantage, and the fingerprint rides through', () => {
    const outcome = serverProbeOutcome(
      {
        ok: true,
        latency_ms: 9,
        measured_from: 'control_plane',
        os_fingerprint: { os: 'linux', confidence: 'high', reason: 'ttl 64' },
      },
      NOW,
    );
    expect(outcome).toMatchObject({
      vantage: { measuredFrom: 'control_plane' },
      osFingerprint: { os: 'linux', confidence: 'high', reason: 'ttl 64' },
    });
    expect((outcome as { vantage?: { nodeId?: string } }).vantage?.nodeId).toBeUndefined();
  });
});

describe('testProxyOnServer — asks for the FLEET vantage and never throws', () => {
  it("CRITICAL sends { vantage: 'fleet' } with the caller's credentials and id", async () => {
    testAccountProxy.mockResolvedValue({ ok: true, latency_ms: 31 });
    await testProxyOnServer('http://localhost:3000', 'ds_test', 'aprx_1', () => NOW);
    expect(testAccountProxy).toHaveBeenCalledTimes(1);
    expect(testAccountProxy.mock.calls[0]).toEqual([
      'http://localhost:3000',
      'ds_test',
      'aprx_1',
      { vantage: 'fleet' },
    ]);
  });

  it('a request that throws is `unavailable`, not an exception the caller has to survive', async () => {
    testAccountProxy.mockRejectedValue(new Error('offline'));
    await expect(testProxyOnServer('http://x', 'k', 'aprx_1', () => NOW)).resolves.toEqual({
      kind: 'unavailable',
    });
  });
});

describe('persistServerProbe — one cache write for both surfaces', () => {
  it("CRITICAL stores the server latency, the verdict under the SERVER's stamp, the vantage, the relay verdict and the fingerprint", async () => {
    await saveProbeResult('p1', OK, 1);
    const outcome = serverProbeOutcome(
      {
        ok: true,
        latency_ms: 31,
        quic_measured: 'h3',
        quic_measured_at: SERVER_TS,
        measured_from: 'fleet',
        node_id: 'mac-07',
        quic_probe: true,
        os_fingerprint: { os: 'linux', confidence: 'high', reason: 'ttl 64' },
      },
      NOW,
    );
    const cache = await persistServerProbe('p1', outcome);
    expect(cache?.['p1']).toMatchObject({
      serverLatencyMs: 31,
      quicMeasured: 'h3',
      quicMeasuredAt: SERVER_MS,
      measuredFrom: 'fleet',
      nodeId: 'mac-07',
      quicProbe: true,
      osFingerprint: { os: 'linux', confidence: 'high', reason: 'ttl 64', at: NOW },
    });
    expect(cache?.['p1']?.quicMeasuredAt).not.toBe(NOW);
  });

  it('T-1 — a null latency CLEARS a stored number', async () => {
    await saveProbeResult('p1', OK, 1);
    await persistServerProbe('p1', serverProbeOutcome({ ok: true, latency_ms: 31 }, NOW));
    const cleared = await persistServerProbe(
      'p1',
      serverProbeOutcome({ ok: true, latency_ms: null, measured_from: 'fleet' }, NOW + 1),
    );
    expect(cleared?.['p1']?.serverLatencyMs).toBeUndefined();
  });

  it('VACUITY CONTROL — `failed` and `unavailable` write nothing and return null', async () => {
    await saveProbeResult('p1', OK, 1);
    expect(await persistServerProbe('p1', { kind: 'unavailable' })).toBeNull();
    expect(await persistServerProbe('p1', { kind: 'failed', at: NOW, reason: 'no' })).toBeNull();
    expect((await loadProbeCache())['p1']).toEqual({ result: OK, at: 1 });
  });

  it('a proxy with no native entry gets nothing invented', async () => {
    const cache = await persistServerProbe(
      'ghost',
      serverProbeOutcome({ ok: true, latency_ms: 31 }, NOW),
    );
    expect(cache?.['ghost']).toBeUndefined();
  });
});
