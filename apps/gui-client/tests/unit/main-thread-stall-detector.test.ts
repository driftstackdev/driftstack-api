import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyStall,
  formatFlightRecord,
  formatStall,
  setStallHeartbeatForTests,
  shouldSurfaceRecord,
  stallHeartbeatMs,
  stallThresholdForHeartbeat,
  startStallWatch,
  takeStallCensus,
  type FlightRecord,
  STALL_THRESHOLD_MS,
  STALL_HEARTBEAT_MS,
} from '../../src/lib/main-thread-stall-detector';

describe('main-thread stall detector', () => {
  it('CRITICAL an ordinary heartbeat is not a stall — the arm that stops this from reporting every second', () => {
    const v = classifyStall({ elapsedMs: STALL_HEARTBEAT_MS + 20, visibleThroughout: true });
    expect(v.stalled).toBe(false);
    expect(v.blockedMs).toBe(20);
  });

  it('CRITICAL a long gap on a VISIBLE window is a stall, and blockedMs excludes the interval the timer was supposed to wait', () => {
    const v = classifyStall({ elapsedMs: 9_000, visibleThroughout: true });
    expect(v.stalled).toBe(true);
    expect(v.blockedMs, 'the thread was unavailable for 8s of the 9s gap').toBe(8_000);
    expect(v.discardedReason).toBeNull();
  });

  it('CRITICAL a long gap on a HIDDEN window is discarded — a backgrounded window throttles timers and is indistinguishable from a freeze, so reporting it would bury the real thing in noise from every minimised window', () => {
    const v = classifyStall({ elapsedMs: 60_000, visibleThroughout: false });
    expect(v.stalled).toBe(false);
    expect(v.discardedReason).toBe('hidden');
    expect(v.blockedMs, 'still measured, just not reported').toBe(59_000);
  });

  it('CRITICAL a hidden window with a NORMAL gap carries no discard reason. `discardedReason` means "a stall was suppressed", so setting it on every hidden sample would make the field useless for telling the two apart.', () => {
    const v = classifyStall({ elapsedMs: STALL_HEARTBEAT_MS + 5, visibleThroughout: false });
    expect(v.stalled).toBe(false);
    expect(v.discardedReason).toBeNull();
  });

  it('the threshold is the boundary, asserted on both sides so an off-by-one cannot pass', () => {
    expect(
      classifyStall({ elapsedMs: STALL_THRESHOLD_MS - 1, visibleThroughout: true }).stalled,
    ).toBe(false);
    expect(classifyStall({ elapsedMs: STALL_THRESHOLD_MS, visibleThroughout: true }).stalled).toBe(
      true,
    );
  });

  it('CRITICAL the census reports what was HELD at the moment of the stall — the counts that separate a leak from a slow frame', () => {
    const census = takeStallCensus(8_000, {
      videoElements: () => 4,
      documentChildren: () => 5_400,
      tabCount: () => 7,
      pendingReceipts: () => 128,
      heapUsedMiB: () => 900,
    });
    expect(census).toEqual({
      blockedMs: 8_000,
      videoElements: 4,
      documentChildren: 5_400,
      tabCount: 7,
      pendingReceipts: 128,
      heapUsedMiB: 900,
    });
  });

  it('optional probes degrade to null rather than throwing — a runtime without performance.memory must still produce a report', () => {
    const census = takeStallCensus(4_000, {
      videoElements: () => 1,
      documentChildren: () => 100,
    });
    expect(census.heapUsedMiB).toBeNull();
    expect(census.tabCount).toBeNull();
    expect(census.pendingReceipts).toBeNull();
  });

  it('formats one paste-ready line, because the person reporting this is copying it into a bug report and a multi-line dump gets truncated', () => {
    const line = formatStall(
      takeStallCensus(8_000, {
        videoElements: () => 4,
        documentChildren: () => 5_400,
        tabCount: () => 7,
        pendingReceipts: () => 128,
        heapUsedMiB: () => 900,
      }),
    );
    expect(line).toBe(
      '[stall] main thread blocked 8000ms video=4 dom=5400 tabs=7 receipts=128 heap=900MiB',
    );
    expect(line.split('\n')).toHaveLength(1);
  });

  it('omits absent probes from the line rather than printing null', () => {
    const line = formatStall(
      takeStallCensus(3_500, { videoElements: () => 1, documentChildren: () => 42 }),
    );
    expect(line).toBe('[stall] main thread blocked 3500ms video=1 dom=42');
  });

  describe('the heartbeat test seam (setStallHeartbeatForTests / stallHeartbeatMs)', () => {
    // Why it exists: advancing 6 h of fake time through the mounted App ran
    // 23,066 timer callbacks, 21,600 of them this 1 s heartbeat (measured
    // 2026-09-12, the app-shell six-hour test). The shell tests slow it through
    // the seam rather than stubbing the module; these arms pin that the seam
    // is what the detector actually starts from.
    //
    // This file runs in the node project, where there is no window and
    // `startStallWatch` returns a no-op. A minimal window/document stub —
    // `setInterval` delegating to the (fake) global at call time and counting
    // every tick per registered delay — is what makes the interval the detector
    // registers, and how often it runs, observable here.
    //
    // Mutations run: `stallHeartbeatMs()` returning STALL_HEARTBEAT_MS
    // regardless of the override (`return STALL_HEARTBEAT_MS`) reds the
    // override arm at its first read ("expected 1000 to be 60000"), before the
    // tick count is reached. App.tsx dropping the third argument of
    // `startStallWatch` is pinned in the-app-shell-keeps-checking-for-updates.
    const ticksByDelay = new Map<number, number>();
    const stops: Array<() => void> = [];
    const deps = { videoElements: () => 0, documentChildren: () => 0 };

    beforeEach(() => {
      vi.useFakeTimers();
      ticksByDelay.clear();
      vi.stubGlobal('window', {
        setInterval: (fn: () => void, ms: number): unknown =>
          globalThis.setInterval(() => {
            ticksByDelay.set(ms, (ticksByDelay.get(ms) ?? 0) + 1);
            fn();
          }, ms),
        clearInterval: (handle: unknown): void => {
          globalThis.clearInterval(handle as NodeJS.Timeout);
        },
      });
      vi.stubGlobal('document', {
        visibilityState: 'visible',
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      });
    });

    afterEach(() => {
      for (const stop of stops.splice(0)) stop();
      setStallHeartbeatForTests(null);
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it('(a) with no override the seam reads the production constant, and a watch started through it ticks every second — the positive control for the counter the next arm relies on', () => {
      expect(stallHeartbeatMs()).toBe(1_000);
      expect(stallHeartbeatMs()).toBe(STALL_HEARTBEAT_MS);
      stops.push(startStallWatch(() => undefined, deps, stallHeartbeatMs()));
      vi.advanceTimersByTime(120_000);
      expect(ticksByDelay.get(1_000), '120 s at a 1 s heartbeat').toBe(120);
      expect(ticksByDelay.size, 'the heartbeat is the only interval this watch registers').toBe(1);
    });

    it('CRITICAL (b) after setStallHeartbeatForTests(60_000) the seam reads 60000 and the watch fires its first tick at 60 s, not 1 s — 2 ticks over 120 s, not 120', () => {
      setStallHeartbeatForTests(60_000);
      expect(stallHeartbeatMs()).toBe(60_000);
      stops.push(startStallWatch(() => undefined, deps, stallHeartbeatMs()));
      vi.advanceTimersByTime(59_999);
      expect(ticksByDelay.get(60_000), 'nothing before 60 s').toBeUndefined();
      expect(ticksByDelay.get(1_000), 'and no 1 s interval was registered at all').toBeUndefined();
      vi.advanceTimersByTime(1);
      expect(ticksByDelay.get(60_000), 'the first tick lands at exactly 60 s').toBe(1);
      vi.advanceTimersByTime(60_000);
      expect(ticksByDelay.get(60_000), '2 ticks over 120 s, not 120').toBe(2);
      expect(ticksByDelay.get(1_000)).toBeUndefined();
    });

    it('(c) setStallHeartbeatForTests(null) restores the default, for the seam AND for the next watch started through it', () => {
      setStallHeartbeatForTests(60_000);
      expect(stallHeartbeatMs()).toBe(60_000);
      setStallHeartbeatForTests(null);
      expect(stallHeartbeatMs()).toBe(1_000);
      stops.push(startStallWatch(() => undefined, deps, stallHeartbeatMs()));
      vi.advanceTimersByTime(2_000);
      expect(ticksByDelay.get(1_000), 'back on the 1 s heartbeat').toBe(2);
      expect(ticksByDelay.get(60_000)).toBeUndefined();
    });

    it('CRITICAL (d) at the 60 s heartbeat an ON-TIME tick is NOT a stall, and a 63 s gap is one stall of 3000 ms — the arm that stops a slowed watch reporting a 0 ms stall every tick', () => {
      // Measured 2026-09-12 before this arm existed: with the bare
      // STALL_THRESHOLD_MS (3 000) as the elapsed-time boundary, every on-time
      // 60 000 ms tick classified as stalled with blockedMs 0, and one run of
      // the app-shell test file emitted 2,523 "[stall] main thread blocked
      // 0ms" warnings plus as many onStall flight-store writes. The threshold
      // the watch passes to classifyStall must move with the heartbeat.
      //
      // Mutation reasoned: `stallThresholdForHeartbeat(heartbeatMs)` at the
      // classifyStall call in startStallWatch → the bare `STALL_THRESHOLD_MS`
      // reds the first assertion (onStall called on the on-time tick, blockedMs
      // 0). `stallThresholdForHeartbeat` returning `heartbeatMs` alone (no
      // margin) reds the same assertion — an on-time 60 000 ms tick is not
      // below a 60 000 ms boundary either — and the pure arm below at the
      // production boundary (1000, not 3000). Both run 2026-09-12.
      setStallHeartbeatForTests(60_000);
      const onStall = vi.fn<(line: string, census: { blockedMs: number }) => void>();
      stops.push(startStallWatch(onStall, deps, stallHeartbeatMs()));
      vi.advanceTimersByTime(60_000);
      expect(ticksByDelay.get(60_000), 'the tick ran').toBe(1);
      expect(onStall, 'an on-time tick is not a stall at ANY heartbeat').not.toHaveBeenCalled();

      // The thread goes away for 3 s: the wall clock moves 3 000 ms further
      // than the timer did, so the next tick sees a 63 000 ms gap.
      vi.setSystemTime(Date.now() + 3_000);
      vi.advanceTimersByTime(60_000);
      expect(ticksByDelay.get(60_000)).toBe(2);
      expect(onStall, 'the late tick is exactly one stall').toHaveBeenCalledTimes(1);
      expect(onStall.mock.calls[0]?.[0]).toBe('[stall] main thread blocked 3000ms video=0 dom=0');
      expect(onStall.mock.calls[0]?.[1].blockedMs).toBe(3_000);

      // Back on time: silence again, so the stall was the gap and not a latch.
      vi.advanceTimersByTime(60_000);
      expect(onStall).toHaveBeenCalledTimes(1);
    });

    it('the threshold moves with the heartbeat: the production boundary at 1 s is exactly STALL_THRESHOLD_MS, and a slower heartbeat keeps the same 2 s margin above it', () => {
      expect(stallThresholdForHeartbeat(STALL_HEARTBEAT_MS)).toBe(STALL_THRESHOLD_MS);
      expect(stallThresholdForHeartbeat(60_000), '60 s heartbeat → 62 s boundary').toBe(62_000);
      expect(stallThresholdForHeartbeat(60_000) - 60_000, 'the margin is the production one').toBe(
        STALL_THRESHOLD_MS - STALL_HEARTBEAT_MS,
      );
      // A FASTER heartbeat never lowers the boundary below the production
      // threshold: a 3 s freeze is the defect, whatever the sampling rate.
      expect(stallThresholdForHeartbeat(100)).toBe(STALL_THRESHOLD_MS);
      // The watch's own boundary, both sides, at the slowed heartbeat.
      expect(
        classifyStall(
          { elapsedMs: 61_999, visibleThroughout: true },
          stallThresholdForHeartbeat(60_000),
          60_000,
        ).stalled,
      ).toBe(false);
      expect(
        classifyStall(
          { elapsedMs: 62_000, visibleThroughout: true },
          stallThresholdForHeartbeat(60_000),
          60_000,
        ).stalled,
      ).toBe(true);
    });
  });

  describe('flight recorder', () => {
    const record = (onStall: boolean): FlightRecord => ({
      at: Date.UTC(2026, 7, 26, 9, 30, 0),
      onStall,
      census: takeStallCensus(0, {
        videoElements: () => 9,
        documentChildren: () => 41_000,
        tabCount: () => 12,
        pendingReceipts: () => 128,
        heapUsedMiB: () => 1_800,
      }),
    });

    it('CRITICAL a surviving record after an UNCLEAN exit is surfaced — this is the whole point, because the freeze the owner reports never lets the stall watch fire at all', () => {
      expect(shouldSurfaceRecord(record(false), false)).toBe(true);
    });

    it('CRITICAL a clean shutdown is NOT reported. Without this, one stale write would announce a freeze on every launch forever.', () => {
      expect(shouldSurfaceRecord(record(false), true)).toBe(false);
    });

    it('no record means nothing to say — the ordinary case, and it must not be a false positive', () => {
      expect(shouldSurfaceRecord(null, false)).toBe(false);
      expect(shouldSurfaceRecord(null, true)).toBe(false);
    });

    it('the surfaced line says WHEN, WHY, and what was held — the three things nobody can reconstruct after a restart', () => {
      const line = formatFlightRecord(record(false));
      expect(line).toContain('previous run ended without shutting down');
      expect(line).toContain('last periodic snapshot');
      expect(line).toContain('2026-08-26T09:30:00.000Z');
      expect(line).toContain('video=9');
      expect(line).toContain('receipts=128');
    });

    it('distinguishes a snapshot taken BECAUSE of a stall from a scheduled one — they mean different things about how the run died', () => {
      expect(formatFlightRecord(record(true))).toContain('after a detected stall');
      expect(formatFlightRecord(record(false))).toContain('last periodic snapshot');
    });
  });
});
