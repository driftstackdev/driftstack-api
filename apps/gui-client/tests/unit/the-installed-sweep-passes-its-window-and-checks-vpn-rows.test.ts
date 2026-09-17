// 2026-09-17 — a WIRING test, not another unit test of the planner.
//
// Two pieces of tested machinery sat behind the installed proxy sweep and neither
// was connected to it:
//
//   (a) `checkEndpointRowForSweep` exists so the sweep can re-check VPN / HTTP rows,
//       and `runSweep` plans those rows only when it is handed a `checkEndpoint` —
//       which App.tsx never passed, so every such row was excluded from every sweep.
//   (b) `installProxySweepSchedule` hands each trigger ITS staleness window (20 min
//       on app-open / focus, the 6 h TTL on the interval), and App.tsx's
//       `const sweep = () => runSweep(deps)` ignored the argument — so the short
//       window was discarded and every trigger waited six hours.
//
// Both halves had green unit tests the whole time, which is the point: the planner
// was right and nothing called it that way. So this file drives the INSTALLED
// function — `runInstalledSweep`, the one App.tsx hands to the schedule — against
// the real cache, and pins that App.tsx hands it over with the run it was given.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

const requests: Array<{ method: string; url: string; auth: string | undefined }> = [];
let nextResponse: () => Response = () => new Response('{}', { status: 500 });
vi.mock('../../src/lib/fetch-with-deadline', () => ({
  DEFAULT_REQUEST_TIMEOUT_MS: 15_000,
  fetchWithDeadline: (
    url: string,
    init?: { method?: string; headers?: Record<string, string> },
  ): Promise<Response> => {
    requests.push({ method: init?.method ?? 'GET', url, auth: init?.headers?.authorization });
    return Promise.resolve(nextResponse());
  },
}));

import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';

let stored: ProxyConfig[] = [];
const nativeProbes: string[] = [];
const resolves: string[] = [];
/** When set, the native probe does not answer until it is called — a sweep held
 *  in flight. */
let holdNativeProbe: Promise<void> | null = null;
const OK: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0,
  latency_ms: 40,
  message: 'ok',
};
vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve(stored),
  testProxy: async (input: { host: string }) => {
    nativeProbes.push(input.host);
    if (holdNativeProbe !== null) await holdNativeProbe;
    return OK;
  },
  resolveEndpoint: (host: string) => {
    resolves.push(host);
    return Promise.resolve({ resolved: true, ip: '198.51.100.7', message: 'ok' });
  },
  setProxyServerId: vi.fn(),
  updateProxy: vi.fn(),
}));

import {
  clearCapabilityMaterialUnsynced,
  invalidateProbe,
  loadCapabilityAttempts,
  loadProbeCache,
  PROBE_TTL_MS,
  saveEndpointResult,
  saveProbeResult,
} from '../../src/lib/proxy-probe-cache';
import {
  __resetSweepLatchForTests,
  ACTIVE_SWEEP_STALE_MS,
  staleAfterForTrigger,
} from '../../src/lib/proxy-probe-sweeper';
import {
  installedSweepDeps,
  runInstalledCapabilityRefresh,
  runInstalledSweep,
} from '../../src/lib/proxy-server-test';

const MIN = 60_000;
const socks = (id: string): ProxyConfig => ({
  id,
  label: id,
  host: `${id}.example.com`,
  port: 1080,
  username: 'u',
  password: 'p',
  createdAt: '2026-05-20T00:00:00.000Z',
  scheme: 'socks5',
});
const vpn = (id: string, serverId?: string): ProxyConfig => ({
  ...socks(id),
  scheme: 'wireguard',
  port: 51820,
  ...(serverId !== undefined ? { serverId } : {}),
});

beforeEach(() => {
  stores.clear();
  requests.length = 0;
  nativeProbes.length = 0;
  resolves.length = 0;
  stored = [];
  holdNativeProbe = null;
  nextResponse = () => new Response('{}', { status: 500 });
  vi.useRealTimers();
  __resetSweepLatchForTests();
});

