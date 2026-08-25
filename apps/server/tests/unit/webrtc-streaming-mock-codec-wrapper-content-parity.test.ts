// W458.B — drift guard for packages/webrtc-streaming/src/mock-codec-wrapper.ts.
// V-531.B-mock end-to-end pipeline rehearsal wrapper. Drift here
// either drops the unsubscribe-return-fn contract on onChunk/onEnd
// (consumers can't remove handlers, lose memory-leak guard) or
// breaks the stop() idempotence-via-stopped-flag (consumers
// double-call stop on cleanup paths and the second call double-
// stops the source).
//
//   • V-531.B-mock framing pinned + 'V-531.A shipped the building
//     blocks (FrameSource interface, MockFrameSource, EncodePipeline
//     with pass-through encoder). This wrapper composes them into a
//     single, opinionated, drop-in "streaming session" the
//     gui-client can consume as a stand-in for the future real-
//     WebRTC pipeline.'
//   • NOT-real-codec framing pinned: 'It is NOT a real codec —
//     chunks carry raw frame bytes with codec=raw. But it is a real
//     *pipeline*: frames flow through the FrameSource →
//     EncodePipeline → consumer in the same order + timing they
//     will once WkWebViewFrameSource + libvpx land.'
//   • Usage example framing pinned (createMockEncodedStream
//     {targetFps:5, durationFrames:60} + onChunk + start + off +
//     stop).
//   • MockEncodedStreamOpts: 7 optional fields (targetFps default 5
//     'matches LiveSessionView default cadence' + targetWidth 390 +
//     targetHeight 844 'iPhone 16 Pro logical size' + pixelFormat
//     'I420' + durationFrames default 0 'infinite — caller must
//     stop' + keyframeIntervalFrames default 30 '≈1/s @ 30fps' +
//     fillByte 'test determinism').
//   • MockEncodedStream: 5 methods (onChunk + onEnd + start
//     'Resolves when start() completes (NOT when stream ends)' +
//     stop 'Idempotent' + getStats {framesIn + chunksOut + bytesOut}).
//   • createMockEncodedStream defaults: targetFps:5 + 390x844 +
//     I420 + maxFrames via durationFrames undefined-coalesce.
//   • Handler sets: chunkHandlers + endHandlers; pipeline.onChunk
//     iterates handler set.
//   • start: idempotent via runPromise !== null check; awaits
//     source.start(config); pipeline.start() not awaited + catch
//     unhandled rejections.
//   • stop: idempotent via stopped flag; pipeline.stop + source.stop;
//     races runPromise vs 50ms setTimeout 'Give the pipeline loop a
//     chance to observe the stopped state.'

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/webrtc-streaming/src/mock-codec-wrapper.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W458.B packages/webrtc-streaming/src/mock-codec-wrapper.ts content parity', () => {
  const body = read(LIB);

  it("V-531.B-mock framing pinned: 'V-531.B-mock — mock-codec wrapper for end-to-end pipeline rehearsal.' + 'V-531.A shipped the building blocks (FrameSource interface, MockFrameSource, EncodePipeline with pass-through encoder). This wrapper composes them into a single, opinionated, drop-in \"streaming session\" the gui-client can consume as a stand-in for the future real-WebRTC pipeline.'", () => {
    expect(body).toMatch(
      /\/\/ V-531\.B-mock — mock-codec wrapper for end-to-end pipeline rehearsal\./,
    );
    expect(body).toMatch(
      /\/\/ V-531\.A shipped the building blocks \(FrameSource interface,\s*\/\/ MockFrameSource, EncodePipeline with pass-through encoder\)\. This\s*\/\/ wrapper composes them into a single, opinionated, drop-in\s*\/\/ "streaming session" the gui-client can consume as a stand-in for\s*\/\/ the future real-WebRTC pipeline\./,
    );
  });

  it("NOT-real-codec framing pinned: 'It is NOT a real codec — chunks carry raw frame bytes with codec=raw. But it is a real *pipeline*: frames flow through the FrameSource → EncodePipeline → consumer in the same order + timing they will once WkWebViewFrameSource + libvpx land.'", () => {
    expect(body).toMatch(
      /\/\/ It is NOT a real codec — chunks carry raw frame bytes with\s*\/\/ codec='raw'\. But it is a real \*pipeline\*: frames flow through the\s*\/\/ FrameSource → EncodePipeline → consumer in the same order \+\s*\/\/ timing they will once `WkWebViewFrameSource` \+ libvpx land\./,
    );
  });

  it('Usage example framing pinned: createMockEncodedStream + onChunk + decodeAndRender + start + off() + stop', () => {
    expect(body).toMatch(
      /\/\/\s*const stream = createMockEncodedStream\(\{ targetFps: 5, durationFrames: 60 \}\);\s*\/\/\s*const off = stream\.onChunk\(\(chunk\) => decodeAndRender\(chunk\)\);\s*\/\/\s*await stream\.start\(\);[\s\S]*?\/\/\s*off\(\);\s*\/\/\s*await stream\.stop\(\);/,
    );
  });

  it("MockEncodedStreamOpts: 7 optional fields with defaults (targetFps default 5 'matches LiveSessionView default cadence' + targetWidth default 390 + targetHeight default 844 'iPhone 16 Pro logical size' + pixelFormat default I420 + durationFrames default 0 'infinite — caller must stop' + keyframeIntervalFrames default 30 '≈1/s @ 30fps' + fillByte 'test determinism')", () => {
    expect(body).toMatch(
      /\/\*\* Target FPS\. Default 5 \(matches LiveSessionView default cadence\)\. \*\/\s*targetFps\?: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Frame dimensions\. Default 390x844 \(iPhone 16 Pro logical size\)\. \*\/\s*targetWidth\?: number;\s*targetHeight\?: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Pixel format\. Default 'I420'\. \*\/\s*pixelFormat\?: FramePixelFormat;/,
    );
    expect(body).toMatch(
      /\/\*\* Stop after this many frames\. Default 0 \(infinite — caller must stop\)\. \*\/\s*durationFrames\?: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Keyframe interval in frames\. Default 30 \(≈1\/s @ 30fps\)\. \*\/\s*keyframeIntervalFrames\?: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Fill byte for the mock frame data plane \(test determinism\)\. \*\/\s*fillByte\?: number;/,
    );
  });

  it("MockEncodedStream: 5 methods (onChunk + onEnd 'Subscribe to end-of-stream (source returned null).' + start 'Resolves when start() completes (NOT when stream ends).' + stop 'Idempotent.' + getStats {framesIn + chunksOut + bytesOut})", () => {
    expect(body).toMatch(
      /\/\*\* Subscribe to encoded chunks\. Returns an unsubscribe fn\. \*\/\s*onChunk\(handler: \(chunk: EncodedChunk\) => void\): \(\) => void;/,
    );
    expect(body).toMatch(
      /\/\*\* Subscribe to end-of-stream \(source returned null\)\. \*\/\s*onEnd\(handler: \(\) => void\): \(\) => void;/,
    );
    expect(body).toMatch(
      /\/\*\* Start the pipeline\. Resolves when start\(\) completes \(NOT when stream ends\)\. \*\/\s*start\(\): Promise<void>;/,
    );
    expect(body).toMatch(/\/\*\* Stop the pipeline\. Idempotent\. \*\/\s*stop\(\): Promise<void>;/);
    expect(body).toMatch(
      /\/\*\* Current snapshot of pipeline counters\. \*\/\s*getStats\(\): \{ framesIn: number; chunksOut: number; bytesOut: number \};/,
    );
  });

  it("createMockEncodedStream defaults: targetFps:5 + 390x844 + I420 + maxFrames via durationFrames undefined-coalesce; framing pinned 'Compose a MockFrameSource + EncodePipeline into a single subscribable stream. The wrapper hides the pull-loop wiring so consumers see only encoded chunks + end events.'", () => {
    expect(body).toMatch(
      /\*\s*Compose a MockFrameSource \+ EncodePipeline into a single subscribable\s*\*\s*stream\. The wrapper hides the pull-loop wiring so consumers see only\s*\*\s*encoded chunks \+ end events\./,
    );
    expect(body).toMatch(
      /const config: FrameSourceConfig = \{\s*targetFps,\s*targetWidth: opts\.targetWidth \?\? 390,\s*targetHeight: opts\.targetHeight \?\? 844,\s*preferredPixelFormat: opts\.pixelFormat \?\? 'I420',\s*\};/,
    );
    expect(body).toMatch(
      /maxFrames: opts\.durationFrames === undefined \? undefined : opts\.durationFrames,/,
    );
  });

  it('Handler sets: chunkHandlers + endHandlers; pipeline.onChunk iterates handler set; onChunk + onEnd return delete-from-set unsubscribe fn', () => {
    expect(body).toMatch(/const chunkHandlers = new Set<\(chunk: EncodedChunk\) => void>\(\);/);
    expect(body).toMatch(/const endHandlers = new Set<\(\) => void>\(\);/);
    expect(body).toMatch(
      /pipeline\.onChunk\(\(chunk\) => \{\s*for \(const h of chunkHandlers\) h\(chunk\);\s*\}\);/,
    );
    expect(body).toMatch(
      /onChunk\(handler\) \{\s*chunkHandlers\.add\(handler\);\s*return \(\) => chunkHandlers\.delete\(handler\);\s*\},/,
    );
  });

  it('start: idempotent via runPromise !== null guard; rebuilds a spent source+pipeline on restart; awaits source.start(config); pipeline.start() NOT awaited + catch unhandled rejections; clears the latch on run settle (restart after natural drain)', () => {
    // restart support: source + pipeline are single-use, so a fresh pair is
    // built per run + start() after stop/end actually restarts.
    expect(body).toMatch(
      /async start\(\) \{\s*if \(runPromise !== null\) return;[\s\S]*?if \(stopped\) \{\s*current = build\(\);\s*stopped = false;\s*\}\s*await current\.source\.start\(config\);\s*const run = current\.pipeline\.start\(\);\s*runPromise = run;/,
    );
    // The run latch clears when THIS run settles, so restart works after a
    // natural drain (not just an explicit stop()).
    expect(body).toMatch(
      /run\s*\.catch\(\(\) => \{\}\)\s*\.finally\(\(\) => \{\s*if \(runPromise === run\) \{\s*runPromise = null;\s*stopped = true;/,
    );
  });

  it('build(): each run gets a FRESH MockFrameSource + EncodePipeline wired to forward into the persistent handler sets (restart/resubscribe support)', () => {
    expect(body).toMatch(
      /function build\(\): \{ source: MockFrameSource; pipeline: EncodePipeline \} \{/,
    );
    expect(body).toMatch(
      /pipeline\.onChunk\(\(chunk\) => \{\s*for \(const h of chunkHandlers\) h\(chunk\);\s*\}\);/,
    );
    expect(body).toMatch(/let current = build\(\);/);
  });

  it("stop: idempotent via stopped flag; current.pipeline.stop + await current.source.stop; framing pinned 'Give the pipeline loop a chance to observe the stopped state.' + 50ms setTimeout race; clears the run latch so a subsequent start() restarts", () => {
    expect(body).toMatch(
      /async stop\(\) \{\s*if \(stopped\) return;\s*stopped = true;\s*current\.pipeline\.stop\(\);\s*await current\.source\.stop\(\);[\s\S]*?\/\/ Give the pipeline loop a chance to observe the stopped state\.\s*if \(runPromise !== null\) \{\s*await Promise\.race\(\[runPromise, new Promise<void>\(\(resolve\) => setTimeout\(resolve, 50\)\)\]\);\s*\}\s*[\s\S]*?runPromise = null;/,
    );
  });

  it('getStats: passes through pipeline counters {framesIn + chunksOut + bytesOut}', () => {
    expect(body).toMatch(
      /getStats\(\) \{\s*const s = current\.pipeline\.getStats\(\);\s*return \{ framesIn: s\.framesIn, chunksOut: s\.chunksOut, bytesOut: s\.bytesOut \};\s*\},/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
