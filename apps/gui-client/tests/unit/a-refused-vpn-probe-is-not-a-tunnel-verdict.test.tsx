// (d) — the control plane REFUSES a fleet test of a VPN row while a live
// session browses through it (a second tunnel on a one-connection VPN account
// would drop the session), and a fleet node refuses one it cannot run
// (`node_busy`). Both come back `ok:false`, and the GUI turned every `ok:false`
// into a TUNNEL-DOWN verdict: the red pill, the failure sentence in error ink,
// the Test-all tally counting the row as a tunnel that is not up, and the
// refusal's `exit_observed` — the exit the live session sees — dropped unread.
// A wait that measured nothing was rendered and tallied as a failed proxy.
//
// The wire now carries `not_run` — the discriminator a client branches on,
// never the prose — and the GUI has its own outcome for it:
//   1. the wire parse keeps `not_run` (closed set) and, beside `live_session`
//      only, the refusal's `exit_observed`;
//   2. serverProbeOutcome translates it to `not_run`, never `failed` —
//      CONTROL: the SAME sentence without the field is still `failed`, so the
//      branch is on the field, not the words;
//   3. persistServerProbe adopts the refusal's exit for a VPN row (adoptExit),
//      writes no measurement, and never downgrades;
//   4. the Proxies grid shows the sentence as a muted notice beside an
//      "endpoint ok" pill (never "tunnel down"), shows the exit, and Test all
//      tallies the row as SKIPPED — never as a tunnel that is not up.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
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

let nextResponse: () => Response = () => new Response('{}', { status: 500 });
vi.mock('../../src/lib/fetch-with-deadline', () => ({
  DEFAULT_REQUEST_TIMEOUT_MS: 15_000,
  fetchWithDeadline: (): Promise<Response> => Promise.resolve(nextResponse()),
}));

const testProxy = vi.fn<(input: unknown) => Promise<ProxyTestResult>>();
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

let stored: ProxyConfig[] = [];
const settingsStub = { settings: { apiKey: 'ds_test_x' as string | null, baseUrl: 'http://x' } };

vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve(stored),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: (input: unknown) => testProxy(input),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: vi.fn(() =>
    Promise.resolve({ resolved: true, ip: '198.51.100.1', message: 'Resolved' }),
  ),
}));
vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  testAccountProxy: (
    baseUrl: string,
    apiKey: string,
    id: string,
    opts?: { vantage?: 'cp' | 'fleet' },
  ) => testAccountProxy(baseUrl, apiKey, id, opts),
}));
vi.mock('../../src/lib/profile-bindings', () => ({
  clearBindingsForProxy: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => settingsStub,
}));

// The REAL wire parse, for the parse arms (the grid arms use the mock above).
const real = await vi.importActual<typeof AccountProxiesModule>('../../src/lib/account-proxies');
import {
  loadProbeCache,
  saveEndpointResult,
  saveExitResult,
  saveOsFingerprint,
  saveServerProbeResult,
} from '../../src/lib/proxy-probe-cache';
import {
  adoptListExitObserved,
  LIST_TUNNEL_DOWN_REASON,
  persistServerProbe,
  SERVER_DID_NOT_ANSWER_NOTICE,
  serverProbeOutcome,
} from '../../src/lib/proxy-server-test';
const { ProxiesView } = await import('../../src/views/ProxiesView');

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const REFUSAL =
  'This VPN is in use by a live session; its exit is shown from that session. End the session to test the tunnel.';
const BUSY =
  'The Mac that runs your profiles is busy with another tunnel or test. Try again in a minute.';
const SESSION_EXIT = {
  ip: '203.0.113.9',
  country: 'NL',
  timezone: 'Europe/Amsterdam',
  region: null,
  city: null,
};
const REFUSED: AccountProxiesModule.AccountProxyTestResult = {
  ok: false,
  reason: REFUSAL,
  measured_from: 'control_plane',
  not_run: 'live_session',
  exit_observed: SESSION_EXIT,
};
const NODE_BUSY: AccountProxiesModule.AccountProxyTestResult = {
  ok: false,
  reason: BUSY,
  measured_from: 'fleet',
  not_run: 'node_busy',
};
const NOW = 1_800_000_000_000;

function vpnRow(): ProxyConfig {
  return {
    id: 'vpn1',
    label: 'ResVPN',
    host: 'vpn.example.com',
    port: 51820,
    username: null,
    password: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    scheme: 'wireguard',
    serverId: 'aprx_vpn',
  };
}
function socks5Row(): ProxyConfig {
  return {
    id: 's1',
    label: 'Socks',
    host: '127.0.0.1',
    port: 1080,
    username: null,
    password: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    scheme: 'socks5',
  };
}
const HEALTHY: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'ok',
};

beforeEach(() => {
  stores.clear();
  nextResponse = () => new Response('{}', { status: 500 });
  testProxy.mockReset();
  testProxy.mockResolvedValue(HEALTHY);
  testAccountProxy.mockReset();
  testAccountProxy.mockResolvedValue(REFUSED);
  settingsStub.settings.apiKey = 'ds_test_x';
  stored = [vpnRow()];
});

describe('the wire parse — `not_run` and the refusal exit', () => {
  it('CRITICAL keeps not_run and, beside live_session, the exit the session observed', async () => {
    nextResponse = () =>
      json({
        ok: false,
        reason: REFUSAL,
        measured_from: 'control_plane',
        not_run: 'live_session',
        exit_observed: SESSION_EXIT,
      });
    const r = await real.testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' });
    expect(r).toEqual(REFUSED);
  });

  it('node_busy / node_error are kept; a value outside the closed set is dropped (a plain failure, never a refusal it did not earn)', async () => {
    nextResponse = () =>
      json({ ok: false, reason: BUSY, measured_from: 'fleet', not_run: 'node_busy' });
    expect(await real.testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' })).toEqual(
      NODE_BUSY,
    );
    nextResponse = () =>
      json({ ok: false, reason: 'x', measured_from: 'fleet', not_run: 'node_error' });
    expect(
      (await real.testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' })) as {
        not_run?: string;
      },
    ).toMatchObject({ not_run: 'node_error' });
    nextResponse = () =>
      json({ ok: false, reason: REFUSAL, measured_from: 'control_plane', not_run: 'guess' });
    const r = await real.testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' });
    expect(r).toEqual({ ok: false, reason: REFUSAL, measured_from: 'control_plane' });
  });

  it('CONTROL — an exit_observed beside a plain failure (no not_run) or a busy node is NOT a claim this reply can make: dropped', async () => {
    nextResponse = () =>
      json({
        ok: false,
        reason: 'did not answer',
        measured_from: 'fleet',
        exit_observed: SESSION_EXIT,
      });
    expect(await real.testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' })).toEqual({
      ok: false,
      reason: 'did not answer',
      measured_from: 'fleet',
    });
    nextResponse = () => json({ ...NODE_BUSY, exit_observed: SESSION_EXIT });
    expect(await real.testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' })).toEqual(
      NODE_BUSY,
    );
  });

  it('a malformed refusal exit drops the FIELD, never the reply', async () => {
    nextResponse = () =>
      json({
        ok: false,
        reason: REFUSAL,
        measured_from: 'control_plane',
        not_run: 'live_session',
        exit_observed: { ip: '' },
      });
    const r = await real.testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' });
    expect(r).toEqual({
      ok: false,
      reason: REFUSAL,
      measured_from: 'control_plane',
      not_run: 'live_session',
    });
  });
});

describe('serverProbeOutcome — a refusal is `not_run`, never `failed`', () => {
  it('CRITICAL live_session → not_run with why, the sentence, the vantage and the session exit', () => {
    expect(serverProbeOutcome(REFUSED, NOW)).toEqual({
      kind: 'not_run',
      at: NOW,
      why: 'live_session',
      reason: REFUSAL,
      vantage: { measuredFrom: 'control_plane' },
      exitObserved: SESSION_EXIT,
    });
  });

  it('node_busy → not_run with no exit', () => {
    expect(serverProbeOutcome(NODE_BUSY, NOW)).toEqual({
      kind: 'not_run',
      at: NOW,
      why: 'node_busy',
      reason: BUSY,
      vantage: { measuredFrom: 'fleet' },
    });
  });

  it('CONTROL — the SAME sentence without `not_run` is still `failed`: the branch is on the field, not the prose', () => {
    expect(
      serverProbeOutcome({ ok: false, reason: REFUSAL, measured_from: 'control_plane' }, NOW),
    ).toEqual({
      kind: 'failed',
      at: NOW,
      reason: REFUSAL,
      vantage: { measuredFrom: 'control_plane' },
    });
  });
});

