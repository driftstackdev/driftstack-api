// The freeze the owner reported twice: "one freeze and nothing works anymore —
// not a single input, not a single new URL, everything totally stuck and it
// never picks up."
//
// The mechanism was a room-scoped congestion latch set on a LiveKit
// DCBufferStatusChanged high-water event and cleared ONLY by the matching low
// crossing or a room reconnect. Both are EVENTS. If the buffer never drained —
// which is precisely the case that congests it — and no reconnect fired, nothing
// ever cleared it, and every reliable input threw for the life of the room.
//
// Two defects, and the second is why the report says "not a single new URL":
//   1. the latch had no upper bound in time;
//   2. `navigate` was NOT exempt from it, so the one action that could recover
//      the session was the one the latch also blocked.
//
// These arms pin the ESCAPE, not the backpressure. Backpressure working is not
// in question; backpressure that cannot end is the outage.

import { describe, it, expect } from 'vitest';
import {
  CONGESTION_MAX_AGE_MS,
  isReliableInputCongested,
  setReliableInputCongested,
  reliableInputCongestedForMs,
} from '../../src/lib/livekit-input-congestion';

const room = (): object => ({});

describe('a congestion latch expires on its own', () => {
  it('suppresses input while the signal is fresh', () => {
    // Vacuity control: the latch must actually work, or every arm below passes
    // on a feature that does nothing.
    const r = room();
    setReliableInputCongested(r, true, 1_000);
    expect(isReliableInputCongested(r, 1_000)).toBe(true);
    expect(isReliableInputCongested(r, 1_000 + CONGESTION_MAX_AGE_MS - 1)).toBe(true);
  });

  it('stops suppressing once the signal is older than the deadline', () => {
    // THE FIX. No low crossing, no reconnect — the two events the old code
    // depended on — and it still recovers.
    const r = room();
    setReliableInputCongested(r, true, 1_000);
    expect(isReliableInputCongested(r, 1_000 + CONGESTION_MAX_AGE_MS)).toBe(false);
  });

  it('does NOT restamp on a repeated congestion signal', () => {
    // A chatty channel re-arming the latch on every high-water event would push
    // the deadline forward forever and rebuild the unbounded latch this
    // replaced. Onset time is the FIRST one.
    const r = room();
    setReliableInputCongested(r, true, 1_000);
    setReliableInputCongested(r, true, 5_000);
    setReliableInputCongested(r, true, 9_000);
    expect(reliableInputCongestedForMs(r, 9_000)).toBe(8_000);
    expect(isReliableInputCongested(r, 1_000 + CONGESTION_MAX_AGE_MS)).toBe(false);
  });

  it('still clears immediately on an explicit drain, without waiting', () => {
    // The fast path must survive the fix: a real low crossing recovers at once
    // rather than after the deadline.
    const r = room();
    setReliableInputCongested(r, true, 1_000);
    setReliableInputCongested(r, false, 1_200);
    expect(isReliableInputCongested(r, 1_300)).toBe(false);
  });

  it('keeps rooms independent', () => {
    // WeakMap keyed by room: one wedged session must not mute another.
    const a = room();
    const b = room();
    setReliableInputCongested(a, true, 1_000);
    expect(isReliableInputCongested(b, 1_000)).toBe(false);
    expect(isReliableInputCongested(a, 1_000)).toBe(true);
  });
});
