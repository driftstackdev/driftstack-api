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

export type {
  FramePixelFormat,
  FrameSource,
  FrameSourceConfig,
  VideoFrame,
} from './frame-source.js';
export { MockFrameSource } from './frame-source.js';

export type { EncodedChunk, EncodePipelineOpts, EncodePipelineStats } from './encode-pipeline.js';
export { EncodePipeline } from './encode-pipeline.js';

export type { MockEncodedStream, MockEncodedStreamOpts } from './mock-codec-wrapper.js';
export { createMockEncodedStream } from './mock-codec-wrapper.js';
