// Live WebRTC transport diagnostics for the simulator stream (founder
// 2026-06-21: "is it slow because we're on TCP? isn't UDP faster?").
//
// The data-channel ping (livekit-latency-ping) measures input round-trip but
// CAN'T tell us WHY a stream feels worse than RDP. This reads the subscribed
// video track's RTCStatsReport (getRTCStatsReport) and surfaces the things
// that actually explain "worse than RDP":
//   - transport udp/tcp + relayed?  — a TURN/TCP relay is the classic
//     worse-than-RDP cause (TCP head-of-line-blocks real-time video; UDP just
//     skips a lost packet). If we're relayed-over-TCP, that's the smoking gun.
//   - packet loss % + jitter        — a lossy/jittery trans-Atlantic leg
//     inflates the buffer + drops frames.
//   - decode fps + freeze count     — low fps / frequent freezes read as
//     "very slow" even at low RTT.
//
// Read-only: it polls stats and renders them. It never touches the video
// element, sizing, or input — so it cannot affect the stream itself.

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */

import { useEffect, useRef, useState } from 'react';
import type { Room } from './livekit';
import { reportTransport, type ControlAuth } from './agent-session-control';

/** Poll cadence. Stats move slowly; 3s keeps the readout fresh without churn. */
export const CONNECTION_STATS_INTERVAL_MS = 3000;

/** ICE.T — how often (at most) the live transport diagnostics are POSTed to the
 *  control plane. The stats poll runs every 3s (CONNECTION_STATS_INTERVAL_MS) for
 *  a fresh LOCAL readout, but telemetry to the CP is throttled to ~15s: the
 *  transport type + relay path change rarely, so a report every poll would be
 *  4-5× the traffic for no extra signal. A final report is ALSO flushed on
 *  session end / unmount regardless of this interval. */
export const TRANSPORT_REPORT_MIN_INTERVAL_MS = 15_000;

export interface ConnectionStats {
  /** Effective media transport: 'udp' (good for real-time) or 'tcp' (relay
   *  fallback — head-of-line blocking, the worse-than-RDP case). null = unknown. */
  transport: 'udp' | 'tcp' | null;
  /** True when the selected ICE path is a TURN relay (not a direct/host path). */
  relayed: boolean | null;
  /** Selected candidate-pair RTT in ms (the real media RTT, not the data ping). */
  rttMs: number | null;
  /** Lifetime inbound video packet loss, percent (cumulative average — moves
   *  very slowly, so a recent burst barely registers; kept as a secondary
   *  figure). */
  packetLossPct: number | null;
  /** Packet loss over the LAST poll interval only, percent. A short burst
   *  (e.g. 3000 lost in 3s during a freeze) shows up here immediately, where
   *  the lifetime average would dilute it to ~0. null until two polls have
   *  landed (no prior sample to diff against). */
  packetLossRecentPct: number | null;
  /** Raw cumulative inbound-video packet counters (signed per WebRTC spec),
   *  carried so the polling hook can diff consecutive samples for the recent
   *  loss figure. null when unavailable. */
  packetsLost: number | null;
  packetsReceived: number | null;
  /** Inbound video jitter in ms. */
  jitterMs: number | null;
  /** Decoder frames-per-second the client is actually rendering. */
  decodeFps: number | null;
  /** Cumulative freeze count on the inbound video. */
  freezeCount: number | null;
}

const EMPTY: ConnectionStats = {
  transport: null,
  relayed: null,
  rttMs: null,
  packetLossPct: null,
  packetLossRecentPct: null,
  packetsLost: null,
  packetsReceived: null,
  jitterMs: null,
  decodeFps: null,
  freezeCount: null,
};

/** Find the first subscribed remote video track on the room, or null. */
function firstSubscribedVideoTrack(room: Room): any {
  try {
    for (const participant of (room as any).remoteParticipants?.values?.() ?? []) {
      for (const pub of participant.videoTrackPublications?.values?.() ?? []) {
        if (pub?.isSubscribed && pub.track) return pub.track;
      }
    }
  } catch {
    /* room mid-teardown — treat as no track */
  }
  return null;
}

/** Parse a RemoteTrack RTCStatsReport into the diagnostic fields. Pure +
 *  exported so the parsing is unit-tested without a live PeerConnection. */
