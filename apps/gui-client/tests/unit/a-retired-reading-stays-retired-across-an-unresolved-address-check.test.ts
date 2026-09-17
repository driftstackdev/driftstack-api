// 2026-09-17 — one failed DNS lookup un-retired a reading.
//
// A reading the account holds is refused by the list adoption when a local stamp
// says it was retired: `exitSupersededAt` (a check found the tunnel down),
// `serverReadingsRetiredAt` (the endpoint moved), `quicProbeRetiredAt` (the relay
// leg reached no verdict). `saveEndpointResult` — the address check that runs
// before EVERY check and in every background sweep — carried those stamps only
// across a pre-flight that resolved to the SAME ip, and minted the address stamp
// only when both sides of the comparison were resolved.
//
// MEASURED, both holes:
//   (1) VPN row tested ok at T0 (the account stores its readings). T1: the full
//       test fails → `exitSupersededAt = T1`. T2: a background address check fails
//       DNS once → the entry is rebuilt as the bare verdict with NO stamp. T3: it
//       resolves again; the prior verdict was unresolved, so nothing is carried
//       and nothing minted. The next list sync adopts the T0 readings the T1
//       failure had contradicted.
//   (2) A → unresolved → B: neither step names two addresses to compare, so the
//       move was never seen and the readings taken through A came back beside B.
//       (The previous repair documented this one as a known limit.)
//
// Now the stamps cross every pre-flight, and any pre-flight that cannot CONFIRM
// the address is the same mints `serverReadingsRetiredAt`.
//
// ⛔ PRODUCTION LINES WHOSE REVERSION REDS — see each arm's MUTATION note.

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

import {
  __resetMaterialEditsForTests,
  clearFleetFailure,
  loadProbeCache,
  saveEndpointResult,
  saveFleetFailure,
  saveOsFingerprint,
  saveServerProbeResult,
  seedServerOsFingerprint,
  type CachedEndpointVerdict,
} from '../../src/lib/proxy-probe-cache';
import {
  adoptListCapabilityReadings,
  adoptListExitObserved,
  adoptListOsFingerprint,
  LIST_TUNNEL_DOWN_REASON,
  type ListCapabilityRow,
  type ListExitProxyLike,
  type ListExitRow,
  type ListOsRow,
} from '../../src/lib/proxy-server-test';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const T1 = T0 + 10 * MIN; // the full test fails
const T2 = T0 + 20 * MIN; // a background address check fails DNS once
const T3 = T0 + 25 * MIN; // …and resolves again
const SYNC = T0 + 26 * MIN; // the list sync that follows the refresh
const iso = (ms: number): string => new Date(ms).toISOString();

const A: CachedEndpointVerdict = { resolved: true, ip: '198.51.100.1', message: 'ok' };
const B: CachedEndpointVerdict = { resolved: true, ip: '198.51.100.2', message: 'ok' };
const UNRESOLVED: CachedEndpointVerdict = {
  resolved: false,
  ip: '',
  message: 'The endpoint host could not be resolved.',
};

const VPN: ListExitProxyLike = {
  id: 'v1',
  serverId: 'aprx_v1',
  scheme: 'wireguard',
  host: 'vpn.example.com',
  port: 51820,
};

/** What the account stored at T0 and still holds — it stores nothing on a failed
 *  test, so these outlive every failure until the next success. */
const accountAtT0: ListCapabilityRow = {
  id: 'aprx_v1',
  stored_quic_probe: true,
  stored_quic_probe_at: iso(T0),
  stored_udp_probe: true,
  stored_udp_probe_at: iso(T0),
};

const READING = {
  os: 'macos-or-ios' as const,
  confidence: 'high' as const,
  reason: 'Based on how this proxy responds to a network connection.',
};
/** …and the OS reading it took in the same test. */
const accountOsAt = (ms: number): ListOsRow => ({
  id: 'aprx_v1',
  os_fingerprint: READING,
  os_fingerprint_at: iso(ms),
});

/** The T0 test as this Mac holds it: a resolved address check, then the reply. */
async function testedOkAtT0(): Promise<void> {
  await saveEndpointResult('v1', A, T0);
  await saveServerProbeResult(
    'v1',
    { latencyMs: 30, measuredFrom: 'fleet', nodeId: 'n1', quicProbe: true, udpProbe: true },
    T0,
  );
  await saveOsFingerprint('v1', READING, T0);
}

beforeEach(() => {
  stores.clear();
  __resetMaterialEditsForTests();
});

