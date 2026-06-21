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

import { useEffect, useState } from 'react';
import type { Room } from './livekit';

/** Poll cadence. Stats move slowly; 3s keeps the readout fresh without churn. */
export const CONNECTION_STATS_INTERVAL_MS = 3000;

export interface ConnectionStats {
  /** Effective media transport: 'udp' (good for real-time) or 'tcp' (relay
   *  fallback — head-of-line blocking, the worse-than-RDP case). null = unknown. */
  transport: 'udp' | 'tcp' | null;
  /** True when the selected ICE path is a TURN relay (not a direct/host path). */
  relayed: boolean | null;
  /** Selected candidate-pair RTT in ms (the real media RTT, not the data ping). */
  rttMs: number | null;
  /** Lifetime inbound video packet loss, percent. */
  packetLossPct: number | null;
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
    const proto = (relayed ? (local?.relayProtocol ?? local?.protocol) : local?.protocol) as
      | string
      | undefined;
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
    if (lost !== null && recv !== null && lost + recv > 0) {
      out.packetLossPct = Math.round((lost / (lost + recv)) * 1000) / 10;
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

  useEffect(() => {
    if (room === null || !enabled) {
      setStats(EMPTY);
      return;
    }
    let cancelled = false;

    const poll = (): void => {
      if (cancelled) return;
      const track = firstSubscribedVideoTrack(room);
      if (track === null || typeof track.getRTCStatsReport !== 'function') return;
      void Promise.resolve(track.getRTCStatsReport())
        .then((report: RTCStatsReport | undefined) => {
          if (cancelled || report === undefined) return;
          setStats(parseConnectionStats(report));
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