export function parseConnectionStats(report: RTCStatsReport): ConnectionStats {
  const byId = new Map<string, any>();
  report.forEach((s: any) => {
    if (s && typeof s.id === 'string') byId.set(s.id, s);
  });

  const out: ConnectionStats = { ...EMPTY };

  // Selected candidate-pair: prefer a nominated/succeeded pair, else the one
  // actually moving bytes.
  let pair: any = null;
  report.forEach((s: any) => {
    if (s?.type !== 'candidate-pair') return;
    const active =
      s.nominated === true || (typeof s.bytesReceived === 'number' && s.bytesReceived > 0);
    if (!active) return;
    if (pair === null || (s.bytesReceived ?? 0) > (pair.bytesReceived ?? 0)) pair = s;
  });
  if (pair !== null) {
    if (typeof pair.currentRoundTripTime === 'number')
      out.rttMs = Math.round(pair.currentRoundTripTime * 1000);
    const local =
      typeof pair.localCandidateId === 'string' ? byId.get(pair.localCandidateId) : null;
    const remote =
      typeof pair.remoteCandidateId === 'string' ? byId.get(pair.remoteCandidateId) : null;
    const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
    out.relayed = relayed;
    // Effective transport: a relay's relayProtocol if relayed, else the local
    // candidate protocol (udp/tcp).
    const rawProto = (relayed ? (local?.relayProtocol ?? local?.protocol) : local?.protocol) as
      | string
      | undefined;
    // TURN-over-TLS ('tls') is TCP-based (TLS runs over TCP, typically on 443) —
    // the single most common "relayed over TCP" case when UDP is blocked
    // (corporate / hotel / VPN networks), and exactly the head-of-line-blocking,
    // worse-than-RDP path this badge exists to surface. Without mapping it, `proto`
    // was 'tls' → failed the udp/tcp guard → transport stayed null → the pill read
    // 'unknown' and the slow-relay warning never showed. (Fable GUI re-audit.)
    const proto = rawProto === 'tls' ? 'tcp' : rawProto;
    if (proto === 'udp' || proto === 'tcp') out.transport = proto;
  }

  // Inbound video RTP: fps, loss, jitter, freezes.
  report.forEach((s: any) => {
    if (s?.type !== 'inbound-rtp' || s.kind !== 'video') return;
    if (typeof s.framesPerSecond === 'number') out.decodeFps = Math.round(s.framesPerSecond);
    if (typeof s.freezeCount === 'number') out.freezeCount = s.freezeCount;
    if (typeof s.jitter === 'number') out.jitterMs = Math.round(s.jitter * 1000);
    const lost = typeof s.packetsLost === 'number' ? s.packetsLost : null;
    const recv = typeof s.packetsReceived === 'number' ? s.packetsReceived : null;
    // Carry the raw cumulative counters so the polling hook can diff
    // consecutive samples into a recent-interval loss figure (the lifetime
    // average below barely moves during a short burst).
    out.packetsLost = lost;
    out.packetsReceived = recv;
    if (lost !== null && recv !== null && lost + recv > 0) {
      // packetsLost is a SIGNED cumulative estimate (WebRTC spec) that
      // legitimately goes negative early in a relayed SFU stream (RTX /
      // duplicates / reorder counted as "negative loss"). Clamp so the
      // founder-facing diagnostics pill + Copy-diagnostics never show a
      // nonsensical negative loss % (Fable GUI LiveKit re-audit).
      out.packetLossPct = Math.max(0, Math.round((lost / (lost + recv)) * 1000) / 10);
    }
  });

  return out;
}

export interface UseConnectionStatsOpts {
  room: Room | null;
  enabled: boolean;
}

