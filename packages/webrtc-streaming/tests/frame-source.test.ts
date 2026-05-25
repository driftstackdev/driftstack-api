// Unit coverage for MockFrameSource (frame-source.ts). The synthetic
// source is what the encode-pipeline tests build on, so its frame-size
// math, sequence numbering, timestamp cadence, and state guards must be
// correct — a wrong plane-size here would silently invalidate every
// downstream codec assertion. frame-source.ts previously had no direct
// test.

import { describe, expect, it } from 'vitest';
import { MockFrameSource, type FrameSourceConfig } from '../src/index.js';

const I420_CONFIG: FrameSourceConfig = {
  targetFps: 30,
  targetWidth: 320,
  targetHeight: 240,
  preferredPixelFormat: 'I420',
};

describe('MockFrameSource', () => {
  it('start() → running; pullNextFrame emits monotonically increasing sequence from 1', async () => {
    const src = new MockFrameSource();
    expect(src.getState()).toBe('idle');
    await src.start(I420_CONFIG);
    expect(src.getState()).toBe('running');

    const f1 = await src.pullNextFrame();
    const f2 = await src.pullNextFrame();
    const f3 = await src.pullNextFrame();
    expect(f1?.sequence).toBe(1);
    expect(f2?.sequence).toBe(2);
    expect(f3?.sequence).toBe(3);
  });

  it('allocates frame data at 1.5×pixels for planar 4:2:0 (I420/NV12)', async () => {
    const pixels = 320 * 240;
    for (const fmt of ['I420', 'NV12'] as const) {
      const src = new MockFrameSource();
      await src.start({ ...I420_CONFIG, preferredPixelFormat: fmt });
      const frame = await src.pullNextFrame();
      expect(frame?.pixelFormat).toBe(fmt);
      expect(frame?.data.length).toBe(Math.floor(pixels * 1.5));
    }
  });

  it('allocates frame data at 4×pixels for packed formats (BGRA/RGBA)', async () => {
    const pixels = 320 * 240;
    for (const fmt of ['BGRA', 'RGBA'] as const) {
      const src = new MockFrameSource();
      await src.start({ ...I420_CONFIG, preferredPixelFormat: fmt });
      const frame = await src.pullNextFrame();
      expect(frame?.data.length).toBe(pixels * 4);
    }
  });

  it('advances the capture timestamp by floor(1e6 / targetFps) between frames', async () => {
    const src = new MockFrameSource();
    await src.start(I420_CONFIG);
    const f1 = await src.pullNextFrame();
    const f2 = await src.pullNextFrame();
    expect((f2?.timestampMicros ?? 0) - (f1?.timestampMicros ?? 0)).toBe(
      Math.floor(1_000_000 / 30),
    );
  });

  it('fills the data plane with the configured fill byte (default 0x80)', async () => {
    const def = new MockFrameSource();
    await def.start(I420_CONFIG);
    const defFrame = await def.pullNextFrame();
    expect(defFrame?.data.every((b) => b === 0x80)).toBe(true);

    const custom = new MockFrameSource({ fillByte: 0xff });
    await custom.start(I420_CONFIG);
    const customFrame = await custom.pullNextFrame();
    expect(customFrame?.data.every((b) => b === 0xff)).toBe(true);
  });

  it('honours the maxFrames cap then returns null', async () => {
    const src = new MockFrameSource({ maxFrames: 2 });
    await src.start(I420_CONFIG);
    expect(await src.pullNextFrame()).not.toBeNull();
    expect(await src.pullNextFrame()).not.toBeNull();
    expect(await src.pullNextFrame()).toBeNull();
  });

  it('returns null when pulled before start or after stop, and reports state', async () => {
    const src = new MockFrameSource();
    expect(await src.pullNextFrame()).toBeNull(); // before start

    await src.start(I420_CONFIG);
    expect(await src.pullNextFrame()).not.toBeNull();

    await src.stop();
    expect(src.getState()).toBe('stopped');
    expect(await src.pullNextFrame()).toBeNull(); // after stop
  });

  it('restart resets the sequence counter to 1', async () => {
    const src = new MockFrameSource();
    await src.start(I420_CONFIG);
    expect((await src.pullNextFrame())?.sequence).toBe(1);
    expect((await src.pullNextFrame())?.sequence).toBe(2);
    await src.stop();
    await src.start(I420_CONFIG);
    expect((await src.pullNextFrame())?.sequence).toBe(1);
  });
});
