// "can you check these auto sent diagnostics" — owner item N-0.
//
// There were none. The flight recorder surfaced the previous run's record via
// onReport and then unconditionally cleared it; console.warn was the only other
// copy, and the toast said "A diagnostic snapshot was saved" while the next
// three lines deleted it. In a release build that is delivery to nobody.
//
// The fix is additive and keeps the re-report semantics: BEFORE the live key is
// cleared, the record is moved into a bounded history and the formatted line is
// handed to a durable sink (the log buffer's ERROR path, which flushes to disk
// immediately rather than on a debounce a crash loop can outrun). These arms pin
// that the copy exists AFTER reporting, that the clear still happens, and that
// the history stays bounded — "bounded by construction" is the section's own
// rule and a diagnostic that grows while hunting a leak is its own punchline.

import { describe, it, expect, vi } from 'vitest';
import {
  reportPreviousRun,
  readFlightHistory,
  FLIGHT_HISTORY_MAX,
  type FlightRecord,
} from '../../src/lib/main-thread-stall-detector';

function fakeStore(seed: Record<string, unknown> = {}) {
  const m = new Map<string, unknown>(Object.entries(seed));
  return {
    get: <T>(k: string): Promise<T | undefined> => Promise.resolve(m.get(k) as T | undefined),
    set: (k: string, v: unknown): Promise<void> => {
      m.set(k, v);
      return Promise.resolve();
    },
    save: (): Promise<void> => Promise.resolve(),
    raw: m,
  };
}

const rec = (at: number): FlightRecord => ({
  at,
  onStall: true,
  window: 'main',
  census: {
    blockedMs: 5000,
    videoElements: 1,
    documentChildren: 100,
    heapUsedMiB: 50,
    tabCount: null,
    pendingReceipts: null,
  },
});

describe('a surfaced record is kept, not destroyed by being reported', () => {
  it('moves the record into history BEFORE clearing the live key', async () => {
    const store = fakeStore({ lastRun: rec(1_000), cleanShutdown: false });
    const onReport = vi.fn();
    const persist = vi.fn();
    await reportPreviousRun(store, onReport, persist);
    // Re-report semantics kept: the live key is cleared.
    expect(store.raw.get('lastRun')).toBeNull();
    // THE FIX: the copy the toast promises actually exists.
    const history = await readFlightHistory(store);
    expect(history).toHaveLength(1);
    expect(history[0]?.at).toBe(1_000);
    expect(onReport).toHaveBeenCalledTimes(1);
  });

  it('hands the formatted line to the durable sink', async () => {
    const store = fakeStore({ lastRun: rec(1_000), cleanShutdown: false });
    const persist = vi.fn();
    await reportPreviousRun(store, vi.fn(), persist);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]?.[0]).toContain('[flight-recorder]');
  });

  it('does nothing on a clean shutdown', async () => {
    // Vacuity control: history and sink must be driven by a GENUINE unclean
    // exit, not by every launch.
    const store = fakeStore({ lastRun: rec(1_000), cleanShutdown: true });
    const persist = vi.fn();
    await reportPreviousRun(store, vi.fn(), persist);
    expect(await readFlightHistory(store)).toHaveLength(0);
    expect(persist).not.toHaveBeenCalled();
  });

  it('keeps history bounded, newest first', async () => {
    const prior = Array.from({ length: FLIGHT_HISTORY_MAX }, (_, i) => rec(100 + i));
    const store = fakeStore({ lastRun: rec(9_999), cleanShutdown: false, history: prior });
    await reportPreviousRun(store, vi.fn());
    const history = await readFlightHistory(store);
    expect(history).toHaveLength(FLIGHT_HISTORY_MAX);
    expect(history[0]?.at).toBe(9_999);
  });
});
