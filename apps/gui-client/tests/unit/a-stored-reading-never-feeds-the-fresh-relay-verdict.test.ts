// 2026-09-17 — the server now STORES what a proxy Test measured about QUIC and UDP
// and serves it back, on the account list and on every /test reply, as
// `quic_probe` / `quic_probe_at` / `udp_probe` / `udp_probe_at`.
//
// ⛔ THE NAME COLLISION. This client's parsed /test result ALREADY has a field
// called `quic_probe`, and it means the opposite: THIS test's fresh relay reading,
// derived from the wire's `quic_ok`, which `serverProbeOutcome` stamps with the
// reply time and every chip renders in the present tense. The wire key of the same
// name is a reading that may be weeks old, or null. One careless
// `...body` — or one "helpful" `body.quic_probe ?? body.quic_ok` — and last
// month's reading is a green `✓ QUIC` "measured just now".
//
// So the stored readings are RENAMED at the wire boundary (`stored_quic_probe` …)
// and travel to the cache on their own path, where they are adopted under a
// newer-wins rule by their OWN date. This file pins the boundary, and the adoption.

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
      this.map().set(key, structuredClone(value));
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

import { listProxies, testAccountProxy } from '../../src/lib/account-proxies';
import type { ProxyTestResult } from '../../src/lib/proxies';
import {
  AGED_READING_MAX_MS,
  deriveProbeViewState,
  loadProbeCache,
  saveEndpointResult,
  saveFleetFailure,
  saveProbeResult,
  saveServerProbeResult,
} from '../../src/lib/proxy-probe-cache';
import {
  adoptListCapabilityReadings,
  datedStoredReading,
  persistServerProbe,
  serverProbeOutcome,
  syncListExitObserved,
  type ListCapabilityRow,
  type ListExitProxyLike,
} from '../../src/lib/proxy-server-test';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number): string => new Date(ms).toISOString();

const OK: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0,
  latency_ms: 40,
  message: 'ok',
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const SOCKS: ListExitProxyLike = {
  id: 'p1',
  serverId: 'aprx_1',
  scheme: 'socks5',
  host: 'proxy.example.com',
  port: 1080,
};

const row = (over: Partial<ListCapabilityRow> = {}): ListCapabilityRow => ({
  id: 'aprx_1',
  ...over,
});

beforeEach(() => {
  stores.clear();
  nextResponse = () => new Response('{}', { status: 500 });
});