describe('persistServerProbe — a refusal writes no measurement, adopts the session exit for a VPN row', () => {
  const seed = (): Promise<unknown> =>
    saveEndpointResult(
      'vpn1',
      { resolved: true, ip: '198.51.100.1', message: 'Resolved' },
      NOW - 1,
    );

  it('CRITICAL adoptExit: the session exit lands in the exit cache, stamped with this reply; no server field is written', async () => {
    await seed();
    const cache = await persistServerProbe('vpn1', serverProbeOutcome(REFUSED, NOW), {
      adoptExit: true,
    });
    expect(cache?.vpn1?.exitIp).toBe('203.0.113.9');
    expect(cache?.vpn1?.exitCountry).toBe('NL');
    expect(cache?.vpn1?.exitTimezone).toBe('Europe/Amsterdam');
    expect(cache?.vpn1?.exitAt).toBe(NOW);
    expect(cache?.vpn1?.serverLatencyMs).toBeUndefined();
    expect(cache?.vpn1?.measuredFrom).toBeUndefined();
    expect((await loadProbeCache()).vpn1?.exitIp).toBe('203.0.113.9');
  });

  // (g) — the grid's Check writes the endpoint pre-flight BEFORE it asks the
  // fleet, and that write used to replace the whole entry, so a REFUSED test
  // (nothing measured) erased the latency / vantage / relay verdict / OS
  // fingerprint the last measurement had written. Mutation: make
  // saveEndpointResult carry nothing over and the CRITICAL arms red.
  it('CRITICAL the endpoint pre-flight (resolved) preserves the server-measured fields of a prior endpoint entry', async () => {
    await seed();
    await saveServerProbeResult(
      'vpn1',
      { latencyMs: 42, measuredFrom: 'fleet', nodeId: 'mac-07', quicProbe: true },
      NOW - 1,
    );
    await saveOsFingerprint('vpn1', { os: 'linux', confidence: 'high', reason: 'ttl' }, NOW - 1);
    await saveExitResult('vpn1', '203.0.113.9', 'NL', { timezone: 'Europe/Amsterdam' }, NOW - 1);
    const cache = await saveEndpointResult(
      'vpn1',
      { resolved: true, ip: '198.51.100.1', message: 'Resolved' },
      NOW,
    );
    const entry = cache.vpn1;
    expect(entry?.endpoint).toEqual({ resolved: true, ip: '198.51.100.1', message: 'Resolved' });
    expect(entry?.at).toBe(NOW);
    expect(entry?.serverLatencyMs).toBe(42);
    expect(entry?.measuredFrom).toBe('fleet');
    expect(entry?.nodeId).toBe('mac-07');
    expect(entry?.quicProbe).toBe(true);
    expect(entry?.osFingerprint).toMatchObject({ os: 'linux', confidence: 'high' });
    expect(entry?.exitIp).toBe('203.0.113.9');
    expect(entry?.exitAt).toBe(NOW - 1);
    // Still not a SOCKS5 verdict, still the placeholder.
    expect(entry?.result).toMatchObject({ reachable: false, auth_ok: false, can_route: false });
  });

  // (g-followup) The carry-over is keyed on the ADDRESS. Mutation: drop the
  // `prior.endpoint.ip === endpoint.ip` predicate and this arm reds while the
  // CRITICAL arm above (same ip) stays green — the two together pin the key.
  it('CONTROL — a pre-flight that resolves to a DIFFERENT address carries nothing over: the new server was never measured', async () => {
    await seed();
    await saveServerProbeResult(
      'vpn1',
      { latencyMs: 42, measuredFrom: 'fleet', nodeId: 'mac-07', quicProbe: true },
      NOW - 1,
    );
    await saveOsFingerprint('vpn1', { os: 'linux', confidence: 'high', reason: 'ttl' }, NOW - 1);
    await saveExitResult('vpn1', '203.0.113.9', 'NL', { timezone: 'Europe/Amsterdam' }, NOW - 1);
    const cache = await saveEndpointResult(
      'vpn1',
      { resolved: true, ip: '198.51.100.77', message: 'Resolved' },
      NOW,
    );
    const entry = cache.vpn1;
    expect(entry?.endpoint).toEqual({ resolved: true, ip: '198.51.100.77', message: 'Resolved' });
    expect(entry?.at).toBe(NOW);
    expect(entry?.serverLatencyMs).toBeUndefined();
    expect(entry?.measuredFrom).toBeUndefined();
    expect(entry?.nodeId).toBeUndefined();
    expect(entry?.quicProbe).toBeUndefined();
    expect(entry?.osFingerprint).toBeUndefined();
    expect(entry?.exitIp).toBeUndefined();
    expect(entry?.exitAt).toBeUndefined();
    // The entry holds ONLY the verdict triple — no server-measured key, even an
    // absent one, so a later toEqual on the record sees nothing carried.
    expect(Object.keys(entry ?? {}).sort()).toEqual(['at', 'endpoint', 'result']);
  });

  it('CONTROL — a prior UNRESOLVED endpoint entry carries nothing over even when the address now matches', async () => {
    await saveEndpointResult('vpn1', { resolved: false, ip: '', message: 'NXDOMAIN' }, NOW - 2);
    // Enrichments written after an unresolved pre-flight (a stale fleet reply
    // landing late) must not resurface when the name resolves again.
    await saveServerProbeResult(
      'vpn1',
      { latencyMs: 42, measuredFrom: 'fleet', nodeId: 'mac-07', quicProbe: true },
      NOW - 1,
    );
    const cache = await saveEndpointResult(
      'vpn1',
      { resolved: true, ip: '', message: 'Resolved' },
      NOW,
    );
    expect(cache.vpn1?.serverLatencyMs).toBeUndefined();
    expect(cache.vpn1?.measuredFrom).toBeUndefined();
    expect(cache.vpn1?.endpoint?.resolved).toBe(true);
  });

  it('CONTROL — an UNRESOLVED pre-flight still drops them all (nothing can be measured through a dead endpoint)', async () => {
    await seed();
    await saveServerProbeResult(
      'vpn1',
      { latencyMs: 42, measuredFrom: 'fleet', nodeId: 'mac-07', quicProbe: true },
      NOW - 1,
    );
    const cache = await saveEndpointResult(
      'vpn1',
      { resolved: false, ip: '', message: 'NXDOMAIN' },
      NOW,
    );
    expect(cache.vpn1?.serverLatencyMs).toBeUndefined();
    expect(cache.vpn1?.measuredFrom).toBeUndefined();
    expect(cache.vpn1?.nodeId).toBeUndefined();
    expect(cache.vpn1?.quicProbe).toBeUndefined();
    expect(cache.vpn1?.endpoint?.resolved).toBe(false);
  });

  it('CONTROL — a prior SOCKS5 entry (the row changed scheme) carries nothing over: its fields were measured through a listener this row does not have', async () => {
    const { saveProbeResult } = await import('../../src/lib/proxy-probe-cache');
    await saveProbeResult('vpn1', HEALTHY, NOW - 2);
    await saveServerProbeResult(
      'vpn1',
      { latencyMs: 42, measuredFrom: 'fleet', nodeId: 'mac-07', quicProbe: true },
      NOW - 1,
    );
    const cache = await saveEndpointResult(
      'vpn1',
      { resolved: true, ip: '198.51.100.1', message: 'Resolved' },
      NOW,
    );
    expect(cache.vpn1?.serverLatencyMs).toBeUndefined();
    expect(cache.vpn1?.measuredFrom).toBeUndefined();
    expect(cache.vpn1?.quicProbe).toBeUndefined();
    expect(cache.vpn1?.endpoint?.resolved).toBe(true);
  });

  it('VACUITY CONTROL — without adoptExit (a SOCKS5 caller), or with no exit on the refusal, nothing is written', async () => {
    await seed();
    const before = JSON.stringify(await loadProbeCache());
    expect(await persistServerProbe('vpn1', serverProbeOutcome(REFUSED, NOW))).toBeNull();
    expect(
      await persistServerProbe('vpn1', serverProbeOutcome(NODE_BUSY, NOW), { adoptExit: true }),
    ).toBeNull();
    expect(JSON.stringify(await loadProbeCache())).toBe(before);
  });

  it('never downgrades: a geo-less refusal exit does not replace stored geo for the same ip', async () => {
    await seed();
    await saveExitResult('vpn1', '203.0.113.9', 'NL', { timezone: 'Europe/Amsterdam' }, NOW - 1);
    const geoless: AccountProxiesModule.AccountProxyTestResult = {
      ...REFUSED,
      exit_observed: { ...SESSION_EXIT, country: null, timezone: null },
    };
    expect(
      await persistServerProbe('vpn1', serverProbeOutcome(geoless, NOW), { adoptExit: true }),
    ).toBeNull();
    const entry = (await loadProbeCache()).vpn1;
    expect(entry?.exitCountry).toBe('NL');
    expect(entry?.exitAt).toBe(NOW - 1);
  });

  it('a proxy with no entry gets nothing invented (and "nothing written" is null, not an empty map)', async () => {
    expect(
      await persistServerProbe('ghost', serverProbeOutcome(REFUSED, NOW), { adoptExit: true }),
    ).toBeNull();
    expect((await loadProbeCache()).ghost).toBeUndefined();
  });
});

