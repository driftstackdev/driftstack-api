// 2026-09-17 — the THIRD display state: AGED.
//
// A capability reading (the OS its stack presents as, the live QUIC verdict, the
// Test's QUIC and UDP readings) leaves its present-tense map once its DISPLAY
// WINDOW closes. That rule is right and is NOT touched here: a chip that says
// `✓ QUIC` must be true now, and the launch path acts on fresh identity. But
// leaving the map is also what "never measured" looks like, so a proxy the
// customer tested just outside the window rendered exactly like one nobody had
// ever tested — and told them to press Test on a row they had just tested. The
// value was on disk the whole time.
//
// ⛔ PIN UPDATED 2026-09-17. The window was thirty minutes for all four readings;
// it is now thirty minutes for the LIVE session verdict (fed by a 300 s re-emit)
// and `MEASURED_READING_TTL_MS` — eight hours, derived from the six-hour
// capability cadence — for the three fed by the automatic check. The ages below
// moved past the new boundary; the SHAPE of every arm is unchanged, and the
// invariant that produced the new number has its own suite
// (a-display-window-outlasts-the-refresh-that-feeds-it.test.ts).
//
// `ProbeViewState.aged` is a PARALLEL structure: a reading is in its fresh map or
// in `aged`, never both; every fresh map holds exactly what it held before; and a
// surface renders an aged reading in the past tense, muted, with its age — never
// in the tone of a current verdict.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

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
      this.map().set(key, structuredClone(value));
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import {
  agedQuicReading,
  ProxyCapabilityChips,
  ProxyOsChip,
  proxyCapabilities,
} from '../../src/components/ProxyCapabilities';
import { OS_FINGERPRINT_TTL_MS } from '../../src/lib/os-fingerprint-verdict';
import type { ProxyTestResult } from '../../src/lib/proxies';
import {
  AGED_READING_MAX_MS,
  agedReadingsFor,
  deriveProbeViewState,
  isExitIdentityFresh,
  isOsFingerprintFresh,
  isQuicProbeFresh,
  isQuicVerdictFresh,
  isUdpVerdictFresh,
  loadProbeCache,
  MEASURED_READING_TTL_MS,
  QUIC_VERDICT_TTL_MS,
  saveEndpointResult,
  saveObservedQuic,
  saveProbeResult,
  saveServerProbeResult,
  type CachedProbe,
  type ProbeCacheMap,
} from '../../src/lib/proxy-probe-cache';
import { deriveProbeViewWithEndpointRows } from '../../src/lib/proxy-server-test';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Past EVERY display window (the longest is `MEASURED_READING_TTL_MS`, 8 h) and
 *  well inside `AGED_READING_MAX_MS`, so a reading taken this long ago is aged on
 *  every one of the four maps. It was 4 h, which is now INSIDE three of them. */
const AGED_AT = 9 * HOUR;

const OK: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0,
  latency_ms: 40,
  message: 'ok',
};
const DOWN: ProxyTestResult = { ...OK, reachable: false, auth_ok: false, can_route: false };

const FP = {
  os: 'macos-or-ios' as const,
  confidence: 'high' as const,
  reason: 'r',
  observedVia: 'exit_ip' as const,
  singleHostVantage: true as const,
  webPortVantage: true as const,
};

/** Every capability reading on one entry, all taken `ageMs` ago. */
const entry = (ageMs: number, over: Partial<CachedProbe> = {}): CachedProbe => ({
  result: OK,
  at: NOW - MIN,
  osFingerprint: { ...FP, at: NOW - ageMs },
  quicMeasured: 'h3',
  quicMeasuredAt: NOW - ageMs,
  quicProbe: true,
  quicProbeAt: NOW - ageMs,
  udpProbe: false,
  udpProbeAt: NOW - ageMs,
  ...over,
});

beforeEach(() => {
  stores.clear();
});

