// A `vantage=fleet` test on a VPN row asks a Mac in the fleet to bring a real tunnel up.
// The node budgets 40s for the tunnel to come up and 10s for its SOCKS listener — 50s
// worst case, ~40s for the case that matters most, an endpoint that never answers — and
// the control plane waits for the node's own reported budget plus headroom.
//
// The desktop cut every proxy test at 30s regardless of vantage, so it gave up FIRST: a
// WireGuard or OpenVPN endpoint that was slow, or honestly unreachable, came back as "the
// server did not answer" — the client minting a verdict while the measurement it asked
// for was still running, and the owner reading a server fault where there was none.
//
// These arms pin that the fleet vantage gets its own, longer deadline, that the cp
// vantage is unchanged, and that the fleet deadline sits above the control plane's wait.
// The deadline is read off the REAL call (a stubbed fetch that never settles), not off an
// exported constant — a constant can be raised while the call site still passes the old
// one, which is exactly the shape of the bug.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { testAccountProxy } from '../../src/lib/account-proxies';

const BASE = 'https://api.example.test';
const KEY = 'k-test';

/** Resolve with the deadline the call actually passed, by racing the AbortSignal.
 *  vi.useFakeTimers lets the whole thing run instantly. */
async function deadlineOf(opts?: { vantage?: 'cp' | 'fleet' }): Promise<number> {
  vi.useFakeTimers();
  let aborted: number | null = null;
  const started = Date.now();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = Date.now() - started;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    ),
  );
  const call = testAccountProxy(BASE, KEY, 'p1', opts).catch(() => null);
  // Run every timer the deadline helper scheduled.
  await vi.advanceTimersByTimeAsync(300_000);
  await call;
  vi.useRealTimers();
  if (aborted === null) throw new Error('the request was never aborted — no deadline was applied');
  return aborted;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a fleet proxy test waits longer than the tunnel takes', () => {
  it('CRITICAL the fleet vantage waits at least 60s — the control plane itself waits 60s when a node reports no budget, so a shorter client deadline cuts the answer off. MUTATION: pass PROXY_TEST_DEADLINE_MS for the fleet branch and this reads 30000', async () => {
    const ms = await deadlineOf({ vantage: 'fleet' });
    expect(ms).toBeGreaterThanOrEqual(60_000);
  });

  it('CRITICAL the fleet deadline is strictly longer than the cp one — the whole defect was that one number served both', async () => {
    const fleet = await deadlineOf({ vantage: 'fleet' });
    const cp = await deadlineOf({ vantage: 'cp' });
    expect(fleet).toBeGreaterThan(cp);
  });

  it('VACUITY CONTROL — the cp vantage is UNCHANGED at 30s. Without this, raising both to 90s would pass the arms above while making every ordinary SOCKS5 test hang three times as long on a dead proxy', async () => {
    expect(await deadlineOf({ vantage: 'cp' })).toBe(30_000);
    expect(await deadlineOf()).toBe(30_000);
  });
});
