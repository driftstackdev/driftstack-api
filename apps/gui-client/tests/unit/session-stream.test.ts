// V-534.E — unit tests for the polling frame stream.

import { describe, expect, it, vi } from 'vitest';
import {
  computeFps,
  createPollingFrameStream,
  type Frame,
  type FrameStreamEvent,
} from '../../src/lib/session-stream';

function fakeFrame(at: number): Frame {
  return { pngBase64: 'AAAA', bytes: 4, capturedAt: at, durationMs: 10 };
}

describe('V-534.E computeFps', () => {
  it('0 fps for <2 frames', () => {
    expect(computeFps([])).toBe(0);
    expect(computeFps([1])).toBe(0);
  });
  it('rounds to one decimal place', () => {
    // 4 timestamps spaced 500ms → 3 intervals over 1500ms → 2.0 fps
    expect(computeFps([0, 500, 1000, 1500])).toBe(2);
  });
  it('handles 0-delta safely (returns 0, not Infinity)', () => {
    expect(computeFps([1000, 1000, 1000])).toBe(0);
  });
});

describe('V-534.E createPollingFrameStream — initial fetch', () => {
  it('fires a frame event for the first fetch', async () => {
    const fetchFrame = vi.fn(() => Promise.resolve(fakeFrame(1_000_000)));
    const stream = createPollingFrameStream(fetchFrame, { intervalMs: 5_000 });
    const listener = vi.fn<(e: FrameStreamEvent) => void>();
    stream.subscribe(listener);
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    const event = listener.mock.calls[0]?.[0];
    expect(event?.kind).toBe('frame');
    if (event?.kind === 'frame') {
      expect(event.frame.bytes).toBe(4);
    }
    stream.stop();
  });

  it('does not fire an initial frame when initialPaused=true', async () => {
    const fetchFrame = vi.fn(() => Promise.resolve(fakeFrame(0)));
    const stream = createPollingFrameStream(fetchFrame, {
      intervalMs: 5_000,
      initialPaused: true,
    });
    const listener = vi.fn();
    stream.subscribe(listener);
    // Give the microtask queue a chance to fire.
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchFrame).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    stream.stop();
  });
});

describe('V-534.E createPollingFrameStream — pause / resume', () => {
  it('pause() stops further frames; resume() triggers an immediate fetch', async () => {
    let counter = 0;
    const fetchFrame = vi.fn(() => Promise.resolve(fakeFrame(++counter * 100)));
    const stream = createPollingFrameStream(fetchFrame, { intervalMs: 5_000 });
    const listener = vi.fn();
    stream.subscribe(listener);
    await vi.waitFor(() => expect(fetchFrame).toHaveBeenCalledTimes(1));
    stream.pause();
    expect(stream.isPaused()).toBe(true);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ kind: 'paused' }));
    // Resume should trigger another fetch immediately.
    stream.resume();
    expect(stream.isPaused()).toBe(false);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ kind: 'resumed' }));
    await vi.waitFor(() => expect(fetchFrame).toHaveBeenCalledTimes(2));
    stream.stop();
  });

  it('redundant pause / resume are no-ops', async () => {
    const fetchFrame = vi.fn(() => Promise.resolve(fakeFrame(1)));
    const stream = createPollingFrameStream(fetchFrame, { intervalMs: 100_000 });
    const listener = vi.fn();
    stream.subscribe(listener);
    await vi.waitFor(() => expect(fetchFrame).toHaveBeenCalledTimes(1));
    stream.pause();
    stream.pause(); // second pause → no extra 'paused' event
    const pausedEventCount = listener.mock.calls.filter(
      (c) => (c[0] as { kind: string }).kind === 'paused',
    ).length;
    expect(pausedEventCount).toBe(1);
    stream.stop();
  });
});

describe('createPollingFrameStream — single-timer invariant (resume during in-flight fetch)', () => {
  it('keeps exactly ONE pending timer when resume() races an in-flight fetch (no double chain / leak)', async () => {
    vi.useFakeTimers();
    try {
      let resolveFirst!: (f: Frame) => void;
      let calls = 0;
      const fetchFrame = vi.fn(() => {
        calls++;
        if (calls === 1) {
          return new Promise<Frame>((res) => {
            resolveFirst = res;
          });
        }
        return Promise.resolve(fakeFrame(calls * 100));
      });
      // Big interval so no real cadence interferes; we assert the timer COUNT.
      const stream = createPollingFrameStream(fetchFrame, { intervalMs: 1_000_000 });
      // tick A started synchronously and is now awaiting the deferred fetch —
      // it has NOT scheduled a timer yet.
      expect(fetchFrame).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);

      // resume() during the in-flight fetch → tick B hits the skip path and
      // schedules timer #1.
      stream.pause();
      stream.resume();
      expect(vi.getTimerCount()).toBe(1);

      // Resolve the in-flight fetch → tick A's finally calls schedule() again.
      // The fix clears timer #1 before arming timer #2, so the count stays 1.
      // Without the fix, timer #1 leaks and the count is 2 (two timer chains →
      // frame-rate doubling).
      resolveFirst(fakeFrame(50));
      for (let i = 0; i < 6; i++) await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);

      stream.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('V-534.E createPollingFrameStream — errors', () => {
  it('emits an error event when fetchFrame rejects; continues polling', async () => {
    const err = new Error('capture failed');
    let calls = 0;
    const fetchFrame = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.reject(err);
      return Promise.resolve(fakeFrame(calls * 1000));
    });
    const stream = createPollingFrameStream(fetchFrame, { intervalMs: 20 });
    const listener = vi.fn();
    stream.subscribe(listener);
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    await vi.waitFor(() => expect(fetchFrame.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 1000,
    });
    const errorEvents = listener.mock.calls.filter(
      (c) => (c[0] as { kind: string }).kind === 'error',
    );
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    stream.stop();
  });
});

describe('V-534.E createPollingFrameStream — fps + stop', () => {
  it('fpsActual updates as multiple frames stream in', async () => {
    const timestamps = [1_000_000, 1_000_500, 1_001_000, 1_001_500];
    let i = 0;
    const fetchFrame = vi.fn(() => {
      const at = timestamps[i] ?? timestamps[timestamps.length - 1] ?? 0;
      i++;
      return Promise.resolve(fakeFrame(at));
    });
    const stream = createPollingFrameStream(fetchFrame, { intervalMs: 5 });
    const frames: number[] = [];
    stream.subscribe((event) => {
      if (event.kind === 'frame') {
        frames.push(event.fpsActual);
        // Stop once we've captured the 4-frame moving-average value.
        if (frames.length === 4) stream.stop();
      }
    });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(4), { timeout: 2000 });
    expect(frames[3]).toBe(2); // 4 frames @ 500ms spacing → 2 fps
  });

  it('stop() halts polling + drops listeners', async () => {
    const fetchFrame = vi.fn(() => Promise.resolve(fakeFrame(1)));
    const stream = createPollingFrameStream(fetchFrame, { intervalMs: 10 });
    const listener = vi.fn();
    stream.subscribe(listener);
    await vi.waitFor(() => expect(fetchFrame).toHaveBeenCalledTimes(1));
    stream.stop();
    const callsBefore = fetchFrame.mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(fetchFrame.mock.calls.length).toBe(callsBefore);
  });
});
