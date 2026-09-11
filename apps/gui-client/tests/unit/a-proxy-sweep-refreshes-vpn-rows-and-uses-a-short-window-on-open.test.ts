// (q) Item 13(c) — proxy state auto-refresh (open / focus / periodic) for the
// rows the owner actually has, at a cadence a customer can see.
//
// MEASURED (re-verification against b65ddc209):
//   (1) `planSweep` dropped EVERY non-SOCKS5 row (`if (!isSocks5Probeable(...))
//       return false`) and no timer/focus trigger ever called the endpoint check
//       — so for a customer whose proxies are OpenVPN/WireGuard rows the app-open,
//       focus and 15-min refresh did nothing at all.
//   (2) All three triggers gated on `isProbeStale` = the 6 h PROBE_TTL_MS, so a
//       SOCKS5 row tested under 6 h ago refreshed on neither open nor focus.
//
// Now: `planSweep` takes a staleness window and (when the runner has a checker)
// plans endpoint rows for THEIR check; `runSweep` dispatches by scheme — a VPN/
// HTTP row to `checkEndpoint` (the grid's own two legs, lib/proxy-server-test
// `checkEndpointRowForSweep`), never to the SOCKS5 handshake; and
// `installProxySweepSchedule` hands each trigger its window: startup/focus a
// short `ACTIVE_SWEEP_STALE_MS`, the interval the full TTL.
//
// ⛔ PRODUCTION LINES WHOSE REVERSION REDS:
//   • arms 1–3, 8: the `if (!isSocks5Probeable(p.scheme)) { if (opts.endpointRows
//     !== true) return false; … }` branch of planSweep and the scheme dispatch in
//     runSweep. Put the old `return false` back → no VPN row is ever planned.
//   • arms 4–5: `opts.staleAfterMs ?? PROBE_TTL_MS` feeding `isProbeStaleAfter`.
//     Hard-code PROBE_TTL_MS → a 30-min-old row is not planned under a 20-min window.
//   • arms 6–7: `staleAfterForTrigger` inside installProxySweepSchedule. Pass the
//     TTL for every trigger → the startup/focus runs carry the wrong window.
//   • arms 9–12: `checkEndpointRowForSweep`'s legs and gates.
// ⛔ Widen — plan endpoint rows WITHOUT a checker, or hand one to testProxy — and
//    the CONTROLS (arms 2, 3, 8) red: a sweep that cannot check a VPN row would
//    burn its budget on it, or send a SOCKS5 greeting to a UDP endpoint and write
//    "unreachable" over a whole VPN fleet, unasked — the failure this file's
//    predecessor pinned against.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type * as ProxiesModule from '../../src/lib/proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type { ProbeCacheMap } from '../../src/lib/proxy-probe-cache';
import type { SweepDeps, SweepRun, SweepScheduleHost } from '../../src/lib/proxy-probe-sweeper';

const h = vi.hoisted(() => ({
  resolveEndpoint:
    vi.fn<
      (host: string, port: number) => Promise<{ resolved: boolean; ip: string; message: string }>
    >(),
  testAccountProxy: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  saveEndpointResult: vi.fn<(...a: unknown[]) => Promise<ProbeCacheMap>>(() => Promise.resolve({})),
  saveServerProbeResult: vi.fn<(...a: unknown[]) => Promise<ProbeCacheMap>>(() =>
    Promise.resolve({}),
  ),
  saveExitResult: vi.fn<(...a: unknown[]) => Promise<ProbeCacheMap>>(() => Promise.resolve({})),
  loadProbeCache: vi.fn<() => Promise<ProbeCacheMap>>(() => Promise.resolve({})),
}));

vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  resolveEndpoint: (host: string, port: number) => h.resolveEndpoint(host, port),
  testProxy: () => Promise.reject(new Error('the SOCKS5 handshake must never run here')),
}));
vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  testAccountProxy: (...a: unknown[]) => h.testAccountProxy(...a),
}));
vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ProbeCacheModule>()),
  loadProbeCache: () => h.loadProbeCache(),
  saveEndpointResult: (...a: unknown[]) => h.saveEndpointResult(...a),
  saveServerProbeResult: (...a: unknown[]) => h.saveServerProbeResult(...a),
  saveExitResult: (...a: unknown[]) => h.saveExitResult(...a),
}));

