// 2026-09-17 — "after, never beside" was one-directional, so the budget overshot.
//
// The automatic capability run refuses to START while a reachability sweep is
// probing. Nothing told the SWEEP about a run — and a run lasts minutes (11 s a
// SOCKS5 row, up to 95 s a VPN), so a window focus during one started a full sweep
// beside it. MEASURED: the sweep's VPN check read the ledger live, found budget,
// stamped and tested vpn2; the run then reached its own planned VPN row, re-asked
// "still eligible?" with the budget IGNORED, and tested vpn1 too — four rows and
// two tunnels inside one fifteen-minute window, at the same time, against the
// documented "at most three rows and one VPN per window, whoever asks".
//
// Two repairs, each pinned alone below because EITHER ONE makes the headline
// scenario come out at three-and-one:
//   (a) the sweep's SERVER test does not run while a capability run is in flight
//       (its address check and its native handshakes still do — the sweep is what
//       keeps the verdicts a bulk launch trusts young);
//   (b) the run re-reads the purse from a FRESH ledger when each row's turn comes.
//
// Everything below the transport is REAL: `runCapabilityRefresh` on its production
// deps, `runSweep` on `installedSweepDeps` (so the real `checkEndpointRowForSweep`),
// the real cache and ledger writers over one in-memory store, under fake timers.
//
// ⛔ PRODUCTION LINES WHOSE REMOVAL REDS:
//   • `if (isCapabilityRunInFlight()) return;` in checkEndpointRowForSweep → arm 1's
//     "vpn2 was not tested" lines (and, with (b) also out, the window totals);
//   • the `capabilityBudgetLeft(attemptsNow, …)` re-check in runCapabilityRefresh →
//     arm 2;
//   • the `finally` that releases `capabilityInFlight` (release it only on a normal
//     return instead) → the "run that THROWS" arm.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stores = new Map<string, Map<string, unknown>>();
/** Names the ONE store key whose read rejects — the ledger's, for the arm where a
 *  run THROWS rather than ends. */
const storeFault = { key: null as string | null };
const LEDGER_KEY = 'capability_attempts';
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
      if (storeFault.key === key) return Promise.reject(new Error('store unreadable'));
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

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  resolved: [] as string[],
  nativeProbes: [] as string[],
  /** Every server test asked for, in order, with how many VPN tests were already
   *  in flight when it started (read for VPN tests: "two tunnels at once"). */
  serverTests: [] as Array<{ serverId: string; vpnInFlightAtStart: number }>,
  inFlight: new Set<string>(),
  /** Runs at the START of the named server test — the "another path spends from
   *  the purse while this run is mid-row" seam of arm 2. */
  onServerTest: null as null | ((serverId: string) => Promise<void>),
}));

const SOCKS_TEST_MS = 11_000;
const VPN_TEST_MS = 95_000;

vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => Promise.resolve(h.rows),
  resolveEndpoint: (host: string) => {
    h.resolved.push(host);
    return Promise.resolve({ resolved: true, ip: '198.51.100.7', message: 'ok' });
  },
  testProxy: (p: { host: string }) => {
    h.nativeProbes.push(p.host);
    return Promise.resolve({
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      can_route: true,
      connect_reply: 0,
      latency_ms: 40,
      message: 'ok',
    });
  },
}));
vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  // A server test that TAKES AS LONG AS ONE DOES — the overlap this file is about
  // does not exist for a test that answers in a microtask.
  testAccountProxy: async (_base: string, _key: string, serverId: string) => {
    const isVpn = serverId.includes('vpn');
    h.serverTests.push({
      serverId,
      vpnInFlightAtStart: [...h.inFlight].filter((id) => id.includes('vpn')).length,
    });
    h.inFlight.add(serverId);
    try {
      await h.onServerTest?.(serverId);
      await new Promise<void>((r) => setTimeout(r, isVpn ? VPN_TEST_MS : SOCKS_TEST_MS));
      return { ok: true, latency_ms: 30, measured_from: 'fleet', node_id: 'n1' };
    } finally {
      h.inFlight.delete(serverId);
    }
  },
}));

import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type * as ProxiesModule from '../../src/lib/proxies';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import {
  loadCapabilityAttempts,
  loadProbeCache,
  recordCapabilityAttempt,
  saveEndpointResult,
  saveProbeResult,
} from '../../src/lib/proxy-probe-cache';
import {
  __resetSweepLatchForTests,
  CAPABILITY_BUDGET_WINDOW_MS,
  CAPABILITY_MAX_PER_RUN,
  CAPABILITY_MAX_VPN_PER_RUN,
  isCapabilityRunInFlight,
  runSweep,
  staleAfterForTrigger,
} from '../../src/lib/proxy-probe-sweeper';
import { installedSweepDeps, runInstalledCapabilityRefresh } from '../../src/lib/proxy-server-test';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const OK: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0,
  latency_ms: 40,
  message: 'ok',
};

