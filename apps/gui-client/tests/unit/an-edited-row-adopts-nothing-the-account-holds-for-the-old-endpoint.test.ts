// 2026-09-17 — the list sync wrote the OLD endpoint's readings onto a row the
// customer had just edited.
//
// THE SEQUENCE, as measured: the customer tests row R, so the account stores its
// OS / QUIC / UDP readings (and, for a VPN, its exit), dated. They edit R's host
// and save. `invalidateProbe` deletes the whole cache entry — every retirement
// stamp with it — and marks the row `materialUnsynced` in the automatic check's
// ledger. The view then refreshes BEFORE the re-test that pushes the new material
// to the account, and the refresh fires the list sync. The account row still holds
// the OLD endpoint's readings; with no local entry the adoptions admit everything,
// and the edited row showed its predecessor's readings in the present tense.
//
// The mark already kept the automatic CHECK off such a row. It did not reach the
// three list adoptions. It does now, and an unreadable ledger adopts nothing.
//
// The stored mark is not the whole answer, and the last describe says where it
// falls short: the view does not await the edit, the mark's write is best-effort,
// an edit can land mid-sync, and the mark can be LIFTED while a list that predates
// the store is still in flight. The adoptions ask one gate that knows all four.
//
// ⛔ PRODUCTION LINES WHOSE REMOVAL REDS (each proven on a snapshot, see the arms):
//   • the `gate.refuses(p.id)` continue at the top of adoptListExitObserved,
//     adoptListOsFingerprint and adoptListCapabilityReadings — one arm each;
//   • `enterListAdoption`'s `catch { return null }` → an empty ledger — the
//     fail-closed arms;
//   • each term of the gate's `refuses` — one arm each in the last describe
//     (the stored-mark term is what the first describe is about).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = new Map<string, Map<string, unknown>>();
/** Names the ONE store key whose read rejects — the ledger's, so the cache beside
 *  it stays readable and the arm isolates the ledger's failure. */
const storeFault = {
  key: null as string | null,
  /** …but only from the Nth read of that key on (1-based); 0 = every read. */
  fromRead: 0,
};
/** Reads per store key — "how many times did the sync read the ledger?". */
const reads = new Map<string, number>();
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
      const n = (reads.get(key) ?? 0) + 1;
      reads.set(key, n);
      if (storeFault.key === key && n >= storeFault.fromRead) {
        return Promise.reject(new Error('store unreadable'));
      }
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
/** Runs while the list request is "in flight" — after it was sent, before it answers. */
let whileInFlight: () => Promise<void> = () => Promise.resolve();
vi.mock('../../src/lib/fetch-with-deadline', () => ({
  DEFAULT_REQUEST_TIMEOUT_MS: 15_000,
  fetchWithDeadline: async () => {
    await whileInFlight();
    return nextResponse();
  },
}));

const h = vi.hoisted(() => ({
  resolveEndpoint:
    vi.fn<
      (host: string, port: number) => Promise<{ resolved: boolean; ip: string; message: string }>
    >(),
}));
vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  resolveEndpoint: (host: string, port: number) => h.resolveEndpoint(host, port),
}));

import type { AccountProxyMeta } from '../../src/lib/account-proxies';
import type * as ProxiesModule from '../../src/lib/proxies';
import type { ProxyTestResult } from '../../src/lib/proxies';
import {
  __resetMaterialEditsForTests,
  clearCapabilityMaterialUnsynced,
  invalidateProbe,
  loadCapabilityAttempts,
  loadProbeCache,
  saveEndpointResult,
  saveExitResult,
  saveOsFingerprint,
  saveProbeResult,
  saveServerProbeResult,
} from '../../src/lib/proxy-probe-cache';
import {
  adoptListCapabilityReadings,
  adoptListExitObserved,
  adoptListOsFingerprint,
  syncListExitObserved,
  type ListExitProxyLike,
} from '../../src/lib/proxy-server-test';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
/** The ledger's store key — named here so the fault can single it out. Asserted
 *  against the real store below, so a rename cannot make the fault a no-op. */
const LEDGER_KEY = 'capability_attempts';

const OK: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0,
  latency_ms: 40,
  message: 'ok',
};
const READING = {
  os: 'macos-or-ios' as const,
  confidence: 'high' as const,
  reason: 'Based on how this proxy responds to a network connection.',
};

