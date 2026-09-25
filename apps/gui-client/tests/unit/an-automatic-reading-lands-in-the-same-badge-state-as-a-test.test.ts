// Owner item 9 (2026-09-24, verbatim): "The UDP, QUIC, Apple badges not always
// show currently still at auto proxy state detection. Has not been measured, but
// QUIC did, or the other way around, it's very confusing, they should all always
// show accurate stats."
//
// ROOT CAUSE (the cache half). A proxy this Mac has never tested itself — a
// second Mac, a reinstall, a proxy created by a launch — gets its readings from
// the SERVER: the account-list adoption (`seedServerOsFingerprint`,
// `seedServerCapabilityReadings`) and the automatic capability check
// (`persistAutomaticServerProbe` → `ensureServerSeededEntry`). All three write
// onto a `serverSeeded` entry. `deriveProbeViewState` then let the OS reading of
// a seeded entry through (it has no red "unreachable" pill to sit beside) and
// held back its QUIC and UDP readings behind `isProxyUsable(c.result)` — which a
// seeded entry's placeholder result can never pass. So the SAME automatic check
// that measured all three showed "✓ Apple" beside an untested QUIC and UDP:
// "has not been measured, but QUIC did" — exactly.
//
// And the live HTTP/3 a running session observed (`recordLiveH3Observations` →
// `saveObservedQuic`) was DROPPED when the proxy had no cache entry at all, so
// the Simulator said "HTTP/3 ✓ live" while the card and the grid said nothing.
//
// Pinned: a seeded entry shows ALL its readings, fresh and aged, under the same
// freshness rule; and a live observation lands on a proxy with no entry. The
// seeded entry still asserts nothing about reachability (no test result, no
// "Tested" stamp) — the one thing the seed mark exists to keep.

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
  deriveProbeViewState,
  loadProbeCache,
  saveObservedQuic,
  SERVER_SEEDED_PLACEHOLDER_RESULT,
  type CachedProbe,
} from '../../src/lib/proxy-probe-cache';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const APPLE = {
  os: 'macos-or-ios' as const,
  confidence: 'high' as const,
  reason: 'initial TTL 64, Darwin option layout',
  observedVia: 'exit_ip' as const,
  webPortVantage: true,
};

/** A seeded entry: the server measured all three, this Mac never tested it. */
const seeded = (ageMs: number): CachedProbe => ({
  result: SERVER_SEEDED_PLACEHOLDER_RESULT,
  at: NOW - ageMs,
  serverSeeded: true,
  osFingerprint: { ...APPLE, at: NOW - ageMs },
  quicMeasured: 'h3',
  quicMeasuredAt: NOW - ageMs,
  quicProbe: true,
  quicProbeAt: NOW - ageMs,
  udpProbe: true,
  udpProbeAt: NOW - ageMs,
});

beforeEach(() => {
  stores.clear();
});

describe('owner item 9 — a reading the automatic check took shows on every badge it measured', () => {
  it('CRITICAL a server-seeded entry shows its OS AND its QUIC AND its UDP reading — never Apple alone', () => {
    const view = deriveProbeViewState({ s: seeded(10 * MIN) }, NOW);
    expect(view.osFingerprints.s?.os).toBe('macos-or-ios');
    expect(view.quicProbe.s).toBe(true);
    expect(view.udpProbe.s).toBe(true);
    // The live verdict is fresh for 30 min; 10 min old it is current.
    expect(view.quicMeasured.s).toBe('h3');
    // …and it still asserts nothing about reachability.
    expect(view.testResults).toEqual({});
    expect(view.testedAt).toEqual({});
    expect(view.serverLatency).toEqual({});
  });

  it('an OLD seeded reading ages exactly as the OS one beside it does: all three in `aged`, none in the present tense', () => {
    const view = deriveProbeViewState({ s: seeded(9 * HOUR) }, NOW);
    expect(view.aged.osFingerprints.s).toBeDefined();
    expect(view.aged.quicProbe.s?.value).toBe(true);
    expect(view.aged.udpProbe.s?.value).toBe(true);
    expect(view.aged.quicMeasured.s?.value).toBe('h3');
    expect(view.quicProbe.s).toBeUndefined();
    expect(view.udpProbe.s).toBeUndefined();
  });

  it('VACUITY: a row a Test found DOWN still shows no Driftstack reading at all (the gate the seed exception must not open)', () => {
    const down: CachedProbe = {
      ...seeded(10 * MIN),
      serverSeeded: undefined,
      result: { ...SERVER_SEEDED_PLACEHOLDER_RESULT, message: 'not reachable' },
    };
    delete down.serverSeeded;
    const view = deriveProbeViewState({ d: down }, NOW);
    expect(view.osFingerprints).toEqual({});
    expect(view.quicProbe).toEqual({});
    expect(view.udpProbe).toEqual({});
    expect(view.quicMeasured).toEqual({});
  });

  it('CRITICAL a live session’s HTTP/3 lands on a proxy this Mac has no entry for (it used to be dropped)', async () => {
    expect(await loadProbeCache()).toEqual({});
    const cache = await saveObservedQuic('fresh-proxy', 'h3', NOW - MIN);
    expect(cache['fresh-proxy']?.quicMeasured).toBe('h3');
    expect(cache['fresh-proxy']?.serverSeeded).toBe(true);
    const view = deriveProbeViewState(await loadProbeCache(), NOW);
    expect(view.quicMeasured['fresh-proxy']).toBe('h3');
    expect(view.testResults['fresh-proxy']).toBeUndefined();
  });
});
