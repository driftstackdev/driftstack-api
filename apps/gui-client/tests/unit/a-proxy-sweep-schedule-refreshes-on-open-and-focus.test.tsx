// N3 (owner: "auto update proxy states more often ... when opening application, and
// periodically") — the proxy-probe sweep used to run ONLY on a 15-min interval whose
// first tick was deferred a full interval, so opening the app showed stale states for
// up to 15 min. installProxySweepSchedule now fires on three triggers — a staggered
// startup sweep, the steady interval, and window focus/visibility — all calling the
// same single-flight sweep. planSweep still gates on TTL, so a focus sweep only
// re-probes genuinely-stale rows (never fresh/unlooked-at ones).
//
// Pure schedule logic tested against a fake host, so no DOM/timers are needed.

import { describe, expect, it, vi } from 'vitest';
import {
  installProxySweepSchedule,
  STARTUP_SWEEP_DELAY_MS,
  SWEEP_INTERVAL_MS,
  type SweepScheduleHost,
} from '../../src/lib/proxy-probe-sweeper';

function fakeHost(isVisible = true) {
  const rec = {
    timeouts: [] as { fn: () => void; ms: number }[],
    intervals: [] as { fn: () => void; ms: number }[],
    focus: [] as (() => void)[],
    visibility: [] as (() => void)[],
    cleared: { timeouts: [] as number[], intervals: [] as number[] },
    removedFocus: 0,
    removedVisibility: 0,
    visible: isVisible,
  };
  const host: SweepScheduleHost = {
    setTimeout: (fn, ms) => (rec.timeouts.push({ fn, ms }), rec.timeouts.length - 1),
    clearTimeout: (id) => rec.cleared.timeouts.push(id),
    setInterval: (fn, ms) => (rec.intervals.push({ fn, ms }), rec.intervals.length - 1),
    clearInterval: (id) => rec.cleared.intervals.push(id),
    addFocus: (fn) => rec.focus.push(fn),
    removeFocus: () => (rec.removedFocus += 1),
    addVisibility: (fn) => rec.visibility.push(fn),
    removeVisibility: () => (rec.removedVisibility += 1),
    isVisible: () => rec.visible,
  };
  return { host, rec };
}

describe('N3 — installProxySweepSchedule', () => {
  it('schedules a staggered startup sweep (sooner than the interval) AND the steady interval', () => {
    const sweep = vi.fn();
    const { host, rec } = fakeHost();
    installProxySweepSchedule(sweep, host);

    expect(rec.timeouts).toHaveLength(1);
    expect(rec.timeouts[0]?.ms).toBe(STARTUP_SWEEP_DELAY_MS);
    expect(rec.intervals).toHaveLength(1);
    expect(rec.intervals[0]?.ms).toBe(SWEEP_INTERVAL_MS);
    // The startup sweep is the whole point: sooner than the interval, but not
    // synchronous (0) — it must stay off the busy launch moment.
    expect(STARTUP_SWEEP_DELAY_MS).toBeGreaterThan(0);
    expect(STARTUP_SWEEP_DELAY_MS).toBeLessThan(SWEEP_INTERVAL_MS);

    // Firing the startup timer runs the sweep.
    sweep.mockClear();
    rec.timeouts[0]?.fn();
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('sweeps on focus/visibility ONLY while visible (removing this trigger fails here)', () => {
    const sweep = vi.fn();
    const { host, rec } = fakeHost(true);
    installProxySweepSchedule(sweep, host);
    expect(rec.focus).toHaveLength(1);
    expect(rec.visibility).toHaveLength(1);

    sweep.mockClear();
    rec.focus[0]?.();
    expect(sweep).toHaveBeenCalledTimes(1); // a focus while visible refreshes
  });

  it('does NOT sweep when the window is hidden (visibility-gated, not every event)', () => {
    const sweep = vi.fn();
    const { host, rec } = fakeHost(false); // hidden
    installProxySweepSchedule(sweep, host);
    sweep.mockClear();
    rec.visibility[0]?.();
    expect(sweep).not.toHaveBeenCalled();
  });

  it('cleanup clears both timers and removes both listeners', () => {
    const sweep = vi.fn();
    const { host, rec } = fakeHost();
    const cleanup = installProxySweepSchedule(sweep, host);
    cleanup();
    expect(rec.cleared.timeouts).toHaveLength(1);
    expect(rec.cleared.intervals).toHaveLength(1);
    expect(rec.removedFocus).toBe(1);
    expect(rec.removedVisibility).toBe(1);
  });
});
