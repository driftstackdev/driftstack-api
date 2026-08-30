// V-2167 — the latency ping's sample must SURVIVE to the receipt deadline.
//
// `useLatencyPing` is not only a badge: every echo it lands is forwarded to
// `noteRoomRtt`, and that is the sole writer of the measurement
// `currentReceiptDeadline` reads. V-2150 widened the input-receipt budget on a
// slow link precisely so a proxied mobile session stops being accused of
// dropping input it actually applied.
//
// ⛔ The staleness sweep used to clear that measurement on EVERY tick
// (LIVEKIT_PING_STALE_SWEEP_MS = 1s) rather than only when the sample had aged
// out (LIVEKIT_PING_FRESH_WINDOW_MS = 6s), so a fresh sample survived at most
// one second and the deadline read `null` almost always — V-2150 silently
// degraded back to the flat budget it was written to replace. The badge kept
// showing the right number, so nothing looked wrong.
//
// These arms assert the measurement's LIFETIME, which is the half the badge
// tests cannot see: a landed sample still drives the deadline several sweep
// ticks later, and stops driving it once it is genuinely stale.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const sendInputEventMock = vi.fn();
let dataHandler: ((payload: Uint8Array) => void) | null = null;

vi.mock('../../src/lib/livekit', () => ({
  RoomEvent: { DataReceived: 'dataReceived' },
  sendInputEvent: (...args: unknown[]) => sendInputEventMock(...args) as unknown,
}));

function makeRoom(): unknown {
  return {
    on: (event: string, cb: (payload: Uint8Array) => void) => {
      if (event === 'dataReceived') dataHandler = cb;
    },
    off: (event: string) => {
      if (event === 'dataReceived') dataHandler = null;
    },
  };
}

function echo(timestamp: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type: 'ping', timestamp }));
}

// Imported AFTER the mock so the hook picks up the stubbed transport. Note that
// `livekit-input-ack` is deliberately NOT mocked: `currentReceiptDeadline` is
// the real consumer, and a faked one would prove only that the hook calls a
// function I wrote.
import {
  useLatencyPing,
  LIVEKIT_PING_FRESH_WINDOW_MS,
  LIVEKIT_PING_STALE_SWEEP_MS,
} from '../../src/lib/livekit-latency-ping';
import {
  currentReceiptDeadline,
  receiptDeadlineForRtt,
  INPUT_RECEIPT_DEADLINE_MS,
} from '../../src/lib/livekit-input-ack';

function lastSentTimestamp(): number {
  const calls = sendInputEventMock.mock.calls;
  const payload = calls[calls.length - 1][1] as { timestamp: number };
  return payload.timestamp;
}

/** A round trip slow enough that the adaptive deadline exceeds the flat one. */
const SLOW_RTT_MS = 1_200;

beforeEach(() => {
  sendInputEventMock.mockReset();
  dataHandler = null;
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLatencyPing → currentReceiptDeadline', () => {
  it('a landed sample widens the receipt deadline', () => {
    const room = makeRoom() as never;
    renderHook(() => useLatencyPing({ room, enabled: true }));

    const ts = lastSentTimestamp();
    act(() => {
      vi.advanceTimersByTime(SLOW_RTT_MS);
      dataHandler?.(echo(ts));
    });

    // Not a hand-typed number: the same function the wire layer calls, so the
    // arm pins the plumbing rather than restating the arithmetic.
    expect(currentReceiptDeadline(room)).toBe(receiptDeadlineForRtt(SLOW_RTT_MS));
    expect(currentReceiptDeadline(room)).toBeGreaterThan(INPUT_RECEIPT_DEADLINE_MS);
  });

  it('the sample survives sweep ticks until it is actually stale', () => {
    const room = makeRoom() as never;
    renderHook(() => useLatencyPing({ room, enabled: true }));

    const ts = lastSentTimestamp();
    act(() => {
      vi.advanceTimersByTime(SLOW_RTT_MS);
      dataHandler?.(echo(ts));
    });
    const widened = currentReceiptDeadline(room);
    expect(widened).toBeGreaterThan(INPUT_RECEIPT_DEADLINE_MS);

    // Several sweep ticks pass, all of them still INSIDE the freshness window.
    // This is the arm the pre-fix code failed on the very first tick.
    act(() => {
      vi.advanceTimersByTime(LIVEKIT_PING_STALE_SWEEP_MS * 3);
    });
    expect(LIVEKIT_PING_STALE_SWEEP_MS * 3).toBeLessThan(LIVEKIT_PING_FRESH_WINDOW_MS);
    expect(currentReceiptDeadline(room)).toBe(widened);
  });

  it('a genuinely stale sample stops widening the deadline', () => {
    const room = makeRoom() as never;
    renderHook(() => useLatencyPing({ room, enabled: true }));

    const ts = lastSentTimestamp();
    act(() => {
      vi.advanceTimersByTime(SLOW_RTT_MS);
      dataHandler?.(echo(ts));
    });
    expect(currentReceiptDeadline(room)).toBeGreaterThan(INPUT_RECEIPT_DEADLINE_MS);

    // Past the freshness window with no further echo: the link stopped
    // answering, so an unmeasured link falls back to the flat budget rather
    // than keeping a stale widening forever.
    act(() => {
      vi.advanceTimersByTime(LIVEKIT_PING_FRESH_WINDOW_MS + LIVEKIT_PING_STALE_SWEEP_MS);
    });
    expect(currentReceiptDeadline(room)).toBe(INPUT_RECEIPT_DEADLINE_MS);
  });
});