export function useConnectionStats(opts: UseConnectionStatsOpts): ConnectionStats {
  const { room, enabled } = opts;
  const [stats, setStats] = useState<ConnectionStats>(EMPTY);
  // Previous poll's cumulative packet counters, kept across polls so we can
  // report the loss over the LAST interval (the lifetime average dilutes a
  // short burst to ~0). Reset to null whenever we drop to EMPTY so a stale
  // pre-resubscribe sample can't diff against a fresh, lower cumulative count.
  const prevCountersRef = useRef<{ lost: number; recv: number } | null>(null);

  useEffect(() => {
    if (room === null || !enabled) {
      prevCountersRef.current = null;
      setStats(EMPTY);
      return;
    }
    let cancelled = false;

    const poll = (): void => {
      if (cancelled) return;
      const track = firstSubscribedVideoTrack(room);
      // No subscribed video track right now (e.g. a freeze-recovery
      // resubscribe blip where the panel toggles setSubscribed(false) then
      // re-subscribes). The old stats no longer describe the live
      // PeerConnection, so reset to EMPTY — the transport pill falls back to
      // "link…" until a real report lands, instead of showing a stale
      // udp/tcp + RTT that hides a transport change during recovery.
      if (track === null || typeof track.getRTCStatsReport !== 'function') {
        prevCountersRef.current = null;
        setStats(EMPTY);
        return;
      }
      void Promise.resolve(track.getRTCStatsReport())
        .then((report: RTCStatsReport | undefined) => {
          if (cancelled || report === undefined) return;
          const parsed = parseConnectionStats(report);
          // Compute recent-interval loss from the delta between this poll's
          // cumulative counters and the last poll's. Only meaningful when the
          // counters advanced monotonically (recv delta > 0); a fresh/reset
          // PeerConnection (lower cumulative count than before) is treated as
          // no prior sample so we don't emit a bogus spike.
          if (parsed.packetsLost !== null && parsed.packetsReceived !== null) {
            const prev = prevCountersRef.current;
            if (
              prev !== null &&
              parsed.packetsReceived >= prev.recv &&
              parsed.packetsLost >= prev.lost
            ) {
              const dLost = parsed.packetsLost - prev.lost;
              const dRecv = parsed.packetsReceived - prev.recv;
              if (dLost + dRecv > 0) {
                parsed.packetLossRecentPct = Math.max(
                  0,
                  Math.round((dLost / (dLost + dRecv)) * 1000) / 10,
                );
              }
            }
            prevCountersRef.current = { lost: parsed.packetsLost, recv: parsed.packetsReceived };
          }
          setStats(parsed);
        })
        .catch(() => undefined);
    };

    poll();
    const handle = setInterval(poll, CONNECTION_STATS_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [room, enabled]);

  return stats;
}

/** #60 — throttle floor for transport telemetry POSTs (the stats poll is 3s;
 *  we don't need fleet telemetry that often). */
export const TRANSPORT_TELEMETRY_MIN_INTERVAL_MS = 15000;

/** Map the parsed ConnectionStats to the CP transport-report wire body. */
export function transportReportBody(stats: ConnectionStats): {
  transport: 'udp' | 'tcp' | null;
  relayed: boolean | null;
  rtt_ms: number | null;
  packet_loss_recent_pct: number | null;
  jitter_ms: number | null;
  decode_fps: number | null;
  freeze_count: number | null;
} {
  return {
    transport: stats.transport,
    relayed: stats.relayed,
    rtt_ms: stats.rttMs,
    packet_loss_recent_pct: stats.packetLossRecentPct,
    jitter_ms: stats.jitterMs,
    decode_fps: stats.decodeFps,
    freeze_count: stats.freezeCount,
  };
}

/** #60 — best-effort transport telemetry: POST the live diagnostics
 *  (transport/relayed/RTT/loss) to the CP on a throttled cadence + a final
 *  flush on unmount, so we PROVE the selected transport fleet-wide + MEASURE a
 *  TURN relay before/after WITHOUT disturbing the user. Fire-and-forget:
 *  reportTransport swallows every error, so this can never touch the stream. */
export function useTransportTelemetry(opts: {
  stats: ConnectionStats;
  sessionId: string;
  auth: ControlAuth;
  enabled: boolean;
}): void {
  const { stats, sessionId, auth, enabled } = opts;
  const lastSentAtRef = useRef(0);
  // Snapshot the latest inputs so the unmount flush posts a fresh sample
  // without re-subscribing its cleanup on every 3s poll.
  const latestRef = useRef({ stats, sessionId, auth, enabled });
  latestRef.current = { stats, sessionId, auth, enabled };

  // Throttled send: at most once per TRANSPORT_TELEMETRY_MIN_INTERVAL_MS, and
  // only once a real transport has resolved on a live session.
  useEffect(() => {
    if (!enabled || sessionId === '' || stats.transport === null) return;
    const now = Date.now();
    if (now - lastSentAtRef.current < TRANSPORT_TELEMETRY_MIN_INTERVAL_MS) return;
    lastSentAtRef.current = now;
    void reportTransport(sessionId, transportReportBody(stats), auth);
  }, [stats, sessionId, auth, enabled]);

  // Final flush on unmount — one last transport data point for the session.
  useEffect(() => {
    return () => {
      const l = latestRef.current;
      if (l.enabled && l.sessionId !== '' && l.stats.transport !== null) {
        void reportTransport(l.sessionId, transportReportBody(l.stats), l.auth);
      }
    };
  }, []);
}
