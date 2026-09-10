// D2 — the account proxy LIST now carries `exit_observed`: the exit the server
// last saw through each proxy (a live session's egress, or a fleet probe),
// resolved to geo server-side. For an OpenVPN/WireGuard row that is the only
// exit identity a client can get between tests — the native exit probe is a
// SOCKS5 request from this Mac and cannot run through a tunnel — so the GUI
// adopts it into the SAME cache fields the fleet test and the native probe
// write (exitIp / exitCountry / exitTimezone / exitAt), and the row shows its
// exit without anyone pressing Test.
//
// Four layers, one property per arm:
//   1. the wire parse keeps a well-formed `exit_observed`, turns a malformed one
//      into null (that row's "never observed"), and leaves an absent one absent;
//   2. adoptListExitObserved writes it via saveExitResult for a VPN row —
//      MUTATION: delete that call and the CRITICAL arm reds (no exitIp) — and
//      never for a SOCKS5 row (its native geo is authoritative), never as a
//      downgrade (same ip, no geo, over stored geo), never as a rewind;
//   3. syncListExitObserved only pays the list round-trip when a synced VPN row
//      exists, and every failure is a rejection, never a throw;
//   4. the Proxies grid runs it on refresh — MUTATION: drop the call in
//      ProxiesView.refresh and the render arm reds (the row says "run Test").

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ProxyConfig } from '../../src/lib/proxies';

const stores = new Map<string, Map<string, unknown>>();
let storeWrites = 0;
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
      storeWrites++;
      this.map().set(key, value);
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

let nextResponse: () => Response = () => new Response('{}', { status: 500 });
const fetchCalls: string[] = [];
vi.mock('../../src/lib/fetch-with-deadline', () => ({
  DEFAULT_REQUEST_TIMEOUT_MS: 15_000,
  fetchWithDeadline: (url: string): Promise<Response> => {
    fetchCalls.push(url);
    return Promise.resolve(nextResponse());
  },
}));

// The grid's local registry — hand-listed like the sibling ProxiesView suites;
// the pure predicate is the real one so "usable" cannot drift.
let stored: ProxyConfig[] = [];
vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve(stored),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: vi.fn(() => Promise.reject(new Error('never'))),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: vi.fn(() => Promise.resolve({ resolved: true, ip: '1.2.3.4', message: 'ok' })),
}));
vi.mock('../../src/lib/profile-bindings', () => ({
  clearBindingsForProxy: vi.fn(() => Promise.resolve([])),
}));
const settingsStub: { settings: { apiKey: string | null; baseUrl: string } } = {
  settings: { apiKey: 'ds_key', baseUrl: 'https://api.example' },
};
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

import { cleanListExitObserved, listProxies } from '../../src/lib/account-proxies';
import { resolveEndpoint } from '../../src/lib/proxies';
import {
  loadProbeCache,
  saveEndpointResult,
  saveProbeResult,
} from '../../src/lib/proxy-probe-cache';
import {
  adoptListExitObserved,
  deriveProbeViewWithEndpointRows,
  syncListExitObserved,
} from '../../src/lib/proxy-server-test';
const { ProxiesView } = await import('../../src/views/ProxiesView');

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const OBSERVED_AT = '2026-09-10T08:00:00.000Z';
const OBSERVED_AT_MS = Date.parse(OBSERVED_AT);
const EXIT = {
  ip: '203.0.113.9',
  country: 'NL',
  timezone: 'Europe/Amsterdam',
  observed_via: 'session' as const,
  observed_at: OBSERVED_AT,
};
const META = {
  label: 'wg-ams',
  scheme: 'wireguard',
  host: 'wg.example.com',
  port: 51820,
  username: null,
  has_password: false,
  created_at: '2026-06-16T00:00:00.000Z',
  updated_at: '2026-06-16T00:00:00.000Z',
};
const WG_ROW = { ...META, id: 'aprx_wg', exit_observed: EXIT };
const SOCKS_ROW = { ...META, id: 'aprx_socks', scheme: 'socks5', exit_observed: EXIT };

