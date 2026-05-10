// V-531 — frame source interface (cross-agent contract).
//
// This is the contract between this repo (driftstack-api control plane) and
// the WebKit fork (Agent 1's scope). The WebKit fork implements
// `WkWebViewFrameSource` on the harness side — extracting frames from a
// WKWebView's surface — and ships them across the IPC boundary to the
// control plane's encode pipeline (see `encode-pipeline.ts`).
//
// Document at `docs/internal/v531-cross-agent-contract.md` describes the
// IPC envelope; this file is the language-level interface the server-side
// pipeline depends on.
//
// V-530-style real-implementation work; V-531.A this wave covers the
// interface + a mock implementation + the server-side encode pipeline
// (next file). The real `WkWebViewFrameSource` lands in the WebKit fork
// in coordination with Agent 1.

/** Pixel format the frame source emits. */
export type FramePixelFormat = 'I420' | 'NV12' | 'BGRA' | 'RGBA';

/** A single video frame from a frame source. */
export interface VideoFrame {
  /**
   * Wall-clock capture timestamp in microseconds (matches WebRTC's
   * `RTCRtpScriptTransformer` timestamp resolution).
   */
  timestampMicros: number;
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** Pixel format of `data`. */
  pixelFormat: FramePixelFormat;
  /**
   * Raw pixel data. For planar formats (I420 / NV12) the planes are
   * concatenated in standard order (Y, then U, then V; or Y, then UV
   * interleaved). For packed formats (BGRA / RGBA) one buffer holds the
   * interleaved pixels.
   */
  data: Uint8Array;
  /**
   * Per-frame sequence number (monotonically increasing from 1 within a
   * single FrameSource.start() lifetime). Resets on stop+restart.
   */
  sequence: number;
}

/** Configuration for starting a frame source. */
export interface FrameSourceConfig {
  /** Target frame rate in frames per second. */
  targetFps: number;
  /** Target width in pixels. The source may degrade to a smaller size. */
  targetWidth: number;
  /** Target height in pixels. */
  targetHeight: number;
  /** Preferred pixel format. Implementations may fall back. */
  preferredPixelFormat: FramePixelFormat;
}

/**
 * Frame source interface. Implementations:
 *
 *   1. `MockFrameSource` (this file) — synthetic frames for solo testing.
 *   2. `WkWebViewFrameSource` (WebKit fork; Agent 1 scope) — real frames
 *      from a WKWebView surface via the IPC envelope in V-531 cross-agent
 *      contract doc.
 *
 * Cross-agent compatibility constraint: the interface contract here MUST
 * match the IPC envelope shape. Changes to this interface require a
 * coordinated change to the WebKit-fork implementation in the same wave.
 */
export interface FrameSource {
  /** Begin emitting frames. Resolves once the source is ready. */
  start(config: FrameSourceConfig): Promise<void>;

  /**
   * Pull the next frame. Returns null if the source has been stopped or
   * has hit end-of-stream (e.g. WKWebView closed). The consumer drives the
   * pull rate — the source emits at most one frame per pull regardless of
   * how many frames the underlying surface has produced.
   */
  pullNextFrame(): Promise<VideoFrame | null>;

  /** Stop emitting frames + release resources. Idempotent. */
  stop(): Promise<void>;

  /** Current state. */
  getState(): 'idle' | 'starting' | 'running' | 'stopped' | 'failed';
}

/**
 * Synthetic frame source for solo testing of the server-side encode
 * pipeline. Produces deterministic frames at the configured rate without
 * any actual WKWebView dependency.
 *
 * Frame data is a solid colour fill (configurable) so byte counts and
 * shape assertions in tests are predictable. Real frames carry pixel-
 * complexity, which downstream codec tests will exercise separately.
 */
export class MockFrameSource implements FrameSource {
  private state: 'idle' | 'starting' | 'running' | 'stopped' | 'failed' = 'idle';
  private nextSequence = 1;
  private config: FrameSourceConfig | null = null;
  private nowMicros = 1_714_867_200_000_000; // deterministic start

  constructor(
    private readonly options: {
      /** Fixed byte value for the data plane (test determinism). */
      fillByte?: number;
      /** Cap on total frames produced (then pullNextFrame returns null). */
      maxFrames?: number;
    } = {},
  ) {}

  start(config: FrameSourceConfig): Promise<void> {
    this.config = config;
    this.state = 'running';
    this.nextSequence = 1;
    return Promise.resolve();
  }

  pullNextFrame(): Promise<VideoFrame | null> {
    if (this.state !== 'running' || this.config === null) {
      return Promise.resolve(null);
    }
    if (this.options.maxFrames !== undefined && this.nextSequence > this.options.maxFrames) {
      return Promise.resolve(null);
    }

    const config = this.config;
    const fill = this.options.fillByte ?? 0x80;
    const data = this.allocateFrameData(config);
    data.fill(fill);

    const frame: VideoFrame = {
      timestampMicros: this.nowMicros,
      width: config.targetWidth,
      height: config.targetHeight,
      pixelFormat: config.preferredPixelFormat,
      data,
      sequence: this.nextSequence,
    };

    this.nextSequence += 1;
    this.nowMicros += Math.floor(1_000_000 / config.targetFps);
    return Promise.resolve(frame);
  }

  stop(): Promise<void> {
    this.state = 'stopped';
    return Promise.resolve();
  }

  getState(): 'idle' | 'starting' | 'running' | 'stopped' | 'failed' {
    return this.state;
  }

  /** Test seam: advance the deterministic clock by N microseconds. */
  advanceClockMicros(deltaMicros: number): void {
    this.nowMicros += deltaMicros;
  }

  private allocateFrameData(config: FrameSourceConfig): Uint8Array {
    const pixels = config.targetWidth * config.targetHeight;
    switch (config.preferredPixelFormat) {
      case 'I420':
      case 'NV12':
        // Y plane + chroma at half resolution (4:2:0). Total bytes = 1.5 * pixels.
        return new Uint8Array(Math.floor(pixels * 1.5));
      case 'BGRA':
      case 'RGBA':
        return new Uint8Array(pixels * 4);
    }
  }
}
