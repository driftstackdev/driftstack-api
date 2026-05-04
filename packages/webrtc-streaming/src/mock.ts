// V-149 — mock WebRTC streaming service.
//
// Deterministic outputs so tests can assert exact shape without
// timing flakiness. Real production implementation runs on the Mac
// mini fleet with browser-side WebRTC peer connections.

import type {
  CreateStreamOpts,
  CreateStreamResult,
  StreamRegistry,
  WebRtcStreamingService,
} from './interfaces.js';
import type {
  IceCandidate,
  SdpPayload,
  StreamEvent,
  StreamId,
  StreamStats,
  StreamState,
} from './types.js';

interface MockStreamState {
  streamId: StreamId;
  sessionId: string;
  state: StreamState;
  createdAtMs: number;
  subscribers: Set<(event: StreamEvent) => void>;
}

const FAKE_OFFER_SDP =
  'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';

export class MockWebRtcStreamingService implements WebRtcStreamingService, StreamRegistry {
  private readonly streams = new Map<StreamId, MockStreamState>();
  private nextSeq = 1;
  private nowMs = 1714867200000;

  /** Test seam: advance the deterministic clock. */
  advanceClock(deltaMs: number): void {
    this.nowMs += deltaMs;
  }

  createStream(opts: CreateStreamOpts): Promise<CreateStreamResult> {
    const streamId = `mock_stream_${this.nextSeq.toString().padStart(8, '0')}`;
    this.nextSeq += 1;
    this.streams.set(streamId, {
      streamId,
      sessionId: opts.sessionId,
      state: 'connecting',
      createdAtMs: this.nowMs,
      subscribers: new Set(),
    });
    return Promise.resolve({
      streamId,
      offer: { type: 'offer', sdp: FAKE_OFFER_SDP },
    });
  }

  negotiate(streamId: StreamId, payload: SdpPayload): Promise<SdpPayload> {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return Promise.reject(new Error(`stream not found: ${streamId}`));
    }
    if (payload.type === 'answer') {
      // Caller answered our offer. Transition to connected.
      this.transition(stream, 'connected');
    }
    return Promise.resolve({ type: 'answer', sdp: FAKE_OFFER_SDP });
  }

  submitIceCandidate(streamId: StreamId, _candidate: IceCandidate): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return Promise.reject(new Error(`stream not found: ${streamId}`));
    }
    return Promise.resolve();
  }

  subscribe(streamId: StreamId, handler: (event: StreamEvent) => void): () => void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      // Subscriber to non-existent stream gets a no-op unsubscribe.
      return () => undefined;
    }
    stream.subscribers.add(handler);
    return () => {
      stream.subscribers.delete(handler);
    };
  }

  getStats(streamId: StreamId): Promise<StreamStats | null> {
    const stream = this.streams.get(streamId);
    if (!stream) return Promise.resolve(null);
    return Promise.resolve(this.snapshotStats(stream));
  }

  close(streamId: StreamId): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) return Promise.resolve();
    this.transition(stream, 'closed');
    stream.subscribers.clear();
    return Promise.resolve();
  }

  // ── StreamRegistry ────────────────────────────────────────────────

  list(
    opts: {
      accountId?: string;
      state?: StreamState;
    } = {},
  ): Promise<readonly StreamStats[]> {
    // accountId filtering is a no-op in the mock since we don't model
    // account ownership. Tests that need it pass scoped fixtures.
    const all = [...this.streams.values()].map((s) => this.snapshotStats(s));
    const filtered = opts.state === undefined ? all : all.filter((s) => s.state === opts.state);
    return Promise.resolve(filtered);
  }

  // ── helpers ───────────────────────────────────────────────────────

  private transition(stream: MockStreamState, next: StreamState): void {
    stream.state = next;
    const event: StreamEvent = { kind: 'state_changed', state: next, at: this.nowMs };
    for (const handler of stream.subscribers) {
      handler(event);
    }
  }

  private snapshotStats(stream: MockStreamState): StreamStats {
    const ageMs = this.nowMs - stream.createdAtMs;
    // Deterministic mock numbers — connected streams report 30 fps,
    // pre-connected streams report 0. Real impl reads from the peer
    // connection's RTCStatsReport.
    const fpsAvg = stream.state === 'connected' ? 30 : 0;
    return {
      streamId: stream.streamId,
      state: stream.state,
      ageMs,
      framesSent: Math.floor((ageMs / 1000) * fpsAvg),
      fpsAvg,
      bitrateKbpsAvg: stream.state === 'connected' ? 1500 : 0,
      rttMs: stream.state === 'connected' ? 35 : null,
      packetLossFraction: 0,
    };
  }
}