const WG: ProxyConfig = {
  id: 'wg1',
  label: 'wg-ams',
  host: 'wg.example.com',
  port: 51820,
  username: null,
  password: null,
  createdAt: '2026-05-20T00:00:00.000Z',
  scheme: 'wireguard',
  serverId: 'aprx_wg',
};
const SOCKS: ProxyConfig = {
  id: 'socks1',
  label: 'eu-socks',
  host: 'proxy.example.com',
  port: 1080,
  username: 'u',
  password: 'p',
  createdAt: '2026-05-20T00:00:00.000Z',
  scheme: 'socks5',
  serverId: 'aprx_socks',
};
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

/** The endpoint pre-flight entry a VPN row has once Test/launch ran on THIS
 *  Mac. ⛔ Not a precondition of adoption: the no-entry arms below cover the
 *  second-Mac / fresh-install case, where the adoption runs the pre-flight. */
const seedVpnEntry = (id: string): Promise<unknown> =>
  saveEndpointResult(id, { resolved: true, ip: '198.51.100.7', message: 'ok' }, NOW - 60_000);

beforeEach(() => {
  stores.clear();
  storeWrites = 0;
  fetchCalls.length = 0;
  stored = [];
  nextResponse = () => new Response('{}', { status: 500 });
});

describe('the wire parse — exit_observed on a listed row', () => {
  it('keeps a well-formed exit_observed, every member typed', async () => {
    nextResponse = () => json({ data: [WG_ROW] });
    const rows = await listProxies('https://api.example', 'k');
    expect(rows[0]?.exit_observed).toEqual(EXIT);
  });

  it("a malformed exit_observed becomes that row's null, never a rendered location or a failed list", async () => {
    nextResponse = () =>
      json({
        data: [
          { ...WG_ROW, exit_observed: 'not-an-object' },
          { ...WG_ROW, id: 'b', exit_observed: { ...EXIT, ip: '' } },
          { ...WG_ROW, id: 'c', exit_observed: { ...EXIT, observed_via: 'guess' } },
          { ...WG_ROW, id: 'd', exit_observed: { ...EXIT, country: 7 } },
          { ...WG_ROW, id: 'e', exit_observed: null },
        ],
      });
    const rows = await listProxies('https://api.example', 'k');
    expect(rows.map((r) => r.exit_observed)).toEqual([null, null, null, null, null]);
  });

  it('an absent exit_observed (older server) stays absent — the row is untouched', async () => {
    nextResponse = () => json({ data: [{ ...META, id: 'aprx_wg' }] });
    const rows = await listProxies('https://api.example', 'k');
    expect(rows[0]).toEqual({ ...META, id: 'aprx_wg' });
    expect('exit_observed' in (rows[0] as object)).toBe(false);
  });

  it('absent geo/stamp members read as null; observed_via is a closed set', () => {
    expect(cleanListExitObserved({ ip: '203.0.113.9', observed_via: 'probe' })).toEqual({
      ip: '203.0.113.9',
      country: null,
      timezone: null,
      observed_via: 'probe',
      observed_at: null,
    });
    expect(cleanListExitObserved({ ip: '203.0.113.9', observed_via: 'fleet' })).toBeNull();
    expect(cleanListExitObserved([EXIT])).toBeNull();
  });
});