const { PROBE_TTL_MS } = await import('../../src/lib/proxy-probe-cache');
const {
  ACTIVE_SWEEP_STALE_MS,
  SWEEP_FAILURE_RETRY_MS,
  SWEEP_INTERVAL_MS,
  STARTUP_SWEEP_DELAY_MS,
  installProxySweepSchedule,
  planSweep,
  runSweep,
  staleAfterForTrigger,
  __resetSweepLatchForTests,
} = await import('../../src/lib/proxy-probe-sweeper');
const { checkEndpointRowForSweep } = await import('../../src/lib/proxy-server-test');

const NOW = 1_800_000_000_000;
const OK: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'ok',
};
const PLACEHOLDER: ProxyTestResult = {
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 0,
  message: 'Resolved',
};

function proxy(id: string, over: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    id,
    label: id,
    host: `${id}.example`,
    port: 1080,
    username: null,
    password: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
const socksEntry = (at: number): ProbeCacheMap[string] => ({ result: OK, at });
/** A VPN row that was CHECKED once (the pre-flight verdict is what makes it a
 *  candidate) — resolved, with a fleet number beside it. */
const vpnEntry = (
  at: number,
  over: Partial<ProbeCacheMap[string]> = {},
): ProbeCacheMap[string] => ({
  result: PLACEHOLDER,
  at,
  endpoint: { resolved: true, ip: '198.51.100.1', message: 'Resolved' },
  serverLatencyMs: 40,
  measuredFrom: 'fleet',
  ...over,
});

const VPN = proxy('vpn', { scheme: 'openvpn', serverId: 'aprx_vpn', port: 1194 });
const WG = proxy('wg', { scheme: 'wireguard', serverId: 'aprx_wg', port: 51820 });
const HTTP = proxy('web', { scheme: 'http', port: 8080 });

beforeEach(() => {
  __resetSweepLatchForTests();
  h.resolveEndpoint.mockReset();
  h.resolveEndpoint.mockResolvedValue({ resolved: true, ip: '198.51.100.1', message: 'Resolved' });
  h.testAccountProxy.mockReset();
  h.testAccountProxy.mockResolvedValue({
    ok: true,
    latency_ms: 42,
    measured_from: 'fleet',
    node_id: 'mac-mini-07',
    quic_probe: true,
    exit_observed: { ip: '203.0.113.9', country: 'NL', timezone: 'Europe/Amsterdam' },
  });
  h.saveEndpointResult.mockClear();
  h.saveServerProbeResult.mockClear();
  h.saveExitResult.mockClear();
  h.loadProbeCache.mockReset();
  h.loadProbeCache.mockResolvedValue({
    vpn: vpnEntry(NOW - PROBE_TTL_MS - 1),
  });
});

describe('planSweep — endpoint rows are planned for THEIR check', () => {
  const STALE = NOW - PROBE_TTL_MS - 1;

  it('ARM 1 — CRITICAL: a stale, once-checked OpenVPN / WireGuard / HTTP row is planned when the runner has a checker', () => {
    const cache = { vpn: vpnEntry(STALE - 2), wg: vpnEntry(STALE - 1), web: vpnEntry(STALE) };
    const plan = planSweep(cache, [VPN, WG, HTTP], NOW, 5, { endpointRows: true });
    expect(plan.map((p) => p.id)).toEqual(['vpn', 'wg', 'web']); // oldest first, like SOCKS5 rows
  });

  it('ARM 2 — CONTROL: without a checker they are NOT planned (a sweep that cannot check them must not spend its budget on them)', () => {
    const cache = { vpn: vpnEntry(STALE), a: socksEntry(STALE) };
    expect(planSweep(cache, [VPN, proxy('a')], NOW).map((p) => p.id)).toEqual(['a']);
    expect(
      planSweep(cache, [VPN, proxy('a')], NOW, 5, { endpointRows: false }).map((p) => p.id),
    ).toEqual(['a']);
  });

  it('ARM 3 — CONTROL: a VPN row that was NEVER checked (no pre-flight verdict) is not refreshed unasked', () => {
    // An entry with no `endpoint` is not a check the customer ran; refreshing it
    // would turn "untested" into a fleet result nobody asked for.
    const cache: ProbeCacheMap = { vpn: { result: PLACEHOLDER, at: STALE } };
    expect(planSweep(cache, [VPN], NOW, 5, { endpointRows: true })).toEqual([]);
    expect(planSweep({}, [VPN], NOW, 5, { endpointRows: true })).toEqual([]);
  });

  it('ARM 4 — CRITICAL: a SHORT window plans a 30-min-old SOCKS5 row that the TTL would leave alone', () => {
    const cache = { a: socksEntry(NOW - 30 * 60 * 1000) };
    expect(planSweep(cache, [proxy('a')], NOW)).toEqual([]); // default = TTL: fresh
    expect(
      planSweep(cache, [proxy('a')], NOW, 5, { staleAfterMs: ACTIVE_SWEEP_STALE_MS }).map(
        (p) => p.id,
      ),
    ).toEqual(['a']);
    // …and the same window for a VPN row.
    const vpnCache = { vpn: vpnEntry(NOW - 30 * 60 * 1000) };
    expect(
      planSweep(vpnCache, [VPN], NOW, 5, {
        staleAfterMs: ACTIVE_SWEEP_STALE_MS,
        endpointRows: true,
      }).map((p) => p.id),
    ).toEqual(['vpn']);
  });

  it('ARM 5 — CONTROL: a row younger than the short window is still left alone (no handshake storm on every alt-tab)', () => {
    const cache = { a: socksEntry(NOW - 5 * 60 * 1000), vpn: vpnEntry(NOW - 5 * 60 * 1000) };
    expect(
      planSweep(cache, [proxy('a'), VPN], NOW, 5, {
        staleAfterMs: ACTIVE_SWEEP_STALE_MS,
        endpointRows: true,
      }),
    ).toEqual([]);
    // The window sits between the failure-retry floor and the TTL.
    expect(ACTIVE_SWEEP_STALE_MS).toBeGreaterThanOrEqual(SWEEP_FAILURE_RETRY_MS);
    expect(ACTIVE_SWEEP_STALE_MS).toBeLessThan(PROBE_TTL_MS);
  });

  it("ARM 5b — a VPN row's FAILING verdict (unresolved endpoint, or a fleet 'tunnel down') retries on the failure window", () => {
    const unresolved = vpnEntry(NOW - SWEEP_FAILURE_RETRY_MS, {
      endpoint: { resolved: false, ip: '', message: 'no such host' },
    });
    const tunnelDown = vpnEntry(NOW - SWEEP_FAILURE_RETRY_MS, {
      fleetFailureReason: 'The proxy did not answer.',
    });
    const recentDown = vpnEntry(NOW - SWEEP_FAILURE_RETRY_MS + 1_000, {
      fleetFailureReason: 'The proxy did not answer.',
    });
    expect(
      planSweep({ vpn: unresolved }, [VPN], NOW, 5, { endpointRows: true }).map((p) => p.id),
    ).toEqual(['vpn']);
    expect(
      planSweep({ vpn: tunnelDown }, [VPN], NOW, 5, { endpointRows: true }).map((p) => p.id),
    ).toEqual(['vpn']);
    expect(planSweep({ vpn: recentDown }, [VPN], NOW, 5, { endpointRows: true })).toEqual([]);
    // A healthy VPN verdict of the same age is not retried early.
    expect(
      planSweep({ vpn: vpnEntry(NOW - SWEEP_FAILURE_RETRY_MS) }, [VPN], NOW, 5, {
        endpointRows: true,
      }),
    ).toEqual([]);
  });
});

describe('installProxySweepSchedule — each trigger carries its window', () => {
  function fakeHost(): {
    host: SweepScheduleHost;
    timeouts: (() => void)[];
    intervals: (() => void)[];
    focus: (() => void)[];
  } {
    const timeouts: (() => void)[] = [];
    const intervals: (() => void)[] = [];
    const focus: (() => void)[] = [];
    const host: SweepScheduleHost = {
      setTimeout: (fn, ms) => {
        expect(ms).toBe(STARTUP_SWEEP_DELAY_MS);
        return timeouts.push(fn) - 1;
      },
      clearTimeout: () => undefined,
      setInterval: (fn, ms) => {
        expect(ms).toBe(SWEEP_INTERVAL_MS);
        return intervals.push(fn) - 1;
      },
      clearInterval: () => undefined,
      addFocus: (fn) => focus.push(fn),
      removeFocus: () => undefined,
      addVisibility: () => undefined,
      removeVisibility: () => undefined,
      isVisible: () => true,
    };
    return { host, timeouts, intervals, focus };
  }

  it('ARM 6 — CRITICAL: startup and focus pass the SHORT window; the interval passes the TTL', () => {
    const runs: SweepRun[] = [];
    const { host, timeouts, intervals, focus } = fakeHost();
    installProxySweepSchedule((run) => runs.push(run), host);
    timeouts[0]?.();
    focus[0]?.();
    intervals[0]?.();
    expect(runs).toEqual([
      { trigger: 'startup', staleAfterMs: ACTIVE_SWEEP_STALE_MS },
      { trigger: 'focus', staleAfterMs: ACTIVE_SWEEP_STALE_MS },
      { trigger: 'interval', staleAfterMs: PROBE_TTL_MS },
    ]);
  });

  it('ARM 7 — staleAfterForTrigger is the single source of that mapping', () => {
    expect(staleAfterForTrigger('startup')).toBe(ACTIVE_SWEEP_STALE_MS);
    expect(staleAfterForTrigger('focus')).toBe(ACTIVE_SWEEP_STALE_MS);
    expect(staleAfterForTrigger('interval')).toBe(PROBE_TTL_MS);
  });
});

describe('runSweep — dispatch by scheme', () => {
  const deps = (over: Partial<SweepDeps> = {}): SweepDeps => ({
    loadCache: () =>
      Promise.resolve({
        vpn: vpnEntry(NOW - PROBE_TTL_MS - 2),
        a: socksEntry(NOW - PROBE_TTL_MS - 1),
      }),
    listProxies: () => Promise.resolve([VPN, proxy('a')]),
    testProxy: () => Promise.resolve(OK),
    saveResult: () => Promise.resolve({}),
    now: () => NOW,
    sleep: () => Promise.resolve(),
    ...over,
  });

  it('ARM 8 — CRITICAL: a planned VPN row goes to checkEndpoint, NEVER to testProxy; the SOCKS5 row still goes to testProxy', async () => {
    const probed: string[] = [];
    const checked: string[] = [];
    const r = await runSweep(
      deps({
        testProxy: (p) => {
          probed.push(p.id);
          return Promise.resolve(OK);
        },
        checkEndpoint: (p) => {
          checked.push(p.id);
          return Promise.resolve();
        },
      }),
    );
    expect(checked).toEqual(['vpn']);
    expect(probed).toEqual(['a']);
    expect(r.refreshed).toEqual(['vpn', 'a']);
    expect(r.failed).toEqual([]);
  });

  it('ARM 8b — CONTROL: without checkEndpoint the VPN row is not touched at all, and the SOCKS5 row is swept as before', async () => {
    const probed: string[] = [];
    const r = await runSweep(
      deps({
        testProxy: (p) => {
          probed.push(p.id);
          return Promise.resolve(OK);
        },
      }),
    );
    expect(probed).toEqual(['a']);
    expect(r.refreshed).toEqual(['a']);
  });

  it('ARM 8c — the window rides in: a 30-min-old SOCKS5 row is swept under a short staleAfterMs, not under the default', async () => {
    const probed: string[] = [];
    const d = (staleAfterMs?: number): SweepDeps =>
      deps({
        loadCache: () => Promise.resolve({ a: socksEntry(NOW - 30 * 60 * 1000) }),
        listProxies: () => Promise.resolve([proxy('a')]),
        testProxy: (p) => {
          probed.push(p.id);
          return Promise.resolve(OK);
        },
        ...(staleAfterMs !== undefined ? { staleAfterMs } : {}),
      });
    await runSweep(d());
    expect(probed).toEqual([]);
    await runSweep(d(ACTIVE_SWEEP_STALE_MS));
    expect(probed).toEqual(['a']);
  });

  it('ARM 8d — a VPN check that throws is `failed` (no verdict written by the sweep) and does not abandon the rest', async () => {
    const r = await runSweep(deps({ checkEndpoint: () => Promise.reject(new Error('dns down')) }));
    expect(r.failed).toEqual(['vpn']);
    expect(r.refreshed).toEqual(['a']);
  });
});

describe('checkEndpointRowForSweep — the grid’s two legs, silently', () => {
  const creds = { baseUrl: 'http://x', apiKey: 'ds_key' as string | null };

  it('ARM 9 — CRITICAL: resolves the endpoint, persists the pre-flight, then asks the FLEET for a stored VPN row and persists the answer with its exit', async () => {
    await checkEndpointRowForSweep(VPN, creds, () => NOW);
    expect(h.resolveEndpoint).toHaveBeenCalledWith('vpn.example', 1194);
    expect(h.saveEndpointResult).toHaveBeenCalledWith(
      'vpn',
      { resolved: true, ip: '198.51.100.1', message: 'Resolved' },
      NOW,
    );
    expect(h.testAccountProxy).toHaveBeenCalledTimes(1);
    expect(h.testAccountProxy.mock.calls[0]).toEqual([
      'http://x',
      'ds_key',
      'aprx_vpn',
      { vantage: 'fleet' },
    ]);
    // persistServerProbe(…, { adoptExit: true }) — the fleet number AND the exit land.
    expect(h.saveServerProbeResult).toHaveBeenCalledTimes(1);
    expect(h.saveServerProbeResult.mock.calls[0]?.[0]).toBe('vpn');
    expect(h.saveExitResult).toHaveBeenCalledTimes(1);
    expect(h.saveExitResult.mock.calls[0]?.slice(0, 3)).toEqual(['vpn', '203.0.113.9', 'NL']);
  });

  it('ARM 10 — CONTROL: an unresolved endpoint never reaches the fleet (the pre-flight IS the answer)', async () => {
    h.resolveEndpoint.mockResolvedValue({ resolved: false, ip: '', message: 'no such host' });
    await checkEndpointRowForSweep(VPN, creds, () => NOW);
    expect(h.saveEndpointResult).toHaveBeenCalledTimes(1);
    expect(h.testAccountProxy).not.toHaveBeenCalled();
  });

  it('ARM 11 — CONTROL: no API key, or a row not stored on the account, stops after the pre-flight — and writes NO notice (nobody asked)', async () => {
    await checkEndpointRowForSweep(VPN, { baseUrl: 'http://x', apiKey: null }, () => NOW);
    await checkEndpointRowForSweep(proxy('local', { scheme: 'openvpn' }), creds, () => NOW);
    expect(h.saveEndpointResult).toHaveBeenCalledTimes(2);
    expect(h.testAccountProxy).not.toHaveBeenCalled();
  });

  it('ARM 12 — an HTTP row gets the pre-flight alone; a SOCKS5 row is not this routine’s (nothing runs)', async () => {
    await checkEndpointRowForSweep(HTTP, creds, () => NOW);
    expect(h.saveEndpointResult).toHaveBeenCalledTimes(1);
    expect(h.testAccountProxy).not.toHaveBeenCalled();
    h.resolveEndpoint.mockClear();
    await checkEndpointRowForSweep(proxy('s', { scheme: 'socks5' }), creds, () => NOW);
    expect(h.resolveEndpoint).not.toHaveBeenCalled();
  });
});
