// Adaptive receiver jitter buffer for the interactive simulator stream.
//
// The panel starts the subscribed video track at MIN_S — one frame at the
// publish cadence. It used to start at setPlayoutDelay(0), a zero jitter buffer
// chosen for the lowest input→pixel latency, and on a lossy/jittery leg
// (founder 2026-07-03: "udp·direct, decode 17fps, loss 2.4%, jitter 18ms,
// freezes 43 … tapping does nothing")
// a zero buffer turns every packet-loss / jitter spike into a visible FREEZE:
// the decoder has nothing queued to play while it waits for the retransmit or
// the next keyframe. The stream stutters and taps land on a frozen frame.
//
// This is a small closed-loop controller: it samples the track's live RTP
// stats each poll and nudges the playout delay UP when the link is stressed
// (new freezes / elevated loss / elevated jitter) so a buffer absorbs the
// hiccups, and eases it back toward 0 when the link is calm again — trading a
// little latency for smoothness exactly when (and only when) the network is
// bad. Ramp UP fast (stop the freezes) and ease DOWN slow (avoid oscillation).
//
// Pure decision function so the control law is unit-tested without a live
// PeerConnection; the panel owns the sampling + the setPlayoutDelay() call.

/** Playout-delay control law bounds/steps, in SECONDS (setPlayoutDelay's unit). */
export const ADAPTIVE_PLAYOUT = {
  /**
   * Resting floor — ONE frame interval at the 30fps publish cadence (0.033s,
   * rounded to the control law's 1/100s grid).
   *
   * ⛔ It was 0, and that made the whole controller REACTIVE: with an empty
   * buffer, the first arrival hiccup IS a visible freeze, and only after that
   * freeze is observed does the ramp begin. Worse, the owner's own reported
   * link (2026-08-30: "loss 0.7%, jitter 5ms, freezes 12") sits in the
   * hysteresis HOLD band — 0.7% is above LOSS_CALM_PCT so it never reads calm,
   * and below LOSS_STRESS_PCT so it never reads stressed — so from a 0 start
   * the delay stays 0 indefinitely on exactly the link the owner is
   * complaining about. Simulated against this function: 40 consecutive samples
   * at those numbers leave the delay at 0.
   *
   * One frame of buffer absorbs single-frame arrival jitter before it can
   * become a dropped presentation, at a latency cost far below the 0.3s this
   * same controller already accepts under stress — the trade the owner asked
   * for ("smooth like a local browser"). It is a FLOOR, not a fixed delay: a
   * genuinely stressed link still ramps to MAX_S, and a calm one eases back to
   * here rather than to nothing.
   */
  MIN_S: 0.03,
  /** Ceiling: enough buffer to ride out a bad leg without unbounded lag. At
   *  0.3s the stream is noticeably delayed but SMOOTH — the founder's stated
   *  preference over "frozen + unusable". Only reached under sustained stress. */
  MAX_S: 0.3,
  /** Ramp up fast: one loss burst should start building buffer immediately. */
  STEP_UP_S: 0.1,
  /** Ease down slowly: don't collapse the buffer on the first calm sample and
   *  re-freeze on the next spike. */
  STEP_DOWN_S: 0.05,
  /** Loss ≥ this (percent) → stressed. Below LOSS_CALM_PCT → calm. */
  LOSS_STRESS_PCT: 1.5,
  LOSS_CALM_PCT: 0.5,
  /** Jitter ≥ this (ms) → stressed. Below JITTER_CALM_MS → calm. */
  JITTER_STRESS_MS: 40,
  JITTER_CALM_MS: 20,
} as const;

export interface PlayoutSignals {
  /** New freezes observed since the previous sample (clamped ≥ 0 by the caller
   *  so a track resubscribe resetting freezeCount doesn't read as negative). */
  freezeDelta: number;
  /** Inbound video loss percent this sample, or null when unknown. */
  packetLossPct: number | null;
  /** Inbound video jitter ms this sample, or null when unknown. */
  jitterMs: number | null;
}

export interface PacketCounters {
  packetsLost: number | null;
  packetsReceived: number | null;
}

/**
 * Packet loss over the interval between two cumulative WebRTC samples.
 * Returns null for the first sample, missing counters, a counter reset, or an
 * interval with no packets so callers can fall back to the lifetime figure.
 */
export function recentPacketLossPct(
  previous: PacketCounters | null,
  current: PacketCounters,
): number | null {
  if (
    previous === null ||
    previous.packetsLost === null ||
    previous.packetsReceived === null ||
    current.packetsLost === null ||
    current.packetsReceived === null ||
    current.packetsLost < previous.packetsLost ||
    current.packetsReceived < previous.packetsReceived
  ) {
    return null;
  }

  const lost = current.packetsLost - previous.packetsLost;
  const received = current.packetsReceived - previous.packetsReceived;
  const total = lost + received;
  if (total <= 0) return null;
  return Math.max(0, Math.round((lost / total) * 1000) / 10);
}

/**
 * Next playout delay (seconds) given the current delay + this sample's signals.
 * Stressed (any freeze, or loss/jitter over the stress thresholds) → step up.
 * Calm (no freeze AND loss/jitter under the calm thresholds) → step down.
 * In-between → hold (hysteresis band prevents oscillation). Always clamped to
 * [MIN_S, MAX_S] and rounded to 1/100s to avoid float drift.
 */
export function nextPlayoutDelay(current: number, s: PlayoutSignals): number {
  const loss = s.packetLossPct ?? 0;
  const jitter = s.jitterMs ?? 0;
  const froze = s.freezeDelta > 0;
  const stressed =
    froze ||
    loss >= ADAPTIVE_PLAYOUT.LOSS_STRESS_PCT ||
    jitter >= ADAPTIVE_PLAYOUT.JITTER_STRESS_MS;
  const calm =
    !froze && loss <= ADAPTIVE_PLAYOUT.LOSS_CALM_PCT && jitter <= ADAPTIVE_PLAYOUT.JITTER_CALM_MS;

  let next = current;
  if (stressed) next = current + ADAPTIVE_PLAYOUT.STEP_UP_S;
  else if (calm) next = current - ADAPTIVE_PLAYOUT.STEP_DOWN_S;

  next = Math.max(ADAPTIVE_PLAYOUT.MIN_S, Math.min(ADAPTIVE_PLAYOUT.MAX_S, next));
  return Math.round(next * 100) / 100;
}