describe('deriveProbeViewState — the aged maps', () => {
  it('CRITICAL a reading is AGED only when it is NOT fresh and is younger than 30 days — and it is then in `aged` and NOT in its fresh map. MUTATION: in deriveProbeViewState turn any `else if (… isAgedReadingShowable …)` into a plain `if` and the fresh-window block reds; set AGED_READING_MAX_MS to Infinity and the last block reds', () => {
    // Inside the window: fresh, nothing aged.
    let view = deriveProbeViewState({ p: entry(10 * MIN) }, NOW);
    expect(view.aged).toEqual({
      osFingerprints: {},
      quicMeasured: {},
      quicProbe: {},
      udpProbe: {},
    });
    expect(view.quicProbe.p).toBe(true);

    // Nine hours: every reading has left the present tense and is aged, dated.
    view = deriveProbeViewState({ p: entry(AGED_AT) }, NOW);
    expect(view.osFingerprints).toEqual({});
    expect(view.quicMeasured).toEqual({});
    expect(view.quicProbe).toEqual({});
    expect(view.udpProbe).toEqual({});
    expect(view.aged.osFingerprints.p?.atMs).toBe(NOW - AGED_AT);
    expect(view.aged.osFingerprints.p?.value.os).toBe('macos-or-ios');
    expect(view.aged.quicMeasured.p).toEqual({ value: 'h3', atMs: NOW - AGED_AT });
    expect(view.aged.quicProbe.p).toEqual({ value: true, atMs: NOW - AGED_AT });
    // A measured NEGATIVE ages as a negative — `false` is a reading, not an absence.
    expect(view.aged.udpProbe.p).toEqual({ value: false, atMs: NOW - AGED_AT });

    // Past the cap: not current, not aged — not measured.
    expect(AGED_READING_MAX_MS).toBe(30 * DAY);
    view = deriveProbeViewState({ p: entry(30 * DAY) }, NOW);
    expect(view.aged).toEqual({
      osFingerprints: {},
      quicMeasured: {},
      quicProbe: {},
      udpProbe: {},
    });
  });

  it('CRITICAL an UNDATABLE reading is neither fresh nor aged — an age sentence needs a date. It reads as not measured, and the automatic check re-takes it', () => {
    const { quicProbeAt: _q, udpProbeAt: _u, quicMeasuredAt: _m, ...undated } = entry(AGED_AT);
    const view = deriveProbeViewState({ p: undated }, NOW);
    expect(view.quicProbe).toEqual({});
    expect(view.aged.quicProbe).toEqual({});
    expect(view.aged.udpProbe).toEqual({});
    expect(view.aged.quicMeasured).toEqual({});
  });

  it('CRITICAL the aged arm obeys the SAME gate as its fresh sibling: nothing aged beside a red "unreachable" pill — except the OS reading of a server-seeded row, which has no pill to sit beside. MUTATION: drop `isProxyUsable(c.result)` from an aged arm’s enclosing `if` and the first block reds', () => {
    let view = deriveProbeViewState({ p: entry(AGED_AT, { result: DOWN }) }, NOW);
    expect(view.aged).toEqual({
      osFingerprints: {},
      quicMeasured: {},
      quicProbe: {},
      udpProbe: {},
    });

    view = deriveProbeViewState({ p: entry(AGED_AT, { result: DOWN, serverSeeded: true }) }, NOW);
    expect(view.aged.osFingerprints.p?.atMs).toBe(NOW - AGED_AT);
    expect(view.aged.quicProbe).toEqual({});
    expect(view.aged.udpProbe).toEqual({});
  });

  it('a CAUSE does not age: "the OS check is not available for VPN connections" is as true next month as today, and stays in the current map', () => {
    const cause = {
      os: 'unknown' as const,
      confidence: 'none' as const,
      reason: 'r',
      unavailable: 'vpn_tunnel' as const,
      at: NOW - 20 * DAY,
    };
    const view = deriveProbeViewState({ p: entry(MIN, { osFingerprint: cause }) }, NOW);
    expect(view.osFingerprints.p?.unavailable).toBe('vpn_tunnel');
    expect(view.aged.osFingerprints).toEqual({});
  });

  it('CRITICAL the VPN overlay ages the same way — an overlay that knew only the fresh maps would make the aged state true of SOCKS5 rows and silently absent for tunnels. MUTATION: delete an `else if` aged arm in deriveProbeViewWithEndpointRows and this reds', async () => {
    await saveEndpointResult('v', { resolved: true, ip: '198.51.100.7', message: 'ok' }, NOW - MIN);
    await saveServerProbeResult(
      'v',
      { latencyMs: 60, measuredFrom: 'fleet', quicProbe: true, udpProbe: true },
      NOW - AGED_AT,
    );
    const cache = await loadProbeCache();
    // The BASE derivation shows nothing for a tunnel's placeholder — by design.
    expect(deriveProbeViewState(cache, NOW).aged.quicProbe).toEqual({});
    const view = deriveProbeViewWithEndpointRows(cache, NOW);
    expect(view.quicProbe).toEqual({});
    expect(view.udpProbe).toEqual({});
    expect(view.aged.quicProbe.v).toEqual({ value: true, atMs: NOW - AGED_AT });
    expect(view.aged.udpProbe.v).toEqual({ value: true, atMs: NOW - AGED_AT });
  });
});

