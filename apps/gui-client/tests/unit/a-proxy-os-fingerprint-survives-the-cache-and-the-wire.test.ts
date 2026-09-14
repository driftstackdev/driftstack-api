// N-2 — the fingerprint's two hops on the client: the wire (the control plane's
// test response) and the cache (the per-proxy probe store both proxy surfaces
// render from).
//
// Two properties, one rule: a value outside the closed set is DROPPED, never
// defaulted. A newer server, a corrupt store, or a proxy MITM-ing the response
// can put any string in `os`; the only safe reading of a string the verdict
// cannot classify is "no fingerprint", and the chip then renders neutral.

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
  saveOsFingerprint,
  saveProbeResult,
} from '../../src/lib/proxy-probe-cache';
import { testAccountProxy } from '../../src/lib/account-proxies';

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
// ⛔⛔ (V-219) THE VANTAGE FIELDS ARE PART OF THIS FIXTURE, and their absence is
// exactly how a real defect shipped. `saveOsFingerprint` rebuilds the record
// field by field, and it silently dropped `observedVia` — so the chip never saw
// a vantage on any real row, and the front-door guard that branches on it was a
// dead branch that looked like a working safeguard for weeks.
//
// The round-trip arm below could not catch it: the fixture carried no vantage,
// and `toEqual({ ...FP, at })` is satisfied whether or not the save preserves a
// field the fixture does not have. A round-trip test proves nothing about a
// field its fixture omits — the assertion and the omission agree with each other.
const FP = {
  os: 'windows' as const,
  confidence: 'high' as const,
  reason: 'initial TTL 128',
  observedVia: 'exit_ip' as const,
  singleHostVantage: true as const,
};

beforeEach(() => {
  stores.clear();
});

describe('the cache', () => {
  it('attaches a fingerprint to an existing entry and preserves it across a capability re-test', async () => {
    // No entry yet: nothing to attach to, and no entry is invented.
    expect(await saveOsFingerprint('p1', FP, 1)).toEqual({});
    await saveProbeResult('p1', OK, 1);
    await saveOsFingerprint('p1', FP, 2);
    expect((await loadProbeCache()).p1?.osFingerprint).toEqual({ ...FP, at: 2 });
    // The capability probe and the fingerprint are separate calls; a re-test
    // must not erase what the control plane measured (same rule as exit-geo).
    await saveProbeResult('p1', OK, 3);
    expect((await loadProbeCache()).p1?.osFingerprint).toEqual({ ...FP, at: 2 });
  });

  it('CRITICAL every field of a reading survives the save — named one by one, so a field-by-field rebuild cannot quietly drop one', async () => {
    await saveProbeResult('p2', OK, 1);
    await saveOsFingerprint('p2', FP, 2);
    const stored = (await loadProbeCache()).p2?.osFingerprint;
    // Named individually rather than by a single toEqual against the fixture:
    // that comparison passes when BOTH sides are missing a field, which is how
    // the original drop survived its own round-trip test.
    expect(stored?.os).toBe('windows');
    expect(stored?.confidence).toBe('high');
    expect(stored?.reason).toBe('initial TTL 128');
    expect(stored?.observedVia, 'the vantage died here once already').toBe('exit_ip');
    expect(stored?.singleHostVantage, 'and this one gates whether the chip may assert at all').toBe(
      true,
    );
    expect(stored?.at).toBe(2);
  });

  it('CRITICAL a reading with NO vantage stays without one — the cache must not invent a value that unlocks a claim', async () => {
    const legacy = { os: 'windows' as const, confidence: 'high' as const, reason: 'TTL 128' };
    await saveProbeResult('p3', OK, 1);
    await saveOsFingerprint('p3', legacy, 2);
    const stored = (await loadProbeCache()).p3?.osFingerprint;
    expect(stored?.singleHostVantage).toBeUndefined();
    expect(stored?.observedVia).toBeUndefined();
  });

  it('exposes the fingerprint to the views only while the proxy is usable', async () => {
    await saveProbeResult('p1', OK, 1);
    await saveOsFingerprint('p1', FP, 2);
    expect(deriveProbeViewState(await loadProbeCache()).osFingerprints.p1).toEqual({
      ...FP,
      at: 2,
    });
    // A proxy that went DOWN keeps the record in the store but must not render
    // an OS verdict beside a red "unreachable" pill.
    await saveProbeResult('p1', DOWN, 3);
    expect(deriveProbeViewState(await loadProbeCache()).osFingerprints).toEqual({});
  });

  it('drops a stored fingerprint outside the closed set, keeping the rest of the entry', async () => {
    stores.set(
      'proxy-probe-cache.json',
      new Map([
        [
          'probes',
          {
            p1: {
              result: OK,
              at: 1,
              osFingerprint: { os: 'android', confidence: 'high', reason: 'x', at: 1 },
            },
            p2: {
              result: OK,
              at: 1,
              osFingerprint: { os: 'linux', confidence: 'shrug', reason: 'x', at: 1 },
            },
          },
        ],
      ]),
    );
    const cache = await loadProbeCache();
    expect(cache.p1?.result).toEqual(OK);
    expect(cache.p1).not.toHaveProperty('osFingerprint');
    expect(cache.p2).not.toHaveProperty('osFingerprint');
  });
});

