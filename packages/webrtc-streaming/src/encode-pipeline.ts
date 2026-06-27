// V-531 — server-side encode pipeline.
//
// Consumes frames from a `FrameSource` and produces encoded chunks ready
// for WebRTC track delivery. This wave (V-531.A) ships the pipeline shell
// + a pass-through "raw" encoder so the pipeline is end-to-end testable
// against the MockFrameSource without pulling in a real codec dependency
// (libvpx / openh264). Real codec wiring lands as V-531.B (later wave).

import type { FrameSource, VideoFrame } from './frame-source.js';

/** A single encoded chunk produced by the pipeline. */
export interface EncodedChunk {
  /** Sequence number matching the input frame. */
  sequence: number;
  /** Capture timestamp from the input frame. */
  timestampMicros: number;
  /** Codec used. 'raw' = pass-through (test mode). */
  codec: 'raw' | 'h264' | 'vp8' | 'vp9' | 'av1';
  /** Encoded payload bytes. */
  payload: Uint8Array;
  /** Whether this chunk is a keyframe / IDR. */
  isKeyframe: boolean;
}

export interface EncodePipelineStats {
  framesIn: number;
  chunksOut: number;
  bytesOut: number;
  /** Frames the source returned null for (end-of-stream / stopped). */
  framesDropped: number;
}

export interface EncodePipelineOpts {
  source: FrameSource;
  /**
   * Keyframe interval in frames. Every Nth chunk is marked as a keyframe.
   * Default 30 (≈ 1 keyframe per second at 30 fps).
   */
  keyframeIntervalFrames?: number;
}

/**
 * Server-side encode pipeline. Pulls frames from the source, runs them
 * through the encoder, and emits encoded chunks via callback.
 *
 * V-531.A pass-through behaviour: chunks carry the raw frame bytes
 * unchanged with codec='raw'. This is sufficient to test:
 *   - Frame → chunk sequence correctness.
 *   - Keyframe interval marking.
 *   - End-of-stream handling.
 *   - Stop / drain semantics.
 *
 * V-531.B will swap in real encoders behind the same surface.
 */
export class EncodePipeline {
  private readonly source: FrameSource;
  private readonly keyframeIntervalFrames: number;
  private state: 'idle' | 'running' | 'stopped' = 'idle';
  private chunkHandler: ((chunk: EncodedChunk) => void) | null = null;
  private endHandler: (() => void) | null = null;
  private stats: EncodePipelineStats = {
    framesIn: 0,
    chunksOut: 0,
    bytesOut: 0,
    framesDropped: 0,
  };

  constructor(opts: EncodePipelineOpts) {
    this.source = opts.source;
    const keyframeIntervalFrames = opts.keyframeIntervalFrames ?? 30;
    // The interval indexes integer modulo ((sequence - 1) % N) for the
    // keyframe marker. N = 0 makes `% 0` → NaN, so NO frame is ever
    // marked a keyframe — a silently keyframeless, undecodable stream;
    // negative or non-integer N marks frames nonsensically. Require a
    // positive integer.
    if (!Number.isInteger(keyframeIntervalFrames) || keyframeIntervalFrames < 1) {
      throw new Error(
        `EncodePipeline: keyframeIntervalFrames must be a positive integer (got ${keyframeIntervalFrames})`,
      );
    }
    this.keyframeIntervalFrames = keyframeIntervalFrames;
  }

  onChunk(handler: (chunk: EncodedChunk) => void): void {
    this.chunkHandler = handler;
  }

  onEnd(handler: () => void): void {
    this.endHandler = handler;
  }

  /**
   * Start the pipeline. Runs an internal pull loop until the source returns
   * null or `stop()` is called.
   *
   * Teardown is guaranteed on EVERY exit path — normal end-of-stream, an
   * external `stop()`, OR a throw from the chunk consumer: the loop body's
   * consumer call is wrapped so one throwing subscriber can't abort the loop
   * while leaking the FrameSource and skipping `onEnd`. On any exit the source
   * is released (`source.stop()`, idempotent) and the end handler fires exactly
   * once. A consumer throw is still propagated to the caller AFTER cleanup, so
   * the failure is observable (the mock-codec wrapper's `runPromise.catch`
   * surfaces it) rather than silently dropped.
   */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`EncodePipeline.start: invalid state ${this.state}`);
    }
    this.state = 'running';
    try {
      while (this.state === 'running') {
        const frame = await this.source.pullNextFrame();
        if (frame === null) {
          this.stats.framesDropped += 1;
          this.state = 'stopped';
          break;
        }
        this.stats.framesIn += 1;
        const chunk = this.encode(frame);
        this.stats.chunksOut += 1;
        this.stats.bytesOut += chunk.payload.byteLength;
        // A throwing consumer must NOT abort the loop without cleanup. Mark
        // the pipeline stopped and re-throw so `finally` runs teardown
        // (release source + fire onEnd) before the error propagates.
        try {
          this.chunkHandler?.(chunk);
        } catch (err) {
          this.state = 'stopped';
          throw err;
        }
      }
    } finally {
      // Release the FrameSource on every exit path (idempotent stop()), then
      // fire the end handler exactly once. Guard the source release so a
      // failing stop() can't itself suppress onEnd.
      this.state = 'stopped';
      try {
        await this.source.stop();
      } finally {
        this.endHandler?.();
      }
    }
  }

  stop(): void {
    this.state = 'stopped';
  }

  getStats(): EncodePipelineStats {
    return { ...this.stats };
  }

  getState(): 'idle' | 'running' | 'stopped' {
    return this.state;
  }

  private encode(frame: VideoFrame): EncodedChunk {
    // Mark every Nth frame starting from the first. `(sequence - 1) % N === 0`
    // is correct for all N: N=1 (intra-only) marks every frame, and for N>=2
    // it reduces to the same keyframes (1, N+1, 2N+1, ...) the prior
    // `sequence % N === 1` form produced. The old form silently broke N=1
    // (`sequence % 1` is always 0, so only the first frame was a keyframe).
    const isKeyframe = (frame.sequence - 1) % this.keyframeIntervalFrames === 0;
    return {
      sequence: frame.sequence,
      timestampMicros: frame.timestampMicros,
      codec: 'raw',
      payload: frame.data,
      isKeyframe,
    };
  }
}
