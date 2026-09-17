// 2026-09-17 — the owner: "On proxies, if it's missing to know if a proxy has UDP,
// QUIC or TCP/IP fingerprint, it should automatically check this proxy if it has
// missing information."
//
// Those three readings are measured by Driftstack, not by this Mac, and were only
// ever taken when the customer pressed Test. They leave the present tense after
// thirty minutes (rightly), so a proxy tested in the morning read "not measured" by
// lunch and nothing would look again. The automatic capability check
// (lib/proxy-probe-sweeper `planCapabilityRefresh` / `runCapabilityRefresh`) looks
// again — and this file pins the limits that make that safe to ship:
//
//   ⛔ CONSENT  — a proxy never saved to the account is never sent. A timer is not
//                 the customer pressing Test, and the check uploads NOTHING.
//   ⛔ COST     — one check dials the customer's proxy for ~11 s (a VPN one holds a
//                 tunnel up for up to 95 s) on a machine every customer shares, so:
//                 six hours between looks (NOT the 30-minute display window), six
//                 hours of backoff whatever came back, 24 h after the plan refusal,
//                 three rows a run and one VPN among them, serial.
//   ⛔ NO PAINT — a row nobody tested here adopts a SUCCESS and nothing else; a
//                 failed automatic reply must never paint a red verdict on it.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = new Map<string, Map<string, unknown>>();
/** Set to make every store READ reject — the transient failure the ledger must
 *  not answer as "empty". */
const storeFault = { get: false };
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
      if (storeFault.get) return Promise.reject(new Error('store unreadable'));
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

/** Every request the code under test makes, METHOD and url — the no-upload arms
 *  assert on the method, because a create and a test share a path prefix. */
const requests: Array<{ method: string; url: string }> = [];
let nextResponse: () => Response = () => new Response('{}', { status: 500 });
vi.mock('../../src/lib/fetch-with-deadline', () => ({
  DEFAULT_REQUEST_TIMEOUT_MS: 15_000,
  fetchWithDeadline: (url: string, init?: { method?: string }): Promise<Response> => {
    requests.push({ method: init?.method ?? 'GET', url });
    return Promise.resolve(nextResponse());
  },
}));

/** The saved rows `listProxies` answers with. An automatic check re-reads the row
 *  AFTER the reply and drops a reply about a row that is gone or was edited. */
const local = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => Promise.resolve(local.rows),
}));

import * as accountProxies from '../../src/lib/account-proxies';
import type * as ProxiesModule from '../../src/lib/proxies';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import {
  deriveProbeViewState,
  loadCapabilityAttempts,
  loadProbeCache,
  recordCapabilityAttempt,
  clearCapabilityMaterialUnsynced,
  pruneCapabilityAttempts,
  saveEndpointResult,
  saveProbeResult,
  saveServerProbeResult,
  seedServerOsFingerprint,
  invalidateProbe,
  type CachedProbe,
  type CapabilityAttemptMap,
  type ProbeCacheMap,
} from '../../src/lib/proxy-probe-cache';
import {
  __resetSweepLatchForTests,
  CAPABILITY_BUDGET_WINDOW_MS,
  CAPABILITY_MAX_PER_RUN,
  CAPABILITY_NOT_PRODUCED_RETRY_MS,
  CAPABILITY_PLAN_EXCLUDED_RETRY_MS,
  CAPABILITY_REFRESH_AFTER_MS,
  CAPABILITY_RETRY_AFTER_MS,
  capabilityBudgetLeft,
  capabilityRecheckPromises,
  isCapabilityRowCheckable,
  isProxyProbeInFlight,
  isServerTestInFlight,
  planCapabilityRefresh,
  runCapabilityRefresh,
  runSweep,
  SWEEP_GAP_MS,
  withProxyProbe,
  withServerTest,
  type CapabilityCheckResult,
  type CapabilityRefreshDeps,
} from '../../src/lib/proxy-probe-sweeper';
import {
  checkCapabilitiesForRow,
  deriveProbeViewWithEndpointRows,
  ensureAccountProxyRow,
  fleetFailureReasons,
  persistAutomaticServerProbe,
  type ServerProbeOutcome,
} from '../../src/lib/proxy-server-test';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

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

const READING = {
  os: 'macos-or-ios' as const,
  confidence: 'high' as const,
  reason: 'Based on how this proxy responds to a network connection.',
};

const socks = (id: string, over: Partial<ProxyConfig> = {}): ProxyConfig => ({
  id,
  label: id,
  host: `${id}.example.com`,
  port: 1080,
  username: 'u',
  password: 'secret-password',
  createdAt: '2026-05-20T00:00:00.000Z',
  scheme: 'socks5',
  serverId: `aprx_${id}`,
  ...over,
});
const vpn = (id: string, over: Partial<ProxyConfig> = {}): ProxyConfig =>
  socks(id, { scheme: 'wireguard', port: 51820, username: null, password: null, ...over });

/** A SOCKS5 entry, healthy here, whose Driftstack readings were all taken `ageMs` ago. */
const measured = (ageMs: number, over: Partial<CachedProbe> = {}): CachedProbe => ({
  result: OK,
  at: NOW - MIN,
  osFingerprint: { ...READING, at: NOW - ageMs },
  quicProbe: true,
  quicProbeAt: NOW - ageMs,
  ...over,
});
/** A VPN entry with a resolved address check and both readings taken `ageMs` ago. */
const measuredVpn = (ageMs: number, over: Partial<CachedProbe> = {}): CachedProbe => ({
  result: { ...DOWN, message: 'ok' },
  at: NOW - MIN,
  endpoint: { resolved: true, ip: '198.51.100.7', message: 'ok' },
  quicProbe: true,
  quicProbeAt: NOW - ageMs,
  udpProbe: true,
  udpProbeAt: NOW - ageMs,
  ...over,
});

const plan = (
  cache: ProbeCacheMap,
  proxies: ProxyConfig[],
  attempts: CapabilityAttemptMap = {},
  opts: Partial<Parameters<typeof planCapabilityRefresh>[4]> = {},
): string[] =>
  planCapabilityRefresh(cache, attempts, proxies, NOW, { hasApiKey: true, ...opts }).map(
    (p) => p.id,
  );

beforeEach(() => {
  stores.clear();
  storeFault.get = false;
  local.rows = [];
  requests.length = 0;
  nextResponse = () => new Response('{}', { status: 500 });
  __resetSweepLatchForTests();
  vi.restoreAllMocks();
});