describe('CONTROL — the fresh predicates and the fresh maps are exactly what they were', () => {
  it('CRITICAL every present-tense predicate keeps its SHAPE — a boundary that is exclusive at the edge, an absent stamp NOT fresh, a future stamp fresh — and each one now answers to the window of the thing that FEEDS it: thirty minutes for the live session verdict and the acted-on exit identity, eight hours for the three the six-hourly capability check re-takes. The launch path reads these and nothing in `aged`', () => {
    // ⛔ PIN UPDATED 2026-09-17, and split in two rather than moved wholesale.
    // The live verdict's thirty minutes is derived from the fleet's 300 s ±20%
    // re-emit and is CORRECT; the exit identity's is derived from the fact that a
    // launch ACTS on it. The other three inherited that number by imitation while
    // being fed six-hourly, which is the defect — see proxy-reading-windows.
    const LIVE_TTL = 30 * MIN;
    const MEASURED_TTL = MEASURED_READING_TTL_MS;
    expect(QUIC_VERDICT_TTL_MS).toBe(LIVE_TTL);
    expect(OS_FINGERPRINT_TTL_MS).toBe(MEASURED_TTL);
    expect(MEASURED_TTL).toBe(8 * HOUR);
    for (const [fresh, ttl] of [
      [isQuicVerdictFresh, LIVE_TTL],
      [isExitIdentityFresh, LIVE_TTL],
      [isUdpVerdictFresh, MEASURED_TTL],
      [isQuicProbeFresh, MEASURED_TTL],
    ] as const) {
      expect(fresh(NOW - ttl + 1, NOW)).toBe(true);
      expect(fresh(NOW - ttl, NOW)).toBe(false);
      expect(fresh(undefined, NOW)).toBe(false);
      expect(fresh(NOW + HOUR, NOW)).toBe(true);
    }
    expect(isOsFingerprintFresh({ ...FP, at: NOW - MEASURED_TTL + 1 }, NOW)).toBe(true);
    expect(isOsFingerprintFresh({ ...FP, at: NOW - MEASURED_TTL }, NOW)).toBe(false);
    expect(isOsFingerprintFresh(undefined, NOW)).toBe(false);
  });

  it('CRITICAL for the three readings that were ALREADY aged (OS, live QUIC, UDP) the fresh maps hold exactly the entries the pre-existing predicates admit — at every age, the aged state adds to the view and removes nothing. (The relay verdict is the one deliberate change, pinned below.)', () => {
    for (const ageMs of [
      0,
      10 * MIN,
      30 * MIN - 1,
      30 * MIN,
      4 * HOUR,
      MEASURED_READING_TTL_MS - 1,
      MEASURED_READING_TTL_MS,
      AGED_AT,
      40 * DAY,
    ]) {
      const e = entry(ageMs);
      const view = deriveProbeViewState({ p: e }, NOW);
      expect('p' in view.osFingerprints, `os @${ageMs.toString()}`).toBe(
        isOsFingerprintFresh(e.osFingerprint, NOW),
      );
      expect('p' in view.quicMeasured, `quicMeasured @${ageMs.toString()}`).toBe(
        isQuicVerdictFresh(e.quicMeasuredAt, NOW),
      );
      expect('p' in view.udpProbe, `udp @${ageMs.toString()}`).toBe(
        isUdpVerdictFresh(e.udpProbeAt, NOW),
      );
      // Never in both: fresh XOR aged (or neither).
      expect('p' in view.osFingerprints && 'p' in view.aged.osFingerprints).toBe(false);
      expect('p' in view.quicMeasured && 'p' in view.aged.quicMeasured).toBe(false);
      expect('p' in view.quicProbe && 'p' in view.aged.quicProbe).toBe(false);
      expect('p' in view.udpProbe && 'p' in view.aged.udpProbe).toBe(false);
      // The maps the aged state has nothing to do with are untouched.
      expect(view.testResults.p).toEqual(OK);
      expect(view.testedAt.p).toBe(NOW - MIN);
    }
  });
});