describe('⛔ a retired reading stays retired across an address check that could not resolve', () => {
  it('CRITICAL resolved A → (T1: tunnel found DOWN) → unresolved → resolved A: the list’s T0 readings are REFUSED — the failure’s stamp outlives the failed lookup. MUTATION: in saveEndpointResult drop `exitSupersededAt` from `kept` AND set `unconfirmed` to false and this reds (either stamp alone refuses, which is the point of having both — each is mutated alone in the two arms below)', async () => {
    await testedOkAtT0();
    await saveEndpointResult('v1', A, T1);
    await saveFleetFailure('v1', T1, 'could not connect');
    await saveEndpointResult('v1', UNRESOLVED, T2);
    await saveEndpointResult('v1', A, T3);

    expect(await adoptListCapabilityReadings([accountAtT0], [VPN], SYNC)).toEqual([]);
    const entry = (await loadProbeCache()).v1;
    expect(entry).not.toHaveProperty('quicProbe');
    expect(entry).not.toHaveProperty('udpProbe');
  });

  it('CRITICAL the failure’s stamp, by itself: `exitSupersededAt` is still T1 after the unresolved check AND after the one that resolves again — while its SENTENCE is gone (an unresolved address is an answer that moves "tunnel down" off the row). MUTATION: drop `exitSupersededAt` from `kept` in saveEndpointResult and the two stamp lines red', async () => {
    await testedOkAtT0();
    await saveFleetFailure('v1', T1, 'could not connect');
    await saveEndpointResult('v1', UNRESOLVED, T2);
    const unresolved = (await loadProbeCache()).v1;
    expect(unresolved?.exitSupersededAt).toBe(T1);
    expect(unresolved).not.toHaveProperty('fleetFailureReason');
    await saveEndpointResult('v1', A, T3);
    const again = (await loadProbeCache()).v1;
    expect(again?.exitSupersededAt).toBe(T1);
    expect(again).not.toHaveProperty('fleetFailureReason');
  });

  it('CRITICAL resolved A → unresolved → resolved B, with NO failure anywhere: the move is never observed as "A then B", and the T0 readings taken through A are still REFUSED beside B. MUTATION: restore `addressChanged` (stamp only when prior AND new are resolved with different ips) and this reds', async () => {
    await testedOkAtT0();
    await saveEndpointResult('v1', UNRESOLVED, T2);
    expect((await loadProbeCache()).v1?.serverReadingsRetiredAt).toBe(T2);
    await saveEndpointResult('v1', B, T3);
    expect((await loadProbeCache()).v1?.serverReadingsRetiredAt).toBe(T3);

    expect(await adoptListCapabilityReadings([accountAtT0], [VPN], SYNC)).toEqual([]);
    expect((await loadProbeCache()).v1).not.toHaveProperty('udpProbe');
  });

  it('…and resolved A → unresolved → resolved A with no failure refuses too: an address we could not confirm is the same is not the same address for the purpose of trusting an old reading', async () => {
    await testedOkAtT0();
    await saveEndpointResult('v1', UNRESOLVED, T2);
    await saveEndpointResult('v1', A, T3);
    expect(await adoptListCapabilityReadings([accountAtT0], [VPN], SYNC)).toEqual([]);
  });

  it('the stamp never REWINDS: a later unresolved check under a clock that moved back keeps the newer stamp', async () => {
    await testedOkAtT0();
    await saveEndpointResult('v1', UNRESOLVED, T3);
    await saveEndpointResult('v1', UNRESOLVED, T2);
    expect((await loadProbeCache()).v1?.serverReadingsRetiredAt).toBe(T3);
  });

  it('CONTROL — resolved A → resolved A, no gap and no failure: NO stamp is minted, every field the T0 reply wrote is carried, and a NEWER reading the account holds is still adopted. (Without this the arms above pass for a writer that refuses everything.)', async () => {
    await testedOkAtT0();
    await saveEndpointResult('v1', A, T3);
    const entry = (await loadProbeCache()).v1;
    expect(entry).not.toHaveProperty('serverReadingsRetiredAt');
    expect(entry).not.toHaveProperty('exitSupersededAt');
    expect(entry?.udpProbeAt).toBe(T0);

    const newer: ListCapabilityRow = {
      id: 'aprx_v1',
      stored_udp_probe: false,
      stored_udp_probe_at: iso(T0 + 5 * MIN),
    };
    expect(await adoptListCapabilityReadings([newer], [VPN], SYNC)).toEqual(['v1']);
    const after = (await loadProbeCache()).v1;
    expect(after?.udpProbe).toBe(false);
    expect(after?.udpProbeAt).toBe(T0 + 5 * MIN);
  });

  it('CONTROL — a reading taken AFTER the stamp is evidence about the endpoint as it is now, and is adopted: the stamp refuses the past, not the row', async () => {
    await testedOkAtT0();
    await saveEndpointResult('v1', UNRESOLVED, T2);
    await saveEndpointResult('v1', B, T3);
    const sinceThen: ListCapabilityRow = {
      id: 'aprx_v1',
      stored_udp_probe: true,
      stored_udp_probe_at: iso(T3 + 30_000),
    };
    expect(await adoptListCapabilityReadings([sinceThen], [VPN], SYNC)).toEqual(['v1']);
  });

  it('CONTROL ⛔ a FIRST address check retires nothing — resolved or not. A second Mac or a fresh install has no address check behind it, and a stamp minted there would refuse everything the account holds for exactly the row the adoption exists for. MUTATION: make `unconfirmed` `!sameAddress` (drop the `prior?.endpoint !== undefined` term) and both red', async () => {
    await saveEndpointResult('v1', A, T3);
    expect((await loadProbeCache()).v1).not.toHaveProperty('serverReadingsRetiredAt');
    expect(await adoptListCapabilityReadings([accountAtT0], [VPN], SYNC)).toEqual(['v1']);

    stores.clear();
    await saveEndpointResult('v1', UNRESOLVED, T3);
    expect((await loadProbeCache()).v1).not.toHaveProperty('serverReadingsRetiredAt');
  });
});