const socks = (id: string, over: Partial<ProxyConfig> = {}): ProxyConfig => ({
  id,
  label: id,
  host: `${id}.example.com`,
  port: 1080,
  username: 'u',
  password: 'p',
  createdAt: '2026-05-20T00:00:00.000Z',
  scheme: 'socks5',
  serverId: `aprx_${id}`,
  ...over,
});
const vpn = (id: string): ProxyConfig =>
  socks(id, { scheme: 'wireguard', port: 51820, username: null, password: null });

const readCreds = (): { baseUrl: string; apiKey: string | null } => ({
  baseUrl: 'https://api.example',
  apiKey: 'k',
});
const focusSweep = (): ReturnType<typeof runSweep> =>
  runSweep(
    installedSweepDeps(
      { trigger: 'focus', staleAfterMs: staleAfterForTrigger('focus') },
      readCreds,
    ),
  );

const vpnTests = (): string[] =>
  h.serverTests.map((t) => t.serverId).filter((id) => id.includes('vpn'));

/**
 * The saved list:
 *   a, b   — SOCKS5, healthy a minute ago, no Driftstack reading → the run plans them;
 *   vpn1   — address checked a minute ago (NOT due for the sweep), no reading → the
 *            run's one VPN row;
 *   vpn2   — address checked 30 minutes ago → DUE for a focus sweep, and due for
 *            its server test (never attempted, never answered);
 *   local  — a SOCKS5 row that was never saved to the account, probed 30 minutes
 *            ago → the sweep's native handshake, and nothing the run may touch.
 */
async function seed(): Promise<void> {
  h.rows = [socks('a'), socks('b'), vpn('vpn1'), vpn('vpn2'), socks('local')];
  delete (h.rows[4] as ProxyConfig).serverId;
  await saveProbeResult('a', OK, NOW - MIN);
  await saveProbeResult('b', OK, NOW - MIN);
  await saveEndpointResult(
    'vpn1',
    { resolved: true, ip: '198.51.100.7', message: 'ok' },
    NOW - MIN,
  );
  await saveEndpointResult(
    'vpn2',
    { resolved: true, ip: '198.51.100.7', message: 'ok' },
    NOW - 30 * MIN,
  );
  await saveProbeResult('local', OK, NOW - 30 * MIN);
}

