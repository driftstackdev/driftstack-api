// @driftstack/webrtc-streaming public surface.

export type {
  IceCandidate,
  IceServer,
  SdpPayload,
  StreamConfig,
  StreamEvent,
  StreamId,
  StreamState,
  StreamStats,
} from './types.js';

export type {
  CreateStreamOpts,
  CreateStreamResult,
  StreamRegistry,
  WebRtcStreamingService,
} from './interfaces.js';

export { MockWebRtcStreamingService } from './mock.js';