describe('⛔ …and the OS reading obeys the same two stamps — it was the one reading that still came back', () => {
  it('CRITICAL T0 ok → T1 tunnel found DOWN → unresolved → resolved A: the account’s T0 OS reading is REFUSED, by the adoption AND by the writer under its lock. MUTATION: make `refusesServerOsReading` ignore the stamps (return false after the rewind line) and both halves red', async () => {
    await testedOkAtT0();
    await saveFleetFailure('v1', T1, 'could not connect');
    await saveEndpointResult('v1', UNRESOLVED, T2);
    await saveEndpointResult('v1', A, T3);
    expect((await loadProbeCache()).v1, 'the failure dropped the reading').not.toHaveProperty(
      'osFingerprint',
    );

    expect(await adoptListOsFingerprint([accountOsAt(T0)], [VPN], SYNC)).toEqual([]);
    expect((await loadProbeCache()).v1).not.toHaveProperty('osFingerprint');
    // The writer alone — the pre-check above is only what keeps `written` honest.
    await seedServerOsFingerprint('v1', READING, T0);
    expect((await loadProbeCache()).v1).not.toHaveProperty('osFingerprint');
  });

  it('CRITICAL resolved A → unresolved → resolved B, no failure: the OS reading taken through A is refused beside B (`serverReadingsRetiredAt` alone — no failure stamp exists here)', async () => {
    await testedOkAtT0();
    await saveEndpointResult('v1', UNRESOLVED, T2);
    await saveEndpointResult('v1', B, T3);
    expect((await loadProbeCache()).v1).not.toHaveProperty('exitSupersededAt');
    expect(await adoptListOsFingerprint([accountOsAt(T0)], [VPN], SYNC)).toEqual([]);
    expect((await loadProbeCache()).v1).not.toHaveProperty('osFingerprint');
  });

  it('…and the failure’s stamp alone refuses it too: T1 failure, then a same-address check that mints nothing', async () => {
    await testedOkAtT0();
    await saveFleetFailure('v1', T1, 'could not connect');
    await saveEndpointResult('v1', A, T3);
    expect((await loadProbeCache()).v1).not.toHaveProperty('serverReadingsRetiredAt');
    expect(await adoptListOsFingerprint([accountOsAt(T0)], [VPN], SYNC)).toEqual([]);
  });

  it('CONTROL — an OS reading taken AFTER the stamps is adopted, and a row with NO stamp adopts as it always did. (Without this the arms above pass for an adoption that refuses everything.)', async () => {
    await testedOkAtT0();
    await saveFleetFailure('v1', T1, 'could not connect');
    await saveEndpointResult('v1', UNRESOLVED, T2);
    await saveEndpointResult('v1', A, T3);
    expect(await adoptListOsFingerprint([accountOsAt(T3 + 30_000)], [VPN], SYNC)).toEqual(['v1']);
    expect((await loadProbeCache()).v1?.osFingerprint?.at).toBe(T3 + 30_000);

    stores.clear();
    await saveEndpointResult('v1', A, T3); // a second Mac: one address check, no stamp
    expect(await adoptListOsFingerprint([accountOsAt(T0)], [VPN], SYNC)).toEqual(['v1']);
  });
});