describe('adoptListExitObserved — VPN rows only, never a downgrade, never a rewind', () => {
  it('CRITICAL a VPN row with a server id adopts the observed exit into the exit cache, stamped with observed_at', async () => {
    await seedVpnEntry('wg1');
    const written = await adoptListExitObserved([WG_ROW], [WG], NOW);
    expect(written).toEqual(['wg1']);
    const entry = (await loadProbeCache()).wg1;
    expect(entry?.exitIp).toBe('203.0.113.9');
    expect(entry?.exitCountry).toBe('NL');
    expect(entry?.exitTimezone).toBe('Europe/Amsterdam');
    expect(entry?.exitAt).toBe(OBSERVED_AT_MS);
    // The endpoint overlay — what both grids render — now carries the exit.
    const view = deriveProbeViewWithEndpointRows(await loadProbeCache(), NOW);
    expect(view.exitResults.wg1).toEqual({
      ip: '203.0.113.9',
      country: 'NL',
      city: null,
      region: null,
      timezone: 'Europe/Amsterdam',
      asn_org: null,
    });
  });

  it('a SOCKS5 row is NEVER adopted — its native geo is authoritative (cache byte-identical)', async () => {
    await saveProbeResult('socks1', OK, NOW - 60_000);
    const before = JSON.stringify(await loadProbeCache());
    const written = await adoptListExitObserved([SOCKS_ROW], [SOCKS], NOW);
    expect(written).toEqual([]);
    expect(JSON.stringify(await loadProbeCache())).toBe(before);
  });

  it('a VPN row not yet synced (no serverId), or with no observation, writes nothing', async () => {
    await seedVpnEntry('wg1');
    const before = JSON.stringify(await loadProbeCache());
    const { serverId: _dropped, ...unsynced } = WG;
    expect(await adoptListExitObserved([WG_ROW], [unsynced], NOW)).toEqual([]);
    expect(await adoptListExitObserved([{ ...WG_ROW, exit_observed: null }], [WG], NOW)).toEqual(
      [],
    );
    expect(JSON.stringify(await loadProbeCache())).toBe(before);
  });

  it('never downgrades: same ip with no geo does not replace stored geo', async () => {
    await seedVpnEntry('wg1');
    await adoptListExitObserved([WG_ROW], [WG], NOW);
    const geoless = {
      ...EXIT,
      country: null,
      timezone: null,
      observed_at: '2026-09-11T08:00:00.000Z',
    };
    expect(await adoptListExitObserved([{ ...WG_ROW, exit_observed: geoless }], [WG], NOW)).toEqual(
      [],
    );
    const entry = (await loadProbeCache()).wg1;
    expect(entry?.exitCountry).toBe('NL');
    expect(entry?.exitTimezone).toBe('Europe/Amsterdam');
    expect(entry?.exitAt).toBe(OBSERVED_AT_MS);
  });

  it('never rewinds and never churns: the same observation on a second poll writes nothing', async () => {
    await seedVpnEntry('wg1');
    await adoptListExitObserved([WG_ROW], [WG], NOW);
    const writesAfterFirst = storeWrites;
    expect(await adoptListExitObserved([WG_ROW], [WG], NOW + 15_000)).toEqual([]);
    expect(storeWrites).toBe(writesAfterFirst);
    // …while a FRESHER observation of the same exit re-stamps it.
    const later = { ...EXIT, observed_at: '2026-09-10T09:00:00.000Z' };
    expect(await adoptListExitObserved([{ ...WG_ROW, exit_observed: later }], [WG], NOW)).toEqual([
      'wg1',
    ]);
    expect((await loadProbeCache()).wg1?.exitAt).toBe(Date.parse('2026-09-10T09:00:00.000Z'));
  });

  it('a new ip replaces the exit and starts its city/region/ASN clean; a same-ip refresh keeps them', async () => {
    await seedVpnEntry('wg1');
    await adoptListExitObserved([WG_ROW], [WG], NOW);
    // A fleet test in between resolved city/region/ASN for this ip.
    const { saveExitResult } = await import('../../src/lib/proxy-probe-cache');
    await saveExitResult(
      'wg1',
      '203.0.113.9',
      'NL',
      { city: 'Amsterdam', region: 'North Holland', timezone: 'Europe/Amsterdam', asnOrg: 'AS1' },
      OBSERVED_AT_MS + 1000,
    );
    const sameIpLater = { ...EXIT, observed_at: '2026-09-10T10:00:00.000Z' };
    await adoptListExitObserved([{ ...WG_ROW, exit_observed: sameIpLater }], [WG], NOW);
    let entry = (await loadProbeCache()).wg1;
    expect(entry?.exitCity).toBe('Amsterdam');
    expect(entry?.exitAsnOrg).toBe('AS1');
    const moved = {
      ...EXIT,
      ip: '198.51.100.2',
      country: 'DE',
      timezone: 'Europe/Berlin',
      observed_at: '2026-09-10T11:00:00.000Z',
    };
    await adoptListExitObserved([{ ...WG_ROW, exit_observed: moved }], [WG], NOW);
    entry = (await loadProbeCache()).wg1;
    expect(entry?.exitIp).toBe('198.51.100.2');
    expect(entry?.exitCountry).toBe('DE');
    expect(entry?.exitCity).toBeNull();
    expect(entry?.exitRegion).toBeNull();
    expect(entry?.exitAsnOrg).toBeNull();
  });

  it("a null observed_at is stamped with the caller's clock, never NaN", async () => {
    await seedVpnEntry('wg1');
    await adoptListExitObserved(
      [{ ...WG_ROW, exit_observed: { ...EXIT, observed_at: null } }],
      [WG],
      NOW,
    );
    expect((await loadProbeCache()).wg1?.exitAt).toBe(NOW);
  });
});