const SOCKS: ListExitProxyLike = {
  id: 'p1',
  serverId: 'aprx_1',
  scheme: 'socks5',
  host: 'old.example.com',
  port: 1080,
};
const VPN: ListExitProxyLike = {
  id: 'v1',
  serverId: 'aprx_v1',
  scheme: 'wireguard',
  host: 'old-vpn.example.com',
  port: 51820,
};

type ListRow = Pick<
  AccountProxyMeta,
  | 'id'
  | 'exit_observed'
  | 'exit_superseded_at'
  | 'os_fingerprint'
  | 'os_fingerprint_at'
  | 'quic_measured'
  | 'quic_measured_at'
  | 'stored_quic_probe'
  | 'stored_quic_probe_at'
  | 'stored_udp_probe'
  | 'stored_udp_probe_at'
>;

/** What the account holds for a row tested ten minutes ago — every reading the
 *  three adoptions read, all dated, all inside the present tense. */
const accountRow = (id: string): ListRow => ({
  id,
  exit_observed: {
    ip: '203.0.113.9',
    country: 'NL',
    timezone: 'Europe/Amsterdam',
    observed_at: iso(NOW - 10 * MIN),
  },
  exit_superseded_at: null,
  os_fingerprint: READING,
  os_fingerprint_at: iso(NOW - 10 * MIN),
  quic_measured: 'h3',
  quic_measured_at: iso(NOW - 10 * MIN),
  stored_quic_probe: true,
  stored_quic_probe_at: iso(NOW - 10 * MIN),
  stored_udp_probe: true,
  stored_udp_probe_at: iso(NOW - 10 * MIN),
});

/** The customer's test of the row, as the cache holds it afterwards. */
async function testedSocks(): Promise<void> {
  await saveProbeResult('p1', OK, NOW - 10 * MIN);
  await saveOsFingerprint('p1', READING, NOW - 10 * MIN);
  await saveServerProbeResult(
    'p1',
    { latencyMs: 30, measuredFrom: 'fleet', nodeId: 'n1', quicProbe: true, udpProbe: true },
    NOW - 10 * MIN,
  );
}
async function testedVpn(): Promise<void> {
  await saveEndpointResult(
    'v1',
    { resolved: true, ip: '198.51.100.7', message: 'ok' },
    NOW - 10 * MIN,
  );
  await saveServerProbeResult(
    'v1',
    { latencyMs: 30, measuredFrom: 'fleet', nodeId: 'n1', quicProbe: true, udpProbe: true },
    NOW - 10 * MIN,
  );
  await saveExitResult(
    'v1',
    '203.0.113.9',
    'NL',
    { city: null, region: null, timezone: 'Europe/Amsterdam', asnOrg: null },
    NOW - 10 * MIN,
  );
}

