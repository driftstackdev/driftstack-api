// T-1 ("measured from the Mac that will run the profile, not from local") and
// T-6 (the measured-QUIC verdict) both arrive on the control plane's /test
// response and then take two hops on the client: the WIRE (parsing that
// response) and the CACHE (the per-proxy probe store both proxy surfaces render
// from). This guards both hops.
//
// MEASURED mechanism, two properties one rule — a QUIC value outside the closed
// set {'h3','h2-only'} is DROPPED, never defaulted, so it can never resurface as
// a green chip; and the server latency + measured QUIC ride a SEPARATE call from
// the native capability probe, so a native re-test must PRESERVE them (the same
// rule the exit-geo and OS fingerprint already follow).
//
// One property per assertion; a vacuity control arm proves the preservation test
// is not passing on a value that was there all along.

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
  fetchWithDeadline: () => Promise.resolve(nextResponse()),
}));

import {
  deriveProbeViewState,
  loadProbeCache,
  saveProbeResult,
  saveServerProbeResult,
} from '../../src/lib/proxy-probe-cache';
import { cleanMeasuredQuic, testAccountProxy } from '../../src/lib/account-proxies';

const OK = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 42,
  message: 'ok',
};
const DOWN = { ...OK, reachable: false, can_route: false, connect_reply: 0xff, message: 'down' };

beforeEach(() => {
  stores.clear();
});

describe('the closed set (cleanMeasuredQuic)', () => {
  it("keeps 'h3'", () => {
    expect(cleanMeasuredQuic('h3')).toBe('h3');
  });

  it("keeps 'h2-only'", () => {
    expect(cleanMeasuredQuic('h2-only')).toBe('h2-only');
  });

  it('maps an explicit null (never measured) to null', () => {
    expect(cleanMeasuredQuic(null)).toBeNull();
  });

  it('DROPS an arbitrary string rather than accepting it as measured', () => {
    // The mutation this arm exists for: accepting any string would let a newer
    // server enum (or a proxy MITM-ing the response) manufacture a green chip.
    expect(cleanMeasuredQuic('h3-and-friends')).toBeNull();
    expect(cleanMeasuredQuic('quic')).toBeNull();
    expect(cleanMeasuredQuic('true')).toBeNull();
  });

  it('drops a non-string and an absent field', () => {
    expect(cleanMeasuredQuic(1)).toBeNull();
    expect(cleanMeasuredQuic(undefined)).toBeNull();
    expect(cleanMeasuredQuic({ os: 'h3' })).toBeNull();
  });
});

describe('the wire (testAccountProxy)', () => {
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it("carries a measured 'h3' and its timestamp through, alongside the server latency", async () => {
    nextResponse = () =>
      json(200, {
        ok: true,
        latency_ms: 7,
        quic_measured: 'h3',
        quic_measured_at: '2026-09-03T00:00:00.000Z',
      });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1');
    expect(r).toEqual({
      ok: true,
      latency_ms: 7,
      quic_measured: 'h3',
      quic_measured_at: '2026-09-03T00:00:00.000Z',
    });
  });

  it("carries a measured 'h2-only' through", async () => {
    nextResponse = () => json(200, { ok: true, latency_ms: 7, quic_measured: 'h2-only' });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1');
    expect(r).toMatchObject({ ok: true, quic_measured: 'h2-only', quic_measured_at: null });
  });

  it('DROPS a QUIC value outside the closed set rather than rendering it', async () => {
    nextResponse = () =>
      json(200, { ok: true, latency_ms: 7, quic_measured: 'h9', quic_measured_at: 'x' });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1');
    expect(r).toEqual({ ok: true, latency_ms: 7 });
  });

  it('omits the field entirely when the server reports null (never measured)', async () => {
    nextResponse = () => json(200, { ok: true, latency_ms: 7, quic_measured: null });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1');
    expect(r).toEqual({ ok: true, latency_ms: 7 });
  });

  it('still surfaces the server-measured latency on a response with no QUIC field', async () => {
    nextResponse = () => json(200, { ok: true, latency_ms: 33 });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1');
    expect(r).toMatchObject({ ok: true, latency_ms: 33 });
  });
});

