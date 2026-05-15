// W926 — V-012/V-015 AuthCoalescer single-flight cross-source
// invariant. Two-hundred-fifty-second in the drift-guard series.
// Pins the auth slow-path coalescer contract:
//
//   V-012 / V-015 anchors — single-flight coalescer collapses N
//   concurrent cold-misses to 1 scrypt call. V-012 captured the
//   residual cold-start blip (documented but not fixed there);
//   V-015 implements the coalescer.
//
//   Pre-warming the cache from api_keys is impossible — cache key
//   is sha256(plaintext) and plaintext is not stored anywhere the
//   server can read. Single-flight is the right shape.
//
//   No D-020 design change — coalescer only sits above the cache,
//   doesn't change the cache key or security model.
//
//   Scope: process-local (in-memory) only. Not Redis-backed.
//   Cross-process coalescing would require distributed lock —
//   overkill + re-introduces latency. Multi-process: each process
//   gets its own coalescer; shared Redis cache absorbs cross-
//   process duplication.
//
//   Lifecycle:
//     1. First request for a sha → kicks off slow path, stores
//        Promise.
//     2. Subsequent concurrent requests for same sha → return
//        SAME Promise (coalesce-hit).
//     3. Promise removed on settlement — both fulfilment AND
//        rejection — via .finally(). Without .finally(), a
//        rejected promise stays in map; next caller awaits the
//        rejected promise + errors instead of retrying.
//
//   CoalescerStats (3 counters): starts + hits + inFlight.
//
//   coalesce(sha, slowPath) → Promise<AccountContext>.
//
//   Test covered: rejected slow-path does NOT poison future
//   requests (failed call → next call retries via fresh slowPath).
//
// stays in lockstep across apps/server/src/services/auth-coalescer.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthCoalescer } from '../../src/services/auth-coalescer.js';
import type { AccountContext } from '../../src/services/auth.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const fakeCtx = (id: string): AccountContext => ({ account: { id } }) as unknown as AccountContext;