/** The list as the wire carries it, for the arms that drive the whole sync. */
const listOf = (...ids: string[]): (() => Response) => {
  return () =>
    new Response(
      JSON.stringify({
        data: ids.map((id) => ({
          id,
          quic_probe: true,
          quic_probe_at: iso(NOW - 10 * MIN),
          exit_observed: { ...accountRow(id).exit_observed, observed_via: 'session' },
          exit_superseded_at: null,
        })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
};

beforeEach(() => {
  stores.clear();
  storeFault.key = null;
  storeFault.fromRead = 0;
  reads.clear();
  __resetMaterialEditsForTests();
  whileInFlight = () => Promise.resolve();
  nextResponse = () => new Response('{}', { status: 500 });
  h.resolveEndpoint.mockReset();
  h.resolveEndpoint.mockResolvedValue({ resolved: true, ip: '198.51.100.99', message: 'ok' });
});

describe('⛔ a row edited since the account last received it adopts NOTHING from the list', () => {
  it('CRITICAL a SOCKS5 row: test → edit → the list still carries the old endpoint’s OS / QUIC / UDP readings → none is adopted, and NO seeded entry is invented for them to ride on. Then the store of the row lifts the mark and the SAME list is adopted (positive control: the refusal was the mark’s, not a broken fixture). MUTATION: delete the `gate.refuses` continue in adoptListOsFingerprint / adoptListCapabilityReadings and the matching line reds', async () => {
    await testedSocks();
    await invalidateProbe('p1');
    expect((await loadCapabilityAttempts()).p1?.materialUnsynced).toBe(true);
    expect(await loadProbeCache()).toEqual({});

    const rows = [accountRow('aprx_1')];
    expect(await adoptListOsFingerprint(rows, [SOCKS], NOW)).toEqual([]);
    expect(await adoptListCapabilityReadings(rows, [SOCKS], NOW)).toEqual([]);
    // (The exit adoption skips a SOCKS5 row whatever the mark says — its arm is the
    // VPN one below.)
    expect(await loadProbeCache(), 'no seeded entry invented for the edited row').toEqual({});

    // POSITIVE CONTROL — the account now holds this row's material again.
    await clearCapabilityMaterialUnsynced('p1');
    expect(await adoptListOsFingerprint(rows, [SOCKS], NOW)).toEqual(['p1']);
    expect(await adoptListCapabilityReadings(rows, [SOCKS], NOW)).toEqual(['p1']);
    const entry = (await loadProbeCache()).p1;
    expect(entry?.serverSeeded).toBe(true);
    expect(entry?.osFingerprint?.os).toBe('macos-or-ios');
    expect(entry?.quicProbe).toBe(true);
    expect(entry?.udpProbe).toBe(true);
  });

  it('CRITICAL a VPN row: the exit adoption neither writes the old endpoint’s exit NOR runs the address check that would invent an entry for it to land on — then, the mark lifted, all three adopt (positive control). MUTATION: delete the first `gate.refuses` continue in adoptListExitObserved and the resolve runs, an entry appears and the exit lands', async () => {
    await testedVpn();
    await invalidateProbe('v1');
    const rows = [accountRow('aprx_v1')];

    expect(await adoptListExitObserved(rows, [VPN], NOW)).toEqual([]);
    expect(await adoptListOsFingerprint(rows, [VPN], NOW)).toEqual([]);
    expect(await adoptListCapabilityReadings(rows, [VPN], NOW)).toEqual([]);
    expect(
      h.resolveEndpoint,
      'no lookup spent on a row that adopts nothing',
    ).not.toHaveBeenCalled();
    expect(await loadProbeCache()).toEqual({});

    await clearCapabilityMaterialUnsynced('v1');
    expect(await adoptListExitObserved(rows, [VPN], NOW)).toEqual(['v1']);
    expect(await adoptListCapabilityReadings(rows, [VPN], NOW)).toEqual(['v1']);
    expect(h.resolveEndpoint).toHaveBeenCalledTimes(1);
    const entry = (await loadProbeCache()).v1;
    expect(entry?.exitIp).toBe('203.0.113.9');
    expect(entry?.udpProbe).toBe(true);
  });

  it('the mark is PER ROW: an edited row beside an untouched one refuses for the one and adopts for the other', async () => {
    await testedSocks();
    await invalidateProbe('p1');
    const other: ListExitProxyLike = { ...SOCKS, id: 'p2', serverId: 'aprx_2' };
    const rows = [accountRow('aprx_1'), accountRow('aprx_2')];
    expect(await adoptListOsFingerprint(rows, [SOCKS, other], NOW)).toEqual(['p2']);
    expect(await adoptListCapabilityReadings(rows, [SOCKS, other], NOW)).toEqual(['p2']);
    expect(Object.keys(await loadProbeCache())).toEqual(['p2']);
  });

  it('CRITICAL the whole sync, as the views call it: the ledger is read exactly TWICE — once each side of the request — and never again by the three adoptions, and the edited row comes back untouched while its neighbour is adopted', async () => {
    await testedSocks();
    await invalidateProbe('p1');
    const other: ListExitProxyLike = { ...SOCKS, id: 'p2', serverId: 'aprx_2' };
    nextResponse = () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'aprx_1', quic_probe: true, quic_probe_at: iso(NOW - 10 * MIN) },
            { id: 'aprx_2', quic_probe: true, quic_probe_at: iso(NOW - 10 * MIN) },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    reads.clear();
    expect(await syncListExitObserved('https://api.example', 'k', [SOCKS, other], NOW)).toEqual([
      'p2',
    ]);
    expect(reads.get(LEDGER_KEY)).toBe(2);
    expect(Object.keys(await loadProbeCache())).toEqual(['p2']);
  });

  it('CRITICAL ONE gate for all three: the ledger turns unreadable AFTER the sync’s two reads, and every adoption still runs on what was read — the neighbour gets its exit AND its readings, the edited row nothing. MUTATION: stop passing `gate` to the adoptions in syncListExitObserved and each re-reads, fails closed, and the neighbour adopts nothing', async () => {
    const other: ListExitProxyLike = { ...VPN, id: 'v2', serverId: 'aprx_v2' };
    await testedVpn();
    await invalidateProbe('v1');
    nextResponse = listOf('aprx_v1', 'aprx_v2');
    reads.clear();
    storeFault.key = LEDGER_KEY;
    storeFault.fromRead = 3;
    expect(await syncListExitObserved('https://api.example', 'k', [VPN, other], NOW)).toEqual([
      'v2',
    ]);
    const cache = await loadProbeCache();
    expect(Object.keys(cache)).toEqual(['v2']);
    expect(cache.v2?.exitIp).toBe('203.0.113.9');
    expect(cache.v2?.quicProbe).toBe(true);
  });
});

describe('⛔ the moments the STORED mark cannot cover', () => {
  it('CRITICAL the view does NOT await invalidateProbe before it refreshes: the edit is known from the turn it was called in, before its mark is written. MUTATION: drop `before.pending.has(id)` from the gate and the first line reds', async () => {
    await testedSocks();
    const rows = [accountRow('aprx_1')];
    const edit = invalidateProbe('p1'); // fired, not awaited — as ProxiesView does
    const adopted = adoptListCapabilityReadings(rows, [SOCKS], NOW);
    expect(await adopted).toEqual([]);
    await edit;
    expect(await loadProbeCache()).toEqual({});
  });

  it('CRITICAL the ledger is unreadable AT THE MOMENT OF THE EDIT: the entry is deleted, NO mark is written — and the adoptions still refuse, until the store of the row. (The read side failed closed already; this is the write side.) MUTATION: drop `before.pending.has(id)` from the gate and the old readings are seeded', async () => {
    await testedSocks();
    storeFault.key = LEDGER_KEY;
    await invalidateProbe('p1');
    storeFault.key = null;
    expect(await loadCapabilityAttempts(), 'fixture: no mark was written').toEqual({});
    expect(await loadProbeCache()).toEqual({});

    const rows = [accountRow('aprx_1')];
    expect(await adoptListOsFingerprint(rows, [SOCKS], NOW)).toEqual([]);
    expect(await adoptListCapabilityReadings(rows, [SOCKS], NOW)).toEqual([]);
    expect(await loadProbeCache()).toEqual({});

    await clearCapabilityMaterialUnsynced('p1'); // positive control
    expect(await adoptListOsFingerprint(rows, [SOCKS], NOW)).toEqual(['p1']);
  });

  it('CRITICAL an edit saved WHILE the exit adoption’s address lookup is running — after the gate’s ledger reads: no entry is invented for the row, no exit lands, and the two adoptions after it refuse it too. MUTATION: drop `materialEditedAfter(…)` from the gate and all of it reds', async () => {
    h.resolveEndpoint.mockImplementation(async () => {
      await invalidateProbe('v1');
      // …and the re-test that follows an edit stores the row, lifting the mark:
      // only "edited since this sync began" is left to refuse by.
      await clearCapabilityMaterialUnsynced('v1');
      return { resolved: true, ip: '198.51.100.99', message: 'ok' };
    });
    nextResponse = listOf('aprx_v1');
    expect(await syncListExitObserved('https://api.example', 'k', [VPN], NOW)).toEqual([]);
    expect(h.resolveEndpoint).toHaveBeenCalledTimes(1);
    expect(await loadProbeCache()).toEqual({});
  });

  it('CRITICAL the mark is LIFTED while the list request is in flight (the view sends the request, then the store that lifts it): a list that may predate that store is still refused for the row — by the ledger as read BEFORE the request, with nothing in memory (a mark left by a previous run of the app). MUTATION: drop `before.marked[id]` from the gate and this reds', async () => {
    await testedSocks();
    await invalidateProbe('p1');
    __resetMaterialEditsForTests(); // the app restarted: only the stored mark is left
    whileInFlight = async () => {
      await clearCapabilityMaterialUnsynced('p1');
    };
    nextResponse = listOf('aprx_1');
    expect(await syncListExitObserved('https://api.example', 'k', [SOCKS], NOW)).toEqual([]);
    expect(await loadProbeCache()).toEqual({});

    // CONTROL — the NEXT sync, begun after the lift, adopts.
    whileInFlight = () => Promise.resolve();
    expect(await syncListExitObserved('https://api.example', 'k', [SOCKS], NOW)).toEqual(['p1']);
  });
});

describe('⛔ …and the read AFTER the request is not redundant with memory', () => {
  it('CRITICAL a mark that reaches the STORE while the request is in flight, from somewhere this module’s memory never heard of (anything that shares the store and not the module): the read after the request is the only thing that can see it. MUTATION: drop the `marked[id]` term (the after-read) from the gate and this reds', async () => {
    whileInFlight = () => {
      const file = [...stores.values()][0];
      file?.set(LEDGER_KEY, { p1: { capabilityCheckAttemptedAt: 0, materialUnsynced: true } });
      return Promise.resolve();
    };
    nextResponse = listOf('aprx_1', 'aprx_2');
    const other: ListExitProxyLike = { ...SOCKS, id: 'p2', serverId: 'aprx_2' };
    expect(await syncListExitObserved('https://api.example', 'k', [SOCKS, other], NOW)).toEqual([
      'p2',
    ]);
    expect((await loadCapabilityAttempts()).p1?.materialUnsynced, 'fixture: it landed').toBe(true);
    expect(Object.keys(await loadProbeCache())).toEqual(['p2']);
  });
});

describe('⛔ FAILS CLOSED — a ledger that cannot be read adopts nothing, for anyone', () => {
  it('the fault below really is the ledger’s key (a renamed key would make every arm here vacuous)', async () => {
    await invalidateProbe('p1');
    const file = [...stores.values()].find((m) => m.has(LEDGER_KEY));
    expect(file, `the ledger is stored under "${LEDGER_KEY}"`).toBeDefined();
    storeFault.key = LEDGER_KEY;
    await expect(loadCapabilityAttempts()).rejects.toThrow('store unreadable');
    await expect(loadProbeCache()).resolves.toEqual({});
  });

  it('CRITICAL each adoption called by itself, with NO row marked at all: an unreadable ledger is not "nobody edited anything". MUTATION: make enterListAdoption’s catch answer an empty ledger and all three red. CONTROL: the same calls adopt once the ledger reads again', async () => {
    const rows = [accountRow('aprx_1'), accountRow('aprx_v1')];
    storeFault.key = LEDGER_KEY;
    expect(await adoptListOsFingerprint(rows, [SOCKS, VPN], NOW)).toEqual([]);
    expect(await adoptListCapabilityReadings(rows, [SOCKS, VPN], NOW)).toEqual([]);
    expect(await adoptListExitObserved(rows, [SOCKS, VPN], NOW)).toEqual([]);
    expect(h.resolveEndpoint).not.toHaveBeenCalled();
    expect(await loadProbeCache()).toEqual({});

    storeFault.key = null;
    expect(await adoptListExitObserved(rows, [SOCKS, VPN], NOW)).toEqual(['v1']);
    expect(await adoptListOsFingerprint(rows, [SOCKS, VPN], NOW)).toEqual(['p1', 'v1']);
    expect(await adoptListCapabilityReadings(rows, [SOCKS, VPN], NOW)).toEqual(['p1', 'v1']);
  });

  it('CRITICAL …and the sync as a whole: the list was fetched, the ledger could not be read, NOTHING is written. Unreadable BEFORE the request means no request at all; the mutation above reds this arm too', async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'aprx_1', quic_probe: true, quic_probe_at: iso(NOW - 10 * MIN) }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    storeFault.key = LEDGER_KEY;
    expect(await syncListExitObserved('https://api.example', 'k', [SOCKS], NOW)).toEqual([]);
    expect(await loadProbeCache()).toEqual({});
    storeFault.key = null;
    expect(await syncListExitObserved('https://api.example', 'k', [SOCKS], NOW)).toEqual(['p1']);
  });

  it('…and unreadable only AFTER the request (the second of the sync’s two reads): nothing is written either — the read before the request cannot see an edit saved while it was in flight. MUTATION: make openListAdoptionGate’s catch keep `before.marked` instead of returning null and this reds', async () => {
    nextResponse = listOf('aprx_1');
    storeFault.key = LEDGER_KEY;
    storeFault.fromRead = 2;
    expect(await syncListExitObserved('https://api.example', 'k', [SOCKS], NOW)).toEqual([]);
    expect(reads.get(LEDGER_KEY), 'fixture: the fault hit the second read').toBe(2);
    expect(await loadProbeCache()).toEqual({});
  });
});
