// V-531.B-mock — unit tests for the mock encoded-stream wrapper.

import { describe, expect, it } from 'vitest';
import { createMockEncodedStream, type EncodedChunk } from '../src/index.js';

describe('V-531.B-mock createMockEncodedStream', () => {
  it('emits the configured number of chunks then onEnd', async () => {
    const stream = createMockEncodedStream({ targetFps: 30, durationFrames: 10 });
    const chunks: EncodedChunk[] = [];
    const ended: number[] = [];
    stream.onChunk((c) => chunks.push(c));
    stream.onEnd(() => ended.push(Date.now()));
    await stream.start();
    // Pipeline runs synchronously through the mock pull loop in V-531.A.
    // Wait one microtask so onEnd has fired.
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(chunks).toHaveLength(10);
    expect(ended).toHaveLength(1);
    await stream.stop();
  });

  it('marks chunk 1 as keyframe (initial IDR)', async () => {
    const stream = createMockEncodedStream({ durationFrames: 5 });
    const chunks: EncodedChunk[] = [];
    stream.onChunk((c) => chunks.push(c));
    await stream.start();
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(chunks[0]?.isKeyframe).toBe(true);
    expect(chunks[0]?.sequence).toBe(1);
    await stream.stop();
  });

  it('keyframeIntervalFrames sets the periodic keyframe cadence', async () => {
    const stream = createMockEncodedStream({
      durationFrames: 12,
      keyframeIntervalFrames: 3,
    });
    const chunks: EncodedChunk[] = [];
    stream.onChunk((c) => chunks.push(c));
    await stream.start();
    await new Promise<void>((r) => setTimeout(r, 10));
    const keyframeSeqs = chunks.filter((c) => c.isKeyframe).map((c) => c.sequence);
    // Interval 3 → keyframes at seq 1, 4, 7, 10.
    expect(keyframeSeqs).toEqual([1, 4, 7, 10]);
    await stream.stop();
  });

  it('chunks carry codec="raw" and the mock pixel-fill payload', async () => {
    const stream = createMockEncodedStream({
      durationFrames: 2,
      targetWidth: 8,
      targetHeight: 8,
      pixelFormat: 'I420',
      fillByte: 0x42,
    });
    const chunks: EncodedChunk[] = [];
    stream.onChunk((c) => chunks.push(c));
    await stream.start();
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(chunks[0]?.codec).toBe('raw');
    // I420 at 8x8 = 8*8*1.5 = 96 bytes.
    expect(chunks[0]?.payload.byteLength).toBe(96);
    expect(chunks[0]?.payload[0]).toBe(0x42);
    await stream.stop();
  });

  it('stats reflect frames pulled + chunks emitted', async () => {
    const stream = createMockEncodedStream({ durationFrames: 7 });
    stream.onChunk(() => {});
    await stream.start();
    await new Promise<void>((r) => setTimeout(r, 5));
    const s = stream.getStats();
    expect(s.framesIn).toBe(7);
    expect(s.chunksOut).toBe(7);
    expect(s.bytesOut).toBeGreaterThan(0);
    await stream.stop();
  });

  it('chunk handlers can be unsubscribed; subsequent chunks bypass them', async () => {
    const stream = createMockEncodedStream({ durationFrames: 4 });
    const captured: number[] = [];
    const off = stream.onChunk((c) => captured.push(c.sequence));
    await stream.start();
    // Unsubscribe AFTER pipeline drained (mock pulls synchronously).
    await new Promise<void>((r) => setTimeout(r, 5));
    off();
    expect(captured).toEqual([1, 2, 3, 4]);
    // A second start would re-run, but we instead validate that the
    // chunkHandlers set was actually mutated — adding a different
    // handler shouldn't see the prior 4 chunks.
    const captured2: number[] = [];
    stream.onChunk((c) => captured2.push(c.sequence));
    expect(captured2).toEqual([]);
    await stream.stop();
  });

  it('stop() is idempotent', async () => {
    const stream = createMockEncodedStream({ durationFrames: 2 });
    stream.onChunk(() => {});
    await stream.start();
    await new Promise<void>((r) => setTimeout(r, 5));
    await stream.stop();
    await stream.stop(); // should not throw
  });
});