async function clickCheck(): Promise<void> {
  const btn = await screen.findByRole('button', { name: /check endpoint|re-check/i });
  fireEvent.click(btn);
}

describe('the Proxies grid — a refused test is a notice and a skipped row, never "tunnel down"', () => {
  it('CRITICAL Check on a WireGuard row a live session uses: no red pill, the sentence in muted ink, and the session exit shown', async () => {
    render(<ProxiesView />);
    await clickCheck();
    const notice = await screen.findByText(REFUSAL);
    expect(notice.className).toContain('text-ink-muted');
    expect(notice.className).not.toContain('text-status-error');
    expect(screen.queryByText('tunnel down')).toBeNull();
    expect(screen.getByText('endpoint ok')).toBeInTheDocument();
    expect(await screen.findByText('203.0.113.9')).toBeInTheDocument();
    // Persisted as the row's exit; no measurement invented.
    await waitFor(() =>
      expect(loadProbeCache().then((c) => c.vpn1?.exitIp)).resolves.toBe('203.0.113.9'),
    );
    expect((await loadProbeCache()).vpn1?.serverLatencyMs).toBeUndefined();
  });

  it('a busy node reads the same way: a notice, not a failure', async () => {
    testAccountProxy.mockResolvedValue(NODE_BUSY);
    render(<ProxiesView />);
    await clickCheck();
    const notice = await screen.findByText(BUSY);
    expect(notice.className).toContain('text-ink-muted');
    expect(screen.queryByText('tunnel down')).toBeNull();
  });

  // (g) — the pre-flight's cache write lands BEFORE the fleet reply; it used to
  // replace the entry, so a refused test left the row with no latency and no
  // vantage although nothing had been measured. The row keeps what it holds.
  it('CRITICAL after a REFUSED test the row still shows its prior fleet latency and vantage, and the cache still holds them', async () => {
    await saveEndpointResult(
      'vpn1',
      { resolved: true, ip: '198.51.100.1', message: 'Resolved' },
      NOW - 2,
    );
    await saveServerProbeResult(
      'vpn1',
      { latencyMs: 42, measuredFrom: 'fleet', nodeId: 'mac-07', quicProbe: true },
      NOW - 1,
    );
    testAccountProxy.mockResolvedValue(NODE_BUSY);
    render(<ProxiesView />);
    expect(await screen.findByText('42ms')).toBeInTheDocument();
    expect(screen.getByText('from a fleet Mac')).toBeInTheDocument();
    await clickCheck();
    expect(await screen.findByText(BUSY)).toBeInTheDocument();
    // The pre-flight has been persisted by now (the reply follows it).
    await waitFor(() =>
      expect(loadProbeCache().then((c) => c.vpn1?.at)).resolves.not.toBe(NOW - 2),
    );
    expect(screen.getByText('42ms')).toBeInTheDocument();
    expect(screen.getByText('from a fleet Mac')).toBeInTheDocument();
    const entry = (await loadProbeCache()).vpn1;
    expect(entry?.serverLatencyMs).toBe(42);
    expect(entry?.measuredFrom).toBe('fleet');
    expect(entry?.nodeId).toBe('mac-07');
    expect(entry?.quicProbe).toBe(true);
    expect(entry?.endpoint?.resolved).toBe(true);
  });

  it('CONTROL — the SAME sentence as a plain failure (no not_run) still reads "tunnel down" in error ink, with no exit', async () => {
    testAccountProxy.mockResolvedValue({
      ok: false,
      reason: REFUSAL,
      measured_from: 'control_plane',
    });
    render(<ProxiesView />);
    await clickCheck();
    expect(await screen.findByText('tunnel down')).toBeInTheDocument();
    expect(screen.getByText(REFUSAL).className).toContain('text-status-error');
    expect(screen.queryByText('203.0.113.9')).toBeNull();
    expect((await loadProbeCache()).vpn1?.exitIp).toBeUndefined();
  });

  it('CRITICAL Test all tallies the refused row as SKIPPED — never "0 VPN tunnels up"', async () => {
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));
    expect(
      await screen.findByText(
        '1 VPN tunnel skipped (in use by a live session; end it to test the tunnel) — nothing was tested',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/0 VPN tunnels up/)).toBeNull();
  });

  it('a mixed pool: the SOCKS5 verdict counts, the refused VPN row is skipped beside it', async () => {
    stored = [socks5Row(), vpnRow()];
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));
    expect(
      await screen.findByText(
        'Tested 1 — 1 healthy, 1 VPN tunnel skipped (in use by a live session; end it to test the tunnel)',
      ),
    ).toBeInTheDocument();
  });
});

// (h) VPN surfaces audit — findings 1, 12, 28: a fleet FAILURE is written, it
// SUPERSEDES the exit the entry held, and nothing brings that exit back.
const FLEET_DOWN = 'The Mac that runs your profiles could not bring this tunnel up.';
const FLEET_FAILED: AccountProxiesModule.AccountProxyTestResult = {
  ok: false,
  reason: FLEET_DOWN,
  measured_from: 'fleet',
};
const LIST_ROW = (observedAt: number) => [
  {
    id: 'aprx_vpn',
    exit_observed: {
      ip: '203.0.113.9',
      country: 'NL' as string | null,
      timezone: 'Europe/Amsterdam' as string | null,
      observed_via: 'session' as const,
      observed_at: new Date(observedAt).toISOString(),
    },
  },
];

async function seedMeasured(): Promise<void> {
  await saveEndpointResult(
    'vpn1',
    { resolved: true, ip: '198.51.100.1', message: 'Resolved' },
    NOW - 3,
  );
  await saveServerProbeResult(
    'vpn1',
    { latencyMs: 42, measuredFrom: 'fleet', nodeId: 'mac-07', quicProbe: true },
    NOW - 2,
  );
  await saveOsFingerprint('vpn1', { os: 'linux', confidence: 'high', reason: 'ttl' }, NOW - 2);
  await saveExitResult('vpn1', '203.0.113.9', 'NL', { timezone: 'Europe/Amsterdam' }, NOW - 2);
}

