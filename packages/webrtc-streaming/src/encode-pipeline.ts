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
    this.keyframeIntervalFrames = opts.keyframeIntervalFrames ?? 30;
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
   */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`EncodePipeline.start: invalid state ${this.state}`);
    }
    this.state = 'running';
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
      this.chunkHandler?.(chunk);
    }
    this.endHandler?.();
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