describe('planCapabilityRefresh — who is eligible', () => {
  it('CRITICAL ⛔ a proxy never saved to the account is NEVER planned, however empty its readings — its credentials are device-only until the customer presses Test. MUTATION: delete the `p.serverId === undefined` continue and this reds', () => {
    const { serverId: _never, ...deviceOnly } = socks('local');
    expect(plan({ local: { result: OK, at: NOW - MIN } }, [deviceOnly])).toEqual([]);
    // CONTROL — the same row, saved to the account, IS planned: the exclusion above
    // is the serverId and nothing else.
    expect(plan({ local: { result: OK, at: NOW - MIN } }, [socks('local')])).toEqual(['local']);
  });

  it('plans nothing without an API key — nothing can be asked of Driftstack', () => {
    expect(plan({ a: { result: OK, at: NOW } }, [socks('a')], {}, { hasApiKey: false })).toEqual(
      [],
    );
  });

  it('CRITICAL a row whose LOCAL verdict is failing is never planned — a proxy that is down is the reachability sweep’s business, and nothing can be measured through it. MUTATION: delete the `if (failing) continue` and all three red', () => {
    expect(plan({ a: { result: DOWN, at: NOW - MIN } }, [socks('a')])).toEqual([]);
    expect(
      plan({ a: { result: OK, at: NOW - MIN, fleetFailureReason: 'did not answer' } }, [
        socks('a'),
      ]),
    ).toEqual([]);
    expect(
      plan({ v: measuredVpn(7 * HOUR, { endpoint: { resolved: false, ip: '', message: 'no' } }) }, [
        vpn('v'),
      ]),
    ).toEqual([]);
  });

  it('plans SOCKS5 and VPN rows only — an HTTP row gets its address check alone, here as on the grid', () => {
    expect(plan({}, [socks('h', { scheme: 'http' })])).toEqual([]);
  });

  it('CRITICAL the window is SIX HOURS, not the 30-minute display TTL: a reading 5 h old is shown aged and left alone; one 6 h old is re-taken. MUTATION: set CAPABILITY_REFRESH_AFTER_MS to 30 minutes and the first expectation reds', () => {
    expect(CAPABILITY_REFRESH_AFTER_MS).toBe(6 * HOUR);
    expect(plan({ a: measured(5 * HOUR) }, [socks('a')])).toEqual([]);
    expect(plan({ a: measured(31 * MIN) }, [socks('a')])).toEqual([]);
    expect(plan({ a: measured(6 * HOUR) }, [socks('a')])).toEqual(['a']);
  });

  it('ONE missing reading is enough, and an UNDATABLE one counts as missing (it is shown by nothing, fresh or aged)', () => {
    const { osFingerprint: _os, ...noOs } = measured(MIN);
    expect(plan({ a: noOs }, [socks('a')])).toEqual(['a']);
    const { quicProbeAt: _at, ...undatedQuic } = measured(MIN);
    expect(plan({ a: undatedQuic }, [socks('a')])).toEqual(['a']);
    // A live session's verdict answers the QUIC question as well as the Test's does.
    const { quicProbe: _q, quicProbeAt: _qa, ...noRelay } = measured(MIN);
    expect(
      plan({ a: { ...noRelay, quicMeasured: 'h3', quicMeasuredAt: NOW - MIN } }, [socks('a')]),
    ).toEqual([]);
  });

  it('a CAUSE no retry can change answers the OS question for good; `not_observed` — the one a retry can clear — ages like a reading', () => {
    const cause = (unavailable: 'observer_off' | 'not_observed', ageMs: number): CachedProbe =>
      measured(MIN, {
        osFingerprint: {
          os: 'unknown',
          confidence: 'none',
          reason: 'r',
          unavailable,
          at: NOW - ageMs,
        },
      });
    expect(plan({ a: cause('observer_off', 30 * 24 * HOUR - MIN) }, [socks('a')])).toEqual([]);
    expect(plan({ a: cause('not_observed', 7 * HOUR) }, [socks('a')])).toEqual(['a']);
  });

  it('a VPN row is never planned for an OS reading (a tunnel has none to take), and never without a resolved address check — its readings would be shown nowhere', () => {
    expect(plan({ v: measuredVpn(MIN) }, [vpn('v')])).toEqual([]); // no osFingerprint, not planned
    expect(plan({}, [vpn('v')])).toEqual([]);
    const seeded = seededEntry();
    expect(plan({ v: seeded }, [vpn('v')])).toEqual([]);
    // …while a SOCKS5 row nobody tested here IS planned: its OS reading shows.
    expect(plan({ s: seeded }, [socks('s')])).toEqual(['s']);
    expect(plan({}, [socks('s')])).toEqual(['s']);
  });

  it('CRITICAL BACKOFF — never within six hours of the last automatic attempt WHATEVER came back, and 24 h after the plan refusal. MUTATION: delete the `attempt !== undefined` block and every `[]` here reds', () => {
    const cache = { a: { result: OK, at: NOW - MIN } };
    const at = (ageMs: number, planExcluded = false): CapabilityAttemptMap => ({
      a: {
        capabilityCheckAttemptedAt: NOW - ageMs,
        ...(planExcluded ? { planExcluded: true as const } : {}),
      },
    });
    expect(CAPABILITY_RETRY_AFTER_MS).toBe(6 * HOUR);
    expect(CAPABILITY_PLAN_EXCLUDED_RETRY_MS).toBe(24 * HOUR);
    expect(plan(cache, [socks('a')], at(MIN))).toEqual([]);
    expect(plan(cache, [socks('a')], at(6 * HOUR - 1))).toEqual([]);
    expect(plan(cache, [socks('a')], at(6 * HOUR))).toEqual(['a']);
    expect(plan(cache, [socks('a')], at(23 * HOUR, true))).toEqual([]);
    expect(plan(cache, [socks('a')], at(24 * HOUR, true))).toEqual(['a']);
  });

  it('CRITICAL a row Driftstack answered for inside the window is left alone even with a reading still missing — every leg that can be taken has just been taken (a Test the customer pressed counts). MUTATION: delete the `serverProbeAt` test in isAutomaticServerCheckDue and this reds', () => {
    const { udpProbe: _u, udpProbeAt: _ua, ...noUdp } = measuredVpn(MIN);
    expect(plan({ v: { ...noUdp, serverProbeAt: NOW - HOUR } }, [vpn('v')])).toEqual([]);
    expect(plan({ v: { ...noUdp, serverProbeAt: NOW - 6 * HOUR } }, [vpn('v')])).toEqual(['v']);
  });

  it('CRITICAL a reading a FULL answer did not produce stops counting as "never measured" — a VPN’s QUIC leg is skipped today, and counted as never-measured it re-planned every saved VPN row, and brought a tunnel up, every six hours for ever. The row is then planned on its DATED readings alone; the mark lapses after a week. MUTATION: delete the `notProduced` term from `never` in planCapabilityRefresh and the first two red', () => {
    const { quicProbe: _q, quicProbeAt: _qa, ...noQuic } = measuredVpn(7 * HOUR);
    expect(CAPABILITY_NOT_PRODUCED_RETRY_MS).toBe(7 * 24 * HOUR);
    const mark = (ageMs: number): CapabilityAttemptMap => ({
      v: { capabilityCheckAttemptedAt: NOW - 7 * HOUR, readingsNotProducedAt: NOW - ageMs },
    });
    // UDP taken an hour ago, QUIC never produced: nothing to re-take.
    expect(plan({ v: { ...noQuic, udpProbeAt: NOW - HOUR } }, [vpn('v')], mark(7 * HOUR))).toEqual(
      [],
    );
    // Nothing dated at all, and the blank is known not to be produced: not planned.
    const { udpProbe: _u, udpProbeAt: _ua, ...nothing } = noQuic;
    expect(plan({ v: nothing }, [vpn('v')], mark(7 * HOUR))).toEqual([]);
    // Its UDP reading has gone seven hours old: planned, as an AGED row.
    expect(plan({ v: noQuic }, [vpn('v')], mark(7 * HOUR))).toEqual(['v']);
    // CONTROL — without the mark the blank counts, and after a week it counts again.
    expect(plan({ v: { ...noQuic, udpProbeAt: NOW - HOUR } }, [vpn('v')])).toEqual(['v']);
    expect(
      plan({ v: { ...noQuic, udpProbeAt: NOW - HOUR } }, [vpn('v')], mark(7 * 24 * HOUR)),
    ).toEqual(['v']);
  });
});

