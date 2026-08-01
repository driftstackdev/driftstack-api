// The unhandled-rejection backstop must be observable, not just survivable.
//
// The backstop deliberately keeps the process ALIVE when a fire-and-forget
// promise rejects, so one missed `.catch()` cannot take the control plane down
// during exactly the worst window. That is the right call. Its cost is silence:
// the only trace was a log line, and the counter the module already kept was
// exported for "a future metrics scrape" that was never wired — the accessor had
// zero callers anywhere in the repo.
//
// The failure that leaves open is the slow one. A path that begins rejecting on
// every request keeps serving, keeps logging, and looks identical to a healthy
// process on every dashboard. The same argument is already written into the
// retention-purge counter's own comment — "if a tick started failing … the only
// trace was a log line nobody is watching for" — and was simply never applied
// here.
//
// The replay case is the load-bearing one. The backstop is installed BEFORE any
// async wiring, deliberately, so a rejection during bootstrap is caught; the
// metrics registry does not exist that early. A sink that only counted from
// attach onwards would therefore be blind to precisely the window the backstop
// was written for.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attachUnhandledRejectionMetric,
  getUnhandledRejectionCount,
  installUnhandledRejectionBackstop,
  resetUnhandledRejectionCount,
} from '../../src/lib/unhandled-rejection-backstop.js';

/** Drain the microtask + macrotask queue so `unhandledRejection` can fire. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

function silentLogger(): { error: () => void } {
  return { error: () => undefined };
}

describe('the unhandled-rejection backstop reports to a metric', () => {
  // `installUnhandledRejectionBackstop` documents that it is NOT idempotent, and
  // these cases install it three times. Left in place the listeners would
  // outlive the file and count rejections raised by OTHER tests sharing this
  // worker — inflating this file's numbers and, worse, making an unrelated test
  // flaky. Snapshot the pre-existing listeners and restore exactly them.
  let priorListeners: NodeJS.UnhandledRejectionListener[] = [];

  beforeEach(() => {
    resetUnhandledRejectionCount();
    priorListeners = process.listeners('unhandledRejection');
  });

  afterEach(() => {
    process.removeAllListeners('unhandledRejection');
    for (const l of priorListeners) process.on('unhandledRejection', l);
    resetUnhandledRejectionCount();
  });

  it('CRITICAL a rejection reaches the metric sink. Without this the backstop is a silent swallow: the process survives, which is correct, and nothing anywhere shows that it happened.', async () => {
    installUnhandledRejectionBackstop(silentLogger());
    let emitted = 0;
    attachUnhandledRejectionMetric((delta) => {
      emitted += delta;
    });

    void Promise.reject(new Error('fire-and-forget rejected'));
    await settle();

    expect(getUnhandledRejectionCount(), 'the backstop counted it').toBeGreaterThan(0);
    expect(emitted, 'and the sink was told').toBeGreaterThan(0);
  });

  it('CRITICAL a rejection that happens BEFORE the sink attaches is replayed to it. The backstop is installed before async wiring so a bootstrap-window rejection is caught — which is earlier than the metrics registry exists. A sink counting only from attach onwards would be blind to exactly the window this was written for.', () => {
    resetUnhandledRejectionCount();
    // Simulate two rejections counted while no sink was attached, without
    // depending on process event timing.
    installUnhandledRejectionBackstop(silentLogger());
    const before = getUnhandledRejectionCount();
    expect(before, 'starting clean').toBe(0);

    // Attach with a pre-existing count by driving real rejections first.
    return (async () => {
      void Promise.reject(new Error('during bootstrap 1'));
      void Promise.reject(new Error('during bootstrap 2'));
      await settle();
      const counted = getUnhandledRejectionCount();
      expect(counted, 'both were counted with no sink attached').toBeGreaterThanOrEqual(2);

      let emitted = 0;
      attachUnhandledRejectionMetric((delta) => {
        emitted += delta;
      });
      expect(emitted, 'attach replays what was missed').toBe(counted);
    })();
  });

  it("CRITICAL resetting the counter also drops the sink, so a sink installed by one test cannot keep receiving from the next. A leaked sink would make a later test pass on another test's rejections.", async () => {
    installUnhandledRejectionBackstop(silentLogger());
    let emitted = 0;
    attachUnhandledRejectionMetric((delta) => {
      emitted += delta;
    });
    resetUnhandledRejectionCount();

    void Promise.reject(new Error('after reset'));
    await settle();

    expect(emitted, 'the detached sink received nothing').toBe(0);
    expect(getUnhandledRejectionCount(), 'though the backstop still counts').toBeGreaterThan(0);
  });
});