describe('the installed sweep — what App.tsx actually runs', () => {
  it('CRITICAL (b) forwards the TRIGGER’s window: a row probed 40 minutes ago is re-probed by an app-open / focus run and left alone by the interval run. MUTATION: drop `staleAfterMs: run.staleAfterMs` from installedSweepDeps and the focus run probes nothing', async () => {
    stored = [socks('a')];
    await saveProbeResult('a', OK, Date.now() - 40 * MIN);

    await runInstalledSweep(
      { trigger: 'interval', staleAfterMs: staleAfterForTrigger('interval') },
      () => ({ baseUrl: 'https://api.example', apiKey: null }),
    );
    expect(nativeProbes, '40 min is inside the 6 h TTL the interval keeps').toEqual([]);

    await runInstalledSweep(
      { trigger: 'focus', staleAfterMs: staleAfterForTrigger('focus') },
      () => ({
        baseUrl: 'https://api.example',
        apiKey: null,
      }),
    );
    expect(nativeProbes).toEqual(['a.example.com']);
    expect(staleAfterForTrigger('focus')).toBe(ACTIVE_SWEEP_STALE_MS);
    expect(
      installedSweepDeps({ trigger: 'interval', staleAfterMs: PROBE_TTL_MS }, () => ({
        baseUrl: '',
        apiKey: null,
      })).staleAfterMs,
    ).toBe(PROBE_TTL_MS);
  });

  it('CRITICAL (a) a VPN row is RE-CHECKED by the installed sweep — with its own check, never the native handshake — and asks Driftstack with the account as it is AT RUN TIME. MUTATION: drop `checkEndpoint` from installedSweepDeps and the row is never planned: no resolve, no request', async () => {
    stored = [vpn('v', 'aprx_v')];
    await saveEndpointResult(
      'v',
      { resolved: true, ip: '198.51.100.7', message: 'ok' },
      Date.now() - 40 * MIN,
    );
    // The key arrives AFTER the schedule was installed — read at call time, the run
    // sees it; captured at mount, it would be null for the life of the window.
    let apiKey: string | null = null;
    const readCreds = (): { baseUrl: string; apiKey: string | null } => ({
      baseUrl: 'https://api.example',
      apiKey,
    });
    apiKey = 'ds_signed_in_later';
    await runInstalledSweep({ trigger: 'focus', staleAfterMs: ACTIVE_SWEEP_STALE_MS }, readCreds);

    expect(resolves).toEqual(['v.example.com']);
    expect(nativeProbes, 'a tunnel is never sent the SOCKS5 handshake').toEqual([]);
    expect(requests).toEqual([
      {
        method: 'POST',
        url: 'https://api.example/v1/account/me/proxies/aprx_v/test?vantage=fleet',
        auth: 'Bearer ds_signed_in_later',
      },
    ]);
    // ⛔ ONE request, not two. The reply here is no verdict at all, which leaves the
    // row "never measured" — and the capability check that follows the sweep in the
    // same installed call must NOT ask about it again seconds later: the sweep's
    // check took the row's turn. MUTATION: delete the `recordCapabilityAttempt` line
    // in checkEndpointRowForSweep and a second, identical POST appears above.
    // The pre-flight was re-stamped: the row really was refreshed.
    expect(Date.now() - ((await loadProbeCache()).v?.at ?? 0)).toBeLessThan(MIN);
  });

  it('CRITICAL ⛔ the consent rule survives the wiring: a VPN row that was never saved to the account gets its address check and NOTHING is sent — by the sweep or by the capability check that follows it', async () => {
    stored = [vpn('v')];
    await saveEndpointResult(
      'v',
      { resolved: true, ip: '198.51.100.7', message: 'ok' },
      Date.now() - 40 * MIN,
    );
    await runInstalledSweep({ trigger: 'focus', staleAfterMs: ACTIVE_SWEEP_STALE_MS }, () => ({
      baseUrl: 'https://api.example',
      apiKey: 'ds_key',
    }));
    expect(resolves).toEqual(['v.example.com']);
    expect(requests).toEqual([]);
  });

  it('CRITICAL the capability check runs AFTER the sweep, in the same installed call: a healthy saved SOCKS5 row with no readings is asked about once — and the sweep’s own native probe did not need to run for that. MUTATION: delete the `runInstalledCapabilityRefresh` line from runInstalledSweep and no request is made', async () => {
    stored = [{ ...socks('a'), serverId: 'aprx_a' }];
    await saveProbeResult('a', OK, Date.now() - MIN);
    const run = { trigger: 'interval' as const, staleAfterMs: PROBE_TTL_MS };
    const creds = (): { baseUrl: string; apiKey: string | null } => ({
      baseUrl: 'https://api.example',
      apiKey: 'ds_key',
    });
    await runInstalledSweep(run, creds);
    expect(nativeProbes).toEqual([]);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST https://api.example/v1/account/me/proxies/aprx_a/test?vantage=fleet',
    ]);
    // The next trigger, fifteen minutes later, finds the attempt and asks nothing.
    await runInstalledSweep(run, creds);
    expect(requests).toHaveLength(1);
  });
});