describe('CONTROL — FROZEN: the fresh maps of a fixed cache, as the commit before the aged state produced them', () => {
  // ⛔ The arm above compares the maps with the LIVE predicates, so a change made to a
  // predicate AND the map together, or to a GATE (`isProxyUsable`, the `serverSeeded`
  // exception), would pass it. These literals were recorded by running HEAD's own
  // `deriveProbeViewState` / `deriveProbeViewWithEndpointRows` over this exact cache
  // (2026-09-17). The ONE difference from that recording is deliberate and is the
  // relay verdict: HEAD never aged it, so `old` and `vpnOld` were in `quicProbe` too.
  const endpoint = { resolved: true, ip: '198.51.100.7', message: 'ok' };
  const cache: ProbeCacheMap = {
    fresh: entry(10 * MIN),
    old: entry(AGED_AT),
    down: entry(10 * MIN, { result: DOWN }),
    seeded: entry(10 * MIN, { result: DOWN, serverSeeded: true }),
    vpn: entry(10 * MIN, { result: DOWN, endpoint }),
    vpnOld: entry(AGED_AT, { result: DOWN, endpoint }),
  };
  const AT = NOW - MIN;

  it('CRITICAL deriveProbeViewState — a DOWN row shows no Driftstack reading, a server-seeded row shows its OS reading and nothing else, a tunnel’s placeholder shows nothing. MUTATION: drop `isProxyUsable(c.result)` from a fresh arm’s gate and `down` joins a map', () => {
    const view = deriveProbeViewState(cache, NOW);
    expect(Object.keys(view.osFingerprints)).toEqual(['fresh', 'seeded']);
    expect(view.quicMeasured).toEqual({ fresh: 'h3' });
    expect(view.udpProbe).toEqual({ fresh: false });
    expect(view.quicProbe).toEqual({ fresh: true }); // HEAD: + old (never aged) — the one change
    expect(Object.keys(view.testResults)).toEqual(['fresh', 'old', 'down', 'vpn', 'vpnOld']);
    expect(view.testedAt).toEqual({ fresh: AT, old: AT, down: AT, vpn: AT, vpnOld: AT });
  });

  it('CRITICAL deriveProbeViewWithEndpointRows — the overlay admits a RESOLVED tunnel’s fresh readings and drops its placeholder result, exactly as before', () => {
    const view = deriveProbeViewWithEndpointRows(cache, NOW);
    expect(Object.keys(view.osFingerprints)).toEqual(['fresh', 'seeded', 'vpn']);
    expect(view.quicMeasured).toEqual({ fresh: 'h3', vpn: 'h3' });
    expect(view.udpProbe).toEqual({ fresh: false, vpn: false });
    expect(view.quicProbe).toEqual({ fresh: true, vpn: true }); // HEAD: + old, vpnOld
    expect(Object.keys(view.testResults)).toEqual(['fresh', 'old', 'down']);
    expect(view.testedAt).toEqual({ fresh: AT, old: AT, down: AT, vpn: AT, vpnOld: AT });
  });
});

