import { describe, expect, it } from 'vitest';
import {
  classifyStall,
  formatFlightRecord,
  formatStall,
  shouldSurfaceRecord,
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
