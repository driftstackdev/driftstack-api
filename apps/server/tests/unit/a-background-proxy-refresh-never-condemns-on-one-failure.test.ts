// ITEM 4 — the background proxy-freshness chain, at the level where its promises
// are either kept or not.
//
// The sweep dials a CUSTOMER'S proxy on their bandwidth, on a schedule nobody is
// watching. Four of its properties are therefore not refactoring details:
//
//   * it re-arms even when the tick throws — a chain that stops has no error at
//     the moment it matters, and the readings simply go stale forever;
//   * it stops at its own wall-clock budget — a handler that outruns the 5-minute
//     stale lock is re-claimed and RUN AGAIN while the first run is still going,
//     which for this job means a second connection through someone's proxy;
//   * ONE failed probe changes NOTHING a customer can see — a proxy that is fine
//     but momentarily unreachable from our network must not be reported as stale;
//   * two workers cannot both take the same proxy.
//
// The double-processing and live-session arms below are driven through the
// in-memory repo, which MIRRORS the Drizzle claim clause for clause. That proves
// the SERVICE claims rather than lists — the production shape — but it cannot
// prove the SQL: `FOR UPDATE SKIP LOCKED`, the scheme predicate and the
// live-session NOT EXISTS are proven against a real Postgres in
// `tests/integration/a-second-worker-cannot-claim-the-same-proxy-for-refresh`.
// Neither file is sufficient alone and each says so.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  InMemoryAccountProxiesRepo,
  type AccountProxyRow,
} from '../../src/db/account-proxies-repo.js';
import type {
  EnqueueScheduledJobInput,
  ScheduledJobHandler,
  ScheduledJobRow,
  ScheduledJobsService,
} from '../../src/services/scheduled-jobs.js';
import type { Logger } from '../../src/lib/logger.js';
import type {
  OsObservation,
  ProbeProxyDescriptor,
  ProxyProbeResult,
} from '../../src/services/proxy-connectivity-probe.js';
import {
  PROXY_FRESHNESS_CHAIN_INTERVAL_MS,
  PROXY_FRESHNESS_CONDEMN_AFTER_FAILURES,
  PROXY_FRESHNESS_JOB_TYPE,
  PROXY_FRESHNESS_LEASE_SAFETY_MS,
  PROXY_FRESHNESS_REFRESH_INTERVAL_MS,
  PROXY_FRESHNESS_TICK_BUDGET_MS,
  proxyFreshnessEffectiveBudgetMs,
  proxyFreshnessWorstCasePerProxyMs,
  registerProxyFreshnessJob,
  runProxyFreshnessTick,
  type ProxyFreshnessProbe,
  type ProxyFreshnessResolver,
} from '../../src/services/proxy-freshness-job.js';
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  OS_OBSERVE_TIMEOUT_MS,
  OS_OBSERVE_WORST_CASE_MS,
} from '../../src/services/proxy-connectivity-probe.js';
import { SCHEDULED_JOB_STALE_LOCK_MS } from '../../src/db/scheduled-jobs-repo.js';
import { OS_OBSERVER_LOOKUP_TIMEOUT_MS } from '../../src/lib/os-observer-lookup.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
} as unknown as Logger;

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const START_MS = Date.parse('2026-09-16T09:00:00.000Z');

class FakeScheduledJobs {
  handlers = new Map<string, ScheduledJobHandler>();
  enqueued: EnqueueScheduledJobInput[] = [];
  register(jobType: string, handler: ScheduledJobHandler): void {
    this.handlers.set(jobType, handler);
  }
  enqueue(input: EnqueueScheduledJobInput): Promise<{ enqueued: boolean }> {
    this.enqueued.push(input);
    return Promise.resolve({ enqueued: true });
  }
  handler(jobType: string): ScheduledJobHandler {
    const h = this.handlers.get(jobType);
    if (h === undefined) throw new Error(`no handler registered for ${jobType}`);
    return h;
  }
  asService(): ScheduledJobsService {
    return this as unknown as ScheduledJobsService;
  }
}

function jobRow(runAt: Date): ScheduledJobRow {
  return {
    id: 'job-1',
    jobType: PROXY_FRESHNESS_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt,
    attempts: 1,
    maxAttempts: 5,
  };
}

/** A clock the test moves by hand — the tick's budget is wall-clock, so the only
 *  way to reach it deterministically is to make time a value. */
function clock(startMs = START_MS): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const resolverFor = (
  repo: InMemoryAccountProxiesRepo,
  seen: string[] = [],
): ProxyFreshnessResolver => ({
  resolveProbeDescriptor: async ({ proxyId, accountId }) => {
    seen.push(proxyId);
    const row = await repo.findById({ id: proxyId, accountId });
    if (row === null) return null;
    const protocol: 'socks5' | 'http' | null =
      row.scheme === 'socks5' ? 'socks5' : row.scheme === 'http' ? 'http' : null;
    if (protocol === null) return null;
    return { protocol, host: row.host, port: row.port };
  },
});

const okProbeResult = (ip = '203.0.113.7'): ProxyProbeResult => ({
  ok: true,
  exitIdentity: { ip, country: 'NL', region: null, city: null, timezone: 'Europe/Amsterdam' },
});

const observedOs = (): OsObservation =>
  ({
    observed: true,
    os: 'linux',
    confidence: 'high',
    // The probe's DIAGNOSTIC reason. What lands on the row must be the
    // customer-facing sentence instead — asserted below.
    reason: 'ttl 64, mss 1460, window 29200',
    observedIp: '198.51.100.9',
    via: 'proxy_host',
    singleHostVantage: false,
    webPortVantage: false,
    observedPort: 8443,
    // The raw SYN signature is not read by anything under test.
    signature: { ttl: 64, mss: 1460, window: 29200, options: [] },
  }) as unknown as OsObservation;

/** A probe that records what it dialled. `onProbe` runs INSIDE the probe, which
 *  is how a test simulates something landing while the dial is in flight. */
function fakeProbe(opts: {
  dialed: ProbeProxyDescriptor[];
  result?: ProxyProbeResult;
  os?: OsObservation | 'throw';
  onProbe?: () => void | Promise<void>;
}): ProxyFreshnessProbe {
  return {
    probe: async (descriptor) => {
      opts.dialed.push(descriptor);
      if (opts.onProbe !== undefined) await opts.onProbe();
      return opts.result ?? okProbeResult();
    },
    // A REJECTED promise rather than an async throw — identical at the call site
    // (the job awaits this inside its own try), and it keeps the helper free of
    // an async function with nothing to await.
    observeOs: (): Promise<OsObservation> =>
      opts.os === 'throw'
        ? Promise.reject(new Error('observer tunnel refused'))
        : Promise.resolve(opts.os ?? observedOs()),
  };
}