describe('the cache', () => {
  it('attaches server latency + measured QUIC to an existing entry, and invents nothing without one', async () => {
    // No capability entry yet: nothing to attach to, and none is invented.
    expect(await saveServerProbeResult('ghost', { latencyMs: 5, quicMeasured: 'h3' }, 1)).toEqual(
      {},
    );
    await saveProbeResult('p1', OK, 1);
    await saveServerProbeResult('p1', { latencyMs: 9, quicMeasured: 'h3', quicMeasuredAt: 2 }, 2);
    const c = (await loadProbeCache()).p1;
    expect(c?.serverLatencyMs).toBe(9);
    expect(c?.quicMeasured).toBe('h3');
    expect(c?.quicMeasuredAt).toBe(2);
  });

  it('CRITICAL an explicit null CLEARS the stored latency; undefined leaves it alone', async () => {
    // Three answers, not two. `undefined` means "nothing new this time"; `null`
    // means "measured, and there is no number". Merging them is what let a stale
    // figure reload from disk on the next launch after the in-memory value was
    // dropped — the card would show a number no measurement had produced.
    await saveProbeResult('p1', OK, 1);
    await saveServerProbeResult('p1', { latencyMs: 9 }, 2);
    expect((await loadProbeCache()).p1?.serverLatencyMs).toBe(9);
    await saveServerProbeResult('p1', { quicMeasured: 'h3' }, 3);
    expect((await loadProbeCache()).p1?.serverLatencyMs, 'undefined keeps it').toBe(9);
    await saveServerProbeResult('p1', { latencyMs: null }, 4);
    expect((await loadProbeCache()).p1?.serverLatencyMs, 'null clears it').toBeUndefined();
    // …and nothing else on the entry was collateral damage.
    expect((await loadProbeCache()).p1?.quicMeasured).toBe('h3');
  });

  it('PRESERVES server latency + measured QUIC across a native capability re-test', async () => {
    await saveProbeResult('p1', OK, 1);
    await saveServerProbeResult('p1', { latencyMs: 9, quicMeasured: 'h3', quicMeasuredAt: 2 }, 2);
    // The native probe and the server /test are separate calls; re-running the
    // native probe must not erase what the control plane measured.
    await saveProbeResult('p1', { ...OK, latency_ms: 80 }, 3);
    const c = (await loadProbeCache()).p1;
    expect(c?.result.latency_ms).toBe(80); // native latency did update
    expect(c?.serverLatencyMs).toBe(9); // …but the server number survived
    expect(c?.quicMeasured).toBe('h3'); // …and so did the measured verdict
  });

  it('VACUITY CONTROL — a proxy that never got a server /test has neither field', async () => {
    // Proves the preservation test above is not merely re-reading a value every
    // entry carries: an entry with only a native probe must be empty of both.
    await saveProbeResult('p2', OK, 1);
    const c = (await loadProbeCache()).p2;
    expect(c?.serverLatencyMs).toBeUndefined();
    expect(c?.quicMeasured).toBeUndefined();
  });

  it('drops a stored QUIC verdict outside the closed set, keeping the rest of the entry', async () => {
    stores.set(
      'proxy-probe-cache.json',
      new Map([
        [
          'probes',
          {
            p1: { result: OK, at: 1, serverLatencyMs: 12, quicMeasured: 'h9', quicMeasuredAt: 1 },
          },
        ],
      ]),
    );
    const c = (await loadProbeCache()).p1;
    expect(c?.serverLatencyMs).toBe(12); // a valid sibling field survives
    expect(c).not.toHaveProperty('quicMeasured'); // the bogus verdict is gone
    expect(c).not.toHaveProperty('quicMeasuredAt');
  });

  it('exposes both to the views only while the proxy is usable', async () => {
    await saveProbeResult('p1', OK, 1);
    await saveServerProbeResult('p1', { latencyMs: 9, quicMeasured: 'h3', quicMeasuredAt: 2 }, 2);
    let view = deriveProbeViewState(await loadProbeCache());
    expect(view.serverLatency.p1).toBe(9);
    expect(view.quicMeasured.p1).toBe('h3');
    // A proxy that went DOWN keeps the record in the store but must not surface a
    // server latency or a green QUIC beside a red "unreachable" pill.
    await saveProbeResult('p1', DOWN, 3);
    view = deriveProbeViewState(await loadProbeCache());
    expect(view.serverLatency).toEqual({});
    expect(view.quicMeasured).toEqual({});
  });
});