describe('the wire', () => {
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('CRITICAL keeps a fingerprint the verdict can classify, and carries the VANTAGE fields across the wire', async () => {
    // ⛔ The body is WIRE-shaped (snake_case) on purpose. This arm used to spread
    // the camelCase fixture into the response and assert the parse equalled that
    // same fixture — which agreed with itself whether or not the parser read the
    // vantage at all. It did not read it, and that is how a reading of a
    // provider's front door reached the chip dressed as a verdict.
    nextResponse = () =>
      json(200, {
        ok: true,
        latency_ms: 5,
        os_fingerprint: {
          os: 'windows',
          confidence: 'high',
          reason: 'initial TTL 128',
          observed_ip: '1.2.3.4',
          observed_via: 'proxy_host',
          single_host_vantage: false,
        },
      });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1');
    if (!r.ok) throw new Error('fixture is an ok reply');
    expect(r.os_fingerprint?.os).toBe('windows');
    expect(r.os_fingerprint?.confidence).toBe('high');
    expect(r.os_fingerprint?.reason).toBe('initial TTL 128');
    expect(r.os_fingerprint?.observedVia, 'the wire spelling must be normalised, not dropped').toBe(
      'proxy_host',
    );
    expect(r.os_fingerprint?.singleHostVantage).toBe(false);
    // `observed_ip` is deliberately NOT surfaced — it is an internal diagnostic.
    expect((r.os_fingerprint as unknown as Record<string, unknown>).observed_ip).toBeUndefined();
  });

  it('CRITICAL a server that sends a TRUE vantage is believed, so the parser is not simply hard-coding false', async () => {
    nextResponse = () =>
      json(200, {
        ok: true,
        latency_ms: 5,
        os_fingerprint: {
          os: 'macos-or-ios',
          confidence: 'high',
          reason: 'TTL 64',
          observed_ip: '1.2.3.4',
          observed_via: 'exit_ip',
          single_host_vantage: true,
        },
      });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv2');
    if (!r.ok) throw new Error('fixture is an ok reply');
    expect(r.os_fingerprint?.singleHostVantage).toBe(true);
  });

  it('CRITICAL an older server that sends NO vantage field defaults to withholding, never to asserting', async () => {
    nextResponse = () =>
      json(200, {
        ok: true,
        latency_ms: 5,
        os_fingerprint: { os: 'macos-or-ios', confidence: 'high', reason: 'TTL 64' },
      });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv3');
    if (!r.ok) throw new Error('fixture is an ok reply');
    // The flattering direction is the one that matters: a missing field must not
    // let a reading promote itself into a confident green.
    expect(r.os_fingerprint?.singleHostVantage).toBe(false);
    expect(r.os_fingerprint?.observedVia).toBeUndefined();
  });

  it('drops a fingerprint outside the closed set rather than rendering it', async () => {
    nextResponse = () =>
      json(200, {
        ok: true,
        latency_ms: 5,
        os_fingerprint: { os: 'android', confidence: 'high', reason: 'x' },
      });
    const r = await testAccountProxy('https://api.example', 'ds_x', 'srv1');
    expect(r).toEqual({ ok: true, latency_ms: 5 });
  });

  it('passes a failed test through, and throws on a transport failure', async () => {
    nextResponse = () => json(200, { ok: false, reason: 'The proxy did not answer.' });
    expect(await testAccountProxy('https://api.example', 'ds_x', 'srv1')).toEqual({
      ok: false,
      reason: 'The proxy did not answer.',
    });
    nextResponse = () => json(503, {});
    await expect(testAccountProxy('https://api.example', 'ds_x', 'srv1')).rejects.toThrow('503');
  });
});