describe('⛔ the wire’s `quic_probe` is the STORED reading and never the fresh one', () => {
  it('CRITICAL a /test reply whose own QUIC leg measured NOTHING but which carries a stored `quic_probe: true` yields NO fresh relay verdict — the stored reading lands under its own name, with the SERVER’s date. MUTATION: in testAccountProxy (account-proxies.ts) change `optBool(body.quic_ok)` to `optBool(body.quic_ok ?? body.quic_probe)` and the first three expectations red', async () => {
    const storedAt = iso(NOW - 20 * 24 * HOUR); // three weeks old
    nextResponse = () =>
      json({
        ok: true,
        latency_ms: 30,
        measured_from: 'fleet',
        node_id: 'n1',
        // no `quic_ok`: this test's leg did not reach a verdict
        quic_probe: true,
        quic_probe_at: storedAt,
        udp_probe: false,
        udp_probe_at: storedAt,
      });
    const test = await testAccountProxy('https://api.example', 'k', 'aprx_1', { vantage: 'fleet' });
    if (!test.ok) throw new Error('expected an ok result');
    expect(test.quic_probe, 'the FRESH field is fed by quic_ok and nothing else').toBeUndefined();
    expect(test.udp_associate).toBeUndefined();
    const outcome = serverProbeOutcome(test, NOW);
    if (outcome.kind !== 'ok') throw new Error('expected an ok outcome');
    expect(outcome.quicProbe, 'so no present-tense verdict is minted').toBeUndefined();
    // …and the stored reading is carried, renamed, dated by the server.
    expect(test.stored_quic_probe).toBe(true);
    expect(test.stored_quic_probe_at).toBe(storedAt);
    expect(outcome.storedQuicProbe).toEqual({ value: true, at: Date.parse(storedAt) });
    expect(outcome.storedUdpProbe).toEqual({ value: false, at: Date.parse(storedAt) });
  });

  it('CRITICAL when BOTH are on the reply and they DISAGREE, the fresh verdict is this test’s `quic_ok` — a stored `true` cannot overrule a leg that just measured `false`', async () => {
    nextResponse = () =>
      json({
        ok: true,
        latency_ms: 30,
        measured_from: 'fleet',
        quic_ok: false,
        quic_probe: true,
        quic_probe_at: iso(NOW - HOUR),
      });
    const test = await testAccountProxy('https://api.example', 'k', 'aprx_1', { vantage: 'fleet' });
    if (!test.ok) throw new Error('expected an ok result');
    expect(test.quic_probe).toBe(false);
    expect(test.stored_quic_probe).toBe(true);
    const outcome = serverProbeOutcome(test, NOW);
    expect(outcome.kind === 'ok' && outcome.quicProbe).toBe(false);
  });

  it('CRITICAL the LIST strips the raw wire keys and re-admits them renamed — a row object never carries a `quic_probe` a spread could hand to a test result. MUTATION: spread `...r` instead of `...rest` in listProxies and the `not.toHaveProperty` arms red', async () => {
    nextResponse = () =>
      json({
        data: [
          {
            id: 'aprx_1',
            quic_measured: 'h3',
            quic_measured_at: iso(NOW - HOUR),
            quic_probe: false,
            quic_probe_at: iso(NOW - 2 * HOUR),
            udp_probe: true,
            udp_probe_at: iso(NOW - 3 * HOUR),
          },
        ],
      });
    const [r] = await listProxies('https://api.example', 'k');
    expect(r).not.toHaveProperty('quic_probe');
    expect(r).not.toHaveProperty('quic_probe_at');
    expect(r).not.toHaveProperty('udp_probe');
    expect(r).not.toHaveProperty('udp_probe_at');
    expect(r?.stored_quic_probe).toBe(false);
    expect(r?.stored_quic_probe_at).toBe(iso(NOW - 2 * HOUR));
    expect(r?.stored_udp_probe).toBe(true);
    expect(r?.quic_measured).toBe('h3');
  });

  it('a stored value NEVER travels without its date, and a value outside its type is "the server holds none" — never coerced', async () => {
    nextResponse = () =>
      json({
        data: [
          { id: 'undated', quic_probe: true, quic_probe_at: null, udp_probe: 'true' },
          { id: 'older-server' },
          { id: 'bad-quic', quic_measured: 'h4', quic_measured_at: 12 },
        ],
      });
    const [undated, older, bad] = await listProxies('https://api.example', 'k');
    expect(undated?.stored_quic_probe).toBeNull();
    expect(undated?.stored_quic_probe_at).toBeNull();
    expect(undated?.stored_udp_probe).toBeNull();
    // ABSENT stays absent: an older server says nothing, which is not "never measured".
    expect(older).not.toHaveProperty('stored_quic_probe');
    expect(older).not.toHaveProperty('stored_udp_probe');
    expect(bad?.quic_measured).toBeNull();
    expect(bad?.quic_measured_at).toBeNull();
  });
});