describe('the hover may promise a recheck only for a row the planner would ever check', () => {
  const checkable = (
    p: ProxyConfig,
    entry: CachedProbe | undefined,
    attempt?: CapabilityAttemptMap[string],
    hasApiKey = true,
  ): boolean => isCapabilityRowCheckable(p, entry, attempt, NOW, hasApiKey);

  it('CRITICAL "It will be rechecked automatically" is false for a failing row, an HTTP row, a VPN row with no address check, a device-only row, an account Driftstack refused, a row edited since the account last received it, and with no key. MUTATION: make isCapabilityRowCheckable return `hasApiKey && p.serverId !== undefined` and six of these red', () => {
    const healthy = { result: OK, at: NOW - MIN };
    expect(checkable(socks('a'), healthy)).toBe(true);
    expect(checkable(socks('a'), undefined)).toBe(true); // a never-tested SOCKS5 row IS checked
    expect(checkable(socks('a'), healthy, undefined, false)).toBe(false);
    const { serverId: _never, ...deviceOnly } = socks('a');
    expect(checkable(deviceOnly, healthy)).toBe(false);
    expect(checkable(socks('a'), { result: DOWN, at: NOW - MIN })).toBe(false);
    expect(checkable(socks('h', { scheme: 'http' }), healthy)).toBe(false);
    expect(checkable(vpn('v'), undefined)).toBe(false);
    expect(checkable(vpn('v'), measuredVpn(MIN))).toBe(true);
    expect(
      checkable(socks('a'), healthy, {
        capabilityCheckAttemptedAt: NOW - HOUR,
        planExcluded: true,
      }),
    ).toBe(false);
    expect(
      checkable(socks('a'), healthy, {
        capabilityCheckAttemptedAt: NOW - 24 * HOUR,
        planExcluded: true,
      }),
    ).toBe(true);
    expect(
      checkable(socks('a'), healthy, { capabilityCheckAttemptedAt: 0, materialUnsynced: true }),
    ).toBe(false);
    // An ordinary backoff is NOT a reason to withdraw the promise: it will be rechecked.
    expect(checkable(socks('a'), healthy, { capabilityCheckAttemptedAt: NOW - MIN })).toBe(true);
    expect(
      capabilityRecheckPromises(
        { a: healthy, b: { result: DOWN, at: NOW } },
        {},
        [socks('a'), socks('b')],
        NOW,
        true,
      ),
    ).toEqual({ a: true });
  });
});

/** A server-seeded entry, as the list adoption invents it. */
function seededEntry(): CachedProbe {
  return {
    result: { ...DOWN, message: 'Not checked on this Mac.' },
    at: NOW - HOUR,
    serverSeeded: true,
  };
}

