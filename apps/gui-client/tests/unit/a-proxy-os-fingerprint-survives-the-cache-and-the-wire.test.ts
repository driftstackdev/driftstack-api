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
  OS_FINGERPRINT_TTL_MS,
  deriveProbeViewState,
  loadProbeCache,
  saveEndpointResult,
  saveOsFingerprint,
  saveProbeResult,
} from '../../src/lib/proxy-probe-cache';
import { deriveProbeViewWithEndpointRows } from '../../src/lib/proxy-server-test';
import {
  osFingerprintVerdict,
  unavailableOsFingerprint,
} from '../../src/lib/os-fingerprint-verdict';
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
    // ⚠️ (V-219) `nowMs` is passed explicitly. The fixtures stamp readings at
    // epoch ms 1-3 — 1970 — and readings now AGE OUT, so without it this arm
    // would pass for the wrong reason: an empty map because the record is
    // ancient, read as "the proxy is down". Freshness is pinned separately below.
    await saveProbeResult('p1', OK, 1);
    await saveOsFingerprint('p1', FP, 2);
    expect(deriveProbeViewState(await loadProbeCache(), 2).osFingerprints.p1).toEqual({
      ...FP,
      at: 2,
    });
    // A proxy that went DOWN keeps the record in the store but must not render
    // an OS verdict beside a red "unreachable" pill.
    await saveProbeResult('p1', DOWN, 3);
    expect(deriveProbeViewState(await loadProbeCache(), 3).osFingerprints).toEqual({});
  });

  // ⛔⛔ (V-219) THE READING NEVER EXPIRED, and the two fields either side of it
  // did. `at` was written on every reading and read by NOBODY, so the grid showed
  // a reading of unbounded age in bare present tense — and because a capability
  // re-test carries the stored fingerprint forward while refreshing the visible
  // "Tested" stamp, it showed it beside a timestamp saying we had just checked.
  //
  // Not hypothetical: the owner reported `linux` on a proxy whose probe has since
  // failed every attempt, so what they were looking at could only have been a
  // cached reading with no way to tell its age.
  it('CRITICAL a reading older than its TTL is dropped, so a months-old stack cannot render as current', async () => {
    await saveProbeResult('p1', OK, 1);
    await saveOsFingerprint('p1', FP, 1);
    const cache = await loadProbeCache();
    const justInside = 1 + OS_FINGERPRINT_TTL_MS - 1;
    const justOutside = 1 + OS_FINGERPRINT_TTL_MS;
    expect(
      deriveProbeViewState(cache, justInside).osFingerprints.p1,
      'inside the TTL',
    ).toBeDefined();
    expect(
      deriveProbeViewState(cache, justOutside).osFingerprints.p1,
      'outside it',
    ).toBeUndefined();
  });

  it('CRITICAL a CAUSE does not age. "A VPN tunnel has no SOCKS5 stack to fingerprint" is true however old it is, and expiring it would replace a true explanation with "never measured" — sending the customer to press Test on a row that can never produce a value.', async () => {
    await saveProbeResult('p2', OK, 1);
    await saveOsFingerprint('p2', unavailableOsFingerprint('vpn_tunnel'), 1);
    const cache = await loadProbeCache();
    const ancient = 1 + OS_FINGERPRINT_TTL_MS * 1000;
    const kept = deriveProbeViewState(cache, ancient).osFingerprints.p2;
    expect(kept, 'the cause survives any age').toBeDefined();
    expect(kept?.unavailable).toBe('vpn_tunnel');
  });

  // ⛔ A VPN ROW TAKES A DIFFERENT DERIVATION. `deriveProbeViewState` gates every
  // server-measured field on `isProxyUsable(result)`, which an endpoint row's
  // fail-closed placeholder NEVER satisfies, so `deriveProbeViewWithEndpointRows`
  // re-adds them under `serverVerdictUsable`. A TTL applied in only one of the two
  // is true of SOCKS5 rows and false of VPN rows, with nothing in either function
  // saying so — and the overlay is where the reading would survive, because it
  // runs AFTER the drop and writes the field straight back.
  //
  // The asymmetry was already visible there: the line below the OS one has aged
  // its QUIC verdict since W-30.
  it('CRITICAL a VPN row ages its reading too — the overlay that re-adds a dropped field must re-add it under the same rule', async () => {
    await saveEndpointResult('vpn1', { resolved: true, ip: '203.0.113.17', message: 'ok' }, 1);
    await saveOsFingerprint('vpn1', FP, 1);
    const cache = await loadProbeCache();
    // The overlay is the ONLY path that surfaces it for this row — without it
    // the arm below would pass on a row that never renders a chip at all.
    expect(
      deriveProbeViewState(cache, 2).osFingerprints.vpn1,
      'the plain derivation drops every VPN server field by design',
    ).toBeUndefined();
    expect(
      deriveProbeViewWithEndpointRows(cache, 1 + OS_FINGERPRINT_TTL_MS - 1).osFingerprints.vpn1,
      'inside the TTL the overlay surfaces it',
    ).toBeDefined();
    expect(
      deriveProbeViewWithEndpointRows(cache, 1 + OS_FINGERPRINT_TTL_MS).osFingerprints.vpn1,
      'outside it the overlay must not put it back',
    ).toBeUndefined();
  });

  it('CRITICAL and the VPN row KEEPS its cause — `vpn_tunnel` is the reading these rows normally carry, so an overlay that aged causes would blank the one surface that has an answer', async () => {
    await saveEndpointResult('vpn2', { resolved: true, ip: '203.0.113.17', message: 'ok' }, 1);
    await saveOsFingerprint('vpn2', unavailableOsFingerprint('vpn_tunnel'), 1);
    const cache = await loadProbeCache();
    const kept = deriveProbeViewWithEndpointRows(cache, 1 + OS_FINGERPRINT_TTL_MS * 1000)
      .osFingerprints.vpn2;
    expect(kept?.unavailable).toBe('vpn_tunnel');
  });

  it('CRITICAL an UNDATABLE reading is not fresh — a record with no timestamp cannot be shown as current, and absence must fail closed like its neighbours', async () => {
    await saveProbeResult('p3', OK, 1);
    await saveOsFingerprint('p3', FP, 1);
    const cache = await loadProbeCache();
    const entry = cache.p3;
    if (entry?.osFingerprint === undefined) throw new Error('fixture did not store a reading');
    delete (entry.osFingerprint as { at?: number }).at;
    expect(deriveProbeViewState(cache, 2).osFingerprints.p3).toBeUndefined();
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

  // ⛔⛔ (V-219) THE WHOLE CHAIN, END TO END, for the web-port vantage. The field
  // that preceded it — `observedVia` — was dropped at TWO hops on its way to the
  // chip while every per-hop test stayed green, because no test followed one
  // value from the wire to the verdict. This one does: server reply → wire parse
  // → cache save → cache load → derivation → verdict. A drop at any hop turns
  // the green into the neutral '?' and reds this arm.
  const mobileReply = (webPort: boolean) =>
    json(200, {
      ok: true,
      latency_ms: 5,
      os_fingerprint: {
        os: 'macos-or-ios',
        confidence: 'high',
        reason: 'TTL 64, window-scale before SACK-permitted — Darwin',
        observed_ip: '1.2.3.4',
        // A mobile proxy: dialled front door, device exit — never single-host.
        observed_via: 'proxy_host',
        single_host_vantage: false,
        ...(webPort ? { web_port_vantage: true } : {}),
      },
    });
  const verdictThroughTheChain = async (id: string, webPort: boolean) => {
    nextResponse = () => mobileReply(webPort);
    const r = await testAccountProxy('https://api.example', 'ds_x', id);
    if (!r.ok || r.os_fingerprint === undefined)
      throw new Error('fixture is an ok reply with a fingerprint');
    const now = Date.now();
    await saveProbeResult(id, OK, now);
    await saveOsFingerprint(id, r.os_fingerprint, now);
    const view = deriveProbeViewWithEndpointRows(await loadProbeCache(), now + 1);
    return osFingerprintVerdict(view.osFingerprints[id]);
  };

  it("CRITICAL a web-port reading from a multi-host MOBILE proxy survives every hop and is GREEN — the owner's VerizonNY, read as iOS/macOS where browserleaks read it; we present as an iPhone, so Darwin on the port websites use is a match", async () => {
    const v = await verdictThroughTheChain('mobile-web', true);
    expect(v.tone).toBe('match');
    expect(v.label).toBe('iOS/macOS');
    expect(v.hint).toMatch(/web port \(443\)/);
  });

  it('CRITICAL CONTROL — the same reading WITHOUT the web-port vantage stays neutral, so the arm above is about the vantage and not a relaxed gate', async () => {
    const v = await verdictThroughTheChain('mobile-obs', false);
    expect(v.tone).toBe('unknown');
    expect(v.label, 'the observer-port front door is the gateway: no verdict, no name').toBe('OS');
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