describe('the list sync adopts the server’s QUIC and UDP readings — newer wins, by the reading’s own date', () => {
  const full = (ageMs: number): ListCapabilityRow =>
    row({
      quic_measured: 'h3',
      quic_measured_at: iso(NOW - ageMs),
      stored_quic_probe: true,
      stored_quic_probe_at: iso(NOW - ageMs),
      stored_udp_probe: false,
      stored_udp_probe_at: iso(NOW - ageMs),
    });

  it('CRITICAL a reading taken on ANOTHER Mac reaches this one, dated by the server — current when it is, aged when it is not, and never re-dated by the adoption. `quic_measured` was parsed and read by nothing until this', async () => {
    await saveProbeResult('p1', OK, NOW - MIN);
    expect(await adoptListCapabilityReadings([full(10 * MIN)], [SOCKS], NOW)).toEqual(['p1']);
    let view = deriveProbeViewState(await loadProbeCache(), NOW);
    expect(view.quicMeasured.p1).toBe('h3');
    expect(view.quicProbe.p1).toBe(true);
    expect(view.udpProbe.p1).toBe(false);
    expect((await loadProbeCache()).p1?.quicProbeAt).toBe(NOW - 10 * MIN);

    stores.clear();
    await saveProbeResult('p1', OK, NOW - MIN);
    await adoptListCapabilityReadings([full(4 * HOUR)], [SOCKS], NOW);
    view = deriveProbeViewState(await loadProbeCache(), NOW);
    expect(view.quicProbe, 'four hours old is not a present-tense claim').toEqual({});
    expect(view.aged.quicProbe.p1).toEqual({ value: true, atMs: NOW - 4 * HOUR });
    expect(view.aged.udpProbe.p1).toEqual({ value: false, atMs: NOW - 4 * HOUR });
    expect(view.aged.quicMeasured.p1).toEqual({ value: 'h3', atMs: NOW - 4 * HOUR });
  });

  it('CRITICAL NEWER WINS: a Test run HERE minutes ago outranks the list’s older copy, a newer server reading replaces an older local one, and re-adopting the same reading writes nothing (a poll must not rewrite the store every tick). MUTATION: in serverCapabilityReadingsToAdopt replace `heldAt < incoming.at` with `true` and the first block reds', async () => {
    await saveProbeResult('p1', OK, NOW - HOUR);
    await saveServerProbeResult(
      'p1',
      { latencyMs: 20, measuredFrom: 'fleet', quicProbe: false, udpProbe: true },
      NOW - 5 * MIN,
    );
    // The server's copy is OLDER and says the opposite: adopts NOTHING — not even
    // its live `h3`, which this Mac did not hold: it is older than the relay `false`
    // it contradicts, so it would be retired on arrival, and adopting it only to
    // delete it would rewrite the store on every poll to change nothing.
    const before = structuredClone(await loadProbeCache());
    expect(await adoptListCapabilityReadings([full(2 * HOUR)], [SOCKS], NOW)).toEqual([]);
    expect(await loadProbeCache()).toEqual(before);
    let entry = (await loadProbeCache()).p1;
    expect(entry?.quicProbe, 'the local, newer relay verdict stands').toBe(false);
    expect(entry?.quicProbeAt).toBe(NOW - 5 * MIN);
    expect(entry?.udpProbe).toBe(true);

    // A NEWER server reading does replace it…
    expect(await adoptListCapabilityReadings([full(MIN)], [SOCKS], NOW)).toEqual(['p1']);
    entry = (await loadProbeCache()).p1;
    expect(entry?.quicProbe).toBe(true);
    expect(entry?.quicProbeAt).toBe(NOW - MIN);
    expect(entry?.udpProbe).toBe(false);
    // …and the same list again is a no-op.
    expect(await adoptListCapabilityReadings([full(MIN)], [SOCKS], NOW)).toEqual([]);
  });

  it('CRITICAL an UNDATABLE server reading adopts NOTHING — it could only ever arrive looking current — and fields an older server does not send adopt nothing and invent no entry. MUTATION: in datedStoredReading return `{ value, at: Date.now() }` for an unparseable stamp and this reds', async () => {
    expect(
      await adoptListCapabilityReadings(
        [
          row({
            quic_measured: 'h3',
            quic_measured_at: null,
            stored_quic_probe: true,
            stored_quic_probe_at: 'not a date',
            stored_udp_probe: true,
            stored_udp_probe_at: null,
          }),
        ],
        [SOCKS],
        NOW,
      ),
    ).toEqual([]);
    expect(await adoptListCapabilityReadings([row()], [SOCKS], NOW)).toEqual([]);
    expect(await loadProbeCache()).toEqual({});
    // The one rule both routes share, asked directly — the adoption above would
    // also refuse a reading re-dated to the wall clock for being outside ITS window
    // (NOW here is not the wall clock), which would let that mutation hide.
    expect(datedStoredReading(true, 'not a date')).toBeUndefined();
    expect(datedStoredReading(true, null)).toBeUndefined();
    expect(datedStoredReading(null, iso(NOW))).toBeUndefined();
    expect(datedStoredReading(false, iso(NOW))).toEqual({ value: false, at: NOW });
  });

  it('a reading past the aged cap leaves no trace, and a proxy that is not saved to the account is never looked at', async () => {
    expect(
      await adoptListCapabilityReadings([full(AGED_READING_MAX_MS + MIN)], [SOCKS], NOW),
    ).toEqual([]);
    const { serverId: _never, ...deviceOnly } = SOCKS;
    expect(await adoptListCapabilityReadings([full(MIN)], [deviceOnly], NOW)).toEqual([]);
    expect(await loadProbeCache()).toEqual({});
  });

  it('CRITICAL ⛔ never RESURRECTS: a check that found the proxy down dropped every Driftstack-measured field and stamped when; the server stores nothing on a failed test, so its row still carries the readings from BEFORE — and they must not come back beside the failure. MUTATION: delete the `exitSupersededAt` test in serverCapabilityReadingsToAdopt and this reds', async () => {
    await saveProbeResult('p1', OK, NOW - HOUR);
    await saveFleetFailure('p1', NOW - 10 * MIN, 'did not answer');
    expect(await adoptListCapabilityReadings([full(30 * MIN)], [SOCKS], NOW)).toEqual([]);
    expect((await loadProbeCache()).p1).not.toHaveProperty('quicProbe');
    // CONTROL — a reading taken AFTER the failure is evidence about the proxy now.
    expect(await adoptListCapabilityReadings([full(5 * MIN)], [SOCKS], NOW)).toEqual(['p1']);
  });

  it('the adoption rides the ONE list request the views already make', async () => {
    await saveProbeResult('p1', OK, NOW - MIN);
    nextResponse = () =>
      json({ data: [{ id: 'aprx_1', quic_probe: true, quic_probe_at: iso(NOW - MIN) }] });
    expect(await syncListExitObserved('https://api.example', 'k', [SOCKS], NOW)).toEqual(['p1']);
    expect(deriveProbeViewState(await loadProbeCache(), NOW).quicProbe.p1).toBe(true);
  });
});

