// V-531.B-mock — mock-codec wrapper for end-to-end pipeline rehearsal.
//
// V-531.A shipped the building blocks (FrameSource interface,
// MockFrameSource, EncodePipeline with pass-through encoder). This
// wrapper composes them into a single, opinionated, drop-in
// "streaming session" the gui-client can consume as a stand-in for
// the future real-WebRTC pipeline.
//
// It is NOT a real codec — chunks carry raw frame bytes with
// codec='raw'. But it is a real *pipeline*: frames flow through the
// FrameSource → EncodePipeline → consumer in the same order +
// timing they will once `WkWebViewFrameSource` + libvpx land.
//
// Usage:
//
//   const stream = createMockEncodedStream({ targetFps: 5, durationFrames: 60 });
//   const off = stream.onChunk((chunk) => decodeAndRender(chunk));
//   await stream.start();
//   // ... later
//   off();
//   await stream.stop();

import { EncodePipeline, type EncodedChunk } from './encode-pipeline.js';
import { MockFrameSource, type FramePixelFormat, type FrameSourceConfig } from './frame-source.js';

export interface MockEncodedStreamOpts {
  /** Target FPS. Default 5 (matches LiveSessionView default cadence). */
  targetFps?: number;
  /** Frame dimensions. Default 390x844 (iPhone 16 Pro logical size). */
  targetWidth?: number;
  targetHeight?: number;
  /** Pixel format. Default 'I420'. */
  pixelFormat?: FramePixelFormat;
  /** Stop after this many frames. Default 0 (infinite — caller must stop). */
  durationFrames?: number;
  /** Keyframe interval in frames. Default 30 (≈1/s @ 30fps). */
  keyframeIntervalFrames?: number;
  /** Fill byte for the mock frame data plane (test determinism). */
  fillByte?: number;
}

export interface MockEncodedStream {
  /** Subscribe to encoded chunks. Returns an unsubscribe fn. */
  onChunk(handler: (chunk: EncodedChunk) => void): () => void;
  /** Subscribe to end-of-stream (source returned null). */
  onEnd(handler: () => void): () => void;
  /** Start the pipeline. Resolves when start() completes (NOT when stream ends). */
  start(): Promise<void>;
  /** Stop the pipeline. Idempotent. */
  stop(): Promise<void>;
  /** Current snapshot of pipeline counters. */
  getStats(): { framesIn: number; chunksOut: number; bytesOut: number };
}

/**
 * Compose a MockFrameSource + EncodePipeline into a single subscribable
 * stream. The wrapper hides the pull-loop wiring so consumers see only
 * encoded chunks + end events.
 */
export function createMockEncodedStream(opts: MockEncodedStreamOpts = {}): MockEncodedStream {
  const targetFps = opts.targetFps ?? 5;
  const config: FrameSourceConfig = {
    targetFps,
    targetWidth: opts.targetWidth ?? 390,
    targetHeight: opts.targetHeight ?? 844,
    preferredPixelFormat: opts.pixelFormat ?? 'I420',
  };
  const source = new MockFrameSource({
    fillByte: opts.fillByte,
    maxFrames: opts.durationFrames === undefined ? undefined : opts.durationFrames,
  });
  const pipeline = new EncodePipeline({
    source,
    keyframeIntervalFrames: opts.keyframeIntervalFrames,
  });

  const chunkHandlers = new Set<(chunk: EncodedChunk) => void>();
  const endHandlers = new Set<() => void>();
  pipeline.onChunk((chunk) => {
    for (const h of chunkHandlers) h(chunk);
  });
  pipeline.onEnd(() => {
    for (const h of endHandlers) h();
  });

  let runPromise: Promise<void> | null = null;
  let stopped = false;

  return {
    onChunk(handler) {
      chunkHandlers.add(handler);
      return () => chunkHandlers.delete(handler);
    },
    onEnd(handler) {
      endHandlers.add(handler);
      return () => endHandlers.delete(handler);
    },
    async start() {
      if (runPromise !== null) return;
      await source.start(config);
      runPromise = pipeline.start();
      // Don't await — caller polls onChunk/onEnd. Catch unhandled rejections.
      runPromise.catch(() => {});
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      pipeline.stop();
      await source.stop();
      // Give the pipeline loop a chance to observe the stopped state.
      if (runPromise !== null) {
        await Promise.race([runPromise, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
      }
    },
    getStats() {
      const s = pipeline.getStats();
      return { framesIn: s.framesIn, chunksOut: s.chunksOut, bytesOut: s.bytesOut };
    },
  };
}