// ⛔ The cross-Mac case is the one D2 exists for: a second Mac (or a fresh
// install) syncs the VPN row but has never Tested or launched it here, so the
// row has NO cache entry — and `saveExitResult` invents none, while the
// endpoint-row overlay shows an exit only beside a RESOLVED pre-flight. Before
// this the adoption silently skipped exactly that row, so "shows a
// session-observed exit without a Test" was true only on the Mac that had
// already run one. The fix runs the row's own pre-flight (the same DNS resolve
// Test runs first) once, stores its honest verdict, and lands the exit on top.
describe('adoptListExitObserved — a VPN row with NO entry on this Mac (second Mac / fresh install)', () => {
  const resolve = vi.mocked(resolveEndpoint);

  beforeEach(() => {
    resolve.mockClear();
  });

  it('CRITICAL runs the endpoint pre-flight ONCE, stores it, and adopts the exit on top of it — the overlay shows the exit', async () => {
    expect((await loadProbeCache()).wg1).toBeUndefined();
    const written = await adoptListExitObserved([WG_ROW], [WG], NOW);
    expect(written).toEqual(['wg1']);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('wg.example.com', 51820);
    const entry = (await loadProbeCache()).wg1;
    // The entry is the pre-flight's own verdict — what a Test would have
    // written first — with the session exit beside it, stamped observed_at.
    expect(entry?.endpoint).toEqual({ resolved: true, ip: '1.2.3.4', message: 'ok' });
    expect(entry?.at).toBe(NOW);
    expect(entry?.exitIp).toBe('203.0.113.9');
    expect(entry?.exitCountry).toBe('NL');
    expect(entry?.exitAt).toBe(OBSERVED_AT_MS);
    const view = deriveProbeViewWithEndpointRows(await loadProbeCache(), NOW);
    expect(view.exitResults.wg1?.ip).toBe('203.0.113.9');
    expect(view.endpointResults.wg1?.resolved).toBe(true);
    // The next poll finds the entry: no second resolve, and (unchanged) no write.
    expect(await adoptListExitObserved([WG_ROW], [WG], NOW + 15_000)).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('an endpoint that does not resolve is stored UNRESOLVED — honest — and the exit lands but stays hidden, exactly as after a Test', async () => {
    resolve.mockResolvedValueOnce({ resolved: false, ip: '', message: 'no such host' });
    expect(await adoptListExitObserved([WG_ROW], [WG], NOW)).toEqual(['wg1']);
    const entry = (await loadProbeCache()).wg1;
    expect(entry?.endpoint).toEqual({ resolved: false, ip: '', message: 'no such host' });
    expect(entry?.exitIp).toBe('203.0.113.9');
    const view = deriveProbeViewWithEndpointRows(await loadProbeCache(), NOW);
    expect(view.endpointResults.wg1?.resolved).toBe(false);
    expect(view.exitResults.wg1, 'no exit beside an unresolved endpoint').toBeUndefined();
    // Once an entry exists no resolve runs again — the customer's Test re-runs it.
    await adoptListExitObserved([WG_ROW], [WG], NOW + 15_000);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('CONTROL — a pre-flight that cannot RUN invents nothing: no entry, nothing written; the next poll retries', async () => {
    resolve.mockRejectedValueOnce(new Error('ipc down'));
    expect(await adoptListExitObserved([WG_ROW], [WG], NOW)).toEqual([]);
    expect((await loadProbeCache()).wg1).toBeUndefined();
    expect(await adoptListExitObserved([WG_ROW], [WG], NOW + 15_000)).toEqual(['wg1']);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('CONTROL — no resolve for a SOCKS5 row, nor for a VPN row with nothing to adopt', async () => {
    expect(await adoptListExitObserved([SOCKS_ROW], [SOCKS], NOW)).toEqual([]);
    expect(await adoptListExitObserved([{ ...WG_ROW, exit_observed: null }], [WG], NOW)).toEqual(
      [],
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(await loadProbeCache()).toEqual({});
  });
});

describe('syncListExitObserved — the round-trip is paid only for a synced VPN row', () => {
  it('skips the request with no api key or no synced VPN proxy', async () => {
    expect(await syncListExitObserved('https://api.example', null, [WG], NOW)).toEqual([]);
    expect(await syncListExitObserved('https://api.example', 'k', [SOCKS], NOW)).toEqual([]);
    const { serverId: _dropped, ...unsynced } = WG;
    expect(await syncListExitObserved('https://api.example', 'k', [unsynced], NOW)).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });

  it('fetches the list and adopts for a synced VPN row', async () => {
    await seedVpnEntry('wg1');
    nextResponse = () => json({ data: [WG_ROW, SOCKS_ROW] });
    expect(await syncListExitObserved('https://api.example', 'k', [WG, SOCKS], NOW)).toEqual([
      'wg1',
    ]);
    expect(fetchCalls).toEqual(['https://api.example/v1/account/me/proxies']);
  });

  it("a failed list is a rejection, never a throw the caller's refresh would read as its own failure", async () => {
    let threwSynchronously = false;
    let p: Promise<string[]> | null = null;
    try {
      p = syncListExitObserved('https://api.example', 'k', [WG], NOW);
    } catch {
      threwSynchronously = true;
    }
    expect(threwSynchronously).toBe(false);
    await expect(p).rejects.toThrow('proxies fetch failed: 500');
  });
});

describe('the Proxies grid adopts on refresh', () => {
  it('a WireGuard row shows the session-observed exit without a Test', async () => {
    await seedVpnEntry('wg1');
    stored = [WG];
    nextResponse = () => json({ data: [WG_ROW] });
    render(<ProxiesView />);
    expect(await screen.findByText('203.0.113.9')).toBeTruthy();
    expect(screen.queryByText('run Test for exit IP')).toBeNull();
  });

  it('CRITICAL a WireGuard row this Mac has NEVER Tested (no cache entry) shows the session-observed exit', async () => {
    expect((await loadProbeCache()).wg1).toBeUndefined();
    stored = [WG];
    nextResponse = () => json({ data: [WG_ROW] });
    render(<ProxiesView />);
    expect(await screen.findByText('203.0.113.9')).toBeTruthy();
    expect(screen.queryByText('run Test for exit IP')).toBeNull();
    // Nothing fabricated: the row wears the pre-flight's own verdict.
    expect((await loadProbeCache()).wg1?.endpoint?.resolved).toBe(true);
  });

  it('control: without an observation the row still says "run Test for exit IP"', async () => {
    await seedVpnEntry('wg1');
    stored = [WG];
    nextResponse = () => json({ data: [{ ...WG_ROW, exit_observed: null }] });
    render(<ProxiesView />);
    expect(await screen.findByText('run Test for exit IP')).toBeTruthy();
    await waitFor(() => expect(fetchCalls.length).toBe(1));
    expect(screen.queryByText('203.0.113.9')).toBeNull();
  });
});