describe('a /test reply’s stored readings are adopted only from a reply that measured neither leg', () => {
  const stored = { value: true, at: NOW - 2 * HOUR };

  it('CRITICAL a reply that did NOT come from a test Mac ran neither leg, so the stored reading is its only QUIC answer: adopted, dated by the SERVER (two hours old → aged), never by the reply', async () => {
    await saveProbeResult('p1', OK, NOW - MIN);
    await persistServerProbe('p1', {
      kind: 'ok',
      at: NOW,
      latencyMs: 25,
      vantage: { measuredFrom: 'control_plane' },
      storedQuicProbe: stored,
    });
    const entry = (await loadProbeCache()).p1;
    expect(entry?.quicProbe).toBe(true);
    expect(entry?.quicProbeAt, 'NOT the reply time').toBe(NOW - 2 * HOUR);
    const view = deriveProbeViewState(await loadProbeCache(), NOW);
    expect(view.quicProbe).toEqual({});
    expect(view.aged.quicProbe.p1).toEqual({ value: true, atMs: NOW - 2 * HOUR });
  });

  it('CRITICAL a reply from a test Mac that RAN the leg and reached no verdict retires the old one — and the stored copy the reply carries must not put it back seconds later. MUTATION: in saveServerProbeResult replace `{ quicProbeRetiredAt: at }` with `{}` and the verdict reappears', async () => {
    await saveProbeResult('p1', OK, NOW - HOUR);
    await saveServerProbeResult(
      'p1',
      { latencyMs: 20, measuredFrom: 'fleet', quicProbe: true },
      NOW - 3 * HOUR,
    );
    await persistServerProbe('p1', {
      kind: 'ok',
      at: NOW,
      latencyMs: 25,
      vantage: { measuredFrom: 'fleet', nodeId: 'n1' },
      storedQuicProbe: stored,
    });
    expect((await loadProbeCache()).p1).not.toHaveProperty('quicProbe');
    expect((await loadProbeCache()).p1?.quicProbeRetiredAt).toBe(NOW);
  });

  it('CONTROL — a test-Mac reply whose QUIC leg was SKIPPED retired nothing, so the stored reading is still its only QUIC answer and is adopted (the vantage alone never refuses it)', async () => {
    await saveProbeResult('p1', OK, NOW - HOUR);
    await persistServerProbe('p1', {
      kind: 'ok',
      at: NOW,
      latencyMs: 25,
      vantage: { measuredFrom: 'fleet', nodeId: 'n1' },
      quicLegSkipped: true,
      storedQuicProbe: stored,
    });
    const entry = (await loadProbeCache()).p1;
    expect(entry?.quicProbe).toBe(stored.value);
    expect(entry?.quicProbeAt).toBe(stored.at);
    expect(entry).not.toHaveProperty('quicProbeRetiredAt');
  });
});