describe('planCapabilityRefresh — budget and order', () => {
  it('CRITICAL at most three rows a run, NEVER-measured first, then the OLDEST reading first. MUTATION: reverse the `never` comparison, or sort `b.oldest - a.oldest`, and this reds', () => {
    expect(CAPABILITY_MAX_PER_RUN).toBe(3);
    const cache: ProbeCacheMap = {
      old7: measured(7 * HOUR),
      old9: measured(9 * HOUR),
      old8: measured(8 * HOUR),
      blank: { result: OK, at: NOW - MIN },
    };
    expect(plan(cache, [socks('old7'), socks('old9'), socks('old8'), socks('blank')])).toEqual([
      'blank',
      'old9',
      'old8',
    ]);
  });

  it('CRITICAL at most ONE VPN row a run — and a VPN row over the cap does not burn the slot: the next row takes it. MUTATION: drop the `vpnPlanned >= maxVpn` continue and two tunnels are planned', () => {
    const cache: ProbeCacheMap = {
      v1: measuredVpn(9 * HOUR),
      v2: measuredVpn(8 * HOUR),
      s1: measured(7 * HOUR),
      s2: measured(6.5 * HOUR),
    };
    expect(plan(cache, [vpn('v1'), vpn('v2'), socks('s1'), socks('s2')])).toEqual([
      'v1',
      's1',
      's2',
    ]);
  });

  it('CRITICAL ⛔ the budget is a RATE, not a per-call cap: what other runs (and the reachability sweep’s VPN check) spent inside the window is read off the ledger, so a burst of triggers spends ONE purse. MEASURED per call: three back-to-back runs checked nine of nine rows. MUTATION: make capabilityBudgetLeft return `{ rows: max, vpn: maxVpn }` and every line reds', () => {
    expect(CAPABILITY_BUDGET_WINDOW_MS).toBe(15 * MIN);
    const blank = { result: OK, at: NOW - MIN };
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const cache = Object.fromEntries(ids.map((id) => [id, blank]));
    const proxies = ids.map((id) => socks(id));
    const spent = (n: number, ageMs: number): CapabilityAttemptMap =>
      Object.fromEntries(
        ['x', 'y', 'z'].slice(0, n).map((id) => [id, { capabilityCheckAttemptedAt: NOW - ageMs }]),
      );
    expect(plan(cache, proxies, spent(3, MIN))).toEqual([]);
    expect(plan(cache, proxies, spent(2, MIN))).toEqual(['a']);
    expect(plan(cache, proxies, spent(3, 15 * MIN))).toEqual(['a', 'b', 'c']);
    // The VPN purse likewise: one VPN row checked (by anyone) inside the window.
    const vpnCache = { v2: measuredVpn(9 * HOUR), s: blank };
    const vpnSpent = { v1: { capabilityCheckAttemptedAt: NOW - MIN } };
    expect(plan(vpnCache, [vpn('v1'), vpn('v2'), socks('s')], vpnSpent)).toEqual(['s']);
    expect(capabilityBudgetLeft(vpnSpent, [vpn('v1')], NOW)).toEqual({ rows: 2, vpn: 0 });
    // An edit's `0` stamp and a stamp from a clock that moved spend nothing.
    expect(
      capabilityBudgetLeft(
        { a: { capabilityCheckAttemptedAt: 0 }, b: { capabilityCheckAttemptedAt: NOW + HOUR } },
        [],
        NOW,
      ),
    ).toEqual({ rows: 3, vpn: 1 });
  });

  it('among rows that are all blank, the one attempted LONGEST ago goes first, so a long list rotates instead of starving its tail', () => {
    const blank = { result: OK, at: NOW - MIN };
    const attempts: CapabilityAttemptMap = {
      a: { capabilityCheckAttemptedAt: NOW - 7 * HOUR },
      b: { capabilityCheckAttemptedAt: NOW - 9 * HOUR },
    };
    expect(
      plan({ a: blank, b: blank, c: blank }, [socks('a'), socks('b'), socks('c')], attempts, {
        max: 2,
      }),
    ).toEqual(['c', 'b']);
  });
});