describe('(h) persistServerProbe — a fleet FAILURE on a VPN row supersedes the exit', () => {
  it('CRITICAL every server-measured field goes, the exit is stamped superseded, and the verdict triple stays', async () => {
    await seedMeasured();
    const cache = await persistServerProbe('vpn1', serverProbeOutcome(FLEET_FAILED, NOW), {
      adoptExit: true,
    });
    const entry = cache?.vpn1;
    expect(entry?.serverLatencyMs).toBeUndefined();
    expect(entry?.measuredFrom).toBeUndefined();
    expect(entry?.nodeId).toBeUndefined();
    expect(entry?.quicProbe).toBeUndefined();
    expect(entry?.osFingerprint).toBeUndefined();
    expect(entry?.exitIp).toBeUndefined();
    expect(entry?.exitCountry).toBeUndefined();
    expect(entry?.exitTimezone).toBeUndefined();
    expect(entry?.exitAt).toBeUndefined();
    expect(entry?.serverProbeAt).toBeUndefined();
    expect(entry?.exitSupersededAt).toBe(NOW);
    // (h) finding 3 — the fleet's sentence is persisted WITH the stamp, so the
    // card and a remounted grid render the same verdict.
    expect(entry?.fleetFailureReason).toBe(FLEET_DOWN);
    expect(entry?.at).toBe(NOW - 3);
    expect(entry?.endpoint).toEqual({ resolved: true, ip: '198.51.100.1', message: 'Resolved' });
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      'at',
      'endpoint',
      'exitSupersededAt',
      'fleetFailureReason',
      'result',
    ]);
  });

  // MUTATION: drop the `superseded` predicate in `refusesStoredExit` (the list
  // adoption's shared rule) and the old exit reappears here → red. ⛔ (i) I1 —
  // the `at <= exitSupersededAt` refusal inside saveExitResult is NOT what this
  // arm exercises: the adoption refuses BEFORE the write is reached, so that
  // guard could be dropped with this arm green. It has its own direct arms
  // below ("saveExitResult itself refuses…").
  it('CRITICAL the account list cannot resurrect the exit the fleet just contradicted (observed BEFORE the failure)', async () => {
    await seedMeasured();
    await persistServerProbe('vpn1', serverProbeOutcome(FLEET_FAILED, NOW), { adoptExit: true });
    const written = await adoptListExitObserved(LIST_ROW(NOW - 1), [vpnRow()], NOW + 5);
    expect(written).toEqual([]);
    const entry = (await loadProbeCache()).vpn1;
    expect(entry?.exitIp).toBeUndefined();
    expect(entry?.exitSupersededAt).toBe(NOW);
  });

  it('CONTROL — an observation dated AFTER the failure is a tunnel seen up again: adopted, and the stamp clears', async () => {
    await seedMeasured();
    await persistServerProbe('vpn1', serverProbeOutcome(FLEET_FAILED, NOW), { adoptExit: true });
    const written = await adoptListExitObserved(LIST_ROW(NOW + 1000), [vpnRow()], NOW + 5000);
    expect(written).toEqual(['vpn1']);
    const entry = (await loadProbeCache()).vpn1;
    expect(entry?.exitIp).toBe('203.0.113.9');
    expect(entry?.exitAt).toBe(NOW + 1000);
    expect(entry?.exitSupersededAt).toBeUndefined();
  });

  // (i) I1 — the write's OWN guard, reached directly. Every caller (the list
  // adoption, the not_run adoption) refuses first through `refusesStoredExit`,
  // so dropping `at <= prior.exitSupersededAt` in saveExitResult reds ONLY here.
  it('CRITICAL saveExitResult itself refuses an exit dated at or before the failure: nothing written, the stamp and the sentence stand', async () => {
    await seedMeasured();
    await persistServerProbe('vpn1', serverProbeOutcome(FLEET_FAILED, NOW), { adoptExit: true });
    const before = JSON.stringify(await loadProbeCache());
    for (const at of [NOW - 1, NOW]) {
      const cache = await saveExitResult('vpn1', '198.51.100.200', 'DE', { city: 'Berlin' }, at);
      expect(cache.vpn1?.exitIp, String(at)).toBeUndefined();
      expect(cache.vpn1?.exitAt, String(at)).toBeUndefined();
      expect(cache.vpn1?.exitSupersededAt, String(at)).toBe(NOW);
      expect(cache.vpn1?.fleetFailureReason, String(at)).toBe(FLEET_DOWN);
    }
    expect(JSON.stringify(await loadProbeCache())).toBe(before);
  });

  it('CONTROL — saveExitResult with an exit dated AFTER the failure writes it and clears the stamp and the sentence', async () => {
    await seedMeasured();
    await persistServerProbe('vpn1', serverProbeOutcome(FLEET_FAILED, NOW), { adoptExit: true });
    const cache = await saveExitResult('vpn1', '198.51.100.200', 'DE', { city: 'Berlin' }, NOW + 1);
    expect(cache.vpn1?.exitIp).toBe('198.51.100.200');
    expect(cache.vpn1?.exitCountry).toBe('DE');
    expect(cache.vpn1?.exitCity).toBe('Berlin');
    expect(cache.vpn1?.exitAt).toBe(NOW + 1);
    expect(cache.vpn1?.exitSupersededAt).toBeUndefined();
    expect(cache.vpn1?.fleetFailureReason).toBeUndefined();
    // The verdict triple is untouched by the exit write.
    expect(cache.vpn1?.at).toBe(NOW - 3);
    expect((await loadProbeCache()).vpn1?.exitIp).toBe('198.51.100.200');
  });

  it('the next pre-flight (same address) carries the superseded stamp forward, not an exit', async () => {
    await seedMeasured();
    await persistServerProbe('vpn1', serverProbeOutcome(FLEET_FAILED, NOW), { adoptExit: true });
    const cache = await saveEndpointResult(
      'vpn1',
      { resolved: true, ip: '198.51.100.1', message: 'Resolved' },
      NOW + 1,
    );
    expect(cache.vpn1?.exitSupersededAt).toBe(NOW);
    expect(cache.vpn1?.exitIp).toBeUndefined();
    expect(cache.vpn1?.serverLatencyMs).toBeUndefined();
  });

  it('VACUITY CONTROL — a SOCKS5 caller (no adoptExit) still writes nothing on a failure', async () => {
    await seedMeasured();
    const before = JSON.stringify(await loadProbeCache());
    expect(await persistServerProbe('vpn1', serverProbeOutcome(FLEET_FAILED, NOW))).toBeNull();
    expect(JSON.stringify(await loadProbeCache())).toBe(before);
  });
});

describe('(h) the Proxies grid — a failed tunnel stays failed across cache emits, and "Tested" dates the fleet number', () => {
  it('CRITICAL after a fleet failure a later cache emit from ANY writer does not re-hydrate the old exit, latency or vantage', async () => {
    await seedMeasured();
    testAccountProxy.mockResolvedValue(FLEET_FAILED);
    render(<ProxiesView />);
    expect(await screen.findByText('42ms')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.9')).toBeInTheDocument();
    await clickCheck();
    expect(await screen.findByText('tunnel down')).toBeInTheDocument();
    await waitFor(() =>
      expect(loadProbeCache().then((c) => c.vpn1?.exitSupersededAt)).resolves.toEqual(
        expect.any(Number),
      ),
    );
    // Another writer emits the whole map (finding 1's exact trigger).
    await saveEndpointResult('other', { resolved: true, ip: '1.2.3.4', message: 'ok' }, NOW);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('tunnel down')).toBeInTheDocument();
    expect(screen.queryByText('42ms')).toBeNull();
    expect(screen.queryByText('203.0.113.9')).toBeNull();
    expect(screen.queryByText('from a fleet Mac')).toBeNull();
  });

  // Finding 28 — after a refusal the Tested column read "just now" (the
  // pre-flight's stamp) beside a carried-over fleet number. MUTATION: drop the
  // serverProbeStamps merge in ProxiesView's cache hydration → red.
  it('CRITICAL after a REFUSED test "Tested" still dates the fleet measurement the row shows, not the pre-flight', async () => {
    await saveEndpointResult(
      'vpn1',
      { resolved: true, ip: '198.51.100.1', message: 'Resolved' },
      NOW - 2,
    );
    await saveServerProbeResult(
      'vpn1',
      { latencyMs: 42, measuredFrom: 'fleet', nodeId: 'mac-07', quicProbe: true },
      NOW - 1,
    );
    testAccountProxy.mockResolvedValue(NODE_BUSY);
    const { container } = render(<ProxiesView />);
    expect(await screen.findByText('42ms')).toBeInTheDocument();
    await clickCheck();
    expect(await screen.findByText(BUSY)).toBeInTheDocument();
    await waitFor(() =>
      expect(loadProbeCache().then((c) => c.vpn1?.at)).resolves.not.toBe(NOW - 2),
    );
    expect(screen.getByText('42ms')).toBeInTheDocument();
    const tested = container.querySelector('time[title^="Tested"]');
    expect(tested?.getAttribute('title')).toBe(`Tested: ${new Date(NOW - 1).toLocaleString()}`);
    expect((await loadProbeCache()).vpn1?.serverProbeAt).toBe(NOW - 1);
  });
});

// (h) finding 1 — the superseded-exit rule was bypassed by the /test reply's
// OWN exit_observed: a `no_node` / `live_session` refusal attaches the server's
// STORED exit (which the server never clears on a failed probe), and the client
// adopted it at the REPLY time — always after the failure stamp — so the stamp
// was stripped and the pre-failure exit re-written with a fresh exitAt: back on
// the grid and the card beside "No fleet Mac was free…", and fresh enough for
// the launch's isExitIdentityFresh gate. The list adoption refused the SAME
// datum (observed_at ≤ stamp): two paths, one datum, opposite decisions. The
// reply now dates the stored exit (`observed_at`), and both paths run ONE rule.
const NO_NODE_SENTENCE = 'No fleet Mac was free to test this VPN tunnel. Try again in a minute.';
function noNodeWithStoredExit(
  observedAt: string | null | undefined,
): AccountProxiesModule.AccountProxyTestResult {
  return {
    ok: false,
    reason: NO_NODE_SENTENCE,
    measured_from: 'control_plane',
    not_run: 'no_node',
    exit_observed: {
      ...SESSION_EXIT,
      ...(observedAt === undefined ? {} : { observed_at: observedAt }),
    },
  };
}

