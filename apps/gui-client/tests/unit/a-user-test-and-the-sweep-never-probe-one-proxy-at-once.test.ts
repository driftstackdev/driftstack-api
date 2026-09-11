// (l) SOCKS5/chat audit — finding #15 (L7).
//
// The background sweep and a user-initiated native Test / pre-launch probe
// could run the same SOCKS5 proxy concurrently (a double handshake, which the
// file's own note says skews each other's latency), and whichever
// `saveProbeResult` landed LAST won regardless of which measurement was
// fresher — a sweep probe that started earlier but timed out later overwrote
// the customer's just-shown healthy verdict with "Not reachable" seconds after
// they read it. The sweep fires on every window focus, i.e. exactly when a
// returning customer clicks Test on the stale row the plan just selected.
//
// Fix: a per-proxy claim (`withProxyProbe`). The sweep skips a claimed proxy;
// a user probe queues behind a sweep's probe on the same proxy and lands last.

import { beforeEach, describe, expect, it } from 'vitest';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type { ProbeCacheMap } from '../../src/lib/proxy-probe-cache';
import { PROBE_TTL_MS } from '../../src/lib/proxy-probe-cache';
import type { SweepDeps } from '../../src/lib/proxy-probe-sweeper';
import {
  isProxyProbeInFlight,
  runSweep,
  withProxyProbe,
  __resetSweepLatchForTests,
} from '../../src/lib/proxy-probe-sweeper';

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
const DOWN: ProxyTestResult = { ...OK, reachable: false, auth_ok: false, can_route: false };

function proxy(id: string): ProxyConfig {
  return {
    id,
    label: id,
    host: `${id}.example`,
    port: 1080,
    username: null,
    password: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    scheme: 'socks5',
  };
}
const stale = (): ProbeCacheMap[string] => ({ result: OK, at: NOW - PROBE_TTL_MS - 1 });

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The order writes landed in, as the cache would see them. */
let writes: Array<{ id: string; by: string; result: ProxyTestResult }> = [];

function deps(over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    loadCache: () => Promise.resolve({ a: stale(), b: stale() }),
    listProxies: () => Promise.resolve([proxy('a'), proxy('b')]),
    testProxy: () => Promise.resolve(OK),
    saveResult: (id, result) => {
      writes.push({ id, by: 'sweep', result });
      return Promise.resolve({});
    },
    now: () => NOW,
    sleep: () => Promise.resolve(),
    ...over,
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  __resetSweepLatchForTests();
  writes = [];
});

describe('#15 — the sweep skips a proxy a user probe holds', () => {
  // MUTATION: drop the `isProxyProbeInFlight` check in runSweep → `a` is
  // probed by the sweep underneath the user's probe → red.
  it('CRITICAL a proxy claimed by a user-initiated probe is not probed by the sweep, and is reported skippedBusy', async () => {
    const userProbe = deferred<ProxyTestResult>();
    const user = withProxyProbe('a', async () => {
      const r = await userProbe.promise;
      writes.push({ id: 'a', by: 'user', result: r });
      return r;
    });
    const probedBySweep: string[] = [];
    const report = await runSweep(
      deps({
        testProxy: (p) => {
          probedBySweep.push(p.id);
          return Promise.resolve(DOWN);
        },
      }),
    );
    expect(probedBySweep).toEqual(['b']);
    expect(report.skippedBusy).toEqual(['a']);
    expect(report.refreshed).toEqual(['b']);
    userProbe.resolve(OK);
    await user;
    // The customer's verdict is the only write for `a` — never a sweep DOWN on top of it.
    expect(writes.filter((w) => w.id === 'a')).toEqual([{ id: 'a', by: 'user', result: OK }]);
    expect(isProxyProbeInFlight('a')).toBe(false);
  });

  it('VACUITY CONTROL — with no claim the sweep probes every planned proxy', async () => {
    const report = await runSweep(deps());
    expect(report.refreshed).toEqual(['a', 'b']);
    expect(report.skippedBusy).toEqual([]);
  });
});

describe('#15 — a user probe queues behind the sweep on the same proxy and lands last', () => {
  // MUTATION: drop the wait loop in withProxyProbe → the user probe starts
  // while the sweep's handshake is still open → the order below flips → red.
  it("CRITICAL the user probe does not start until the sweep releases the proxy; its write lands after the sweep's", async () => {
    const sweepProbe = deferred<ProxyTestResult>();
    let userStarted = false;
    const sweep = runSweep(
      deps({
        loadCache: () => Promise.resolve({ a: stale() }),
        listProxies: () => Promise.resolve([proxy('a')]),
        testProxy: () => sweepProbe.promise,
      }),
    );
    await tick();
    expect(isProxyProbeInFlight('a')).toBe(true);
    const user = withProxyProbe('a', () => {
      userStarted = true;
      writes.push({ id: 'a', by: 'user', result: OK });
      return Promise.resolve(OK);
    });
    await tick();
    expect(userStarted).toBe(false); // queued behind the sweep's open handshake
    sweepProbe.resolve(DOWN); // the sweep's slower answer…
    await sweep;
    await user;
    // …lands FIRST; the customer's fresher verdict is what stands.
    expect(writes.map((w) => w.by)).toEqual(['sweep', 'user']);
    expect(writes.at(-1)?.result).toBe(OK);
    expect(isProxyProbeInFlight('a')).toBe(false);
  });

  it('two user probes on one proxy serialise too (the card and the grid)', async () => {
    const first = deferred<ProxyTestResult>();
    const order: string[] = [];
    const p1 = withProxyProbe('a', async () => {
      order.push('first-start');
      await first.promise;
      order.push('first-end');
      return OK;
    });
    const p2 = withProxyProbe('a', () => {
      order.push('second-start');
      return Promise.resolve(OK);
    });
    await tick();
    expect(order).toEqual(['first-start']);
    first.resolve(OK);
    await Promise.all([p1, p2]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('a different proxy is never held up', async () => {
    const gate = deferred<ProxyTestResult>();
    void withProxyProbe('a', () => gate.promise);
    let bRan = false;
    await withProxyProbe('b', () => {
      bRan = true;
      return Promise.resolve(OK);
    });
    expect(bRan).toBe(true);
    gate.resolve(OK);
  });

  it('the claim is released when the probe throws, and the error reaches the caller', async () => {
    await expect(withProxyProbe('a', () => Promise.reject(new Error('socket')))).rejects.toThrow(
      'socket',
    );
    expect(isProxyProbeInFlight('a')).toBe(false);
    // A sweep afterwards is not blocked by the dead claim.
    const report = await runSweep(deps({ loadCache: () => Promise.resolve({ a: stale() }) }));
    expect(report.refreshed).toEqual(['a']);
  });

  it('a sweep probe that throws releases its claim too', async () => {
    const report = await runSweep(
      deps({
        loadCache: () => Promise.resolve({ a: stale() }),
        testProxy: () => Promise.reject(new Error('socket')),
      }),
    );
    expect(report.failed).toEqual(['a']);
    expect(isProxyProbeInFlight('a')).toBe(false);
  });
});