describe('runCapabilityRefresh — the runner', () => {
  type Log = string[];
  const deps = (
    log: Log,
    over: Partial<CapabilityRefreshDeps> & {
      cache?: ProbeCacheMap;
      proxies?: ProxyConfig[];
      result?: (p: ProxyConfig) => CapabilityCheckResult | Promise<CapabilityCheckResult>;
    } = {},
  ): CapabilityRefreshDeps => {
    let attempts: CapabilityAttemptMap = {};
    return {
      loadCache: () => Promise.resolve(over.cache ?? {}),
      loadAttempts: () => Promise.resolve(attempts),
      listProxies: () => Promise.resolve(over.proxies ?? []),
      readCreds: () => ({ baseUrl: 'https://api.example', apiKey: 'ds_key' }),
      recordAttempt: (ids, at, planExcluded) => {
        log.push(`attempt:${ids.join(',')}${planExcluded ? ':plan' : ''}`);
        attempts = { ...attempts };
        for (const id of ids)
          attempts[id] = {
            capabilityCheckAttemptedAt: at,
            ...(planExcluded ? { planExcluded: true as const } : {}),
          };
        return Promise.resolve();
      },
      check: async (p) => {
        log.push(`check:${p.id}`);
        return (await over.result?.(p)) ?? { answered: true, accountRefused: false };
      },
      now: () => NOW,
      sleep: (ms) => {
        log.push(`sleep:${ms.toString()}`);
        return Promise.resolve();
      },
      ...over,
    };
  };
  const blank = { result: OK, at: NOW - MIN };

  it('CRITICAL stamps the attempt BEFORE each request, runs SERIALLY with the sweep’s gap between rows, and a second run finds the backoff and asks for nothing', async () => {
    const log: Log = [];
    const d = deps(log, { cache: { a: blank, b: blank }, proxies: [socks('a'), socks('b')] });
    const report = await runCapabilityRefresh(d);
    expect(report.checked).toEqual(['a', 'b']);
    expect(log).toEqual([
      'attempt:a',
      'check:a',
      `sleep:${SWEEP_GAP_MS.toString()}`,
      'attempt:b',
      'check:b',
    ]);
    log.length = 0;
    expect((await runCapabilityRefresh(d)).checked).toEqual([]);
    expect(log).toEqual([]);
  });

  it('CRITICAL single-flight: a second trigger landing while a run is in flight does NOTHING — the tab opening as the schedule fires must not check a row twice. MUTATION: delete the `capabilityInFlight` early return and `check:a` appears twice', async () => {
    const log: Log = [];
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const d = deps(log, {
      cache: { a: blank },
      proxies: [socks('a')],
      result: async () => {
        await held;
        return { answered: true, accountRefused: false };
      },
    });
    const first = runCapabilityRefresh(d);
    await vi.waitFor(() => expect(log).toContain('check:a'));
    const second = await runCapabilityRefresh(d);
    expect(second.skipped).toBe(true);
    release();
    expect((await first).checked).toEqual(['a']);
    expect(log.filter((l) => l === 'check:a')).toEqual(['check:a']);
  });

  it('CRITICAL ⛔ fails CLOSED: when the attempt cannot be recorded the request is never sent — a check nothing bounds is a dial every fifteen minutes for ever. MUTATION: move `recordAttempt` after `deps.check` and this reds', async () => {
    const log: Log = [];
    const d = deps(log, {
      cache: { a: blank },
      proxies: [socks('a')],
      recordAttempt: () => Promise.reject(new Error('store refused the write')),
    });
    const report = await runCapabilityRefresh(d);
    expect(report.failed).toEqual(['a']);
    expect(log).toEqual([]);
  });

  it('CRITICAL the PLAN refusal is a fact about the account: the run stops, and EVERY eligible row is stamped with it in one write — not one request per row to be told the same. MUTATION: drop `stop = true` in the accountRefused arm and `check:b` runs', async () => {
    const log: Log = [];
    const proxies = ['a', 'b', 'c', 'd', 'e'].map((id) => socks(id));
    const cache = Object.fromEntries(proxies.map((p) => [p.id, blank]));
    const d = deps(log, {
      cache,
      proxies,
      result: () => ({ answered: true, accountRefused: true }),
    });
    await runCapabilityRefresh(d);
    expect(log).toEqual(['attempt:a', 'check:a', 'attempt:a,b,c,d,e:plan']);
  });

  it('no reply at all ends the run — the other rows keep their turn instead of spending six hours of backoff to learn the server is not answering', async () => {
    const log: Log = [];
    const d = deps(log, {
      cache: { a: blank, b: blank },
      proxies: [socks('a'), socks('b')],
      result: () => ({ answered: false, accountRefused: false }),
    });
    await runCapabilityRefresh(d);
    expect(log).toEqual(['attempt:a', 'check:a']);
  });

  it('CRITICAL ⛔ N > 3 eligible rows, two runs at the same instant: the second checks NOTHING — and the next three go only when the window has passed. MUTATION: pass `ignoreBudget: true` to the run’s own plan and the second run checks d, e, f', async () => {
    const log: Log = [];
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    let at = NOW;
    const d = deps(log, {
      cache: Object.fromEntries(ids.map((id) => [id, blank])),
      proxies: ids.map((id) => socks(id)),
      now: () => at,
    });
    expect((await runCapabilityRefresh(d)).checked).toEqual(['a', 'b', 'c']);
    expect((await runCapabilityRefresh(d)).checked).toEqual([]);
    expect((await runCapabilityRefresh(d)).checked).toEqual([]);
    at = NOW + CAPABILITY_BUDGET_WINDOW_MS;
    expect((await runCapabilityRefresh(d)).checked).toEqual(['d', 'e', 'f']);
  });

  it('CRITICAL ⛔ each row is RE-VALIDATED when its turn comes: a run lasts minutes, and a row the customer tested, edited or deleted meanwhile is not dialled on the strength of a plan made before. MUTATION: delete the `stillEligible` test in runCapabilityRefresh and `check:b` / `check:c` appear', async () => {
    const log: Log = [];
    const cache: ProbeCacheMap = { a: blank, b: blank, c: blank };
    let proxies = [socks('a'), socks('b'), socks('c')];
    const d = deps(log, {
      loadCache: () => Promise.resolve(cache),
      listProxies: () => Promise.resolve(proxies),
      result: (p) => {
        if (p.id === 'a') {
          // While `a` is being checked the customer Tests `b` themselves…
          cache.b = { ...blank, serverProbeAt: NOW };
          // …and deletes `c`.
          proxies = proxies.filter((row) => row.id !== 'c');
        }
        return { answered: true, accountRefused: false };
      },
    });
    const report = await runCapabilityRefresh(d);
    expect(report.checked).toEqual(['a']);
    expect(report.skippedChanged).toEqual(['b', 'c']);
    expect(log.filter((l) => l.startsWith('check:') || l.startsWith('attempt:'))).toEqual([
      'attempt:a',
      'check:a',
    ]);
  });

  it('CRITICAL ⛔ a LAUNCH or a manual Test never waits on the automatic check: the per-proxy probe claim is consulted, never HELD, across the 11–95 s server test. MUTATION: wrap `deps.check` in `withProxyProbe(p.id, …)` again and the user probe below does not resolve while the check is pending', async () => {
    const log: Log = [];
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const d = deps(log, {
      cache: { a: blank },
      proxies: [socks('a')],
      result: async () => {
        await held;
        return { answered: true, accountRefused: false };
      },
    });
    const run = runCapabilityRefresh(d);
    await vi.waitFor(() => expect(log).toContain('check:a'));
    expect(isProxyProbeInFlight('a')).toBe(false);
    let userProbeRan = false;
    await withProxyProbe('a', () => {
      userProbeRan = true;
      return Promise.resolve();
    });
    expect(userProbeRan).toBe(true);
    release();
    await run;
  });

  it('CRITICAL a row Driftstack is ALREADY testing — the customer’s own Test, whose server leg runs outside the probe claim — is skipped, unstamped: never a second test through the same proxy beside theirs. MUTATION: drop the `isServerTestInFlight` term in runCapabilityRefresh and `check:a` appears', async () => {
    const log: Log = [];
    const d = deps(log, { cache: { a: blank }, proxies: [socks('a')] });
    let release!: () => void;
    const manual = withServerTest(
      'aprx_a',
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    expect(isServerTestInFlight('aprx_a')).toBe(true);
    const report = await runCapabilityRefresh(d);
    expect(report.skippedBusy).toEqual(['a']);
    expect(log).toEqual([]);
    release();
    await manual;
    expect(isServerTestInFlight('aprx_a')).toBe(false);
  });

  it('…and the customer’s own server test WAITS for an automatic one on the same row, then runs — two at once is how the second gets "busy" for an answer, and that must never be the one they pressed', async () => {
    const order: string[] = [];
    let release!: () => void;
    const automatic = withServerTest('aprx_a', async () => {
      order.push('automatic:start');
      await new Promise<void>((r) => {
        release = r;
      });
      order.push('automatic:end');
    });
    const manual = withServerTest('aprx_a', () => {
      order.push('manual');
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(order).toEqual(['automatic:start']);
    release();
    await Promise.all([automatic, manual]);
    expect(order).toEqual(['automatic:start', 'automatic:end', 'manual']);
  });

  it('does not run BESIDE a reachability sweep: a trigger that lands while one is probing is answered `skipped` (the sweep’s own follow-up covers it). MUTATION: drop `|| inFlight` from the latch test and `check:a` appears', async () => {
    const log: Log = [];
    let release!: () => void;
    const sweeping = runSweep({
      loadCache: () => Promise.resolve({ s: { result: OK, at: 0 } }),
      listProxies: () => Promise.resolve([socks('s')]),
      testProxy: () =>
        new Promise<ProxyTestResult>((r) => {
          release = () => r(OK);
        }),
      saveResult: () => Promise.resolve({}),
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });
    await vi.waitFor(() => expect(isProxyProbeInFlight('s')).toBe(true));
    const d = deps(log, { cache: { a: blank }, proxies: [socks('a')] });
    expect((await runCapabilityRefresh(d)).skipped).toBe(true);
    expect(log).toEqual([]);
    release();
    await sweeping;
    expect((await runCapabilityRefresh(d)).checked).toEqual(['a']);
  });

  it('⛔ never prunes the ledger on an EMPTY proxy list — a transient empty read would wipe every row’s backoff', async () => {
    const pruned: string[][] = [];
    const log: Log = [];
    const prune = (ids: string[]): Promise<void> => {
      pruned.push(ids);
      return Promise.resolve();
    };
    await runCapabilityRefresh(deps(log, { proxies: [], pruneAttempts: prune }));
    expect(pruned).toEqual([]);
    await runCapabilityRefresh(deps(log, { proxies: [socks('a')], pruneAttempts: prune }));
    expect(pruned).toEqual([['a']]);
  });

  it('a row under a NATIVE probe right now is skipped (and not stamped), never checked underneath it', async () => {
    const log: Log = [];
    const d = deps(log, { cache: { a: blank }, proxies: [socks('a')] });
    let release!: () => void;
    const userTest = withProxyProbe(
      'a',
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const report = await runCapabilityRefresh(d);
    expect(report.skippedBusy).toEqual(['a']);
    expect(log).toEqual([]);
    release();
    await userTest;
  });

  it('reads the account at RUN time: no key, no plan, no request', async () => {
    const log: Log = [];
    const d = deps(log, {
      cache: { a: blank },
      proxies: [socks('a')],
      readCreds: () => ({ baseUrl: 'https://api.example', apiKey: null }),
    });
    expect((await runCapabilityRefresh(d)).checked).toEqual([]);
    expect(log).toEqual([]);
  });
});

describe('⛔ the automatic check uploads NOTHING', () => {
  const okReply = (): Response =>
    new Response(
      JSON.stringify({
        ok: true,
        latency_ms: 22,
        measured_from: 'fleet',
        node_id: 'n1',
        quic_ok: true,
        os_fingerprint: READING,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('CRITICAL the ONLY request is the test of the row the account already holds — never a create, never an update — and the credential-bearing calls are never reached. MUTATION: call `ensureAccountProxyRow(p, …)` at the top of checkCapabilitiesForRow and the PUT appears', async () => {
    const create = vi.spyOn(accountProxies, 'createProxy');
    const update = vi.spyOn(accountProxies, 'updateProxy');
    local.rows = [socks('a')];
    await saveProbeResult('a', OK, NOW - MIN);
    nextResponse = okReply;
    const result = await checkCapabilitiesForRow(
      socks('a'),
      { baseUrl: 'https://api.example', apiKey: 'ds_key' },
      () => NOW,
    );
    expect(result).toEqual({ answered: true, accountRefused: false });
    expect(requests).toEqual([
      {
        method: 'POST',
        url: 'https://api.example/v1/account/me/proxies/aprx_a/test?vantage=fleet',
      },
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    // …and what came back landed, dated by this check.
    const entry = (await loadProbeCache()).a;
    expect(entry?.quicProbe).toBe(true);
    expect(entry?.quicProbeAt).toBe(NOW);
    expect(entry?.osFingerprint?.os).toBe('macos-or-ios');
  });

  it('CRITICAL ⛔ a row with no serverId sends NOTHING even when called directly — the second belt under the planner. MUTATION: drop `p.serverId === undefined` from the guard in checkCapabilitiesForRow and a request goes out', async () => {
    const { serverId: _never, ...deviceOnly } = socks('a');
    nextResponse = okReply;
    expect(
      await checkCapabilitiesForRow(deviceOnly, {
        baseUrl: 'https://api.example',
        apiKey: 'ds_key',
      }),
    ).toEqual({ answered: false, accountRefused: false });
    expect(requests).toEqual([]);
  });

  it('CRITICAL reports the plan refusal as such (the 403 whose detail is the tier sentence), so the runner can back the whole account off for a day — and writes no verdict for it. MUTATION: return `accountRefused: false` from checkCapabilitiesForRow and this reds', async () => {
    local.rows = [socks('a')];
    await saveProbeResult('a', OK, NOW - MIN);
    const before = structuredClone(await loadProbeCache());
    nextResponse = () =>
      new Response(
        JSON.stringify({ detail: 'The "vpnEgress" feature is not available on the "free" tier.' }),
        { status: 403, headers: { 'content-type': 'application/problem+json' } },
      );
    expect(
      await checkCapabilitiesForRow(socks('a'), {
        baseUrl: 'https://api.example',
        apiKey: 'ds_key',
      }),
    ).toEqual({ answered: true, accountRefused: true });
    expect(await loadProbeCache()).toEqual(before);
  });

  it('CRITICAL the OTHER account refusal — the credential this desktop signed in with — is reported the same way: "retrying with this credential cannot change it", so every row backs off for the day instead of costing one refused request each, every six hours, for ever. MUTATION: drop `desktop_credential` from isAccountRefusal and this reds', async () => {
    local.rows = [socks('a')];
    await saveProbeResult('a', OK, NOW - MIN);
    vi.spyOn(accountProxies, 'testAccountProxy').mockResolvedValue({
      ok: false,
      reason: 'This sign-in cannot run this check.',
      not_run: 'desktop_credential',
    });
    expect(
      await checkCapabilitiesForRow(socks('a'), {
        baseUrl: 'https://api.example',
        apiKey: 'ds_key',
      }),
    ).toEqual({ answered: true, accountRefused: true });
    // CONTROL — a refusal about the ROW (no machine free) is not one about the account.
    vi.spyOn(accountProxies, 'testAccountProxy').mockResolvedValue({
      ok: false,
      reason: 'busy',
      not_run: 'no_node',
    });
    expect(
      await checkCapabilitiesForRow(socks('a'), {
        baseUrl: 'https://api.example',
        apiKey: 'ds_key',
      }),
    ).toEqual({ answered: true, accountRefused: false });
  });

  it('CRITICAL ⛔ a reply about a row that was EDITED while the check was in flight lands NOTHING. The check cannot push local changes (the consent rule), so it measured the endpoint the account held when it started; persisted onto the edited row, the old endpoint’s OS / QUIC readings would read as current and the re-test would then carry them forward. MUTATION: delete the `rowIdentity(current) === asked` test in checkCapabilitiesForRow and the first block reds', async () => {
    const reply = {
      ok: true as const,
      latency_ms: 22,
      measured_from: 'fleet' as const,
      node_id: 'n1',
      quic_probe: true,
    };
    await saveProbeResult('a', OK, NOW - MIN);
    const before = structuredClone(await loadProbeCache());
    // The host changes while the request is out.
    local.rows = [socks('a')];
    vi.spyOn(accountProxies, 'testAccountProxy').mockImplementation(() => {
      local.rows = [socks('a', { host: 'moved.example.com' })];
      return Promise.resolve(reply);
    });
    const creds = { baseUrl: 'https://api.example', apiKey: 'ds_key' };
    await checkCapabilitiesForRow(socks('a'), creds, () => NOW);
    expect(await loadProbeCache()).toEqual(before);
    // …and the same when the row was DELETED meanwhile.
    local.rows = [socks('a')];
    vi.spyOn(accountProxies, 'testAccountProxy').mockImplementation(() => {
      local.rows = [];
      return Promise.resolve(reply);
    });
    await checkCapabilitiesForRow(socks('a'), creds, () => NOW);
    expect(await loadProbeCache()).toEqual(before);
    // CONTROL — an untouched row takes the same reply: the guard is the identity.
    local.rows = [socks('a')];
    vi.spyOn(accountProxies, 'testAccountProxy').mockResolvedValue(reply);
    await checkCapabilitiesForRow(socks('a'), creds, () => NOW);
    expect((await loadProbeCache()).a?.quicProbe).toBe(true);
  });

  it('a request that gets no usable reply is `answered: false` — the runner ends the run on it', async () => {
    local.rows = [socks('a')];
    await saveProbeResult('a', OK, NOW - MIN);
    expect(
      await checkCapabilitiesForRow(socks('a'), {
        baseUrl: 'https://api.example',
        apiKey: 'ds_key',
      }),
    ).toEqual({ answered: false, accountRefused: false });
  });
});

describe('⛔ a row nobody tested here adopts a SUCCESS and nothing else', () => {
  const failed: ServerProbeOutcome = { kind: 'failed', at: NOW, reason: 'did not answer' };
  const notRun: ServerProbeOutcome = {
    kind: 'not_run',
    at: NOW,
    why: 'no_node',
    reason: 'busy',
    exitObserved: { ip: '203.0.113.9', country: 'NL', region: null, city: null, timezone: null },
  };
  const ok: ServerProbeOutcome = {
    kind: 'ok',
    at: NOW,
    latencyMs: 22,
    vantage: { measuredFrom: 'fleet', nodeId: 'n1' },
    quicProbe: true,
    udpProbe: false,
    osFingerprint: READING,
  };

  // ⚠️ What this arm discriminates is `hasLocalVerdict` versus "an entry exists": a
  // seeded entry EXISTS, and treating it as a local verdict hands a VPN row's failure
  // to `saveFleetFailure`, which rebuilds the entry without `serverSeeded`. (Deleting
  // the `outcome.kind !== 'ok'` return does NOT red it — the seeded entry is already
  // there and `persistServerProbe` without `adoptExit` writes nothing for a failure;
  // that mutation is caught by the no-entry arm below, where an entry gets invented.)
  it('CRITICAL a FAILED automatic reply paints NOTHING on a server-seeded VPN row: no "could not connect" sentence, no red pill, the seeded mark intact. MUTATION: in persistAutomaticServerProbe replace `hasLocalVerdict` with `entry !== undefined` and every expectation below reds', async () => {
    await seedServerOsFingerprint('v', READING, NOW - HOUR);
    const before = structuredClone(await loadProbeCache());
    expect(await persistAutomaticServerProbe(vpn('v'), failed)).toBeNull();
    expect(await persistAutomaticServerProbe(vpn('v'), notRun)).toBeNull();
    const after = await loadProbeCache();
    expect(after).toEqual(before);
    expect(after.v?.serverSeeded).toBe(true);
    expect(fleetFailureReasons(after)).toEqual({});
    expect(deriveProbeViewWithEndpointRows(after, NOW).testResults).toEqual({});
  });

  it('…and the same for a row with NO entry at all: a failure invents nothing. MUTATION: delete the `if (outcome.kind !== "ok") return null` and the not_run reply invents a seeded entry', async () => {
    expect(await persistAutomaticServerProbe(vpn('v'), failed)).toBeNull();
    expect(await persistAutomaticServerProbe(socks('s'), failed)).toBeNull();
    expect(await persistAutomaticServerProbe(socks('s'), notRun)).toBeNull();
    expect(await loadProbeCache()).toEqual({});
  });

  it('…and a server-seeded SOCKS5 row: a failed or refused reply leaves the entry byte for byte — no failure sentence, no superseded stamp, the seeded mark intact', async () => {
    await seedServerOsFingerprint('s', READING, NOW - HOUR);
    const before = structuredClone(await loadProbeCache());
    expect(await persistAutomaticServerProbe(socks('s'), failed)).toBeNull();
    expect(await persistAutomaticServerProbe(socks('s'), notRun)).toBeNull();
    const after = await loadProbeCache();
    expect(after).toEqual(before);
    expect(Object.keys(after.s ?? {})).not.toContain('fleetFailureReason');
    expect(Object.keys(after.s ?? {})).not.toContain('exitSupersededAt');
    expect(after.s?.serverSeeded).toBe(true);
  });

  it('CRITICAL ⛔ a VPN row the customer only ever ADDRESS-checked is not painted "tunnel down" by a timer either: a resolved address says the name resolves, and nobody asked whether the tunnel comes up (the row can be on the account from a launch). MUTATION: delete the `!holdsFleetVerdict(entry)` return in persistAutomaticServerProbe and this reds', async () => {
    await saveEndpointResult('v', { resolved: true, ip: '198.51.100.7', message: 'ok' }, NOW - MIN);
    const before = structuredClone(await loadProbeCache());
    expect(await persistAutomaticServerProbe(vpn('v'), failed)).toBeNull();
    expect(await loadProbeCache()).toEqual(before);
    expect(fleetFailureReasons(await loadProbeCache())).toEqual({});
  });

  it('CONTROL — a VPN row that already HOLDS an answer about its tunnel takes the failure exactly as its manual check would: there it replaces a "tunnel up" that has stopped being true', async () => {
    await saveEndpointResult(
      'v',
      { resolved: true, ip: '198.51.100.7', message: 'ok' },
      NOW - HOUR,
    );
    await saveServerProbeResult('v', { latencyMs: 40, measuredFrom: 'fleet' }, NOW - HOUR);
    await persistAutomaticServerProbe(vpn('v'), failed);
    const cache = await loadProbeCache();
    expect(fleetFailureReasons(cache)).toEqual({ v: 'did not answer' });
    expect(cache.v?.serverLatencyMs).toBeUndefined();
  });

  it('a FULL answer that still leaves a reading blank is recorded as one this proxy does not produce (a VPN’s QUIC leg is skipped today) — and a later full answer that leaves none blank lifts the mark. MUTATION: drop the `noteCapabilityReadingsNotProduced` call and the first block reds', async () => {
    await saveEndpointResult('v', { resolved: true, ip: '198.51.100.7', message: 'ok' }, NOW - MIN);
    const skipped: ServerProbeOutcome = {
      kind: 'ok',
      at: NOW,
      latencyMs: 40,
      vantage: { measuredFrom: 'fleet', nodeId: 'n1' },
      quicLegSkipped: true,
      udpProbe: true,
    };
    await persistAutomaticServerProbe(vpn('v'), skipped, () => NOW);
    expect((await loadCapabilityAttempts()).v?.readingsNotProducedAt).toBe(NOW);
    await persistAutomaticServerProbe(vpn('v'), { ...ok, udpProbe: true }, () => NOW + HOUR);
    expect((await loadCapabilityAttempts()).v?.readingsNotProducedAt).toBeUndefined();
  });

  it('CRITICAL a SUCCESS on a never-tested SOCKS5 row lands its readings on a SEEDED entry — shown, dated, and asserting nothing about reachability (no test result, no "Tested" stamp). MUTATION: drop the `ensureServerSeededEntry` call and nothing is stored at all', async () => {
    expect(await persistAutomaticServerProbe(socks('s'), ok)).not.toBeNull();
    const cache = await loadProbeCache();
    expect(cache.s?.serverSeeded).toBe(true);
    expect(cache.s?.quicProbe).toBe(true);
    expect(cache.s?.quicProbeAt).toBe(NOW);
    expect(cache.s?.udpProbe).toBe(false);
    const view = deriveProbeViewState(cache, NOW);
    expect(view.testResults).toEqual({});
    expect(view.testedAt).toEqual({});
    expect(view.osFingerprints.s?.os).toBe('macos-or-ios');
  });
});

describe('the backoff ledger', () => {
  it('survives every writer that REBUILDS a cache entry — which is why it is its own key and not a field on the entry. A native re-test, an address check and an edit are the three that would have lost it', async () => {
    await saveProbeResult('a', OK, NOW - HOUR);
    await recordCapabilityAttempt(['a', 'b'], NOW - MIN, false);
    await saveProbeResult('a', DOWN, NOW); // field-by-field rebuild
    await saveEndpointResult('b', { resolved: true, ip: '1.2.3.4', message: 'ok' }, NOW);
    expect(await loadCapabilityAttempts()).toEqual({
      a: { capabilityCheckAttemptedAt: NOW - MIN },
      b: { capabilityCheckAttemptedAt: NOW - MIN },
    });
  });

  it('CRITICAL ⛔ an EDIT marks the row `materialUnsynced` and drops its attempt stamp: the automatic check never uploads, so until something stores the edited row it would test the OLD endpoint. The mark is lifted only by a store of the row; an ACCOUNT refusal survives the edit (it is not a fact about the endpoint). MUTATION: in invalidateProbe delete the ledger write and the first expectation reds', async () => {
    await recordCapabilityAttempt(['a'], NOW - MIN, false);
    await recordCapabilityAttempt(['b'], NOW - MIN, true);
    await invalidateProbe('a');
    await invalidateProbe('b');
    await invalidateProbe('never-attempted');
    expect(await loadCapabilityAttempts()).toEqual({
      a: { capabilityCheckAttemptedAt: 0, materialUnsynced: true },
      b: { capabilityCheckAttemptedAt: NOW - MIN, planExcluded: true, materialUnsynced: true },
      'never-attempted': { capabilityCheckAttemptedAt: 0, materialUnsynced: true },
    });
    // The planner leaves such a row alone, however blank…
    expect(plan({}, [socks('a')], await loadCapabilityAttempts())).toEqual([]);
    // …a new attempt stamp does not lift the mark (it describes the ROW)…
    await recordCapabilityAttempt(['a'], NOW, false);
    expect((await loadCapabilityAttempts()).a?.materialUnsynced).toBe(true);
    // …and a store of the row does, after which it is owed a look of its own.
    await clearCapabilityMaterialUnsynced('a');
    expect(await loadCapabilityAttempts()).toMatchObject({
      a: { capabilityCheckAttemptedAt: NOW },
    });
    expect((await loadCapabilityAttempts()).a?.materialUnsynced).toBeUndefined();
  });

  it('CRITICAL ⛔ a ledger that cannot be READ rejects — it is never answered as `{}`. Answered empty, the runner plans every row as never attempted, and a writer rebuilding the map from that answer writes the empty map back: one transient read failure wiping every row’s backoff. MUTATION: wrap readCapabilityAttemptsStrict in `catch { return {} }` and all three red', async () => {
    await recordCapabilityAttempt(['a', 'b'], NOW - MIN, false);
    const map = stores.get('proxy-probe-cache.json');
    const held = structuredClone(map?.get('capability_attempts'));
    storeFault.get = true;
    await expect(loadCapabilityAttempts()).rejects.toThrow('store unreadable');
    await expect(recordCapabilityAttempt(['c'], NOW, false)).rejects.toThrow('store unreadable');
    storeFault.get = false;
    // …and the write that could not read wrote NOTHING: a and b keep their stamps.
    expect(map?.get('capability_attempts')).toEqual(held);
  });

  it('CRITICAL a successful STORE of the row lifts the edited-row mark — `ensureAccountProxyRow` is what a launch and a SOCKS5 Test call, and the account then holds this Mac’s material again. A refused store lifts nothing. MUTATION: delete the `clearCapabilityMaterialUnsynced` call after `updateAccountProxy` and the first block reds', async () => {
    const creds = ['https://api.example', 'ds_key'] as const;
    await invalidateProbe('a');
    nextResponse = () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    await ensureAccountProxyRow(socks('a'), ...creds);
    expect((await loadCapabilityAttempts()).a?.materialUnsynced).toBeUndefined();

    await invalidateProbe('b');
    nextResponse = () => new Response('{}', { status: 500 });
    await expect(ensureAccountProxyRow(socks('b'), ...creds)).rejects.toBeDefined();
    expect((await loadCapabilityAttempts()).b?.materialUnsynced).toBe(true);
  });

  it('prunes the records of proxies that no longer exist — a deleted proxy’s mark otherwise lives for ever', async () => {
    await recordCapabilityAttempt(['a', 'gone'], NOW, false);
    await pruneCapabilityAttempts(['a']);
    expect(Object.keys(await loadCapabilityAttempts())).toEqual(['a']);
  });

  it('records the plan refusal, and drops a malformed record rather than letting it suppress a check for ever', async () => {
    await recordCapabilityAttempt(['a'], NOW, true);
    expect(await loadCapabilityAttempts()).toEqual({
      a: { capabilityCheckAttemptedAt: NOW, planExcluded: true },
    });
    stores.get('proxy-probe-cache.json')?.set('capability_attempts', {
      a: { capabilityCheckAttemptedAt: 'yesterday' },
      b: null,
    });
    expect(await loadCapabilityAttempts()).toEqual({});
  });
});