describe('⛔ a FAILED test rebuilds the entry too — and must not lose the other stamps', () => {
  it('CRITICAL A → unresolved → B (stamped T3), a full test fails at T4, then the account’s clear lifts the failure: the readings taken through A are STILL refused beside B. The failure’s stamp hides the loss while it stands; it is the one stamp that gets removed. MUTATION: drop the `serverReadingsRetiredAt` carry in saveFleetFailure and this reds', async () => {
    const T4 = T3 + MIN;
    await testedOkAtT0();
    await saveEndpointResult('v1', UNRESOLVED, T2);
    await saveEndpointResult('v1', B, T3);
    await saveFleetFailure('v1', T4, 'could not connect');
    expect((await loadProbeCache()).v1?.serverReadingsRetiredAt).toBe(T3);
    await clearFleetFailure('v1');
    const entry = (await loadProbeCache()).v1;
    expect(entry).not.toHaveProperty('exitSupersededAt');
    expect(entry?.serverReadingsRetiredAt).toBe(T3);

    expect(await adoptListCapabilityReadings([accountAtT0], [VPN], T4 + MIN)).toEqual([]);
    expect(await adoptListOsFingerprint([accountOsAt(T0)], [VPN], T4 + MIN)).toEqual([]);
  });

  it('…and the relay leg’s own stamp survives the same rebuild', async () => {
    await testedOkAtT0();
    // A reply that RAN the relay leg and reached no verdict retires the one held.
    await saveServerProbeResult(
      'v1',
      { latencyMs: 30, measuredFrom: 'fleet', nodeId: 'n1', quicProbe: null },
      T1,
    );
    const retiredAt = (await loadProbeCache()).v1?.quicProbeRetiredAt;
    expect(retiredAt, 'fixture: the reply above really did retire the leg').toBe(T1);
    await saveFleetFailure('v1', T2, 'could not connect');
    expect((await loadProbeCache()).v1?.quicProbeRetiredAt).toBe(T1);
  });
});

describe('⛔ "tunnel down" comes back once the address resolves again — the stamp outliving its sentence must not silence it', () => {
  /** What the list says about this row: an exit a session saw at T0, and a full
   *  check that found the tunnel down — dated by the SERVER, a moment before this
   *  Mac stamped its own copy of the same failure at T1. */
  const listRow: ListExitRow = {
    id: 'aprx_v1',
    exit_observed: {
      ip: '203.0.113.9',
      country: 'NL',
      timezone: 'Europe/Amsterdam',
      observed_at: iso(T0),
    },
    exit_superseded_at: iso(T1 - 1_000),
  };

  it('CRITICAL T1 failure → unresolved (the sentence goes, by design) → resolved A: the next list sync writes the sentence back UNDER THE STAMP THIS MAC HOLDS, and still refuses the T0 exit. MUTATION: drop `sentenceMissing` from the condition in adoptListExitObserved and the row stays a plain resolved row for ever', async () => {
    await testedOkAtT0();
    await saveFleetFailure('v1', T1, 'could not connect');
    await saveEndpointResult('v1', UNRESOLVED, T2);

    // While the address is unresolved that answer owns the row: nothing is restored.
    expect(await adoptListExitObserved([listRow], [VPN], T2 + 1_000)).toEqual([]);
    expect((await loadProbeCache()).v1).not.toHaveProperty('fleetFailureReason');

    await saveEndpointResult('v1', A, T3);
    expect((await loadProbeCache()).v1).not.toHaveProperty('fleetFailureReason');
    expect(await adoptListExitObserved([listRow], [VPN], SYNC)).toEqual([]);
    const entry = (await loadProbeCache()).v1;
    expect(entry?.fleetFailureReason).toBe(LIST_TUNNEL_DOWN_REASON);
    expect(entry?.exitSupersededAt, 'this Mac’s own stamp, not rewound to the server’s').toBe(T1);
    expect(entry?.serverReadingsRetiredAt, 'and the restore kept the address stamp').toBe(T3);
    expect(entry).not.toHaveProperty('exitIp');
  });

  it('CONTROL — no restore when the list no longer says down, and none over a test that ANSWERED since', async () => {
    await testedOkAtT0();
    await saveFleetFailure('v1', T1, 'could not connect');
    await saveEndpointResult('v1', UNRESOLVED, T2);
    await saveEndpointResult('v1', A, T3);
    const cleared: ListExitRow = { ...listRow, exit_superseded_at: null };
    await adoptListExitObserved([cleared], [VPN], SYNC);
    expect((await loadProbeCache()).v1).not.toHaveProperty('fleetFailureReason');

    // A full test answered at T3+: what it measured postdates the stamp.
    await saveServerProbeResult(
      'v1',
      { latencyMs: 30, measuredFrom: 'fleet', nodeId: 'n1' },
      T3 + 1_000,
    );
    await adoptListExitObserved([listRow], [VPN], SYNC);
    const entry = (await loadProbeCache()).v1;
    expect(entry).not.toHaveProperty('fleetFailureReason');
    expect(entry?.serverLatencyMs).toBe(30);
  });
});