describe('(h) finding 1 — a refusal’s STORED exit cannot walk past the superseded stamp', () => {
  // MUTATION: date the not_run adoption at `outcome.at` again (drop
  // storedExitStamp) → NOW + 10 > NOW → the exit is adopted and the stamp
  // stripped → red.
  it('CRITICAL persistServerProbe: a stored exit observed BEFORE the failure is refused, the stamp stands, no exit is written', async () => {
    await seedMeasured();
    await persistServerProbe('vpn1', serverProbeOutcome(FLEET_FAILED, NOW), { adoptExit: true });
    const written = await persistServerProbe(
      'vpn1',
      serverProbeOutcome(noNodeWithStoredExit(new Date(NOW - 2).toISOString()), NOW + 10),
      { adoptExit: true },
    );
    expect(written).toBeNull();
    const entry = (await loadProbeCache()).vpn1;
    expect(entry?.exitIp).toBeUndefined();
    expect(entry?.exitAt).toBeUndefined();
    expect(entry?.exitSupersededAt).toBe(NOW);
  });

  it('CONTROL — a stored exit observed AFTER the failure is the tunnel seen up again: adopted at the OBSERVATION’s time, and the stamp clears', async () => {
    await seedMeasured();
    await persistServerProbe('vpn1', serverProbeOutcome(FLEET_FAILED, NOW), { adoptExit: true });
    const written = await persistServerProbe(
      'vpn1',
      serverProbeOutcome(noNodeWithStoredExit(new Date(NOW + 5).toISOString()), NOW + 10),
      { adoptExit: true },
    );
    expect(written?.vpn1?.exitIp).toBe('203.0.113.9');
    expect(written?.vpn1?.exitAt).toBe(NOW + 5);
    expect(written?.vpn1?.exitSupersededAt).toBeUndefined();
  });

  it('an UNDATED stored exit (observed_at null, or absent) is refused while the stamp stands — nothing shows it postdates the failure', async () => {
    for (const undated of [null, undefined] as const) {
      stores.clear();
      await seedMeasured();
      await persistServerProbe('vpn1', serverProbeOutcome(FLEET_FAILED, NOW), {
        adoptExit: true,
      });
      const written = await persistServerProbe(
        'vpn1',
        serverProbeOutcome(noNodeWithStoredExit(undated), NOW + 10),
        { adoptExit: true },
      );
      expect(written, String(undated)).toBeNull();
      expect((await loadProbeCache()).vpn1?.exitIp, String(undated)).toBeUndefined();
    }
  });

  it('VACUITY CONTROL — undated with NO stamp is adopted at the reply time, as before', async () => {
    await saveEndpointResult(
      'vpn1',
      { resolved: true, ip: '198.51.100.1', message: 'Resolved' },
      NOW - 3,
    );
    const written = await persistServerProbe(
      'vpn1',
      serverProbeOutcome(noNodeWithStoredExit(null), NOW + 10),
      { adoptExit: true },
    );
    expect(written?.vpn1?.exitIp).toBe('203.0.113.9');
    expect(written?.vpn1?.exitAt).toBe(NOW + 10);
  });

  it('the account list runs the SAME rule: an undated list observation is refused while the stamp stands', async () => {
    await seedMeasured();
    await persistServerProbe('vpn1', serverProbeOutcome(FLEET_FAILED, NOW), { adoptExit: true });
    const rows = [
      {
        id: 'aprx_vpn',
        exit_observed: {
          ip: '203.0.113.9',
          country: 'NL' as string | null,
          timezone: 'Europe/Amsterdam' as string | null,
          observed_via: 'session' as const,
          observed_at: null,
        },
      },
    ];
    expect(await adoptListExitObserved(rows, [vpnRow()], NOW + 5)).toEqual([]);
    expect((await loadProbeCache()).vpn1?.exitIp).toBeUndefined();
  });

  it('CRITICAL the grid: after "tunnel down", a no_node that attaches the pre-failure exit leaves the exit cell EMPTY and the stamp intact', async () => {
    // Real clock here: the grid stamps the failure at Date.now(), so the
    // stored observation is dated a minute before the test starts.
    const beforeFailure = new Date(Date.now() - 60_000).toISOString();
    await seedMeasured();
    testAccountProxy.mockResolvedValue(FLEET_FAILED);
    render(<ProxiesView />);
    expect(await screen.findByText('203.0.113.9')).toBeInTheDocument();
    await clickCheck();
    expect(await screen.findByText('tunnel down')).toBeInTheDocument();
    await waitFor(() =>
      expect(loadProbeCache().then((c) => c.vpn1?.exitSupersededAt)).resolves.toEqual(
        expect.any(Number),
      ),
    );
    expect(screen.queryByText('203.0.113.9')).toBeNull();
    testAccountProxy.mockResolvedValue(noNodeWithStoredExit(beforeFailure));
    await clickCheck();
    expect(await screen.findByText(NO_NODE_SENTENCE)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('203.0.113.9')).toBeNull();
    const entry = (await loadProbeCache()).vpn1;
    expect(entry?.exitIp).toBeUndefined();
    expect(entry?.exitSupersededAt).toEqual(expect.any(Number));
    // (h) finding 3 — the not_run said nothing about the tunnel: the last
    // verdict stands beside the notice, on this grid and in the cache.
    expect(screen.getByText('tunnel down')).toBeInTheDocument();
    expect(entry?.fleetFailureReason).toBe(FLEET_DOWN);
  });
});

// (h) finding 3 — the "fleet down" state lived only in the view that ran the
// check: the grid's in-memory vpnFailures was gone on remount even though the
// cache still stamped the failure, and the profile card never saw it at all.
// The sentence is persisted with the stamp and both views read it from there.
describe('(h) finding 3 — the failure is the cache’s: a remounted grid still shows it', () => {
  // MUTATION: drop `fleetFailureReasons` from the grid's hydration → after the
  // remount the row reads "endpoint ok" with no sentence → red.
  it('CRITICAL unmount after a fleet failure, render again → "tunnel down" + the sentence, from the cache alone', async () => {
    await seedMeasured();
    testAccountProxy.mockResolvedValue(FLEET_FAILED);
    const first = render(<ProxiesView />);
    await clickCheck();
    expect(await screen.findByText('tunnel down')).toBeInTheDocument();
    await waitFor(() =>
      expect(loadProbeCache().then((c) => c.vpn1?.fleetFailureReason)).resolves.toBe(FLEET_DOWN),
    );
    first.unmount();
    render(<ProxiesView />);
    expect(await screen.findByText('tunnel down')).toBeInTheDocument();
    expect(screen.getByText(FLEET_DOWN)).toBeInTheDocument();
    expect(screen.queryByText('42ms')).toBeNull();
    expect(screen.queryByText('203.0.113.9')).toBeNull();
    expect(testAccountProxy).toHaveBeenCalledTimes(1); // nothing re-ran; it was read
  });

  it('CONTROL — a fleet ok after the failure clears it everywhere: the cache drops the sentence and the row reads "tunnel up"', async () => {
    await seedMeasured();
    testAccountProxy.mockResolvedValue(FLEET_FAILED);
    render(<ProxiesView />);
    await clickCheck();
    expect(await screen.findByText('tunnel down')).toBeInTheDocument();
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 31,
      measured_from: 'fleet',
      node_id: 'mac-07',
    });
    await clickCheck();
    expect(await screen.findByText('tunnel up')).toBeInTheDocument();
    expect(screen.queryByText('tunnel down')).toBeNull();
    await waitFor(() =>
      expect(loadProbeCache().then((c) => c.vpn1?.fleetFailureReason)).resolves.toBeUndefined(),
    );
  });
});

