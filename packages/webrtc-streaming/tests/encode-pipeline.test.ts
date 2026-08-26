import { describe, expect, it } from 'vitest';
import {
  EncodePipeline,
  MockFrameSource,
  type EncodedChunk,
  type FrameSource,
  type FrameSourceConfig,
  type VideoFrame,
} from '../src/index.js';

/** A FrameSource that records whether stop() was called — to assert the
 *  pipeline releases the source on every teardown path. */
class StopTrackingFrameSource implements FrameSource {
  stopCalls = 0;
  constructor(private readonly inner: MockFrameSource) {}
  start(config: FrameSourceConfig): Promise<void> {
    return this.inner.start(config);
  }
  pullNextFrame(): Promise<VideoFrame | null> {
    return this.inner.pullNextFrame();
  }
  stop(): Promise<void> {
    this.stopCalls += 1;
    return this.inner.stop();
  }
  getState(): 'idle' | 'starting' | 'running' | 'stopped' | 'failed' {
    return this.inner.getState();
  }
}

const STD_CONFIG: FrameSourceConfig = {
  targetFps: 30,
  targetWidth: 320,
  targetHeight: 240,
  preferredPixelFormat: 'I420',
};

describe('V-531.A MockFrameSource', () => {
  it('emits sequential frames with monotonic sequence + timestamp', async () => {
    const source = new MockFrameSource({ maxFrames: 5 });
    await source.start(STD_CONFIG);

    const frames = [];
    for (let i = 0; i < 5; i += 1) {
      const f = await source.pullNextFrame();
      expect(f).not.toBeNull();
      frames.push(f!);
    }
    for (let i = 0; i < frames.length; i += 1) {
      expect(frames[i]!.sequence).toBe(i + 1);
    }
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i]!.timestampMicros).toBeGreaterThan(frames[i - 1]!.timestampMicros);
    }
  });

  it('returns null after maxFrames is reached', async () => {
    const source = new MockFrameSource({ maxFrames: 3 });
    await source.start(STD_CONFIG);
    for (let i = 0; i < 3; i += 1) {
      expect(await source.pullNextFrame()).not.toBeNull();
    }
    expect(await source.pullNextFrame()).toBeNull();
    expect(await source.pullNextFrame()).toBeNull();
  });

  it('respects the configured pixel format byte budget', async () => {
    for (const [format, expectedBytes] of [
      ['I420', 320 * 240 * 1.5],
      ['NV12', 320 * 240 * 1.5],
      ['BGRA', 320 * 240 * 4],
      ['RGBA', 320 * 240 * 4],
    ] as const) {
      const source = new MockFrameSource({ maxFrames: 1 });
      await source.start({ ...STD_CONFIG, preferredPixelFormat: format });
      const frame = await source.pullNextFrame();
      expect(frame).not.toBeNull();
      expect(frame!.data.byteLength).toBe(Math.floor(expectedBytes));
      expect(frame!.pixelFormat).toBe(format);
    }
  });

  it('returns null when not started', async () => {
    const source = new MockFrameSource();
    expect(await source.pullNextFrame()).toBeNull();
  });

  it('returns null after stop()', async () => {
    const source = new MockFrameSource({ maxFrames: 10 });
    await source.start(STD_CONFIG);
    expect(await source.pullNextFrame()).not.toBeNull();
    await source.stop();
    expect(await source.pullNextFrame()).toBeNull();
  });

  it('fillByte option fills the frame data uniformly', async () => {
    const source = new MockFrameSource({ maxFrames: 1, fillByte: 0xab });
    await source.start(STD_CONFIG);
    const frame = await source.pullNextFrame();
    expect(frame!.data.every((b) => b === 0xab)).toBe(true);
  });
});

