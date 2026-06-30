// LK.6.e — useLatencyPing staleness sweep.
//
// The badge must not lie when the link dies: once ping echoes stop landing,
// the last good rttMs has to expire to null ("measuring…") instead of staying
// pinned at a healthy-looking number (which the founder would otherwise read as
// a healthy link AND bake into Copy-diagnostics). These tests drive the hook
// over a mocked Room + DataChannel with fake timers and assert that:
//   - a fresh echo populates rttMs + lastSeenAt
//   - once lastSeenAt is older than LIVEKIT_PING_FRESH_WINDOW_MS, the sweep
//     nulls rttMs while PRESERVING lastSeenAt (consumers still know when the
//     link last echoed)
//   - a subsequent fresh echo re-populates rttMs (recovery)

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the livekit wrapper: capture the DataReceived handler the hook registers
// and the input events it sends, without a real Room / data channel.
const sendInputEventMock = vi.fn();
let dataHandler: ((payload: Uint8Array) => void) | null = null;

vi.mock('../../src/lib/livekit', () => ({
  RoomEvent: { DataReceived: 'dataReceived' },
  sendInputEvent: (...args: unknown[]) => sendInputEventMock(...args) as unknown,
}));

// A minimal Room: on/off just record the DataReceived listener.
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

/** Encode a `ping` echo the harness would send back for `timestamp`. */
function echo(timestamp: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type: 'ping', timestamp }));
}

// Import AFTER the mock is registered.
import {
  useLatencyPing,
  LIVEKIT_PING_FRESH_WINDOW_MS,
  LIVEKIT_PING_STALE_SWEEP_MS,
  type LatencyState,
} from '../../src/lib/livekit-latency-ping';

/** The timestamp of the most-recent ping the hook sent (from the mock calls). */
function lastSentTimestamp(): number {
  const calls = sendInputEventMock.mock.calls;
  const payload = calls[calls.length - 1][1] as { timestamp: number };
  return payload.timestamp;
}

beforeEach(() => {
  sendInputEventMock.mockReset();
  dataHandler = null;
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLatencyPing — staleness sweep', () => {
  it('expires a stuck rttMs once echoes stop, preserving lastSeenAt', () => {
    const room = makeRoom() as never;
    const { result } = renderHook(() => useLatencyPing({ room, enabled: true }));

    // The mount fires one ping immediately. Echo it back fresh (instant RTT).
    const ts = lastSentTimestamp();
    act(() => {
      dataHandler?.(echo(ts));
    });
    const fresh: LatencyState = result.current;
    expect(fresh.rttMs).toBe(0);
    expect(fresh.lastSeenAt).toBe(ts);

    // Time passes past the freshness window with NO further echoes (dead link).
    act(() => {
      vi.advanceTimersByTime(LIVEKIT_PING_FRESH_WINDOW_MS + LIVEKIT_PING_STALE_SWEEP_MS);
    });

    // rttMs is expired to null; lastSeenAt is retained so consumers know WHEN
    // the link last echoed.
    expect(result.current.rttMs).toBeNull();
    expect(result.current.lastSeenAt).toBe(fresh.lastSeenAt);
  });

  it('keeps a fresh rttMs while echoes keep landing (no premature expiry)', () => {
    const room = makeRoom() as never;
    const { result } = renderHook(() => useLatencyPing({ room, enabled: true }));

    // Echo the initial ping.
    act(() => {
      dataHandler?.(echo(lastSentTimestamp()));
    });
    expect(result.current.rttMs).toBe(0);

    // Advance a little less than the window, then echo the next ping that fired
    // at the 2s interval — the reading stays fresh, never nulled.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => {
      dataHandler?.(echo(lastSentTimestamp()));
    });
    act(() => {
      vi.advanceTimersByTime(LIVEKIT_PING_STALE_SWEEP_MS);
    });
    expect(result.current.rttMs).not.toBeNull();
  });

  it('recovers — a fresh echo after expiry re-populates rttMs', () => {
    const room = makeRoom() as never;
    const { result } = renderHook(() => useLatencyPing({ room, enabled: true }));

    act(() => {
      dataHandler?.(echo(lastSentTimestamp()));
    });
    expect(result.current.rttMs).toBe(0);

    // Let it go stale.
    act(() => {
      vi.advanceTimersByTime(LIVEKIT_PING_FRESH_WINDOW_MS + LIVEKIT_PING_STALE_SWEEP_MS);
    });
    expect(result.current.rttMs).toBeNull();

    // The next interval ping echoes back → rttMs is fresh again.
    act(() => {
      dataHandler?.(echo(lastSentTimestamp()));
    });
    expect(result.current.rttMs).not.toBeNull();
  });
});