beforeEach(() => {
  stores.clear();
  storeFault.key = null;
  h.rows = [];
  h.resolved.length = 0;
  h.nativeProbes.length = 0;
  h.serverTests.length = 0;
  h.inFlight.clear();
  h.onServerTest = null;
  __resetSweepLatchForTests();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('⛔ at most three rows and one VPN per window, whoever asks', () => {
  it('CRITICAL a capability run with plan [a, b, vpn1]; while `a` is in flight a window focus fires the sweep with a due vpn2. Across the whole window: at most 3 server tests, at most 1 VPN server test, never two VPN tests at once — and specifically the sweep’s vpn2 gets its ADDRESS check and NO server test, unstamped. MUTATION: delete `if (isCapabilityRunInFlight()) return;` in checkEndpointRowForSweep and the vpn2 lines red (vpn2 is tested beside the run and vpn1 loses its turn); delete the run’s fresh budget re-check as well and the totals red too (4 tests, 2 tunnels, concurrently)', async () => {
    await seed();

    const run = runInstalledCapabilityRefresh(readCreds);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(isCapabilityRunInFlight()).toBe(true);
    expect([...h.inFlight], 'the run is mid-row when the focus lands').toEqual(['aprx_a']);

    const sweep = focusSweep();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    const [report, swept] = await Promise.all([run, sweep]);
    expect(Date.now() - NOW).toBeLessThan(CAPABILITY_BUDGET_WINDOW_MS); // ONE window

    // The window's totals — the documented bound.
    expect(h.serverTests.length).toBeLessThanOrEqual(CAPABILITY_MAX_PER_RUN);
    expect(vpnTests().length).toBeLessThanOrEqual(CAPABILITY_MAX_VPN_PER_RUN);
    // Never two tunnels at once: no VPN test STARTED while another was in flight.
    const tunnelsBeside = h.serverTests
      .filter((t) => t.serverId.includes('vpn'))
      .map((t) => t.vpnInFlightAtStart);
    expect(tunnelsBeside.length, 'a VPN test did run — the line below is not vacuous').toBe(1);
    expect(Math.max(...tunnelsBeside)).toBe(0);

    // …and who spent it: the run its whole plan, the sweep nothing.
    expect(h.serverTests.map((t) => t.serverId)).toEqual(['aprx_a', 'aprx_b', 'aprx_vpn1']);
    expect(report.checked).toEqual(['a', 'b', 'vpn1']);
    expect(report.skippedChanged).toEqual([]);

    // ⛔ The sweep was NOT parked behind the run: the address check of vpn2 ran
    // and was written, and so was the native handshake of the device-only row.
    expect(swept.skipped).toBe(false);
    expect([...swept.refreshed].sort()).toEqual(['local', 'vpn2']);
    expect(h.resolved).toContain('vpn2.example.com');
    expect(h.nativeProbes).toEqual(['local.example.com']);
    const cache = await loadProbeCache();
    expect(cache.vpn2?.at, 'vpn2’s address verdict is a second old, not 30 minutes').toBe(
      NOW + 1_000,
    );
    // Unstamped, so it stays due: the next window's run or sweep takes it.
    expect(await loadCapabilityAttempts()).not.toHaveProperty('vpn2');
  });

  it('CRITICAL (b) alone — the run re-reads the PURSE when each row’s turn comes. While `a` is in flight another path stamps a VPN row (what the sweep’s check did before (a); what any future automatic caller would do). `b` still goes — a row is left — and vpn1 does NOT: the window’s one tunnel is spent. MUTATION: delete the `capabilityBudgetLeft(attemptsNow, …)` re-check in runCapabilityRefresh and vpn1 is tested', async () => {
    await seed();
    h.onServerTest = async (serverId) => {
      if (serverId === 'aprx_a') await recordCapabilityAttempt(['vpn2'], Date.now());
    };
    const run = runInstalledCapabilityRefresh(readCreds);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    const report = await run;

    expect(h.serverTests.map((t) => t.serverId)).toEqual(['aprx_a', 'aprx_b']);
    expect(report.checked).toEqual(['a', 'b']);
    expect(report.skippedChanged).toEqual(['vpn1']);
    // Not stamped: a row that did not go has not used its turn.
    expect(await loadCapabilityAttempts()).not.toHaveProperty('vpn1');
  });

  it('…and when another path spends every ROW left, the rest of the plan stands down — counting this run’s own stamp ONCE (a + two others = three)', async () => {
    await seed();
    h.rows = [...(h.rows as ProxyConfig[]), socks('x1'), socks('x2')];
    h.onServerTest = async (serverId) => {
      if (serverId === 'aprx_a') await recordCapabilityAttempt(['x1', 'x2'], Date.now());
    };
    const run = runInstalledCapabilityRefresh(readCreds);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    const report = await run;
    expect(h.serverTests.map((t) => t.serverId)).toEqual(['aprx_a']);
    expect(report.skippedChanged).toEqual(['b', 'vpn1']);
  });

  it('CONTROL — the run’s OWN stamps do not starve it: with nobody else spending, all three planned rows go (a re-check that double-counted the run’s spend would stop after one or two)', async () => {
    await seed();
    const run = runInstalledCapabilityRefresh(readCreds);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect((await run).checked).toEqual(['a', 'b', 'vpn1']);
  });

  it('CONTROL — with NO capability run in flight the sweep’s VPN check still tests a due row, stamps it, and persists the answer. (Without this, arm 1 passes for a sweep whose server test never runs at all.)', async () => {
    await seed();
    expect(isCapabilityRunInFlight()).toBe(false);
    const sweep = focusSweep();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    const swept = await sweep;

    expect([...swept.refreshed].sort()).toEqual(['local', 'vpn2']);
    expect(h.serverTests.map((t) => t.serverId)).toEqual(['aprx_vpn2']);
    expect((await loadCapabilityAttempts()).vpn2?.capabilityCheckAttemptedAt).toBeGreaterThan(0);
    expect((await loadProbeCache()).vpn2?.serverLatencyMs).toBe(30);
  });

  it('CONTROL — the latch is released: once the run has ended, a later sweep’s VPN check runs again (a latch that stuck would silence it for the life of the app)', async () => {
    await seed();
    const run = runInstalledCapabilityRefresh(readCreds);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await run;
    expect(isCapabilityRunInFlight()).toBe(false);

    // The next window: the purse is whole again and vpn2 is still due.
    await vi.advanceTimersByTimeAsync(CAPABILITY_BUDGET_WINDOW_MS);
    h.serverTests.length = 0;
    const sweep = focusSweep();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await sweep;
    expect(vpnTests()).toEqual(['aprx_vpn2']);
  });

  it('CRITICAL …and released by a run that THROWS. The latch gates a second system now — the sweep’s VPN server test — so a release that only happened on a normal return would silence that test for the life of the app after ONE unreadable ledger. MUTATION: move `capabilityInFlight = false` out of the `finally` to just before `return report` and both halves red', async () => {
    await seed();
    storeFault.key = LEDGER_KEY;
    const run = runInstalledCapabilityRefresh(readCreds).then(
      () => 'returned',
      () => 'threw',
    );
    await vi.advanceTimersByTimeAsync(MIN);
    expect(await run, 'the run really did throw — else this arm is the one above').toBe('threw');
    expect(h.serverTests).toEqual([]);
    expect(isCapabilityRunInFlight()).toBe(false);

    storeFault.key = null;
    const sweep = focusSweep();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await sweep;
    expect(vpnTests()).toEqual(['aprx_vpn2']);
  });
});
