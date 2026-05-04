// V-149 — WebRTC streaming interfaces.
//
// Phase 3+ work fills these in with browser-side WebRTC + server-
// side signaling. Today the seam exists so consumers (GUI client
// LiveSessionView, future customer-dashboard live preview) can
// integrate against the contract.

import type {
  IceCandidate,
  SdpPayload,
  StreamConfig,
  StreamEvent,
  StreamId,
  StreamStats,
  StreamState,
} from './types.js';

/** Options for creating a new stream against a session. */
export interface CreateStreamOpts {
  /** Session whose browser is being streamed. */
  sessionId: string;
  /** Stream configuration (FPS, bitrate, ICE servers). */
  config: StreamConfig;
}

/** Result of CreateStream — caller exchanges SDP via the same StreamId. */
export interface CreateStreamResult {
  streamId: StreamId;
  /** Server-side SDP offer. Caller's WebRTC peer answers via `negotiate`. */
  offer: SdpPayload;
}

/**
 * Top-level streaming service. GUI client + customer dashboard both go
 * through this interface; the production implementation runs on the
 * Mac mini fleet (where the browser session lives) and exposes its
 * signaling via a server-side relay.
 */
export interface WebRtcStreamingService {
  /**
   * Begin streaming a session's browser tab. Returns the stream id +
   * server-side SDP offer. Caller's peer connection answers via
   * `negotiate(streamId, answer)`.
   */
  createStream(opts: CreateStreamOpts): Promise<CreateStreamResult>;

  /**
   * Exchange the caller's SDP answer (or a renegotiation offer mid-stream).
   * Resolves to the server's response payload (answer when caller offered,
   * answer when caller answered the original — implementations may need
   * a follow-up offer for codec changes).
   */
  negotiate(streamId: StreamId, payload: SdpPayload): Promise<SdpPayload>;

  /**
   * Submit an ICE candidate from the caller's side. The server multiplexes
   * caller candidates into the active peer connection.
   */
  submitIceCandidate(streamId: StreamId, candidate: IceCandidate): Promise<void>;

  /**
   * Subscribe to stream events. Returns an unsubscribe fn.
   *
   * Implementations push state changes, periodic stats samples,
   * ICE candidates from the server side (which the caller then adds
   * to its peer connection), and errors. Polling-based fallbacks
   * implement this as a periodic stats fetch + state change diff.
   */
  subscribe(streamId: StreamId, handler: (event: StreamEvent) => void): () => void;

  /**
   * Look up the current state + stats for a stream without subscribing.
   * Used by the customer dashboard for at-a-glance metrics on the
   * sessions list page (V-139 /sessions).
   */
  getStats(streamId: StreamId): Promise<StreamStats | null>;

  /**
   * End a stream cleanly. Implementations close the peer connection,
   * release server-side capture resources, drop the signaling channel.
   * Idempotent — calling close on an already-closed stream is a no-op.
   */
  close(streamId: StreamId): Promise<void>;
}

/** Stream registry — read-only enumeration for admin observability. */
export interface StreamRegistry {
  /** List active streams, optionally scoped to an account. */
  list(opts?: { accountId?: string; state?: StreamState }): Promise<readonly StreamStats[]>;
}