describe('⛔ the LIST SYNC never puts back a reading a newer local check retired', () => {
  const stale = (ageMs: number): ListCapabilityRow =>
    row({ stored_quic_probe: true, stored_quic_probe_at: iso(NOW - ageMs) });

  it('CRITICAL a Test measures `true`; ten minutes later a Test RUNS the leg and reaches no verdict, which removes it; the server keeps its old copy (it writes nothing for such a leg) — and the next list sync must adopt NOTHING: neither a current green chip (the stored reading is under thirty minutes old) nor an aged one. MEASURED before the stamp: `{ p1: true }` in the fresh map, seconds after the check that retired it. MUTATION: drop `legRetiredAt` from `retiredAt` in serverCapabilityReadingsToAdopt and this reds', async () => {
    await saveProbeResult('p1', OK, NOW - HOUR);
    await saveServerProbeResult(
      'p1',
      { latencyMs: 20, measuredFrom: 'fleet', quicProbe: true },
      NOW - 10 * MIN,
    );
    await saveServerProbeResult('p1', { latencyMs: 21, measuredFrom: 'fleet' }, NOW);
    expect((await loadProbeCache()).p1).not.toHaveProperty('quicProbe');
    expect(await adoptListCapabilityReadings([stale(10 * MIN)], [SOCKS], NOW + MIN)).toEqual([]);
    const view = deriveProbeViewState(await loadProbeCache(), NOW + MIN);
    expect(view.quicProbe).toEqual({});
    expect(view.aged.quicProbe).toEqual({});
  });

  it('…the stamp survives the writers that REBUILD the entry (a native re-test; a reload) — lost there, the retired verdict returns on the first sync after', async () => {
    await saveProbeResult('p1', OK, NOW - HOUR);
    await saveServerProbeResult('p1', { latencyMs: 21, measuredFrom: 'fleet' }, NOW);
    await saveProbeResult('p1', OK, NOW + MIN);
    expect((await loadProbeCache()).p1?.quicProbeRetiredAt).toBe(NOW);
    expect(await adoptListCapabilityReadings([stale(10 * MIN)], [SOCKS], NOW + 2 * MIN)).toEqual(
      [],
    );
  });

  it('CONTROL — a reading the server took AFTER the retirement is evidence about the proxy now and IS adopted; and a later MEASURED leg drops the stamp', async () => {
    await saveProbeResult('p1', OK, NOW - HOUR);
    await saveServerProbeResult('p1', { latencyMs: 21, measuredFrom: 'fleet' }, NOW - 20 * MIN);
    expect(await adoptListCapabilityReadings([stale(5 * MIN)], [SOCKS], NOW)).toEqual(['p1']);
    expect(deriveProbeViewState(await loadProbeCache(), NOW).quicProbe).toEqual({ p1: true });
    await saveServerProbeResult(
      'p1',
      { latencyMs: 22, measuredFrom: 'fleet', quicProbe: false },
      NOW,
    );
    expect((await loadProbeCache()).p1).not.toHaveProperty('quicProbeRetiredAt');
  });

  it('CONTROL — a fallback, or a SKIPPED leg, retired nothing and stamps nothing', async () => {
    await saveProbeResult('p1', OK, NOW - HOUR);
    await saveServerProbeResult('p1', { latencyMs: 21, measuredFrom: 'control_plane' }, NOW);
    await saveServerProbeResult(
      'p1',
      { latencyMs: 21, measuredFrom: 'fleet', quicSkipped: true },
      NOW,
    );
    expect((await loadProbeCache()).p1).not.toHaveProperty('quicProbeRetiredAt');
  });

  it('CRITICAL an endpoint found at a DIFFERENT address drops every Driftstack-measured field — and the list sync must not put the predecessor address’s readings back beside the new one. MUTATION: in saveEndpointResult set `addressChanged` to false and this reds', async () => {
    const VPN: ListExitProxyLike = { ...SOCKS, id: 'v1', scheme: 'wireguard' };
    const all = row({
      quic_measured: 'h3',
      quic_measured_at: iso(NOW - 10 * MIN),
      stored_quic_probe: true,
      stored_quic_probe_at: iso(NOW - 10 * MIN),
      stored_udp_probe: true,
      stored_udp_probe_at: iso(NOW - 10 * MIN),
    });
    await saveEndpointResult(
      'v1',
      { resolved: true, ip: '198.51.100.1', message: 'ok' },
      NOW - HOUR,
    );
    await saveEndpointResult('v1', { resolved: true, ip: '198.51.100.2', message: 'ok' }, NOW);
    expect((await loadProbeCache()).v1?.serverReadingsRetiredAt).toBe(NOW);
    expect(await adoptListCapabilityReadings([all], [VPN], NOW + MIN)).toEqual([]);
    // The stamp outlives the next pre-flight of the SAME (new) address…
    await saveEndpointResult(
      'v1',
      { resolved: true, ip: '198.51.100.2', message: 'ok' },
      NOW + MIN,
    );
    expect((await loadProbeCache()).v1?.serverReadingsRetiredAt).toBe(NOW);
    // …and a reading taken at the new address, after the change, is adopted.
    const after = row({ stored_udp_probe: true, stored_udp_probe_at: iso(NOW + 2 * MIN) });
    expect(await adoptListCapabilityReadings([after], [VPN], NOW + 3 * MIN)).toEqual(['v1']);
  });

  it('CONTROL — the SAME address mints no stamp and the readings are adopted as ever', async () => {
    const VPN: ListExitProxyLike = { ...SOCKS, id: 'v1', scheme: 'wireguard' };
    await saveEndpointResult(
      'v1',
      { resolved: true, ip: '198.51.100.1', message: 'ok' },
      NOW - HOUR,
    );
    await saveEndpointResult('v1', { resolved: true, ip: '198.51.100.1', message: 'ok' }, NOW);
    expect((await loadProbeCache()).v1).not.toHaveProperty('serverReadingsRetiredAt');
    const held = row({ stored_udp_probe: true, stored_udp_probe_at: iso(NOW - 10 * MIN) });
    expect(await adoptListCapabilityReadings([held], [VPN], NOW + MIN)).toEqual(['v1']);
  });
});
