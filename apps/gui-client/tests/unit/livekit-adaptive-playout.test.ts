import { describe, expect, it } from 'vitest';
import { playoutDelaySupport } from '../../src/components/AgentSessionPanel';
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
  it('rests at the FLOOR on a clean link (no freeze, low loss + jitter)', () => {
    // Asserted against the constant, not a literal: V-2168 raised the floor off
    // zero, and a hard-coded 0 here would have pinned the very default the
    // change exists to move.
    expect(
      nextPlayoutDelay(ADAPTIVE_PLAYOUT.MIN_S, {
        freezeDelta: 0,
        packetLossPct: 0.1,
        jitterMs: 8,
      }),
    ).toBe(ADAPTIVE_PLAYOUT.MIN_S);
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

  it('never goes below the floor when already at it and calm', () => {
    expect(
      nextPlayoutDelay(ADAPTIVE_PLAYOUT.MIN_S, {
        freezeDelta: 0,
        packetLossPct: 0,
        jitterMs: 0,
      }),
    ).toBe(ADAPTIVE_PLAYOUT.MIN_S);
    // …and a delay that somehow starts BELOW the floor is lifted to it.
    expect(nextPlayoutDelay(0, { freezeDelta: 0, packetLossPct: 0, jitterMs: 0 })).toBe(
      ADAPTIVE_PLAYOUT.MIN_S,
    );
  });

  it('treats null loss/jitter as 0 (unknown → calm, not a spurious ramp)', () => {
    expect(
      nextPlayoutDelay(ADAPTIVE_PLAYOUT.MIN_S, {
        freezeDelta: 0,
        packetLossPct: null,
        jitterMs: null,
      }),
    ).toBe(ADAPTIVE_PLAYOUT.MIN_S);
  });

  it("⛔ V-2168: the owner's own link sits in the HOLD band — with a 0 floor the buffer never builds", () => {
    // Reported 2026-08-30: "udp · direct, decode 50 fps, loss 0.7%, jitter 5ms,
    // freezes 12, RENDER 34fps". 0.7% is ABOVE LOSS_CALM_PCT (never calm) and
    // BELOW LOSS_STRESS_PCT (never stressed), and most 3s samples carry no NEW
    // freeze — so the control law HOLDS on every one of them. From a zero start
    // that is zero forever, on exactly the link being complained about: the
    // controller could only react AFTER a freeze the customer had already seen.
    // The floor makes the resting state a real (if tiny) buffer.
    const sample = { freezeDelta: 0, packetLossPct: 0.7, jitterMs: 5 };
    let delay = ADAPTIVE_PLAYOUT.MIN_S;
    for (let i = 0; i < 40; i += 1) delay = nextPlayoutDelay(delay, sample);
    expect(delay, 'the hold band must hold, not decay below the floor').toBe(
      ADAPTIVE_PLAYOUT.MIN_S,
    );
    expect(ADAPTIVE_PLAYOUT.MIN_S).toBeGreaterThan(0);
    // And the floor stays far below the stressed ceiling this controller
    // already accepts — it buys smoothness without spending felt latency.
    expect(ADAPTIVE_PLAYOUT.MIN_S).toBeLessThan(ADAPTIVE_PLAYOUT.MAX_S / 5);
  });
});

describe('playoutDelaySupport — stop asking a browser that cannot answer (V-2159)', () => {
  it('⛔ null (no receiver yet) is NOT "unsupported" — the track simply is not subscribed', () => {
    // Reading a not-yet-subscribed track as unsupported would kill the controller
    // on every session before it ever had a chance to run.
    expect(playoutDelaySupport(null)).toBeNull();
    expect(playoutDelaySupport({})).toBeNull();
    expect(playoutDelaySupport({ receiver: undefined })).toBeNull();
    expect(playoutDelaySupport({ receiver: null })).toBeNull();
  });

  it("mirrors livekit-client's own test: the hint is present on the receiver", () => {
    expect(playoutDelaySupport({ receiver: { playoutDelayHint: 0 } })).toBe(true);
    // WebKit (the Simulator's engine) has no such property — this is the case that
    // produced one "Playout delay not supported in this browser" warn every 3s for
    // the life of a session, because setPlayoutDelay logs instead of throwing.
    expect(playoutDelaySupport({ receiver: {} })).toBe(false);
    expect(playoutDelaySupport({ receiver: { someOtherProp: 1 } })).toBe(false);
  });
});