describe('the Test’s QUIC verdict is dated now — it was the one reading nothing aged', () => {
  it('CRITICAL every local write of the verdict stamps it; a CARRY keeps the original stamp (it measured nothing and may not make an old verdict look new); a native re-test and an address check carry it unchanged. MUTATION: in saveServerProbeResult write `quicProbeAt: at` in the carry arm too and the carry block reds', async () => {
    await saveProbeResult('p', OK, NOW - 5 * HOUR);
    await saveServerProbeResult(
      'p',
      { latencyMs: 20, measuredFrom: 'fleet', quicProbe: true },
      NOW - 5 * HOUR,
    );
    expect((await loadProbeCache()).p?.quicProbeAt).toBe(NOW - 5 * HOUR);

    // A control-plane fallback measured nothing about QUIC: verdict AND date carried.
    await saveServerProbeResult('p', { latencyMs: 25, measuredFrom: 'control_plane' }, NOW - HOUR);
    let e = (await loadProbeCache()).p;
    expect(e?.quicProbe).toBe(true);
    expect(e?.quicProbeAt, 'the carry did not refresh the clock').toBe(NOW - 5 * HOUR);
    expect(e?.serverProbeAt).toBe(NOW - HOUR);

    // …and a skipped leg likewise.
    await saveServerProbeResult(
      'p',
      { latencyMs: 25, measuredFrom: 'fleet', quicSkipped: true },
      NOW - 30 * MIN,
    );
    expect((await loadProbeCache()).p?.quicProbeAt).toBe(NOW - 5 * HOUR);

    // A native re-test rebuilds the entry field by field — the date must survive it.
    await saveProbeResult('p', OK, NOW);
    e = (await loadProbeCache()).p;
    expect(e?.quicProbe).toBe(true);
    expect(e?.quicProbeAt).toBe(NOW - 5 * HOUR);

    // A fresh measurement re-stamps.
    await saveServerProbeResult(
      'p',
      { latencyMs: 20, measuredFrom: 'fleet', quicProbe: false },
      NOW,
    );
    e = (await loadProbeCache()).p;
    expect(e?.quicProbe).toBe(false);
    expect(e?.quicProbeAt).toBe(NOW);
  });

  it('CRITICAL so a relay verdict is no longer a green tick "for the life of the install": it leaves the present tense at its DISPLAY WINDOW like its neighbours, and shows aged instead of vanishing. MUTATION: in deriveProbeViewState replace `isQuicProbeFresh(c.quicProbeAt, nowMs)` with `true` and this reds', () => {
    // ⛔ PIN UPDATED 2026-09-17: the window, not the arm. Five hours is now INSIDE
    // it, deliberately — nothing re-takes this verdict more often than every six
    // hours, so a five-hour-old green chip was being muted before anything could
    // have replaced it. Both edges are still pinned, one step apart.
    expect(isQuicProbeFresh(NOW - MEASURED_READING_TTL_MS + 1, NOW)).toBe(true);
    expect(isQuicProbeFresh(NOW - MEASURED_READING_TTL_MS, NOW)).toBe(false);
    expect(isQuicProbeFresh(undefined, NOW)).toBe(false);
    expect(deriveProbeViewState({ p: entry(5 * HOUR) }, NOW).quicProbe.p).toBe(true);
    const view = deriveProbeViewState({ p: entry(AGED_AT) }, NOW);
    expect(view.quicProbe).toEqual({});
    expect(view.aged.quicProbe.p).toEqual({ value: true, atMs: NOW - AGED_AT });
  });

  it('a live verdict that retires the relay verdict it contradicts retires its DATE with it — a stamp left behind would date the next carried verdict wrongly', async () => {
    await saveProbeResult('p', OK, NOW - HOUR);
    await saveServerProbeResult(
      'p',
      { latencyMs: 20, measuredFrom: 'fleet', quicProbe: true },
      NOW - HOUR,
    );
    await saveObservedQuic('p', 'h2-only', NOW);
    const e = (await loadProbeCache()).p;
    expect(e).not.toHaveProperty('quicProbe');
    expect(e).not.toHaveProperty('quicProbeAt');
  });

  it('the stamp survives a RELOAD, and only beside the verdict it dates', async () => {
    stores.set(
      'proxy-probe-cache.json',
      new Map<string, unknown>([
        ['probes_schema', 2],
        [
          'probes',
          {
            a: { result: OK, at: NOW, quicProbe: true, quicProbeAt: NOW - HOUR },
            orphan: { result: OK, at: NOW, quicProbeAt: NOW - HOUR },
          },
        ],
      ]),
    );
    const cache: ProbeCacheMap = await loadProbeCache();
    expect(cache.a?.quicProbeAt).toBe(NOW - HOUR);
    expect(cache.orphan).not.toHaveProperty('quicProbeAt');
  });
});

