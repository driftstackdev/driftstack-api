// The whole shutdown fits inside systemd's stop window, with room to spare.
//
// Shutdown is a budget spread across three files that are never edited
// together: `CLOSE_DEADLINE_MS` in index.ts bounds the request drain, the
// teardown steps in bootstrap.ts each carry their own timeout, and
// `TimeoutStopSec` in the systemd unit is the wall. Exceed the wall and systemd
// SIGKILLs mid-teardown, which is the one outcome every one of those bounds
// exists to prevent: buffered Sentry events are lost, the Postgres and Redis
// handles leak server-side, and the deploy stalls for the full stop window.
//
// Each of those numbers was already pinned as literal text — `CLOSE_DEADLINE_MS
// = 10_000` in two files, `TimeoutStopSec=20` in a third. Three pins, and not
// one of them looks at another. Change any single value, update its own pin,
// and every test stays green while the relationship between them inverts. A pin
// asserts a number is what it is; it cannot assert that a number is ENOUGH.
//
// So this reads the real values and does the arithmetic. It is the only check
// in the suite that would notice `TimeoutStopSec` being lowered to 8.
//
// The margin requirement is deliberate. A budget that merely fits leaves
// nothing for process startup accounting, a slow SIGTERM delivery, or the
// clearInterval work ahead of the closes — and "fits exactly" is indis-
// tinguishable from "does not fit" once anything real is running on the box.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { REDIS_QUIT_DEADLINE_MS, withTeardownDeadline } from '../../src/lib/bootstrap.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const INDEX = resolve(REPO_ROOT, 'apps/server/src/index.ts');
const BOOTSTRAP = resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts');
const UNIT = resolve(REPO_ROOT, 'infra/systemd/driftstack-api.service');
const DB_CLIENT = resolve(REPO_ROOT, 'apps/server/src/db/client.ts');

/** Milliseconds the request drain may take before teardown starts. */
function closeDeadlineMs(): number {
  const m = /const CLOSE_DEADLINE_MS = ([\d_]+);/.exec(readFileSync(INDEX, 'utf8'));
  if (m === null) throw new Error('CLOSE_DEADLINE_MS not found in index.ts');
  return Number(m[1]!.replace(/_/g, ''));
}

/** systemd's hard wall, in milliseconds. */
function timeoutStopMs(): number {
  const m = /^TimeoutStopSec=(\d+)$/m.exec(readFileSync(UNIT, 'utf8'));
  if (m === null) throw new Error('TimeoutStopSec not found in the systemd unit');
  return Number(m[1]) * 1000;
}

/**
 * Worst case for the teardown block, which runs its independent closes
 * CONCURRENTLY — so the cost is the LONGEST step, not their sum.
 */
function teardownWorstCaseMs(): number {
  const bootstrap = readFileSync(BOOTSTRAP, 'utf8');

  const redis = /const REDIS_QUIT_DEADLINE_MS = ([\d_]+);/.exec(bootstrap);
  if (redis === null) throw new Error('REDIS_QUIT_DEADLINE_MS not found in bootstrap.ts');

  const flush = /await sentry\.flush\((\d+)\);/.exec(bootstrap);
  const close = /await sentry\.close\((\d+)\);/.exec(bootstrap);
  if (flush === null || close === null) throw new Error('sentry flush/close bounds not found');

  const dbSeconds = /client\.end\(\{ timeout: (\d+) \}\)/.exec(readFileSync(DB_CLIENT, 'utf8'));
  if (dbSeconds === null) throw new Error('postgres client.end timeout not found in db/client.ts');

  // Sentry's two calls ARE sequential with each other inside one arm.
  const sentryArm = Number(flush[1]) + Number(close[1]);
  const redisArm = Number(redis[1]!.replace(/_/g, ''));
  const dbArm = Number(dbSeconds[1]) * 1000;
  return Math.max(sentryArm, redisArm, dbArm);
}

/** Fraction of the stop window that must remain unspent. */
const REQUIRED_MARGIN = 0.2;