// (i) I5 — an `unavailable` outcome (the request threw: network, auth, a
// malformed body) is not a verdict about the tunnel. The grid used to clear
// the previous check's notice and say nothing — the row's standing failure was
// kept only by accident of the failed/ok branches not running. Now: the last
// verdict stands (the red pill, the cache's sentence), and "the server did not
// answer" is a transient notice beside it, cleared by the next check like
// every other notice.
describe('(i) I5 — "the server did not answer" keeps the last verdict and is a transient notice', () => {
  // MUTATION: drop vpnFailures (or call dropServerState) on `unavailable` in
  // handleCheckEndpoint → the pill reads "endpoint ok" → red.
  it('CRITICAL after "tunnel down", a check the server does not answer keeps the red pill and the sentence, and adds the notice in muted ink', async () => {
    await seedMeasured();
    testAccountProxy.mockResolvedValue(FLEET_FAILED);
    render(<ProxiesView />);
    await clickCheck();
    expect(await screen.findByText('tunnel down')).toBeInTheDocument();
    await waitFor(() =>
      expect(loadProbeCache().then((c) => c.vpn1?.fleetFailureReason)).resolves.toBe(FLEET_DOWN),
    );
    testAccountProxy.mockRejectedValue(new Error('offline'));
    await clickCheck();
    const notice = await screen.findByText(SERVER_DID_NOT_ANSWER_NOTICE);
    expect(notice.className).toContain('text-ink-muted');
    expect(notice.className).not.toContain('text-status-error');
    expect(screen.getByText('tunnel down')).toBeInTheDocument();
    expect(screen.getByText(FLEET_DOWN).className).toContain('text-status-error');
    expect(screen.queryByText('endpoint ok')).toBeNull();
    const entry = (await loadProbeCache()).vpn1;
    expect(entry?.fleetFailureReason).toBe(FLEET_DOWN);
    expect(entry?.exitSupersededAt).toEqual(expect.any(Number));
    expect(entry?.exitIp).toBeUndefined();
  });

  it('CONTROL — the notice is transient: the next check that answers replaces it', async () => {
    testAccountProxy.mockRejectedValue(new Error('offline'));
    render(<ProxiesView />);
    await clickCheck();
    expect(await screen.findByText(SERVER_DID_NOT_ANSWER_NOTICE)).toBeInTheDocument();
    expect(screen.getByText('endpoint ok')).toBeInTheDocument();
    testAccountProxy.mockResolvedValue(NODE_BUSY);
    await clickCheck();
    expect(await screen.findByText(BUSY)).toBeInTheDocument();
    expect(screen.queryByText(SERVER_DID_NOT_ANSWER_NOTICE)).toBeNull();
  });

  it('a standing fleet measurement survives it too: the row keeps its latency, vantage and exit', async () => {
    await seedMeasured();
    testAccountProxy.mockRejectedValue(new Error('offline'));
    render(<ProxiesView />);
    expect(await screen.findByText('42ms')).toBeInTheDocument();
    await clickCheck();
    expect(await screen.findByText(SERVER_DID_NOT_ANSWER_NOTICE)).toBeInTheDocument();
    expect(screen.getByText('42ms')).toBeInTheDocument();
    expect(screen.getByText('from a fleet Mac')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.9')).toBeInTheDocument();
    expect(screen.getByText('tunnel up')).toBeInTheDocument();
  });

  it('Test all tallies the unanswered row as "not tested (the server did not answer)"', async () => {
    testAccountProxy.mockRejectedValue(new Error('offline'));
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));
    expect(
      await screen.findByText(
        '1 VPN tunnel not tested (the server did not answer) — nothing was tested',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/VPN tunnels? up/)).toBeNull();
  });

  // (j) J3 — "The last verdict stands" was FALSE when the pre-flight resolved
  // the endpoint to a DIFFERENT address: `saveEndpointResult` carries the fleet
  // fields over only for the same address, so that write had already dropped
  // the verdict the notice claimed was standing. The same-address arm above
  // ('a standing fleet measurement survives it too') is the control.
  // MUTATION: drop `endpointMoved` from the notice pick → the standing-verdict
  // sentence renders beside a row that has none → red.
  it('CRITICAL after the endpoint MOVES, an unanswered check says "Endpoint moved; no verdict yet" — never that the last verdict stands (it is gone)', async () => {
    await seedMeasured(); // endpoint 198.51.100.1, fleet 42ms, exit 203.0.113.9
    const Proxies = await import('../../src/lib/proxies');
    vi.mocked(Proxies.resolveEndpoint).mockResolvedValueOnce({
      resolved: true,
      ip: '198.51.100.2',
      message: 'Resolved',
    });
    testAccountProxy.mockRejectedValue(new Error('offline'));
    render(<ProxiesView />);
    expect(await screen.findByText('42ms')).toBeInTheDocument();
    await clickCheck();
    const notice = await screen.findByText(
      'The server did not answer, so the tunnel was not tested. Endpoint moved; no verdict yet — try again.',
    );
    expect(notice.className).toContain('text-ink-muted');
    expect(screen.queryByText(SERVER_DID_NOT_ANSWER_NOTICE)).toBeNull();
    // The verdict really is gone — the notice describes the row it sits beside.
    expect(screen.queryByText('42ms')).toBeNull();
    expect(screen.queryByText('tunnel up')).toBeNull();
    const entry = (await loadProbeCache()).vpn1;
    expect(entry?.endpoint).toEqual({ resolved: true, ip: '198.51.100.2', message: 'Resolved' });
    expect(entry?.serverLatencyMs).toBeUndefined();
    expect(entry?.exitIp).toBeUndefined();
  });

  it('CONTROL — the SAME address keeps the verdict, and the notice says so (the pick is on the address, not on the check)', async () => {
    await seedMeasured();
    testAccountProxy.mockRejectedValue(new Error('offline'));
    render(<ProxiesView />);
    expect(await screen.findByText('42ms')).toBeInTheDocument();
    await clickCheck();
    expect(await screen.findByText(SERVER_DID_NOT_ANSWER_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(/Endpoint moved/)).toBeNull();
    expect(screen.getByText('42ms')).toBeInTheDocument();
    expect((await loadProbeCache()).vpn1?.serverLatencyMs).toBe(42);
  });
});

// (i) I6 — a 403 on /test is the route's TIER refusal (finding 2 made the
// server throw it instead of swallowing it into "no Mac was free"). The
// transport threw on every non-2xx, which the shared step turned into
// `unavailable` — "the server did not answer" — for an account whose retry
// can never succeed. It is now a client-minted `not_run` ('plan_excluded'):
// a notice, a skipped row, never a failure and never "did not answer".
const TIER_DETAIL =
  'The "vpnEgress" feature is not available on the "free" tier. Upgrade to a tier that includes this feature.';
const problem403 = (body: string): Response =>
  new Response(body, { status: 403, headers: { 'content-type': 'application/problem+json' } });