describe('W926 V-012/V-015 AuthCoalescer cross-source invariant', () => {
  // ─── Single-flight intro + V-012/V-015 anchors ───────────────

  it("CRITICAL apps/server/src/services/auth-coalescer.ts header pins V-012/V-015 anchors — 'Why this exists (V-012 / V-015):'. The V-012 anchor flagged the cold-start blip; V-015 implements the coalescer.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-coalescer.ts'));
    expect(p).toMatch(/Why this exists \(V-012 \/ V-015\):/);
  });

  it("CRITICAL single-flight framing — 'Single-flight coalescer for the auth slow path. When N concurrent requests arrive carrying the same plaintext API key and all miss the auth cache, only one runs the prefix lookup + scrypt verification + account fetch; the other N−1 await the in-flight Promise and resolve with the same AccountContext'. The N→1 collapse is the central contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-coalescer.ts'));
    expect(p).toMatch(/Single-flight coalescer for the auth slow path\. When N concurrent/);
    expect(p).toMatch(/requests arrive carrying the same plaintext API key and all miss the/);
    expect(p).toMatch(/auth cache, only one runs the prefix lookup \+ scrypt verification \+/);
    expect(p).toMatch(/account fetch; the other N−1 await the in-flight Promise and resolve/);
    expect(p).toMatch(/with the same AccountContext/);
  });

  // ─── V-012 cold-start blip framing ───────────────────────────

  it("CRITICAL V-012 cold-start framing — 'If 16 connections all start simultaneously with the same plaintext (the perf:sustained smoke shape), all 16 miss the cache simultaneously, all 16 run scrypt in parallel, and p99 captures the slowest of those concurrent verifies. This was V-012's residual cold-start blip — documented but not fixed there'. The 16-connection perf:sustained anchor is the load-shape provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-coalescer.ts'));
    expect(p).toMatch(/If 16 connections all start simultaneously/);
    expect(p).toMatch(/with the same plaintext \(the perf:sustained smoke shape\)/);
    expect(p).toMatch(/all 16 run scrypt in parallel/);
    expect(p).toMatch(/p99 captures the slowest of those concurrent verifies/);
    expect(p).toMatch(/V-012's residual cold-start blip — documented but not fixed there/);
  });

  // ─── No-prewarm-possible + D-020 unchanged ───────────────────

  it("CRITICAL no-prewarm framing — 'Pre-warming the cache from the api_keys table is impossible: the cache key is sha256(plaintext) and plaintext is not stored anywhere the server can read. Single-flight coalescing is the right shape: no design change to the cache, no security-model change to D-020, collapses N concurrent cold-misses to 1 scrypt call'. The cache-cant-be-prewarmed framing is the design-decision justification.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-coalescer.ts'));
    expect(p).toMatch(/Pre-warming the cache from the api_keys table is impossible: the/);
    expect(p).toMatch(/cache key is sha256\(plaintext\) and plaintext is not stored anywhere/);
    expect(p).toMatch(/the server can read\. Single-flight coalescing is the right shape:/);
    expect(p).toMatch(/no design change to the cache, no security-model change to D-020,/);
    expect(p).toMatch(/collapses N concurrent cold-misses to 1 scrypt call/);
  });

  // ─── Process-local scope rationale ───────────────────────────

  it("CRITICAL scope framing — 'Process-local (in-memory) only. Not Redis-backed. Cross-process coalescing would require a distributed lock, which is overkill for a single-process server and would re-introduce the latency the coalescer is supposed to remove. If we ever scale to multi-process, each process gets its own coalescer; the shared Redis cache absorbs the across-process duplication'. The process-local + multi-process plan is the scope decision.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-coalescer.ts'));
    expect(p).toMatch(/Process-local \(in-memory\) only\. Not Redis-backed\. Cross-process/);
    expect(p).toMatch(/coalescing would require a distributed lock, which is overkill for/);
    expect(p).toMatch(/a single-process server and would re-introduce the latency the/);
    expect(p).toMatch(/coalescer is supposed to remove\. If we ever scale to multi-process,/);
    expect(p).toMatch(/each process gets its own coalescer; the shared Redis cache absorbs/);
    expect(p).toMatch(/the across-process duplication/);
  });

  // ─── 3-step lifecycle framing ────────────────────────────────

  it('CRITICAL lifecycle framing — 3 steps. (1) First request kicks off slow path + stores Promise. (2) Concurrent requests return same Promise (coalesce-hit). (3) Promise removed on settlement — both fulfilment AND rejection. The 3-step is the customer-facing reliability contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-coalescer.ts'));
    expect(p).toMatch(/- On the first request for a sha, the coalescer kicks off the slow/);
    expect(p).toMatch(/path and stores the Promise\./);
    expect(p).toMatch(/- Subsequent concurrent requests for the same sha return the same/);
    expect(p).toMatch(/Promise \(counted as a coalesce-hit\)/);
    expect(p).toMatch(/- The Promise is removed from the in-flight map on settlement —/);
    expect(p).toMatch(/both fulfilment AND rejection/);
  });

  // ─── .finally cleanup + no-poison rationale ──────────────────

  it("CRITICAL .finally framing — 'Without .finally(), a rejected promise stays in the map; the next caller awaits the rejected promise and errors out instead of retrying. Test covered'. The Test-covered tag confirms a regression test exists for the no-poison behaviour.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-coalescer.ts'));
    expect(p).toMatch(/Without `\.finally\(\)`, a rejected promise/);
    expect(p).toMatch(/stays in the map; the next caller awaits the rejected promise and/);
    expect(p).toMatch(/errors out instead of retrying\. Test covered\./);
  });

  it("CRITICAL coalesce uses .finally to delete from map — 'slowPath().finally(() => { this.inFlight.delete(sha) })'. Mechanically verified via source pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-coalescer.ts'));
    expect(p).toMatch(
      /const p = slowPath\(\)\.finally\(\(\) => \{\s*\n\s*this\.inFlight\.delete\(sha\);\s*\n\s*\}\);/,
    );
  });

  // ─── CoalescerStats 3-counter shape ──────────────────────────

  it('CRITICAL CoalescerStats has 3 counters — starts + hits + inFlight. The 3-counter shape is the observability seam — drift to 2 counters would lose either start-rate or coalesce-rate.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-coalescer.ts'));
    expect(p).toMatch(/export interface CoalescerStats \{/);
    expect(p).toMatch(/starts: number;/);
    expect(p).toMatch(/hits: number;/);
    expect(p).toMatch(/inFlight: number;/);
  });

  it("CRITICAL starts comment pins 'Number of times a slow-path was started (one per unique sha mid-flight)'. The 'one per unique sha mid-flight' is what makes starts a coalesce-effectiveness denominator.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-coalescer.ts'));
    expect(p).toMatch(/Number of times a slow-path was started \(one per unique sha mid-flight\)/);
  });

  it("CRITICAL hits comment pins 'Number of times a concurrent caller piggybacked on an in-flight Promise'. The 'piggybacked' framing is the latency-savings numerator.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-coalescer.ts'));
    expect(p).toMatch(/Number of times a concurrent caller piggybacked on an in-flight Promise/);
  });

  // ─── Runtime: 3 concurrent same-sha = 1 start + 2 hits ───────

  it('CRITICAL runtime — 3 concurrent coalesce() calls with same sha → slowPath called ONCE; 2 callers piggyback. stats: 1 start + 2 hits + 0 in-flight after settlement.', async () => {
    const coalescer = new AuthCoalescer();
    let slowPathCalls = 0;
    let resolveSlow!: (v: AccountContext) => void;
    const slowPromise = new Promise<AccountContext>((res) => {
      resolveSlow = res;
    });
    const slowPath = (): Promise<AccountContext> => {
      slowPathCalls += 1;
      return slowPromise;
    };
    const p1 = coalescer.coalesce('sha-abc', slowPath);
    const p2 = coalescer.coalesce('sha-abc', slowPath);
    const p3 = coalescer.coalesce('sha-abc', slowPath);
    // The 3 callers should resolve to the same Promise.
    expect(coalescer.stats().inFlight).toBe(1);
    expect(coalescer.stats().starts).toBe(1);
    expect(coalescer.stats().hits).toBe(2);
    resolveSlow(fakeCtx('acc-1'));
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.account.id).toBe('acc-1');
    expect(r2.account.id).toBe('acc-1');
    expect(r3.account.id).toBe('acc-1');
    expect(slowPathCalls).toBe(1);
    expect(coalescer.stats().inFlight).toBe(0);
  });

  // ─── Runtime: rejection does NOT poison next call ────────────

  it('CRITICAL runtime — rejected slow-path does NOT poison the map. The next coalesce() call for the same sha runs slowPath fresh (verifies the .finally cleanup).', async () => {
    const coalescer = new AuthCoalescer();
    let slowPathCalls = 0;
    const failOnce = (): Promise<AccountContext> => {
      slowPathCalls += 1;
      if (slowPathCalls === 1) return Promise.reject(new Error('cold boom'));
      return Promise.resolve(fakeCtx('acc-2'));
    };
    await expect(coalescer.coalesce('sha-fail', failOnce)).rejects.toThrow('cold boom');
    // Map should be clean now; next call runs slowPath again, doesn't await the rejected one.
    expect(coalescer.stats().inFlight).toBe(0);
    const r = await coalescer.coalesce('sha-fail', failOnce);
    expect(r.account.id).toBe('acc-2');
    expect(slowPathCalls).toBe(2);
  });

  // ─── Runtime: different shas don't collide ───────────────────

  it('CRITICAL runtime — different shas run independent slow-paths concurrently. coalesce() keys on sha, not on slowPath identity.', async () => {
    const coalescer = new AuthCoalescer();
    let calls = 0;
    const slow = (id: string) => (): Promise<AccountContext> => {
      calls += 1;
      return Promise.resolve(fakeCtx(id));
    };
    const [a, b] = await Promise.all([
      coalescer.coalesce('sha-a', slow('a')),
      coalescer.coalesce('sha-b', slow('b')),
    ]);
    expect(a.account.id).toBe('a');
    expect(b.account.id).toBe('b');
    expect(calls).toBe(2); // both slow paths ran (different shas)
    expect(coalescer.stats().starts).toBe(2);
    expect(coalescer.stats().hits).toBe(0);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/auth-coalescer-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