describe('the shutdown budget fits inside the systemd stop window', () => {
  it('CRITICAL every input parsed to a real number. If any regex silently failed, the arithmetic below would run on a default and could report a comfortable margin for a budget that does not fit — the exact failure being guarded, produced by the guard itself.', () => {
    expect(closeDeadlineMs(), 'CLOSE_DEADLINE_MS').toBeGreaterThan(0);
    expect(timeoutStopMs(), 'TimeoutStopSec').toBeGreaterThan(0);
    expect(teardownWorstCaseMs(), 'worst-case teardown step').toBeGreaterThan(0);
  });

  it('CRITICAL drain + teardown finishes with margin before systemd SIGKILLs. Exceeding the wall loses buffered Sentry events, leaks the Postgres and Redis handles, and stalls the deploy for the full stop window — the outcome every one of these bounds exists to prevent.', () => {
    const budget = closeDeadlineMs() + teardownWorstCaseMs();
    const wall = timeoutStopMs();
    expect(
      budget,
      `shutdown worst case is ${String(budget)}ms against a ${String(wall)}ms TimeoutStopSec — ` +
        `needs to leave at least ${String(REQUIRED_MARGIN * 100)}% of the window unspent`,
    ).toBeLessThanOrEqual(wall * (1 - REQUIRED_MARGIN));
  });

  it('CRITICAL the teardown closes run concurrently, so one hung dependency cannot starve the others. In series their budgets add and the sum does not fit; worse, a Redis that never answers used to block the Postgres close entirely, which is how a stuck deploy also became a connection leak.', () => {
    const bootstrap = readFileSync(BOOTSTRAP, 'utf8');
    const block = /await Promise\.allSettled\(\[([\s\S]*?)\]\);/.exec(bootstrap);
    expect(block, 'teardown must close its independent clients concurrently').not.toBeNull();
    expect(block![1], 'the Redis quit belongs in the concurrent block').toMatch(/redis\.quit/);
    expect(block![1], 'so does the Postgres close').toMatch(/dbHandle\.close/);
    expect(block![1], 'and the Sentry flush/close arm').toMatch(/sentry\.flush/);
  });

  it('CRITICAL redis.quit carries a deadline. It is the one teardown step that had none, and it runs against a socket that may never answer — an unreachable Redis is not hypothetical during an incident deploy, which is exactly when a clean shutdown matters most.', () => {
    const bootstrap = readFileSync(BOOTSTRAP, 'utf8');
    expect(bootstrap, 'redis.quit must be wrapped in the teardown deadline helper').toMatch(
      /withTeardownDeadline\(REDIS_QUIT_DEADLINE_MS, \(\) => redis\.quit\(\)\)/,
    );
  });
});

// The two checks above are WIRING guards: they prove the call site feeds the
// live helper and constant, which no behavioural test can see. They prove
// nothing about what the helper does, so that is exercised directly here —
// otherwise this file would assert the expression and not the behaviour, which
// is the failure it was written to fix.
describe('withTeardownDeadline', () => {
  it('CRITICAL gives up on a step that never settles. This is the entire point: a Redis socket that never answers must not hold the process past the stop window.', async () => {
    const started = Date.now();
    const result = await withTeardownDeadline(30, () => new Promise<void>(() => {}));
    expect(result.timedOut, 'a hanging step reports timedOut').toBe(true);
    expect(Date.now() - started, 'and it returned promptly').toBeLessThan(2_000);
  });

  it('CRITICAL a step that settles normally is NOT reported as timed out. Without this the check above is satisfied by a helper that abandons every step immediately, which would close nothing at all.', async () => {
    let ran = false;
    const result = await withTeardownDeadline(5_000, async () => {
      ran = true;
      return await Promise.resolve('closed');
    });
    expect(ran, 'the step actually ran').toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('CRITICAL never rejects, whether the step rejects or throws synchronously. Teardown runs on the way to process.exit(0); a throw here would abort the steps after it and turn one unreachable dependency into a leaked one.', async () => {
    await expect(
      withTeardownDeadline(5_000, () => Promise.reject(new Error('redis gone'))),
    ).resolves.toEqual({ timedOut: false });
    await expect(
      withTeardownDeadline(5_000, () => {
        throw new Error('threw synchronously');
      }),
    ).resolves.toEqual({ timedOut: false });
  });

  it('CRITICAL the deadline timer is unref-ed, so a fast shutdown is not held open by a pending timer. A 2s timer that keeps the event loop alive would add 2s to every clean exit.', async () => {
    const before = process.getActiveResourcesInfo?.().filter((r) => r === 'Timeout').length ?? 0;
    await withTeardownDeadline(60_000, () => Promise.resolve());
    const after = process.getActiveResourcesInfo?.().filter((r) => r === 'Timeout').length ?? 0;
    expect(after, 'the 60s timer must not survive the call').toBeLessThanOrEqual(before);
  });

  it('the shipped Redis bound is the one this behaviour is tuned for', () => {
    expect(REDIS_QUIT_DEADLINE_MS).toBe(2_000);
  });
});