describe('(i) I6 — a 403 on /test is the tier refusal, surfaced as a not_run', () => {
  it('CRITICAL the wire: 403 + problem detail → not_run plan_excluded, the plan sentence and the detail', async () => {
    nextResponse = () =>
      problem403(
        JSON.stringify({
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: TIER_DETAIL,
        }),
      );
    const r = await real.testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' });
    expect(r).toEqual({
      ok: false,
      reason: `${real.PLAN_EXCLUDES_FLEET_TEST_REASON} ${TIER_DETAIL}`,
      not_run: 'plan_excluded',
    });
    expect(real.PLAN_EXCLUDES_FLEET_TEST_REASON).toBe(
      'Your plan does not include fleet tests for VPN proxies.',
    );
  });

  // (i) I6 follow-up (review) — the route answers 403 for a key without the
  // `account_owner` scope, a suspended account, the device-key deny gate…
  // none of which is a plan exclusion. Only the TIER detail is. ((j) J4 — the
  // free-desktop ROUTE-POLICY 403 is its own not_run now; see below.)
  it('CRITICAL a 403 that is NOT the tier refusal (scope / suspended / device-key gate / unreadable body) throws like any other non-2xx — never a plan exclusion', async () => {
    const notTier = [
      JSON.stringify({ status: 403, detail: 'This action requires the "account_owner" scope.' }),
      JSON.stringify({ status: 403, detail: 'Account is suspended.' }),
      JSON.stringify({
        status: 403,
        detail:
          'This operation is not permitted with a device-provisioned key. Use a dashboard session.',
      }),
      '<html>forbidden</html>',
      '{}',
      '',
    ];
    for (const body of notTier) {
      nextResponse = () =>
        new Response(body, {
          status: 403,
          headers: { 'content-type': 'application/problem+json' },
        });
      await expect(
        real.testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' }),
        JSON.stringify(body),
      ).rejects.toThrow('proxy test failed: 403');
    }
    // The discriminator, pinned on the server's own sentence shape.
    expect(real.isTierRefusalDetail(TIER_DETAIL)).toBe(true);
    expect(
      real.isTierRefusalDetail(
        'The "aiAgent" feature is not available on the "starter" tier. Upgrade to a tier that includes this feature.',
      ),
    ).toBe(true);
    expect(real.isTierRefusalDetail('This action requires the "account_owner" scope.')).toBe(false);
    expect(real.isTierRefusalDetail('Account is suspended.')).toBe(false);
    expect(real.isTierRefusalDetail(undefined)).toBe(false);
  });

  it('CONTROL — every other non-2xx still throws (→ `unavailable` in the shared step), and the wire never admits plan_excluded', async () => {
    for (const status of [401, 404, 429, 500, 502]) {
      nextResponse = () => new Response('{}', { status });
      await expect(
        real.testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' }),
        String(status),
      ).rejects.toThrow(`proxy test failed: ${String(status)}`);
    }
    nextResponse = () =>
      json({ ok: false, reason: 'x', measured_from: 'control_plane', not_run: 'plan_excluded' });
    expect(await real.testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' })).toEqual({
      ok: false,
      reason: 'x',
      measured_from: 'control_plane',
    });
    // (j) J4 — nor the other client-minted value.
    nextResponse = () =>
      json({
        ok: false,
        reason: 'x',
        measured_from: 'control_plane',
        not_run: 'desktop_credential',
      });
    expect(await real.testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' })).toEqual({
      ok: false,
      reason: 'x',
      measured_from: 'control_plane',
    });
  });

  it('serverProbeOutcome carries it as not_run / plan_excluded with the sentence', () => {
    expect(
      serverProbeOutcome(
        { ok: false, reason: real.PLAN_EXCLUDES_FLEET_TEST_REASON, not_run: 'plan_excluded' },
        NOW,
      ),
    ).toEqual({
      kind: 'not_run',
      at: NOW,
      why: 'plan_excluded',
      reason: real.PLAN_EXCLUDES_FLEET_TEST_REASON,
    });
  });

  it('CRITICAL the grid: a muted notice beside "endpoint ok", never "tunnel down" or "did not answer"; Test all counts the row skipped (not included in your plan)', async () => {
    testAccountProxy.mockResolvedValue({
      ok: false,
      reason: real.PLAN_EXCLUDES_FLEET_TEST_REASON,
      not_run: 'plan_excluded',
    });
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));
    const notice = await screen.findByText(real.PLAN_EXCLUDES_FLEET_TEST_REASON);
    expect(notice.className).toContain('text-ink-muted');
    expect(screen.queryByText('tunnel down')).toBeNull();
    expect(screen.queryByText(SERVER_DID_NOT_ANSWER_NOTICE)).toBeNull();
    expect(screen.getByText('endpoint ok')).toBeInTheDocument();
    expect(
      await screen.findByText(
        '1 VPN tunnel skipped (not included in your plan) — nothing was tested',
      ),
    ).toBeInTheDocument();
    expect((await loadProbeCache()).vpn1?.fleetFailureReason).toBeUndefined();
  });
});

// (j) J4 — a 403 on /test from the free-desktop ROUTE POLICY (a Free tier's
// browser-authorised `cli_device` credential; `POST …/proxies/:id/test` is not
// in FREE_DESKTOP_ALLOWED_ROUTES). Both 403s are `ForbiddenError`s with the
// same problem `type` and title, so the server's detail sentence discriminates:
// the route-policy one is its own not_run ('desktop_credential') — "needs an
// API key from the dashboard" — never the TIER notice ("not included in your
// plan") and never "the server did not answer".
const ROUTE_POLICY_DETAIL =
  'This Free desktop credential cannot access this API route. Use the Driftstack desktop app or upgrade to an API-enabled tier.';

describe('(j) J4 — the free-desktop route-policy 403 is "needs an API key", never the tier notice', () => {
  // MUTATION: route the policy detail through the tier arm (or drop the arm) →
  // plan_excluded / a throw → red.
  it('CRITICAL the wire: 403 + the route-policy detail → not_run desktop_credential with the API-key sentence and the detail — not plan_excluded', async () => {
    nextResponse = () =>
      problem403(
        JSON.stringify({
          type: 'https://errors.driftstack.dev/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: ROUTE_POLICY_DETAIL,
        }),
      );
    const r = await real.testAccountProxy('http://x', 'k', 'aprx_vpn', { vantage: 'fleet' });
    expect(r).toEqual({
      ok: false,
      reason: `${real.DESKTOP_CREDENTIAL_FLEET_TEST_REASON} ${ROUTE_POLICY_DETAIL}`,
      not_run: 'desktop_credential',
    });
    expect(real.DESKTOP_CREDENTIAL_FLEET_TEST_REASON).toBe(
      'Fleet tests need an API key from the dashboard.',
    );
    // The toEqual above pins the whole sentence; this names the claim.
    expect(real.DESKTOP_CREDENTIAL_FLEET_TEST_REASON).not.toContain(
      real.PLAN_EXCLUDES_FLEET_TEST_REASON,
    );
  });

  it('the two discriminators are disjoint: neither sentence matches the other arm', () => {
    expect(real.isDesktopCredentialRefusalDetail(ROUTE_POLICY_DETAIL)).toBe(true);
    expect(real.isTierRefusalDetail(ROUTE_POLICY_DETAIL)).toBe(false);
    expect(real.isDesktopCredentialRefusalDetail(TIER_DETAIL)).toBe(false);
    expect(real.isTierRefusalDetail(TIER_DETAIL)).toBe(true);
    expect(
      real.isDesktopCredentialRefusalDetail(
        'This operation is not permitted with a device-provisioned key. Use a dashboard session.',
      ),
    ).toBe(false);
    expect(real.isDesktopCredentialRefusalDetail(undefined)).toBe(false);
  });

  it('CRITICAL the grid: the API-key sentence as a muted notice beside "endpoint ok" — never "not included in your plan", "tunnel down" or "did not answer"; Test all counts the row NOT TESTED (needs an API key from the dashboard)', async () => {
    testAccountProxy.mockResolvedValue({
      ok: false,
      reason: `${real.DESKTOP_CREDENTIAL_FLEET_TEST_REASON} ${ROUTE_POLICY_DETAIL}`,
      not_run: 'desktop_credential',
    });
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));
    const notice = await screen.findByText(
      `${real.DESKTOP_CREDENTIAL_FLEET_TEST_REASON} ${ROUTE_POLICY_DETAIL}`,
    );
    expect(notice.className).toContain('text-ink-muted');
    expect(screen.queryByText(/not included in your plan/)).toBeNull();
    expect(screen.queryByText('tunnel down')).toBeNull();
    expect(screen.queryByText(SERVER_DID_NOT_ANSWER_NOTICE)).toBeNull();
    expect(screen.getByText('endpoint ok')).toBeInTheDocument();
    // "not tested", like a row with no API key — not "skipped" (a refusal of
    // the row) and not the tier's clause.
    expect(
      await screen.findByText(
        '1 VPN tunnel not tested (needs an API key from the dashboard) — nothing was tested',
      ),
    ).toBeInTheDocument();
    expect((await loadProbeCache()).vpn1?.fleetFailureReason).toBeUndefined();
  });
});

