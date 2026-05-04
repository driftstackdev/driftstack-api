// V-149 — WebRTC streaming types.
//
// CLAUDE.md "Out of scope" notes: "WebRTC streaming layer — may land
// inside the GUI workstream if scope allows; otherwise polling-based
// screenshots for the first iteration." V-149 lands the seam so
// future work can drop in behind a stable interface.
//
// Use case: live-view a session running on a Driftstack-controlled
// browser. Screenshots-on-demand work today (apps/server/src/routes/
// sessions.ts → /v1/sessions/:id/capture). WebRTC unlocks streaming —
// continuous frames at 30+ fps, low latency, no per-frame HTTP cost.

/** Public stream identifier. Stable across re-attaches. */
export type StreamId = string;

/** SDP offer/answer payload, opaque to consumers. */
export interface SdpPayload {
  type: 'offer' | 'answer';
  sdp: string;
}

/** ICE candidate — exchanged during connection establishment. */
export interface IceCandidate {
  candidate: string;
  /** Media-section index. */
  sdpMLineIndex: number | null;
  /** Media-section ID. */
  sdpMid: string | null;
}

export interface StreamConfig {
  /** Target frame rate. Implementations may degrade under bandwidth pressure. */
  targetFps: number;
  /** Target bitrate in kilobits per second. */
  targetBitrateKbps: number;
  /** Audio capture in addition to video? Mostly false for browser sessions. */
  audio: boolean;
  /** ICE servers (STUN / TURN) for NAT traversal. */
  iceServers: readonly IceServer[];
}

export interface IceServer {
  urls: string | readonly string[];
  username?: string;
  credential?: string;
}

/** Stream lifecycle states. */
export type StreamState =
  | 'connecting' // signaling exchange in progress
  | 'connected' // peer connection established + media flowing
  | 'reconnecting' // transient failure, attempting recovery
  | 'closed' // stream ended cleanly
  | 'failed'; // stream ended with an error

/** Per-stream stats snapshot, sampled periodically. */
export interface StreamStats {
  streamId: StreamId;
  state: StreamState;
  /** Wall-clock ms since stream started. */
  ageMs: number;
  /** Frames sent in the last sample window. */
  framesSent: number;
  /** Average sent frame rate. */
  fpsAvg: number;
  /** Bitrate in kbps over the last sample window. */
  bitrateKbpsAvg: number;
  /** Round-trip time in ms (peer connection RTT). */
  rttMs: number | null;
  /** Packet loss fraction (0..1). */
  packetLossFraction: number;
}

/** Event emitted by a stream during its lifecycle. */
export type StreamEvent =
  | { kind: 'state_changed'; state: StreamState; at: number }
  | { kind: 'stats_sample'; stats: StreamStats }
  | { kind: 'ice_candidate'; candidate: IceCandidate }
  | { kind: 'error'; message: string; recoverable: boolean };