describe('the chips — an aged reading can never be mistaken for a current one', () => {
  const aged = agedReadingsFor(deriveProbeViewState({ p: entry(AGED_AT) }, NOW).aged, 'p');

  it('CRITICAL the QUIC chip shows the last reading in the PAST tense, muted, with its age — `data-ok="aged"`, never "true"/"false", never the green of a current verdict — and the hover says when, and that it will be rechecked. MUTATION: render the aged chip with `data-ok={c.aged.value ? "true" : "false"}` and this reds', () => {
    const { container } = render(
      <ProxyCapabilityChips result={OK} aged={aged} nowMs={NOW} autoRecheck />,
    );
    const chip = container.querySelector('[data-capability="quic"]');
    expect(chip?.getAttribute('data-ok')).toBe('aged');
    expect(chip?.getAttribute('data-aged-value')).toBe('true');
    expect(chip?.textContent).toBe('✓QUIC · 9 h ago');
    expect(chip?.className).not.toContain('status-ready');
    expect(chip?.className).not.toContain('status-error');
    expect(chip?.className).toContain('border-dashed');
    expect(chip?.getAttribute('title')).toBe(
      'Last checked 9 hours ago. It will be rechecked automatically. HTTP/3 worked through this exit then.',
    );
    // The chips that come from this Mac's own handshake have no aged state.
    expect(container.querySelector('[data-capability="webrtc"]')?.getAttribute('data-ok')).toBe(
      'true',
    );
  });

  it('an aged NEGATIVE keeps its glyph and says so in the past tense; two days reads "2 d ago"', () => {
    const view = deriveProbeViewState(
      { p: entry(2 * DAY, { quicMeasured: 'h2-only', quicProbe: false }) },
      NOW,
    );
    const { container } = render(
      <ProxyCapabilityChips result={OK} aged={agedReadingsFor(view.aged, 'p')} nowMs={NOW} />,
    );
    const chip = container.querySelector('[data-capability="quic"]');
    expect(chip?.getAttribute('data-ok')).toBe('aged');
    expect(chip?.getAttribute('data-aged-value')).toBe('false');
    expect(chip?.textContent).toBe('⤵QUIC · 2 d ago');
    expect(chip?.getAttribute('title')).toContain('HTTP/3 did not work through this exit then');
  });

  it('CRITICAL a CURRENT verdict always wins: the aged reading is consulted only where the chip would otherwise fall back to the inference. MUTATION: drop the `nothingCurrent &&` test in proxyCapabilities and the first block reds', () => {
    const current = proxyCapabilities(OK, undefined, false, aged).find((c) => c.key === 'quic');
    expect(current?.aged).toBeUndefined();
    expect(current?.ok).toBe(false);
    const live = proxyCapabilities(OK, 'h3', undefined, aged).find((c) => c.key === 'quic');
    expect(live?.aged).toBeUndefined();
    // ⛔ PIN UPDATED 2026-09-17 — SPLIT BY THE SIGN OF THE AGED READING, which is
    // what this arm was missing. It read: "'No UDP — HTTP/3 cannot work here' IS a
    // current verdict, deduced from the native handshake the sweep keeps current,
    // not guessed; an aged '✓ QUIC · 2 h ago' in its place would swap a
    // present-tense negative for an old tick."
    //
    // True of an aged NEGATIVE, which agrees with it and adds nothing — pinned
    // below, unchanged. FALSE of an aged POSITIVE: Driftstack MEASURED HTTP/3
    // working through this exit, and suppressing that in favour of a deduction
    // from a different check is how one proxy came to say "✓ QUIC" on the card
    // and "HTTP/3 cannot work here" on the grid. The measured reading is shown,
    // aged like every other, and the hint says the two checks disagree.
    const agedPositiveNoUdp = proxyCapabilities(
      { ...OK, udp_associate: false },
      undefined,
      undefined,
      aged,
      // The reference moment, injected: the default is the real clock, and these
      // fixtures are dated from a fixed NOW, so the age sentence would read
      // "just now" about a reading taken nine hours before it.
      { nowMs: NOW, autoRecheck: false },
    ).find((c) => c.key === 'quic');
    expect(agedPositiveNoUdp?.aged).toEqual({ value: true, atMs: NOW - AGED_AT });
    expect(agedPositiveNoUdp?.hint).toContain('the two checks disagree');
    expect(agedPositiveNoUdp?.hint).toContain('Last checked 9 hours ago.');
    expect(agedPositiveNoUdp?.hint).not.toBe(
      'No UDP — HTTP/3 cannot work here; it falls back to HTTP/2.',
    );

    // …and the NEGATIVE half, which is the part of the old rule that stands.
    // MUTATION: drop `agedQuic.value` from `agedStandsIn` in proxyCapabilities and
    // this block reds — a four-hour-old "no HTTP/3" replaces a current one.
    const agedNegative = agedReadingsFor(
      deriveProbeViewState(
        { p: entry(AGED_AT, { quicProbe: false, quicMeasured: 'h2-only' }) },
        NOW,
      ).aged,
      'p',
    );
    const noUdp = proxyCapabilities(
      { ...OK, udp_associate: false },
      undefined,
      undefined,
      agedNegative,
    ).find((c) => c.key === 'quic');
    expect(noUdp?.aged).toBeUndefined();
    expect(noUdp?.ok).toBe(false);
    expect(noUdp?.inferred).toBe(false);
    expect(noUdp?.hint).toBe('No UDP — HTTP/3 cannot work here; it falls back to HTTP/2.');
    // And nothing aged beside a proxy that is down.
    expect(proxyCapabilities(DOWN, undefined, undefined, aged)[1]?.aged).toBeUndefined();
  });

  it('between two aged QUIC readings the LATER measurement is the one shown, whichever kind it is; a tie keeps the live one', () => {
    const live = { value: 'h2-only' as const, atMs: NOW - 3 * HOUR };
    expect(
      agedQuicReading({ quicMeasured: live, quicProbe: { value: true, atMs: NOW - HOUR } }),
    ).toEqual({ value: true, atMs: NOW - HOUR });
    expect(
      agedQuicReading({ quicMeasured: live, quicProbe: { value: true, atMs: NOW - 5 * HOUR } }),
    ).toEqual({ value: false, atMs: NOW - 3 * HOUR });
    expect(
      agedQuicReading({ quicMeasured: live, quicProbe: { value: true, atMs: NOW - 3 * HOUR } }),
    ).toEqual({ value: false, atMs: NOW - 3 * HOUR });
    expect(agedQuicReading(undefined)).toBeUndefined();
  });

  it('CRITICAL the OS chip shows the last reading muted with its age and in the NEUTRAL tone — a reading that was a green match nine hours ago supports no claim about the exit now. MUTATION: in agedOsFingerprintVerdict drop `tone: "unknown"` and this reds', () => {
    const { container } = render(
      <ProxyOsChip fingerprint={undefined} aged={aged?.osFingerprint} nowMs={NOW} autoRecheck />,
    );
    const chip = container.querySelector('[data-component="proxy-os-fingerprint"]');
    expect(chip?.getAttribute('data-os-tone')).toBe('unknown');
    expect(chip?.getAttribute('data-ok')).toBe('aged');
    expect(chip?.textContent).toBe('✓iOS/macOS · 9 h ago');
    expect(chip?.className).not.toContain('status-ready');
    expect(chip?.getAttribute('title')).toMatch(
      /^Last checked 9 hours ago\. It will be rechecked automatically\. What it found then: /,
    );
  });

  it('a CURRENT OS reading outranks the aged one, and a row the app cannot recheck by itself names the button instead of promising', () => {
    const current = render(
      <ProxyOsChip fingerprint={{ ...FP, at: NOW - MIN }} aged={aged?.osFingerprint} nowMs={NOW} />,
    );
    const chip = current.container.querySelector('[data-component="proxy-os-fingerprint"]');
    expect(chip?.getAttribute('data-os-tone')).toBe('match');
    expect(chip?.hasAttribute('data-ok')).toBe(false);

    const manual = render(
      <ProxyOsChip
        fingerprint={undefined}
        aged={aged?.osFingerprint}
        nowMs={NOW}
        autoRecheck={false}
      />,
    );
    expect(
      manual.container
        .querySelector('[data-component="proxy-os-fingerprint"]')
        ?.getAttribute('title'),
    ).toContain('Last checked 9 hours ago. Run Test to check it again.');
  });

  // ⛔ PINNED AGAINST LITERALS RECORDED FROM THE COMMIT BEFORE THE AGED STATE EXISTED
  // (HEAD's own components rendered under this same jsdom, 2026-09-17). This arm used
  // to compare `<Chips />` with `<Chips aged={undefined} />` — the same input under a
  // default parameter, equal under ANY implementation, so it proved nothing.
  // MUTATION: make the non-aged branch emit `data-ok="aged"`, the dashed class, or a
  // `data-aged-value` attribute, and every literal below reds.
  const chip = (
    title: string,
    key: string,
    ok: boolean,
    inferred: boolean,
    size: string,
    tone: string,
    glyph: string,
    label: string,
  ): string =>
    `<span title="${title}" data-capability="${key}" data-ok="${String(ok)}" data-inferred="${String(inferred)}" class="inline-flex items-center gap-0.5 rounded-sm px-1 py-px ${size} ${tone}"><span aria-hidden="true">${glyph}</span>${label}</span>`;
  const row = (...chips: string[]): string =>
    `<div class="flex flex-wrap items-center gap-1" data-component="proxy-capabilities">${chips.join('')}</div>`;
  const GREEN = 'bg-status-ready/15 text-status-ready';
  const MUTED = 'bg-surface-inset text-ink-muted';
  const WEBRTC = 'UDP works — WebRTC calls and media stream through this exit.';
  const HTTP2 = 'Connected and logged in — HTTP/2 works through this exit.';

  it('CRITICAL a caller that passes NO aged prop — the profile card — renders byte for byte what it rendered before the aged state existed: the inferred chip, a current relay verdict, and the no-UDP negative', () => {
    expect(render(<ProxyCapabilityChips result={OK} />).container.innerHTML).toBe(
      row(
        chip(WEBRTC, 'webrtc', true, false, 'text-[10px]', GREEN, '✓', 'WebRTC'),
        chip(
          'UDP works, so HTTP/3 is likely — not yet tested. Run Test or a session to confirm.',
          'quic',
          true,
          true,
          'text-[10px]',
          'bg-surface-inset text-ink-secondary',
          '~',
          'QUIC',
        ),
        chip(HTTP2, 'http2', true, false, 'text-[10px]', GREEN, '✓', 'HTTP/2'),
      ),
    );
    expect(render(<ProxyCapabilityChips result={OK} quicProbe={true} />).container.innerHTML).toBe(
      row(
        chip(WEBRTC, 'webrtc', true, false, 'text-[10px]', GREEN, '✓', 'WebRTC'),
        chip(
          'This proxy carries QUIC — HTTP/3 works through this exit.',
          'quic',
          true,
          false,
          'text-[10px]',
          GREEN,
          '✓',
          'QUIC',
        ),
        chip(HTTP2, 'http2', true, false, 'text-[10px]', GREEN, '✓', 'HTTP/2'),
      ),
    );
    expect(
      render(<ProxyCapabilityChips result={{ ...OK, udp_associate: false }} size="xs" />).container
        .innerHTML,
    ).toBe(
      row(
        chip(
          'No UDP — WebRTC falls back to a slower, more detectable path.',
          'webrtc',
          false,
          false,
          'text-[9px]',
          MUTED,
          '⤵',
          'WebRTC',
        ),
        chip(
          'No UDP — HTTP/3 cannot work here; it falls back to HTTP/2.',
          'quic',
          false,
          false,
          'text-[9px]',
          MUTED,
          '⤵',
          'QUIC',
        ),
        chip(HTTP2, 'http2', true, false, 'text-[9px]', GREEN, '✓', 'HTTP/2'),
      ),
    );
  });

  it('CRITICAL …and the OS chip likewise: a current reading and "not measured" are the markup they were — no `data-ok`, no dashed outline, no age beside the label', () => {
    // These two literals are the markup HEAD rendered, byte for byte. For a few
    // hours they were not: `whitespace-nowrap` was added to the OS chip in EVERY
    // tone, this arm went red, and the literals were edited to match — which made
    // the arm pass while quietly turning "unchanged from HEAD" into "unchanged
    // from this morning". Only the AGED chip ever wrapped, so the class now lives
    // on that branch alone and these are HEAD's strings again.
    expect(
      render(<ProxyOsChip fingerprint={{ ...FP, at: NOW - 10 * MIN }} nowMs={NOW} />).container
        .innerHTML,
    ).toBe(
      `<span title="Your proxy presents as iOS/macOS to websites (high confidence) — it matches the iOS device behind it. Measured by Driftstack, 10 minutes ago." data-component="proxy-os-fingerprint" data-os-tone="match" class="inline-flex items-center gap-0.5 rounded-sm px-1 py-px text-[10px] ${GREEN}"><span aria-hidden="true">✓</span>iOS/macOS</span>`,
    );
    expect(render(<ProxyOsChip fingerprint={undefined} nowMs={NOW} />).container.innerHTML).toBe(
      `<span title="OS not measured yet. Run Test on this proxy." data-component="proxy-os-fingerprint" data-os-tone="unknown" class="inline-flex items-center gap-0.5 rounded-sm px-1 py-px text-[10px] ${MUTED}"><span aria-hidden="true">—</span>OS</span>`,
    );
  });

  it('⛔ a caller that passes `aged` and says NOTHING about rechecking names the button — the default never promises a recheck the planner may never make', () => {
    const quic = render(<ProxyCapabilityChips result={OK} aged={aged} nowMs={NOW} />);
    expect(
      quic.container.querySelector('[data-capability="quic"]')?.getAttribute('title'),
    ).toContain('Run Test to check it again.');
    const os = render(
      <ProxyOsChip fingerprint={undefined} aged={aged?.osFingerprint} nowMs={NOW} />,
    );
    expect(
      os.container.querySelector('[data-component="proxy-os-fingerprint"]')?.getAttribute('title'),
    ).toContain('Run Test to check it again.');
    expect(os.container.innerHTML).not.toContain('rechecked automatically');
    expect(quic.container.innerHTML).not.toContain('rechecked automatically');
  });
});