describe('⛔ the sweep is not a way ROUND the automatic check’s backoff and budget', () => {
  // A VPN server test brings a tunnel up for up to 95 s on a machine every customer
  // shares. The sweep's window is twenty minutes on every window focus; the automatic
  // check's is six hours. MEASURED with the sweep's server leg gated only by the
  // sweep's window: every focus event re-tested every saved VPN row.
  const T0 = 1_800_000_000_000;
  const focus = { trigger: 'focus' as const, staleAfterMs: ACTIVE_SWEEP_STALE_MS };
  const creds = (): { baseUrl: string; apiKey: string | null } => ({
    baseUrl: 'https://api.example',
    apiKey: 'ds_key',
  });
  const posts = (): string[] => requests.filter((r) => r.method === 'POST').map((r) => r.url);
  const testUrl = (serverId: string): string =>
    `https://api.example/v1/account/me/proxies/${serverId}/test?vantage=fleet`;
  const at = (ms: number): void => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ms);
  };

  it('CRITICAL two focus sweeps 21 minutes apart: the ADDRESS is re-checked both times, Driftstack is asked ONCE. MUTATION: delete the `isAutomaticServerCheckDue` return in checkEndpointRowForSweep and a second POST appears', async () => {
    stored = [vpn('v', 'aprx_v')];
    at(T0);
    await saveEndpointResult(
      'v',
      { resolved: true, ip: '198.51.100.7', message: 'ok' },
      T0 - 40 * MIN,
    );
    await runInstalledSweep(focus, creds);
    at(T0 + 21 * MIN);
    await runInstalledSweep(focus, creds);
    expect(resolves).toEqual(['v.example.com', 'v.example.com']);
    expect(posts()).toEqual([testUrl('aprx_v')]);
    // …and six hours after the attempt the row is due again.
    at(T0 + 6 * 60 * MIN);
    await runInstalledSweep(focus, creds);
    expect(posts()).toEqual([testUrl('aprx_v'), testUrl('aprx_v')]);
  });

  it('CRITICAL an account Driftstack REFUSES is asked once, for every row, for the day — not one refused request per VPN row on every focus, for ever. MUTATION: delete the `isAccountRefusal` block in checkEndpointRowForSweep and the second VPN row is asked, and both again seven hours later', async () => {
    stored = [vpn('v1', 'aprx_v1'), vpn('v2', 'aprx_v2')];
    nextResponse = () =>
      new Response(
        JSON.stringify({ detail: 'The "vpnEgress" feature is not available on the "free" tier.' }),
        { status: 403, headers: { 'content-type': 'application/problem+json' } },
      );
    at(T0);
    for (const id of ['v1', 'v2']) {
      await saveEndpointResult(
        id,
        { resolved: true, ip: '198.51.100.7', message: 'ok' },
        T0 - 40 * MIN,
      );
    }
    await runInstalledSweep(focus, creds);
    expect(posts()).toHaveLength(1);
    expect(await loadCapabilityAttempts()).toMatchObject({
      v1: { planExcluded: true },
      v2: { planExcluded: true },
    });
    at(T0 + 7 * 60 * MIN);
    await runInstalledSweep(focus, creds);
    expect(posts()).toHaveLength(1);
    at(T0 + 24 * 60 * MIN);
    await runInstalledSweep(focus, creds);
    expect(posts()).toHaveLength(2);
  });

  it('CRITICAL ONE tunnel per budget window, whoever asks: two stale VPN rows in one sweep → one is asked about, and the capability check that follows does not take the other. MUTATION: drop `budget.vpn <= 0` from checkEndpointRowForSweep and both are asked', async () => {
    stored = [vpn('v1', 'aprx_v1'), vpn('v2', 'aprx_v2')];
    at(T0);
    await saveEndpointResult(
      'v1',
      { resolved: true, ip: '198.51.100.7', message: 'ok' },
      T0 - 50 * MIN,
    );
    await saveEndpointResult(
      'v2',
      { resolved: true, ip: '198.51.100.7', message: 'ok' },
      T0 - 40 * MIN,
    );
    // (`sleep` is a real timer and only Date is faked, so the sweep's gap elapses.)
    await runInstalledSweep(focus, creds);
    expect(resolves).toEqual(['v1.example.com', 'v2.example.com']);
    expect(posts()).toEqual([testUrl('aprx_v1')]);
  }, 15_000);

  it('CRITICAL the other direction: the tab-open capability check asks about a VPN row, and the focus sweep minutes later re-checks its ADDRESS only — never the same tunnel twice within minutes', async () => {
    stored = [vpn('v', 'aprx_v')];
    at(T0);
    await saveEndpointResult(
      'v',
      { resolved: true, ip: '198.51.100.7', message: 'ok' },
      T0 - 40 * MIN,
    );
    await runInstalledCapabilityRefresh(creds);
    expect(posts()).toEqual([testUrl('aprx_v')]);
    at(T0 + 5 * MIN);
    await runInstalledSweep(focus, creds);
    expect(resolves).toEqual(['v.example.com']);
    expect(posts()).toEqual([testUrl('aprx_v')]);
  });

  it('CRITICAL ⛔ a row EDITED since the account last received it is not server-tested by the sweep either: the sweep never uploads, so it would bring up the OLD tunnel and write its exit onto the edited row', async () => {
    stored = [vpn('v', 'aprx_v')];
    at(T0);
    await invalidateProbe('v'); // what a connection-changing save does
    await saveEndpointResult(
      'v',
      { resolved: true, ip: '198.51.100.7', message: 'ok' },
      T0 - 40 * MIN,
    );
    await runInstalledSweep(focus, creds);
    expect(resolves).toEqual(['v.example.com']);
    expect(posts()).toEqual([]);
    // A store of the row (the customer's Check, a launch) lifts the mark.
    await clearCapabilityMaterialUnsynced('v');
    at(T0 + 21 * MIN);
    await runInstalledSweep(focus, creds);
    expect(posts()).toEqual([testUrl('aprx_v')]);
  });

  it('CRITICAL "after, never beside": a trigger that lands while a sweep is still probing starts NO capability check — `runSweep` answers `skipped` at once, and the check would have run beside the sweep. MUTATION: drop `|| inFlight` from runCapabilityRefresh’s latch test and the POST appears while the sweep is held', async () => {
    stored = [{ ...socks('a'), serverId: 'aprx_a' }];
    await saveProbeResult('a', OK, Date.now() - 40 * MIN);
    let release!: () => void;
    holdNativeProbe = new Promise<void>((r) => {
      release = r;
    });
    const first = runInstalledSweep(focus, creds);
    await vi.waitFor(() => expect(nativeProbes).toEqual(['a.example.com']));
    await runInstalledSweep(focus, creds); // the second focus event
    expect(posts()).toEqual([]);
    release();
    await first;
    // The sweep that WAS running makes the follow-up call when it ends.
    expect(posts()).toEqual([testUrl('aprx_a')]);
  });
});

describe('App.tsx hands the schedule THIS function, with the run it was given', () => {
  const app = readFileSync(resolve(__dirname, '../../src/App.tsx'), 'utf8');

  it('CRITICAL the sweep callback TAKES the run and forwards it, and reads the account through a ref at call time. The defect was exactly a callback with no parameter — `const sweep = (): void => void runSweep(deps)` — which type-checks against the schedule and discards the window', () => {
    expect(app).toMatch(
      /const sweep = \(run: SweepRun\): void =>\s*void runInstalledSweep\(run, \(\) => sweepCredsRef\.current\);/,
    );
    expect(app).toMatch(/installProxySweepSchedule\(sweep,/);
    // Re-assigned on EVERY render, so the ref is never the mount-time account.
    expect(app).toMatch(
      /sweepCredsRef\.current = \{ baseUrl: kbSettings\.baseUrl, apiKey: kbSettings\.apiKey \};/,
    );
    // The old shape is gone: no deps object built at mount, no bare runSweep here.
    expect(app).not.toMatch(/\brunSweep\(/);
  });
});
