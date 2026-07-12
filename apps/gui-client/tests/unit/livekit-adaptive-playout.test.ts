import { describe, expect, it } from 'vitest';
import {
  ADAPTIVE_PLAYOUT,
  nextPlayoutDelay,
  recentPacketLossPct,
} from '../../src/lib/livekit-adaptive-playout';

describe('recentPacketLossPct — adaptive playout sampling', () => {
  it('surfaces a fresh burst that a lifetime average would dilute', () => {
    expect(
      recentPacketLossPct(
        { packetsLost: 10, packetsReceived: 9_990 },
        { packetsLost: 30, packetsReceived: 10_970 },
      ),
    ).toBe(2);
  });

  it('returns null for the first sample, missing counters, resets, and idle intervals', () => {
    expect(recentPacketLossPct(null, { packetsLost: 4, packetsReceived: 96 })).toBeNull();
    expect(
      recentPacketLossPct(
        { packetsLost: 4, packetsReceived: 96 },
        { packetsLost: null, packetsReceived: 120 },
      ),
    ).toBeNull();
    expect(
      recentPacketLossPct(
        { packetsLost: 4, packetsReceived: 96 },
        { packetsLost: 0, packetsReceived: 10 },
      ),
    ).toBeNull();
    expect(
      recentPacketLossPct(
        { packetsLost: 4, packetsReceived: 96 },
        { packetsLost: 4, packetsReceived: 96 },
      ),
    ).toBeNull();
  });

  it('handles a signed WebRTC loss baseline when counters advance', () => {
    expect(
      recentPacketLossPct(
        { packetsLost: -4, packetsReceived: 96 },
        { packetsLost: -2, packetsReceived: 198 },
      ),
    ).toBe(1.9);
  });
});

describe('nextPlayoutDelay — adaptive jitter-buffer control law', () => {
  it('holds at 0 on a clean link (no freeze, low loss + jitter)', () => {
    expect(nextPlayoutDelay(0, { freezeDelta: 0, packetLossPct: 0.1, jitterMs: 8 })).toBe(0);
  });

  it('ramps UP on a fresh freeze', () => {
    expect(nextPlayoutDelay(0, { freezeDelta: 1, packetLossPct: 0, jitterMs: 5 })).toBe(
      ADAPTIVE_PLAYOUT.STEP_UP_S,
    );
  });

  it("ramps UP under the founder's exact conditions (loss 2.4%, jitter 18ms)", () => {
    // loss 2.4% ≥ LOSS_STRESS_PCT(1.5) → stressed even without a counted freeze this tick.
    expect(nextPlayoutDelay(0, { freezeDelta: 0, packetLossPct: 2.4, jitterMs: 18 })).toBe(0.1);
  });

  it('ramps toward the MAX ceiling over successive stressed ticks, then clamps', () => {
    let d = 0;
    for (let i = 0; i < 10; i += 1) {
      d = nextPlayoutDelay(d, { freezeDelta: 2, packetLossPct: 3, jitterMs: 30 });
    }
    expect(d).toBe(ADAPTIVE_PLAYOUT.MAX_S);
    // Never exceeds the ceiling.
    expect(
      nextPlayoutDelay(ADAPTIVE_PLAYOUT.MAX_S, { freezeDelta: 5, packetLossPct: 9, jitterMs: 90 }),
    ).toBe(ADAPTIVE_PLAYOUT.MAX_S);
  });

  it('eases DOWN (slower than it ramped up) once the link is calm again', () => {
    // From a built-up buffer, a calm tick steps down by STEP_DOWN_S (< STEP_UP_S).
    expect(nextPlayoutDelay(0.3, { freezeDelta: 0, packetLossPct: 0.2, jitterMs: 10 })).toBe(
      Math.round((0.3 - ADAPTIVE_PLAYOUT.STEP_DOWN_S) * 100) / 100,
    );
    expect(ADAPTIVE_PLAYOUT.STEP_DOWN_S).toBeLessThan(ADAPTIVE_PLAYOUT.STEP_UP_S);
  });

  it('HOLDS in the hysteresis band (loss/jitter between calm and stress, no freeze) — no oscillation', () => {
    // loss 1.0 is > LOSS_CALM(0.5) but < LOSS_STRESS(1.5); jitter 30 is > CALM(20) < STRESS(40).
    expect(nextPlayoutDelay(0.15, { freezeDelta: 0, packetLossPct: 1.0, jitterMs: 30 })).toBe(0.15);
  });

  it('never goes below 0 (floor) when already at 0 and calm', () => {
    expect(nextPlayoutDelay(0, { freezeDelta: 0, packetLossPct: 0, jitterMs: 0 })).toBe(0);
  });

  it('treats null loss/jitter as 0 (unknown → calm, not a spurious ramp)', () => {
    expect(nextPlayoutDelay(0, { freezeDelta: 0, packetLossPct: null, jitterMs: null })).toBe(0);
  });
});