async function seedProxy(
  repo: InMemoryAccountProxiesRepo,
  args: { id: string; scheme?: string; label?: string },
): Promise<AccountProxyRow> {
  return repo.create(ACCOUNT, {
    id: args.id,
    label: args.label ?? args.id,
    scheme: args.scheme ?? 'socks5',
    host: `${args.id}.proxy.example.com`,
    port: 1080,
    username: null,
    wrappedPassword: null,
  });
}

const rowOf = async (repo: InMemoryAccountProxiesRepo, id: string): Promise<AccountProxyRow> => {
  const row = await repo.findById({ id, accountId: ACCOUNT });
  if (row === null) throw new Error(`proxy ${id} vanished`);
  return row;
};

const noSleep = (): Promise<void> => Promise.resolve();

describe('the background proxy-freshness chain', () => {
  it('CRITICAL re-arms even when the tick THROWS. A chain with no external scheduler exists only as long as every tick enqueues its successor: the first tick that throws would otherwise be the last one that ever runs, the poller would burn maxAttempts, markFailed would leave no pending row, and every saved proxy would stop being refreshed — silently, with no error at the moment it matters.', async () => {
    const scheduledJobs = new FakeScheduledJobs();
    const dialed: ProbeProxyDescriptor[] = [];
    const exploding = {
      claimDueForFreshnessRefresh: () => Promise.reject(new Error('postgres went away')),
      findById: () => Promise.resolve(null),
      update: () => Promise.resolve(null),
      recordFreshnessFailure: () => Promise.resolve(null),
    } as unknown as InMemoryAccountProxiesRepo;

    registerProxyFreshnessJob({
      scheduledJobs: scheduledJobs.asService(),
      proxies: exploding,
      resolver: resolverFor(new InMemoryAccountProxiesRepo()),
      probe: fakeProbe({ dialed }),
      logger: silentLogger,
      nowFn: () => START_MS,
      sleepFn: noSleep,
    });

    const runAt = new Date(START_MS);
    // Must NOT reject: a throw escaping to the poller is the other way this chain
    // dies (retry until maxAttempts, then no pending row at all).
    await expect(
      scheduledJobs.handler(PROXY_FRESHNESS_JOB_TYPE)(jobRow(runAt)),
    ).resolves.toBeUndefined();

    expect(
      scheduledJobs.enqueued.map((e) => e.jobType),
      'the successor is armed on the throwing path, not only on the happy one',
    ).toEqual([PROXY_FRESHNESS_JOB_TYPE]);
    expect(scheduledJobs.enqueued[0]?.runAt.getTime()).toBe(
      START_MS + PROXY_FRESHNESS_CHAIN_INTERVAL_MS,
    );
    expect(
      scheduledJobs.enqueued[0]?.dedupAfterRunAt,
      'the re-arm dedups only against a committed FUTURE successor, never against its own cohort',
    ).toBe(runAt);
  });

  it('CRITICAL stops at its wall-clock budget and re-arms instead of running long. The scheduler re-claims a job whose lock has gone 5 minutes untouched WITHOUT excluding the still-running worker, so a tick that overruns is run a second time concurrently — for this job that is a second dial through the same customer proxy. Rows it did not reach are left UNCLAIMED, so the next tick takes them.', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) await seedProxy(repo, { id });
    const c = clock();
    const dialed: ProbeProxyDescriptor[] = [];
    // 40s per proxy: the third probe ends at 120s, and 120s + the 30s worst case
    // for a fourth is past the 120s budget, so the tick stops with two left.
    const perProbeMs = 40_000;

    const result = await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo),
      probe: fakeProbe({ dialed, onProbe: () => c.advance(perProbeMs) }),
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });

    expect(result.stoppedAtBudget, 'the tick knows it stopped early').toBe(true);
    expect(result.claimed, 'three fit inside the budget, two did not').toBe(3);
    const untouched = await Promise.all(
      ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => rowOf(repo, id)),
    );
    expect(
      untouched.filter((r) => r.freshnessAttemptedAt === null),
      'a row the tick never dialled must NOT be stamped as attempted, or it waits a full refresh interval for a probe that never happened',
    ).toHaveLength(2);
    // The arithmetic this budget rests on, pinned against the probe that will
    // actually dial rather than against module constants — see the arms below.
    const defaultWorstCase = proxyFreshnessWorstCasePerProxyMs(fakeProbe({ dialed: [] }));
    expect(
      PROXY_FRESHNESS_TICK_BUDGET_MS + defaultWorstCase,
      'the overshoot bound must stay well inside the 5-minute stale lock',
    ).toBeLessThan(SCHEDULED_JOB_STALE_LOCK_MS);
  });

  it('CRITICAL a due SOCKS5 proxy is refreshed and BOTH readings are persisted with the date they were taken. This is the whole point of the chain: a reading taken once on one Mac is invisible to a second machine and to a reinstall, and nothing re-took it.', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    await seedProxy(repo, { id: 'p1' });
    const c = clock();
    const dialed: ProbeProxyDescriptor[] = [];

    const result = await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo),
      probe: fakeProbe({ dialed }),
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });

    expect(result).toMatchObject({ claimed: 1, refreshed: 1, failed: 0, skipped: 0 });
    const row = await rowOf(repo, 'p1');
    expect(row.exitObserved).toEqual({
      ip: '203.0.113.7',
      country: 'NL',
      timezone: 'Europe/Amsterdam',
      observed_via: 'probe',
    });
    expect(row.exitObservedAt?.getTime()).toBe(START_MS);
    expect(row.osFingerprint).toEqual({
      os: 'linux',
      confidence: 'high',
      // The CUSTOMER-facing sentence, identical to the one the /test route
      // stores — the /proxies list shows this field to a person.
      reason: 'Based on how this proxy responds to a network connection.',
      observed_ip: '198.51.100.9',
      observed_via: 'proxy_host',
      single_host_vantage: false,
      web_port_vantage: false,
    });
    expect(row.osFingerprintAt?.getTime()).toBe(START_MS);
    expect(row.freshnessAttemptedAt?.getTime(), 'the attempt is recorded by the claim').toBe(
      START_MS,
    );

    // And it is not re-dialled on the next tick: the cooldown is the attempt
    // stamp, so a second tick a minute later finds nothing due.
    c.advance(60_000);
    dialed.length = 0;
    const second = await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo),
      probe: fakeProbe({ dialed }),
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });
    expect(second.claimed, 'still inside the 6-hour per-proxy cooldown').toBe(0);
    expect(dialed, 'the customer proxy is not dialled again').toEqual([]);
  });

  it('CRITICAL a VPN row is SKIPPED, and not by accident. An OpenVPN/WireGuard tunnel can only be brought up by a fleet node — the control plane cannot dial one — so a VPN refresh needs node dispatch and its own "do not open a second tunnel" policy. It is excluded twice: the claim never returns one, and the refresher refuses one that reaches it anyway.', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    await seedProxy(repo, { id: 'vpn1', scheme: 'openvpn' });
    await seedProxy(repo, { id: 'wg1', scheme: 'wireguard' });
    await seedProxy(repo, { id: 'p1', scheme: 'socks5' });
    const c = clock();
    const dialed: ProbeProxyDescriptor[] = [];
    const resolved: string[] = [];

    const result = await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo, resolved),
      probe: fakeProbe({ dialed }),
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });

    expect(result.claimed, 'only the socks5 row is claimable').toBe(1);
    expect(resolved, 'a VPN row is never even resolved to a descriptor').toEqual(['p1']);
    expect((await rowOf(repo, 'vpn1')).freshnessAttemptedAt).toBeNull();
    expect((await rowOf(repo, 'wg1')).freshnessAttemptedAt).toBeNull();

    // Defence in depth: hand the refresher a VPN row directly — as a changed
    // claim predicate would — and it must still refuse to dial it.
    const vpnRow = await rowOf(repo, 'vpn1');
    const lyingRepo = {
      claimDueForFreshnessRefresh: (() => {
        let handed = false;
        return () => {
          if (handed) return Promise.resolve(null);
          handed = true;
          return Promise.resolve(vpnRow);
        };
      })(),
      findById: repo.findById.bind(repo),
      update: repo.update.bind(repo),
      recordFreshnessFailure: repo.recordFreshnessFailure.bind(repo),
    } as unknown as InMemoryAccountProxiesRepo;
    const dialedAfter: ProbeProxyDescriptor[] = [];
    const resolvedAfter: string[] = [];
    const forced = await runProxyFreshnessTick({
      proxies: lyingRepo,
      resolver: resolverFor(repo, resolvedAfter),
      probe: fakeProbe({ dialed: dialedAfter }),
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });
    expect(forced.skipped).toBe(1);
    expect(resolvedAfter, 'refused before anything is resolved or dialled').toEqual([]);
    expect(dialedAfter).toEqual([]);
  });

  it('CRITICAL ONE failed background probe changes NOTHING a customer can see — not the exit, not the fingerprint, not even updated_at. This is the webhooks precedent (recordRetry deliberately does not bump consecutive_failures; only recordDlq does): a proxy that is healthy but momentarily unreachable from our network must never be reported as stale because of a blip nobody watched.', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    await seedProxy(repo, { id: 'p1' });
    const c = clock();
    // Give it a good reading first, the way a customer's own Test would.
    await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo),
      probe: fakeProbe({ dialed: [] }),
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });
    const good = await rowOf(repo, 'p1');
    expect(good.exitObserved).not.toBeNull();

    const failTick = async (): Promise<void> => {
      // Past the cooldown AND past the linear failure backoff.
      c.advance(PROXY_FRESHNESS_REFRESH_INTERVAL_MS * 5);
      await runProxyFreshnessTick({
        proxies: repo,
        resolver: resolverFor(repo),
        probe: fakeProbe({ dialed: [], result: { ok: false, reason: 'timeout' } }),
        logger: silentLogger,
        nowFn: c.now,
        sleepFn: noSleep,
      });
    };

    await failTick();
    const afterOne = await rowOf(repo, 'p1');
    expect(afterOne.exitObserved, 'the stored exit is untouched').toEqual(good.exitObserved);
    expect(afterOne.exitObservedAt?.getTime()).toBe(good.exitObservedAt?.getTime());
    expect(afterOne.osFingerprint, 'the stored fingerprint is untouched').toEqual(
      good.osFingerprint,
    );
    expect(
      afterOne.exitSupersededAt,
      'ONE failure must not mark the stored exit contradicted — that is customer-visible',
    ).toBeNull();
    expect(
      afterOne.updatedAt.getTime(),
      'updated_at is on the metadata view; a failed background probe is not an edit',
    ).toBe(good.updatedAt.getTime());
    expect(afterOne.freshnessConsecutiveFailures).toBe(1);

    await failTick();
    expect(
      (await rowOf(repo, 'p1')).exitSupersededAt,
      'nor does the second, at roughly twelve hours',
    ).toBeNull();

    await failTick();
    const afterThree = await rowOf(repo, 'p1');
    expect(afterThree.freshnessConsecutiveFailures).toBe(PROXY_FRESHNESS_CONDEMN_AFTER_FAILURES);
    expect(
      afterThree.exitSupersededAt,
      'only a SUSTAINED run — three dials across roughly a day — dates the contradiction',
    ).not.toBeNull();
    expect(afterThree.exitObserved, 'and even then the exit itself is KEPT').toEqual(
      good.exitObserved,
    );
    // Proxy-accuracy audit G2 (d), second pass (0146) — the streak is the CONTROL
    // PLANE's, from an address that is not the one sessions use: it dates a
    // contradicted exit, and it is NEVER Driftstack's verdict about the proxy. The
    // desktop reads `full_check_ok` for that, so the job must never write it.
    expect(
      { ok: afterThree.fullCheckOk, at: afterThree.fullCheckAt },
      'the background streak writes no full-check verdict',
    ).toEqual({ ok: null, at: null });

    // A provider outage must heal itself: the next success clears both.
    c.advance(PROXY_FRESHNESS_REFRESH_INTERVAL_MS * 5);
    await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo),
      probe: fakeProbe({ dialed: [], result: okProbeResult('203.0.113.9') }),
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });
    const healed = await rowOf(repo, 'p1');
    expect(healed.freshnessConsecutiveFailures).toBe(0);
    expect(
      healed.exitSupersededAt,
      'a contradiction older than an observation is spent',
    ).toBeNull();
    expect(healed.exitObserved?.ip).toBe('203.0.113.9');
  });

  it('CRITICAL two workers ticking at once never process the same proxy twice. Every probe is a real connection through a customer proxy, so a double-claim is a doubled bill, not a bookkeeping slip. The tick CLAIMS each row (the claim stamps the attempt) rather than listing and filtering — a lister would hand both workers the same rows.', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    for (const id of ['p1', 'p2', 'p3']) await seedProxy(repo, { id });
    const c = clock();
    const dialedA: ProbeProxyDescriptor[] = [];
    const dialedB: ProbeProxyDescriptor[] = [];
    const tick = (dialed: ProbeProxyDescriptor[]) =>
      runProxyFreshnessTick({
        proxies: repo,
        resolver: resolverFor(repo),
        probe: fakeProbe({ dialed }),
        logger: silentLogger,
        nowFn: c.now,
        sleepFn: noSleep,
      });

    const [a, b] = await Promise.all([tick(dialedA), tick(dialedB)]);

    const hosts = [...dialedA, ...dialedB].map((d) => d.host);
    expect(hosts, 'three proxies, three dials in total').toHaveLength(3);
    expect(new Set(hosts).size, 'and no proxy dialled twice').toBe(3);
    expect(a.claimed + b.claimed).toBe(3);
  });

  it("CRITICAL a proxy a LIVE agent session is using is never dialled. The session is already writing that row's exit through the capabilityReport relay — fresher than anything this sweep could measure — and a background dial would add a connection to the customer's proxy while they are browsing through it.", async () => {
    const repo = new InMemoryAccountProxiesRepo();
    await seedProxy(repo, { id: 'busy' });
    await seedProxy(repo, { id: 'idle' });
    repo.setLiveSessionProxyIds(['busy']);
    const dialed: ProbeProxyDescriptor[] = [];

    await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo),
      probe: fakeProbe({ dialed }),
      logger: silentLogger,
      nowFn: clock().now,
      sleepFn: noSleep,
    });

    expect(dialed.map((d) => d.host)).toEqual(['idle.proxy.example.com']);
    expect(
      (await rowOf(repo, 'busy')).freshnessAttemptedAt,
      'it is not even claimed, so it is refreshed the moment the session closes',
    ).toBeNull();
  });

  it("CRITICAL a proxy whose exit SOMEBODY ELSE already refreshed is not dialled again. The point of the sweep is a CURRENT reading, not a reading of our own: an exit a live session's relay or the customer's own Test observed an hour ago is exactly as fresh as one we would take now, and dialling for it spends their bandwidth to learn nothing.", async () => {
    const repo = new InMemoryAccountProxiesRepo();
    await seedProxy(repo, { id: 'fresh' });
    const c = clock();
    // Someone else observed this exit an hour ago — inside the 6-hour window.
    await repo.update({
      id: 'fresh',
      accountId: ACCOUNT,
      updates: {
        exitObserved: {
          ip: '203.0.113.30',
          country: 'NL',
          timezone: 'Europe/Amsterdam',
          observed_via: 'session',
        },
        exitObservedAt: new Date(c.now() - 60 * 60 * 1000),
      },
    });
    const dialed: ProbeProxyDescriptor[] = [];

    const result = await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo),
      probe: fakeProbe({ dialed }),
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });

    expect(result.claimed, 'never attempted by US, and still not due').toBe(0);
    expect(dialed, 'nothing dialled').toEqual([]);

    // Once that reading passes the interval, it IS ours to re-take.
    c.advance(PROXY_FRESHNESS_REFRESH_INTERVAL_MS);
    const later = await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo),
      probe: fakeProbe({ dialed }),
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });
    expect(later.refreshed, 'a stale reading is re-taken').toBe(1);
  });

  it('CRITICAL a reading the CUSTOMER took while our probe was in flight WINS. Our dial holds the proxy for up to 18 seconds; if they press Test in that window, both come back with a real reading but ours was taken FIRST and would land SECOND — stamping an older observation with a newer date, over the result they are watching.', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    await seedProxy(repo, { id: 'p1' });
    const c = clock();
    const dialed: ProbeProxyDescriptor[] = [];

    await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo),
      probe: fakeProbe({
        dialed,
        // INSIDE the dial: the customer's own Test lands, with a different exit.
        onProbe: async () => {
          c.advance(9_000);
          await repo.update({
            id: 'p1',
            accountId: ACCOUNT,
            updates: {
              exitObserved: {
                ip: '198.51.100.200',
                country: 'DE',
                timezone: 'Europe/Berlin',
                observed_via: 'probe',
              },
              exitObservedAt: new Date(c.now()),
              osFingerprint: {
                os: 'windows',
                confidence: 'high',
                reason: 'Based on how this proxy responds to a network connection.',
                observed_ip: '198.51.100.200',
                observed_via: 'exit_ip',
              },
              osFingerprintAt: new Date(c.now()),
            },
          });
          c.advance(1_000);
        },
      }),
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });

    const row = await rowOf(repo, 'p1');
    expect(row.exitObserved?.ip, "the customer's newer observation is not overwritten").toBe(
      '198.51.100.200',
    );
    expect(row.osFingerprint?.os, 'nor their newer fingerprint').toBe('windows');
  });

  it('CRITICAL a reading is DISCARDED when the customer REPOINTED the proxy while our probe was in flight. The PUT clears these columns in the same statement that moves the row, so a write landing after it restores a reading of the OLD machine, dated AFTER the move, onto the row the customer just fixed — and no staleness tie-break can catch that, because the invalidation NULLS the timestamps a tie-break compares.', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    await seedProxy(repo, { id: 'p1' });
    const c = clock();
    const dialed: ProbeProxyDescriptor[] = [];
    const probe: ProxyFreshnessProbe = {
      probe: async (descriptor) => {
        dialed.push(descriptor);
        if (descriptor.host !== 'p1.proxy.example.com') {
          // The NEW address, dialled because the edit made the row due again.
          // It does not answer yet — which is the case that matters: nothing
          // arrives to paper over a stale reading the fence wrongly let through.
          return { ok: false, reason: 'timeout' };
        }
        // INSIDE the dial through the OLD machine: the customer repoints the
        // row, exactly as `proxyReadingsInvalidatedByEdit` writes it — the new
        // address and every reading nulled, in ONE update.
        c.advance(9_000);
        await repo.update({
          id: 'p1',
          accountId: ACCOUNT,
          updates: {
            host: 'moved.proxy.example.com',
            osFingerprint: null,
            osFingerprintAt: null,
            exitObserved: null,
            exitObservedAt: null,
            exitSupersededAt: null,
            quicMeasured: null,
            quicMeasuredAt: null,
            freshnessConsecutiveFailures: 0,
            freshnessAttemptedAt: null,
          },
        });
        c.advance(1_000);
        return okProbeResult('203.0.113.7');
      },
      observeOs: () => Promise.resolve(observedOs()),
    };

    const result = await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo),
      probe,
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });

    expect(
      result,
      'the old machine SKIPS (it did nothing wrong, so no failure streak); the second claim is the edit’s own doing — it made the row due again',
    ).toMatchObject({ claimed: 2, refreshed: 0, failed: 1, skipped: 1 });
    expect(
      dialed.map((d) => d.host),
      'and the address dialled second is the one the row now has',
    ).toEqual(['p1.proxy.example.com', 'moved.proxy.example.com']);

    const row = await rowOf(repo, 'p1');
    expect(row.host).toBe('moved.proxy.example.com');
    expect(
      row.exitObserved,
      'an exit measured through the PREVIOUS machine, dated after the move',
    ).toBeNull();
    expect(row.exitObservedAt).toBeNull();
    expect(row.osFingerprint, 'and its fingerprint').toBeNull();
    expect(row.osFingerprintAt).toBeNull();
  });

  it("CRITICAL a proxy belonging to a SUSPENDED or soft-DELETED account is never claimed. Deletion here is SOFT and the retention purge nulls the SECRETS, not the rows, so an erased customer's proxies otherwise stay claimable forever — the sweep would dial their provider four times a day and keep writing NEW measurements onto the row of somebody who asked to be erased. And post-purge `wrapped_password IS NULL`, which resolveProbeDescriptor cannot tell from \"no password configured\", so every one of those dials would be UNAUTHENTICATED. MUTATION: delete the `JOIN accounts a … a.status = 'active'` from the due CTE (and the `nonActiveAccountIds` filter from the double) and this reds.", async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const GONE = '22222222-2222-4222-8222-222222222222';
    const SUSPENDED = '33333333-3333-4333-8333-333333333333';
    await seedProxy(repo, { id: 'live' });
    await repo.create(GONE, {
      id: 'erased',
      label: 'erased',
      scheme: 'socks5',
      host: 'erased.proxy.example.com',
      port: 1080,
      username: null,
      // Exactly what clearProxySecretsForAccount leaves behind: the row, with no
      // credential. A dial through this is unauthenticated, on an ex-customer.
      wrappedPassword: null,
    });
    await repo.create(SUSPENDED, {
      id: 'paused',
      label: 'paused',
      scheme: 'socks5',
      host: 'paused.proxy.example.com',
      port: 1080,
      username: null,
      wrappedPassword: null,
    });
    repo.setNonActiveAccountIds([GONE, SUSPENDED]);
    const dialed: ProbeProxyDescriptor[] = [];

    const result = await runProxyFreshnessTick({
      proxies: repo,
      resolver: {
        resolveProbeDescriptor: ({ proxyId }) =>
          Promise.resolve({ protocol: 'socks5', host: `${proxyId}.proxy.example.com`, port: 1080 }),
      },
      probe: fakeProbe({ dialed }),
      logger: silentLogger,
      nowFn: clock().now,
      sleepFn: noSleep,
    });

    expect(result.claimed, "only the active account's proxy is claimable").toBe(1);
    expect(dialed.map((d) => d.host)).toEqual(['live.proxy.example.com']);
    // Not even ATTEMPTED — the exclusion is in the claim, so nothing about these
    // rows moves at all.
    for (const id of ['erased', 'paused']) {
      const row = await repo.findById({
        id,
        accountId: id === 'erased' ? GONE : SUSPENDED,
      });
      expect(row?.freshnessAttemptedAt, `${id} was not even stamped as attempted`).toBeNull();
      expect(row?.exitObserved, `and no NEW measurement was written onto ${id}`).toBeNull();
      expect(row?.osFingerprint).toBeNull();
    }
  });

  it('CRITICAL a reading the CUSTOMER took while our probe was in flight is not CONDEMNED by our failure either. The success path already stands down via yieldToReadingsAfter; the condemn path had no tie-break at all, so a customer pressing Test mid-sweep could have their own freshly-verified exit stamped `exit_superseded_at` by our older, failed measurement — after which account-me.ts returns null for the stored exit and agent-sessions.ts refuses to project it into the live cockpit. MUTATION: drop the `p.exit_observed_at <= probeStartedAt` disjunct from recordFreshnessFailure (SQL and double) and this reds.', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    await seedProxy(repo, { id: 'p1' });
    const c = clock();
    // A good reading first, then two background failures: the counter sits at
    // CONDEMN-1, so the next failure is the one that would stamp.
    await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo),
      probe: fakeProbe({ dialed: [] }),
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });
    for (let i = 0; i < PROXY_FRESHNESS_CONDEMN_AFTER_FAILURES - 1; i += 1) {
      c.advance(PROXY_FRESHNESS_REFRESH_INTERVAL_MS * 5);
      await runProxyFreshnessTick({
        proxies: repo,
        resolver: resolverFor(repo),
        probe: fakeProbe({ dialed: [], result: { ok: false, reason: 'timeout' } }),
        logger: silentLogger,
        nowFn: c.now,
        sleepFn: noSleep,
      });
    }
    expect((await rowOf(repo, 'p1')).freshnessConsecutiveFailures).toBe(
      PROXY_FRESHNESS_CONDEMN_AFTER_FAILURES - 1,
    );
    expect((await rowOf(repo, 'p1')).exitSupersededAt).toBeNull();

    // The third dial. It fails — but the customer pressed Test five seconds in
    // and their probe SUCCEEDED, writing a verified exit onto the row.
    c.advance(PROXY_FRESHNESS_REFRESH_INTERVAL_MS * 5);
    const theirExitAt = c.now() + 5_000;
    await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo),
      probe: fakeProbe({
        dialed: [],
        result: { ok: false, reason: 'timeout' },
        onProbe: async () => {
          c.advance(5_000);
          await repo.update({
            id: 'p1',
            accountId: ACCOUNT,
            updates: {
              exitObserved: {
                ip: '198.51.100.200',
                country: 'DE',
                timezone: 'Europe/Berlin',
                observed_via: 'probe',
              },
              exitObservedAt: new Date(c.now()),
              exitSupersededAt: null,
            },
          });
          // Our dial keeps going and fails at t+30s, AFTER their observation.
          c.advance(25_000);
        },
      }),
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });

    const row = await rowOf(repo, 'p1');
    expect(
      row.freshnessConsecutiveFailures,
      'our probe really did fail — the counter moved, so this is not a vacuous pass',
    ).toBe(PROXY_FRESHNESS_CONDEMN_AFTER_FAILURES);
    expect(
      row.exitSupersededAt,
      'but the exit the customer is watching is NOT condemned by evidence older than it',
    ).toBeNull();
    expect(row.exitObserved?.ip, 'and their reading is still the stored one').toBe(
      '198.51.100.200',
    );
    expect(row.exitObservedAt?.getTime()).toBe(theirExitAt);
  });

  it("CRITICAL an observation from ANOTHER vantage between our failures breaks the streak. The counter used to be reset only by this sweep's own success, so the three failures the threshold requires need not have been consecutive in time and need not have been uncontradicted — background misses on day 1 and day 2, a month of successful live-session relay writes (which keep the row from ever being due), and then a single blip is the THIRD failure and flips customer-visible state. That is the outcome the threshold exists to prevent. MUTATION: delete the `freshness_consecutive_failures = CASE …` from the claim UPDATE (and the `contradictedSinceLastAttempt` branch in the double) and this reds.", async () => {
    const repo = new InMemoryAccountProxiesRepo();
    await seedProxy(repo, { id: 'p1' });
    const c = clock();
    await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo),
      probe: fakeProbe({ dialed: [] }),
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });
    const failTick = async (): Promise<void> => {
      c.advance(PROXY_FRESHNESS_REFRESH_INTERVAL_MS * 5);
      await runProxyFreshnessTick({
        proxies: repo,
        resolver: resolverFor(repo),
        probe: fakeProbe({ dialed: [], result: { ok: false, reason: 'timeout' } }),
        logger: silentLogger,
        nowFn: c.now,
        sleepFn: noSleep,
      });
    };

    await failTick();
    await failTick();
    expect((await rowOf(repo, 'p1')).freshnessConsecutiveFailures).toBe(2);

    // Between failure 2 and failure 3: a LIVE SESSION's capability relay observes
    // the exit and writes it. It does not touch the counter (it has no reason to
    // know one exists) — the claim is what must notice.
    c.advance(60 * 60 * 1000);
    await repo.update({
      id: 'p1',
      accountId: ACCOUNT,
      updates: {
        exitObserved: {
          ip: '203.0.113.7',
          country: 'NL',
          timezone: 'Europe/Amsterdam',
          observed_via: 'session',
        },
        exitObservedAt: new Date(c.now()),
        exitSupersededAt: null,
      },
    });

    await failTick();
    const row = await rowOf(repo, 'p1');
    expect(
      row.freshnessConsecutiveFailures,
      'the streak restarted at this failure — it is the FIRST uncontradicted one',
    ).toBe(1);
    expect(
      row.exitSupersededAt,
      'so one background blip after a month of successful sessions changes nothing a customer can see',
    ).toBeNull();
    expect(row.exitObserved?.ip).toBe('203.0.113.7');
  });

  it('a successful tick that measured NOTHING does not bump `updated_at`. That field is published on the proxy metadata and read by the desktop client, so moving it reports an edit that never happened — the failure path has been guarded against exactly this since it was written. It is reachable on the SUCCESS path too: the probe answers `{ok: true}` with no exitIdentity when the echo body did not parse, and with no DS_OS_OBSERVER_HOST (the default) there is no OS reading either. MUTATION: call `deps.proxies.update` unconditionally instead of guarding on `Object.keys(updates).length > 0` and this reds.', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    await seedProxy(repo, { id: 'p1' });
    const before = await rowOf(repo, 'p1');
    const c = clock();
    const dialed: ProbeProxyDescriptor[] = [];

    // ⛔ Both repo implementations stamp `updatedAt: new Date()` from the REAL
    // clock, not the injected one, so an assertion on the timestamp alone passes
    // vacuously when the whole tick runs inside one millisecond — measured: this
    // arm reported green against the unguarded write until this wait was added.
    // Every update call is therefore RECORDED as well, which is the unambiguous
    // half, and the wait makes the published timestamp move if one happens.
    const updateCalls: Array<Record<string, unknown>> = [];
    const recording = {
      claimDueForFreshnessRefresh: repo.claimDueForFreshnessRefresh.bind(repo),
      findById: repo.findById.bind(repo),
      recordFreshnessFailure: repo.recordFreshnessFailure.bind(repo),
      update: (args: { id: string; accountId: string; updates: Record<string, unknown> }) => {
        updateCalls.push(args.updates);
        return repo.update(args);
      },
    } as unknown as InMemoryAccountProxiesRepo;
    await new Promise((r) => setTimeout(r, 25));

    const result = await runProxyFreshnessTick({
      proxies: recording,
      resolver: resolverFor(repo),
      // ok, but nothing measured: no exitIdentity, and no observer wired at all.
      probe: {
        probe: (descriptor) => {
          dialed.push(descriptor);
          return Promise.resolve({ ok: true });
        },
      },
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });

    expect(result, 'the proxy answered, so the refresh succeeded').toMatchObject({
      claimed: 1,
      refreshed: 1,
    });
    expect(dialed, 'and it really was dialled — not a vacuous pass').toHaveLength(1);
    expect(
      updateCalls,
      'no UPDATE is issued at all — an empty one exists only to bump updated_at',
    ).toEqual([]);
    const after = await rowOf(repo, 'p1');
    expect(
      after.updatedAt.getTime(),
      'updated_at is on the metadata view; a tick that measured nothing is not an edit',
    ).toBe(before.updatedAt.getTime());
    expect(after.exitObserved).toBeNull();
    expect(after.osFingerprint).toBeNull();
    expect(after.freshnessAttemptedAt?.getTime(), 'the ATTEMPT is still recorded').toBe(START_MS);

    // CONTROL — the write really would move it, so the assertion above is a
    // statement about the tick's choice and not about a repo that cannot stamp.
    await new Promise((r) => setTimeout(r, 25));
    await repo.update({ id: 'p1', accountId: ACCOUNT, updates: {} });
    expect(
      (await rowOf(repo, 'p1')).updatedAt.getTime(),
      'an empty update is NOT a no-op — this is what the guard above is avoiding',
    ).toBeGreaterThan(before.updatedAt.getTime());
  });

  it("CRITICAL the per-proxy ceiling is taken from the WIRED probe, and the tick's budget is clamped so `budget + ceiling` can never reach the lease. Both inputs used to be module constants and both were wrong: bootstrap makes the probe deadline env-tunable ON PURPOSE (DRIFTSTACK_PROXY_PROBE_TIMEOUT_MS), and `observeOs` arms its budgets in SERIES — dial, a second tunnel deadline, then up to two sequential observer lookups — so it can spend 16s, not 6s. A deployment at a 120s probe timeout had a real ceiling of 138s against a sum that still said 20s, and the arm that pinned 20_000 corroborated the wrong number instead of checking it.", () => {
    // The understated leg, stated where it can be seen.
    expect(
      OS_OBSERVE_WORST_CASE_MS,
      'two OS_OBSERVE_TIMEOUT_MS budgets in series plus two observer lookups',
    ).toBe(2 * OS_OBSERVE_TIMEOUT_MS + 2 * OS_OBSERVER_LOOKUP_TIMEOUT_MS);
    expect(OS_OBSERVE_WORST_CASE_MS, 'and it is NOT one OS_OBSERVE_TIMEOUT_MS').toBeGreaterThan(
      OS_OBSERVE_TIMEOUT_MS,
    );

    // A probe wired the way bootstrap wires one when the env raises the deadline.
    const raised: ProxyFreshnessProbe = {
      probe: () => Promise.resolve({ ok: true }),
      observeOs: () => Promise.resolve({ observed: false, reason: 'x' }) as Promise<never>,
      effectiveTimeoutMs: 120_000,
      observeWorstCaseMs: OS_OBSERVE_WORST_CASE_MS,
    };
    expect(proxyFreshnessWorstCasePerProxyMs(raised)).toBe(
      120_000 + OS_OBSERVE_WORST_CASE_MS + 2_000,
    );
    // …and a probe that exposes neither accessor falls back to the defaults.
    expect(proxyFreshnessWorstCasePerProxyMs(fakeProbe({ dialed: [] }))).toBe(
      DEFAULT_PROBE_TIMEOUT_MS + OS_OBSERVE_WORST_CASE_MS + 2_000,
    );

    // THE RELATION THAT ACTUALLY MATTERS, across the whole range a deployment can
    // configure — including one so large a single proxy cannot fit, where the only
    // safe budget is zero (a tick that cannot promise to finish inside the lease
    // must not start: the scheduler's answer to an overrun is to run the handler
    // AGAIN, concurrently, dialling the customer's proxy a second time).
    for (const probeTimeoutMs of [1_000, DEFAULT_PROBE_TIMEOUT_MS, 30_000, 120_000, 400_000]) {
      const worstCasePerProxyMs = proxyFreshnessWorstCasePerProxyMs({
        probe: () => Promise.resolve({ ok: true }),
        observeOs: () => Promise.resolve({ observed: false, reason: 'x' }) as Promise<never>,
        effectiveTimeoutMs: probeTimeoutMs,
        observeWorstCaseMs: OS_OBSERVE_WORST_CASE_MS,
      });
      const budget = proxyFreshnessEffectiveBudgetMs({
        configuredBudgetMs: PROXY_FRESHNESS_TICK_BUDGET_MS,
        worstCasePerProxyMs,
      });
      expect(budget, 'never negative').toBeGreaterThanOrEqual(0);
      expect(
        budget === 0 ? 0 : budget + worstCasePerProxyMs,
        `overshoot bound at a ${String(probeTimeoutMs)}ms probe timeout must leave the lease room to settle`,
      ).toBeLessThanOrEqual(SCHEDULED_JOB_STALE_LOCK_MS - PROXY_FRESHNESS_LEASE_SAFETY_MS);
    }
    expect(
      proxyFreshnessEffectiveBudgetMs({
        configuredBudgetMs: PROXY_FRESHNESS_TICK_BUDGET_MS,
        worstCasePerProxyMs: 400_000,
      }),
      'a single probe that cannot fit the safe window buys no budget at all',
    ).toBe(0);
  });

  it('a tick whose ONE proxy could outrun the lease claims nothing at all, rather than starting a dial it cannot promise to finish. The scheduler answers an overrun by running the handler again CONCURRENTLY — for this job, a second connection through the same customer proxy.', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    for (const id of ['p1', 'p2']) await seedProxy(repo, { id });
    const dialed: ProbeProxyDescriptor[] = [];

    const result = await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo),
      probe: {
        probe: (descriptor) => {
          dialed.push(descriptor);
          return Promise.resolve({ ok: true });
        },
        // Past SCHEDULED_JOB_STALE_LOCK_MS − PROXY_FRESHNESS_LEASE_SAFETY_MS on
        // its own, so no batch size is safe.
        effectiveTimeoutMs: SCHEDULED_JOB_STALE_LOCK_MS,
      },
      logger: silentLogger,
      nowFn: clock().now,
      sleepFn: noSleep,
    });

    expect(result.claimed, 'nothing claimed').toBe(0);
    expect(result.stoppedAtBudget, 'and it says why').toBe(true);
    expect(dialed, 'no customer proxy dialled').toEqual([]);
    expect((await rowOf(repo, 'p1')).freshnessAttemptedAt, 'and nothing stamped').toBeNull();
  });

  it("CRITICAL the refresh cadence and the desktop client's DISPLAY WINDOW are PINNED AGAINST EACH OTHER, and the window is now DERIVED FROM the cadence rather than chosen beside it. ⛔ PIN UPDATED 2026-09-17 — this arm asked for exactly this change and said so: a reading this sweep keeps at most 6 hours old was displayable for 30 of every 360 minutes (8%), and it recorded that the CADENCE was not the half that should move. The client's window is now `MEASURED_READING_TTL_MS` (proxy-reading-windows.ts) = the client's own copy of this cadence + one sweep slot + margin, so the two can no longer disagree: lowering the cadence narrows the window with it. MUTATION: type a literal back into OS_FINGERPRINT_TTL_MS and the re-export arm reds; change the client's CAPABILITY_REFRESH_AFTER_MS alone and the agreement arm reds.", () => {
    const windowsSource = readFileSync(
      resolve(HERE, '..', '..', '..', 'gui-client', 'src', 'lib', 'proxy-reading-windows.ts'),
      'utf8',
    );
    const clientSource = readFileSync(
      resolve(HERE, '..', '..', '..', 'gui-client', 'src', 'lib', 'os-fingerprint-verdict.ts'),
      'utf8',
    );

    // ⛔ The OS reading's window is no longer DEFINED in os-fingerprint-verdict —
    // it is re-exported from the one module that derives it, so the cockpit's
    // session readout and the proxy grid cannot drift apart AND neither can drift
    // from the cadence. A literal reappearing here is the defect coming back.
    expect(
      /export \{\s*MEASURED_READING_TTL_MS as OS_FINGERPRINT_TTL_MS\s*\}\s*from '\.\/proxy-reading-windows'/.test(
        clientSource,
      ),
      'the client no longer re-exports the derived window — re-read this contract',
    ).toBe(true);
    expect(
      /export const OS_FINGERPRINT_TTL_MS\s*=/.test(clientSource),
      'a hand-typed OS window is back in os-fingerprint-verdict',
    ).toBe(false);

    /** A plain product of numeric literals, read out of the client's own source.
     *  Evaluated by PARSING, not by `new Function`: this reads a source file from
     *  another app, and a parity check must never execute what it is inspecting. */
    const literalMs = (name: string): number => {
      const match = new RegExp(`export const ${name}\\s*=\\s*([^;]+);`).exec(windowsSource);
      expect(match, `${name} was renamed or moved — re-read this contract`).not.toBeNull();
      const factors = (match?.[1] ?? '').split('*').map((p) => Number(p.trim().replace(/_/g, '')));
      expect(
        factors.every((n) => Number.isFinite(n)),
        `${name} is no longer a plain product of numeric literals — read it by hand`,
      ).toBe(true);
      return factors.reduce((a, b) => a * b, 1);
    };

    // ⛔ THE AGREEMENT THIS ARM EXISTS FOR: the client's idea of how often a
    // reading is re-taken is the SERVER's actual cadence. They are two constants
    // in two apps and nothing but this line holds them together.
    const clientCadenceMs = literalMs('CAPABILITY_REFRESH_AFTER_MS');
    expect(clientCadenceMs, "the client's copy of the refresh cadence").toBe(
      PROXY_FRESHNESS_REFRESH_INTERVAL_MS,
    );
    expect(PROXY_FRESHNESS_REFRESH_INTERVAL_MS, 'the server cadence').toBe(6 * 60 * 60 * 1000);

    // The window, recomputed by the client's own arithmetic (cadence + one sweep
    // slot + an hour of margin, rounded up to a whole hour) rather than restated.
    const sweepMs = literalMs('SWEEP_INTERVAL_MS');
    const HOUR_MS = 60 * 60 * 1000;
    const windowMs = Math.ceil((clientCadenceMs + sweepMs + HOUR_MS) / HOUR_MS) * HOUR_MS;
    expect(windowMs, 'the derived display window').toBe(8 * HOUR_MS);

    // The consequence, stated as a number so nobody has to derive it again. It
    // was 8: a healthy proxy's reading was muted for ~92% of every refresh cycle.
    const displayablePercent = Math.round((windowMs / PROXY_FRESHNESS_REFRESH_INTERVAL_MS) * 100);
    expect(
      displayablePercent,
      'a server-seeded OS reading is displayable for this % of each refresh cycle — at or above 100 the green state is reachable in steady state, which is the whole point',
    ).toBe(133);
    expect(windowMs).toBeGreaterThanOrEqual(PROXY_FRESHNESS_REFRESH_INTERVAL_MS + sweepMs);
  });

  it('CRITICAL schema.ts declares the freshness due index as the PARTIAL index migration 0123 actually creates. It declared a FULL one, with a comment directly above it asserting the opposite — the precise drift schema.ts itself records as having produced migration 0071, a duplicate index whose own rationale called a partial index “that full index”. Nothing breaks while drizzle-kit is unwired; this file is the source of truth the moment TD-002 reinstates generation. MUTATION: delete the `.where(sql`…`)` from `account_proxies_freshness_due_idx` in schema.ts and this reds.', () => {
    const schemaSrc = readFileSync(resolve(HERE, '..', '..', 'src', 'db', 'schema.ts'), 'utf8');
    const migrationSrc = readFileSync(
      resolve(HERE, '..', '..', 'src', 'db', 'migrations', '0123_add_account_proxy_freshness.sql'),
      'utf8',
    );

    // The migration's predicate, read out of the migration rather than restated.
    const created =
      /CREATE INDEX[^;]*"account_proxies_freshness_due_idx"[\s\S]*?WHERE\s+"scheme"\s+IN\s*\(([^)]*)\)/i.exec(
        migrationSrc,
      );
    expect(created, 'migration 0123 no longer creates this index partially').not.toBeNull();
    const migrationSchemes = (created?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .sort();
    expect(migrationSchemes).toEqual(['http', 'socks5']);

    // The declaration, which must carry the same predicate.
    const declared =
      /index\(\s*'account_proxies_freshness_due_idx'\s*\)[\s\S]{0,400}?\.where\(\s*sql`([^`]*)`/.exec(
        schemaSrc,
      );
    expect(
      declared,
      'schema.ts declares account_proxies_freshness_due_idx WITHOUT a .where() — it is a FULL index here and a PARTIAL one in migration 0123',
    ).not.toBeNull();
    const declaredSchemes = [...(declared?.[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)]
      .map((m) => m[1] as string)
      .sort();
    expect(
      declaredSchemes,
      'the declared predicate must name exactly the schemes the migration names',
    ).toEqual(migrationSchemes);
    expect(
      declared?.[1],
      'and it must be a scheme predicate, matching the migration clause for clause',
    ).toMatch(/scheme\}?\s+IN/i);
  });

  it('an OS observation that fails does NOT fail the refresh, and never nulls the fingerprint the row already holds. The observer tunnel is a second connection with its own failure modes; the connectivity probe already passed, so the proxy is up.', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    await seedProxy(repo, { id: 'p1' });
    const c = clock();
    await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo),
      probe: fakeProbe({ dialed: [] }),
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });
    const good = await rowOf(repo, 'p1');

    c.advance(PROXY_FRESHNESS_REFRESH_INTERVAL_MS * 2);
    const result = await runProxyFreshnessTick({
      proxies: repo,
      resolver: resolverFor(repo),
      probe: fakeProbe({ dialed: [], result: okProbeResult('203.0.113.55'), os: 'throw' }),
      logger: silentLogger,
      nowFn: c.now,
      sleepFn: noSleep,
    });

    expect(result.refreshed, 'the proxy answered, so the refresh succeeded').toBe(1);
    const row = await rowOf(repo, 'p1');
    expect(row.osFingerprint, 'a miss writes NOTHING — it never nulls a real reading').toEqual(
      good.osFingerprint,
    );
    expect(row.osFingerprintAt?.getTime()).toBe(good.osFingerprintAt?.getTime());
    expect(row.exitObserved?.ip, 'while the exit it DID measure is stored').toBe('203.0.113.55');
  });
});