describe('V-531.A EncodePipeline', () => {
  it('emits one chunk per frame', async () => {
    const source = new MockFrameSource({ maxFrames: 5 });
    await source.start(STD_CONFIG);
    const pipeline = new EncodePipeline({ source });
    const chunks: EncodedChunk[] = [];
    pipeline.onChunk((c) => chunks.push(c));
    await pipeline.start();
    expect(chunks).toHaveLength(5);
    expect(pipeline.getStats().chunksOut).toBe(5);
  });

  it('chunk sequence numbers match frame sequence numbers', async () => {
    const source = new MockFrameSource({ maxFrames: 10 });
    await source.start(STD_CONFIG);
    const pipeline = new EncodePipeline({ source });
    const chunks: EncodedChunk[] = [];
    pipeline.onChunk((c) => chunks.push(c));
    await pipeline.start();
    for (let i = 0; i < chunks.length; i += 1) {
      expect(chunks[i]!.sequence).toBe(i + 1);
    }
  });

  it('marks first chunk + every Nth chunk as a keyframe', async () => {
    const source = new MockFrameSource({ maxFrames: 65 });
    await source.start(STD_CONFIG);
    const pipeline = new EncodePipeline({ source, keyframeIntervalFrames: 30 });
    const chunks: EncodedChunk[] = [];
    pipeline.onChunk((c) => chunks.push(c));
    await pipeline.start();
    // Keyframes at seq 1, 31, 61.
    expect(chunks[0]!.isKeyframe).toBe(true);
    expect(chunks[30]!.isKeyframe).toBe(true);
    expect(chunks[60]!.isKeyframe).toBe(true);
    // Non-keyframes at seq 2..30, 32..60, 62..65.
    expect(chunks[1]!.isKeyframe).toBe(false);
    expect(chunks[29]!.isKeyframe).toBe(false);
    expect(chunks[31]!.isKeyframe).toBe(false);
    expect(chunks[59]!.isKeyframe).toBe(false);
    expect(chunks[61]!.isKeyframe).toBe(false);
  });

  it('keyframeIntervalFrames=1 marks every chunk as a keyframe (intra-only)', async () => {
    const source = new MockFrameSource({ maxFrames: 8 });
    await source.start(STD_CONFIG);
    const pipeline = new EncodePipeline({ source, keyframeIntervalFrames: 1 });
    const chunks: EncodedChunk[] = [];
    pipeline.onChunk((c) => chunks.push(c));
    await pipeline.start();
    expect(chunks).toHaveLength(8);
    expect(chunks.every((c) => c.isKeyframe)).toBe(true);
  });

  it('rejects a non-positive or non-integer keyframeIntervalFrames (0 → NaN modulo → keyframeless stream)', () => {
    const source = new MockFrameSource({ maxFrames: 1 });
    expect(() => new EncodePipeline({ source, keyframeIntervalFrames: 0 })).toThrow(
      /keyframeIntervalFrames must be a positive integer/,
    );
    expect(() => new EncodePipeline({ source, keyframeIntervalFrames: -5 })).toThrow(
      /keyframeIntervalFrames must be a positive integer/,
    );
    expect(() => new EncodePipeline({ source, keyframeIntervalFrames: 1.5 })).toThrow(
      /keyframeIntervalFrames must be a positive integer/,
    );
  });

  it('calls onEnd when the source drains', async () => {
    const source = new MockFrameSource({ maxFrames: 3 });
    await source.start(STD_CONFIG);
    const pipeline = new EncodePipeline({ source });
    let endCalled = false;
    pipeline.onEnd(() => {
      endCalled = true;
    });
    await pipeline.start();
    expect(endCalled).toBe(true);
    expect(pipeline.getState()).toBe('stopped');
  });

  it('releases the FrameSource on normal end-of-stream', async () => {
    const source = new StopTrackingFrameSource(new MockFrameSource({ maxFrames: 3 }));
    await source.start(STD_CONFIG);
    const pipeline = new EncodePipeline({ source });
    await pipeline.start();
    expect(source.stopCalls).toBeGreaterThanOrEqual(1);
  });

  it('a throwing chunk consumer releases the source + fires onEnd, then surfaces the error', async () => {
    // Regression: a throw from the consumer must NOT abort the pull loop while
    // leaking the FrameSource and skipping onEnd. Teardown (release + onEnd)
    // must run, and the error must still propagate so it is observable.
    const source = new StopTrackingFrameSource(new MockFrameSource({ maxFrames: 10 }));
    await source.start(STD_CONFIG);
    const pipeline = new EncodePipeline({ source });
    let endCalled = false;
    pipeline.onEnd(() => {
      endCalled = true;
    });
    pipeline.onChunk(() => {
      throw new Error('consumer boom');
    });
    await expect(pipeline.start()).rejects.toThrow(/consumer boom/);
    expect(endCalled).toBe(true); // onEnd fired despite the throw
    expect(source.stopCalls).toBeGreaterThanOrEqual(1); // FrameSource released
    expect(pipeline.getState()).toBe('stopped');
  });

  it('stop() halts processing mid-stream', async () => {
    const source = new MockFrameSource({ maxFrames: 100 });
    await source.start(STD_CONFIG);
    const pipeline = new EncodePipeline({ source });
    let chunkCount = 0;
    pipeline.onChunk(() => {
      chunkCount += 1;
      if (chunkCount === 5) pipeline.stop();
    });
    await pipeline.start();
    // The pull-loop is synchronous-on-resolved-promise per tick — stop()
    // takes effect after the current iteration. Allow ±1 for the
    // race-free implementation.
    expect(chunkCount).toBeGreaterThanOrEqual(5);
    expect(chunkCount).toBeLessThanOrEqual(6);
  });

  it('rejects start() in non-idle state', async () => {
    const source = new MockFrameSource({ maxFrames: 1 });
    await source.start(STD_CONFIG);
    const pipeline = new EncodePipeline({ source });
    await pipeline.start();
    await expect(pipeline.start()).rejects.toThrow(/invalid state/);
  });

  it('stats track frames in + bytes out', async () => {
    const source = new MockFrameSource({ maxFrames: 4 });
    await source.start(STD_CONFIG);
    const pipeline = new EncodePipeline({ source });
    await pipeline.start();
    const stats = pipeline.getStats();
    expect(stats.framesIn).toBe(4);
    expect(stats.chunksOut).toBe(4);
    expect(stats.bytesOut).toBe(4 * Math.floor(320 * 240 * 1.5));
    expect(stats.framesDropped).toBe(1); // the terminal null pull
  });

  it('payload byte length matches frame data byte length (pass-through codec)', async () => {
    const source = new MockFrameSource({ maxFrames: 2 });
    await source.start(STD_CONFIG);
    const pipeline = new EncodePipeline({ source });
    const chunks: EncodedChunk[] = [];
    pipeline.onChunk((c) => chunks.push(c));
    await pipeline.start();
    for (const chunk of chunks) {
      expect(chunk.codec).toBe('raw');
      expect(chunk.payload.byteLength).toBe(Math.floor(320 * 240 * 1.5));
    }
  });
});