// (i) I7 follow-up (review of the batch) — the server emits `exit_superseded_at`
// on the /proxies list; this is the CONSUMER. A Mac that never ran the failing
// test has no local stamp, so `refusesStoredExit`'s local predicate could not
// refuse the contradicted exit: the list adoption now refuses by the SERVER's
// stamp and stamps the local entry exactly as the Mac that ran the test did.
describe('(i) I7 — the list adoption honours the server’s exit_superseded_at on a Mac with no local stamp', () => {
  const STAMP = NOW; // the fleet verdict's time, as the list carries it
  const listRow = (observedAt: number, supersededAt: number | null | undefined) => ({
    ...LIST_ROW(observedAt)[0]!,
    ...(supersededAt === undefined
      ? {}
      : {
          exit_superseded_at: supersededAt === null ? null : new Date(supersededAt).toISOString(),
        }),
  });

  it('CRITICAL second Mac (exit adopted earlier, no local stamp): the contradicted exit is refused, the local exit is DROPPED and the entry stamped at the server’s time', async () => {
    await seedMeasured(); // exit at NOW-2, fleet fields, no stamp — a Mac that saw the tunnel up
    const written = await adoptListExitObserved([listRow(NOW - 1, STAMP)], [vpnRow()], NOW + 5);
    expect(written).toEqual([]);
    const entry = (await loadProbeCache()).vpn1;
    expect(entry?.exitIp).toBeUndefined();
    expect(entry?.exitAt).toBeUndefined();
    expect(entry?.serverLatencyMs).toBeUndefined();
    expect(entry?.measuredFrom).toBeUndefined();
    expect(entry?.exitSupersededAt).toBe(STAMP);
    expect(entry?.fleetFailureReason).toBe(LIST_TUNNEL_DOWN_REASON);
    // The verdict triple (the endpoint DID resolve) is untouched.
    expect(entry?.at).toBe(NOW - 3);
    expect(entry?.endpoint).toEqual({ resolved: true, ip: '198.51.100.1', message: 'Resolved' });
  });

  it('CRITICAL fresh install (no entry at all): the resolve invents the entry, the exit is NOT written, the entry is stamped', async () => {
    const written = await adoptListExitObserved([listRow(NOW - 1, STAMP)], [vpnRow()], NOW + 5);
    expect(written).toEqual([]);
    const entry = (await loadProbeCache()).vpn1;
    expect(entry, 'the pre-flight entry exists (second-Mac rule)').toBeDefined();
    expect(entry?.exitIp).toBeUndefined();
    expect(entry?.exitSupersededAt).toBe(STAMP);
    expect(entry?.fleetFailureReason).toBe(LIST_TUNNEL_DOWN_REASON);
  });

  // MUTATION: the two CRITICAL arms above red when the local stamp write is
  // dropped (the exit is then refused but never dropped). Dropping ONLY the
  // `serverSupersededAt` leg of `superseded` in refusesStoredExit leaves them
  // green — the stamp write runs first and the local predicate then refuses —
  // so that leg is pinned here, on an entry the stamp write must SKIP.
  it('CRITICAL the refusal holds by the server’s stamp alone when the entry is not stamped (it holds a later fleet measurement of its own)', async () => {
    await saveEndpointResult(
      'vpn1',
      { resolved: true, ip: '198.51.100.1', message: 'Resolved' },
      NOW - 3,
    );
    // This Mac's own fleet probe ran AFTER the server's contradiction (STAMP)
    // and saw no exit: the entry holds a latency dated NOW+10, no exit, no stamp.
    await saveServerProbeResult(
      'vpn1',
      { latencyMs: 40, measuredFrom: 'fleet', nodeId: 'mac-07', quicProbe: true },
      NOW + 10,
    );
    // The list still carries the pre-failure exit (observed NOW-1 <= STAMP).
    const written = await adoptListExitObserved([listRow(NOW - 1, STAMP)], [vpnRow()], NOW + 20);
    expect(written).toEqual([]);
    const entry = (await loadProbeCache()).vpn1;
    expect(entry?.exitIp, 'refused by the server’s stamp').toBeUndefined();
    expect(
      entry?.exitSupersededAt,
      'the later measurement kept the entry unstamped',
    ).toBeUndefined();
    expect(entry?.serverLatencyMs).toBe(40);
  });

  it('idempotent: a second poll with the same list writes nothing (no churn every 15s)', async () => {
    await seedMeasured();
    await adoptListExitObserved([listRow(NOW - 1, STAMP)], [vpnRow()], NOW + 5);
    const before = JSON.stringify(await loadProbeCache());
    expect(await adoptListExitObserved([listRow(NOW - 1, STAMP)], [vpnRow()], NOW + 20)).toEqual(
      [],
    );
    expect(JSON.stringify(await loadProbeCache())).toBe(before);
  });

  it('CONTROL — an observation dated AFTER the server’s stamp is the tunnel seen up again: adopted, local stamp cleared', async () => {
    await seedMeasured();
    await adoptListExitObserved([listRow(NOW - 1, STAMP)], [vpnRow()], NOW + 5);
    const written = await adoptListExitObserved(
      [listRow(STAMP + 1000, STAMP)],
      [vpnRow()],
      STAMP + 5000,
    );
    expect(written).toEqual(['vpn1']);
    const entry = (await loadProbeCache()).vpn1;
    expect(entry?.exitIp).toBe('203.0.113.9');
    expect(entry?.exitAt).toBe(STAMP + 1000);
    expect(entry?.exitSupersededAt).toBeUndefined();
    expect(entry?.fleetFailureReason).toBeUndefined();
  });

  it('CONTROL — null / absent / malformed exit_superseded_at refuses nothing and stamps nothing (an older server, a clean row)', async () => {
    for (const stamp of [null, undefined] as const) {
      await seedMeasured();
      const written = await adoptListExitObserved([listRow(NOW + 1, stamp)], [vpnRow()], NOW + 5);
      expect(written, String(stamp)).toEqual(['vpn1']);
      const entry = (await loadProbeCache()).vpn1;
      expect(entry?.exitAt, String(stamp)).toBe(NOW + 1);
      expect(entry?.exitSupersededAt, String(stamp)).toBeUndefined();
    }
    await seedMeasured();
    const malformed = { ...listRow(NOW + 1, null), exit_superseded_at: 'not-a-date' };
    expect(await adoptListExitObserved([malformed], [vpnRow()], NOW + 5)).toEqual(['vpn1']);
    expect((await loadProbeCache()).vpn1?.exitSupersededAt).toBeUndefined();
  });

  it('the Mac that ran the failing test keeps its OWN sentence when the server’s stamp is later by clock skew; an older server stamp is ignored', async () => {
    await seedMeasured();
    await persistServerProbe('vpn1', serverProbeOutcome(FLEET_FAILED, NOW), { adoptExit: true });
    // Server wrote its stamp 3s after this Mac's reply time (positive skew).
    await adoptListExitObserved([listRow(NOW - 1, NOW + 3000)], [vpnRow()], NOW + 5000);
    let entry = (await loadProbeCache()).vpn1;
    expect(entry?.exitSupersededAt).toBe(NOW + 3000);
    expect(entry?.fleetFailureReason, 'the node’s sentence survives').toBe(FLEET_DOWN);
    // An OLDER server stamp (a stale list) changes nothing.
    await adoptListExitObserved([listRow(NOW - 1, NOW - 60_000)], [vpnRow()], NOW + 6000);
    entry = (await loadProbeCache()).vpn1;
    expect(entry?.exitSupersededAt).toBe(NOW + 3000);
    expect(entry?.fleetFailureReason).toBe(FLEET_DOWN);
  });

  it('a measurement this Mac made AFTER the server’s stamp outranks a list that has not caught up: nothing dropped, nothing stamped', async () => {
    await seedMeasured(); // fleet fields + exit at NOW-2
    // The server says the tunnel was down at NOW-10; this Mac saw it up at NOW-2.
    const written = await adoptListExitObserved([listRow(NOW - 20, NOW - 10)], [vpnRow()], NOW);
    expect(written).toEqual([]); // the NOW-20 observation is a rewind anyway
    const entry = (await loadProbeCache()).vpn1;
    expect(entry?.exitIp).toBe('203.0.113.9');
    expect(entry?.exitAt).toBe(NOW - 2);
    expect(entry?.serverLatencyMs).toBe(42);
    expect(entry?.exitSupersededAt).toBeUndefined();
  });

  it('SOCKS5 rows are untouched by a stamp (VPN rows only, as ever)', async () => {
    await saveEndpointResult(
      'socks1',
      { resolved: true, ip: '198.51.100.2', message: 'Resolved' },
      NOW - 3,
    );
    const row = { ...listRow(NOW - 1, STAMP), id: 'aprx_socks' };
    const socks = { ...socks5Row(), id: 'socks1', serverId: 'aprx_socks' };
    expect(await adoptListExitObserved([row], [socks], NOW + 5)).toEqual([]);
    expect((await loadProbeCache()).socks1?.exitSupersededAt).toBeUndefined();
  });

  it('CRITICAL the wire: listProxies keeps exit_superseded_at as a string or null and nulls anything else', async () => {
    const base = {
      id: 'aprx_vpn',
      label: 'v',
      scheme: 'wireguard',
      host: 'h',
      port: 1,
      username: null,
      has_password: false,
      created_at: 'c',
      updated_at: 'u',
      exit_observed: null,
    };
    nextResponse = () =>
      json({
        data: [
          { ...base, id: 'a', exit_superseded_at: '2026-09-10T08:00:00.000Z' },
          { ...base, id: 'b', exit_superseded_at: null },
          { ...base, id: 'c', exit_superseded_at: 12345 },
          { ...base, id: 'd' },
        ],
      });
    const rows = await real.listProxies('http://x', 'k');
    expect(rows.map((r) => [r.id, r.exit_superseded_at])).toEqual([
      ['a', '2026-09-10T08:00:00.000Z'],
      ['b', null],
      ['c', null],
      ['d', undefined],
    ]);
    expect('exit_superseded_at' in rows[3]!).toBe(false);
  });
});
