// W458.C — drift guard for packages/webrtc-streaming/src/encode-pipeline.ts.
// V-531 server-side encode pipeline (V-531.A pass-through shell).
// Drift here either drops the keyframe-on-first-frame guarantee
// ((sequence - 1) % N === 0 is always true at sequence 1) — consumers
// can't decode from start without a keyframe to anchor reconstruction
// — or breaks the
// EOS handling (source returning null counts as framesDropped+=1
// + state→stopped + endHandler fires).
//
//   • V-531 framing pinned + 'V-531.A ships the pipeline shell + a
//     pass-through "raw" encoder so the pipeline is end-to-end
//     testable against the MockFrameSource without pulling in a
//     real codec dependency (libvpx / openh264). Real codec wiring
//     lands as V-531.B (later wave).'
//   • EncodedChunk: 5-field (sequence + timestampMicros + codec
//     5-value union 'raw'|'h264'|'vp8'|'vp9'|'av1' + payload
//     Uint8Array + isKeyframe).
//   • EncodePipelineStats: 4-field (framesIn + chunksOut + bytesOut
//     + framesDropped 'Frames the source returned null for (end-of-
//     stream / stopped).').
//   • EncodePipelineOpts: 2-field (source + keyframeIntervalFrames
//     'Every Nth chunk is marked as a keyframe. Default 30 (≈ 1
//     keyframe per second at 30 fps).').
//   • EncodePipeline framing pinned: 'Server-side encode pipeline.
//     Pulls frames from the source, runs them through the encoder,
//     and emits encoded chunks via callback.' + 4-item pass-through
//     test scope (sequence correctness + keyframe interval marking
//     + end-of-stream handling + stop/drain semantics).
//   • 3-state union ('idle'|'running'|'stopped') with idle→running
//     start guard 'throw EncodePipeline.start: invalid state X'.
//   • start: pull loop while running; null frame → framesDropped+=1
//     + state→stopped + break; non-null frame → framesIn+=1 +
//     encode + chunksOut+=1 + bytesOut+=payload.byteLength +
//     chunkHandler emit; endHandler fires post-loop.
//   • stop: sets state to 'stopped'.
//   • getStats: returns spread copy (defensive).
//   • encode: pass-through raw codec; isKeyframe =
//     (sequence - 1) % keyframeIntervalFrames === 0.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/webrtc-streaming/src/encode-pipeline.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W458.C packages/webrtc-streaming/src/encode-pipeline.ts content parity', () => {
  const body = read(LIB);

  it("V-531 framing pinned: 'V-531 — server-side encode pipeline.' + 'Consumes frames from a FrameSource and produces encoded chunks ready for WebRTC track delivery. This wave (V-531.A) ships the pipeline shell + a pass-through \"raw\" encoder so the pipeline is end-to-end testable against the MockFrameSource without pulling in a real codec dependency (libvpx / openh264). Real codec wiring lands as V-531.B (later wave).'", () => {
    expect(body).toMatch(/\/\/ V-531 — server-side encode pipeline\./);
    expect(body).toMatch(
      /\/\/ Consumes frames from a `FrameSource` and produces encoded chunks ready\s*\/\/ for WebRTC track delivery\. This wave \(V-531\.A\) ships the pipeline shell\s*\/\/ \+ a pass-through "raw" encoder so the pipeline is end-to-end testable\s*\/\/ against the MockFrameSource without pulling in a real codec dependency\s*\/\/ \(libvpx \/ openh264\)\. Real codec wiring lands as V-531\.B \(later wave\)\./,
    );
  });

  it("EncodedChunk: 5-field (sequence + timestampMicros + codec 5-value union 'raw'|'h264'|'vp8'|'vp9'|'av1' + payload Uint8Array + isKeyframe); 'pass-through (test mode)' framing on codec='raw'", () => {
    expect(body).toMatch(
      /export interface EncodedChunk \{[\s\S]*?sequence: number;[\s\S]*?timestampMicros: number;[\s\S]*?\/\*\* Codec used\. 'raw' = pass-through \(test mode\)\. \*\/\s*codec: 'raw' \| 'h264' \| 'vp8' \| 'vp9' \| 'av1';[\s\S]*?payload: Uint8Array;[\s\S]*?isKeyframe: boolean;/,
    );
  });

  it("EncodePipelineStats: 4-field (framesIn + chunksOut + bytesOut + framesDropped 'Frames the source returned null for (end-of-stream / stopped).'); EncodePipelineOpts: 2-field with keyframeIntervalFrames 'Every Nth chunk is marked as a keyframe. Default 30 (≈ 1 keyframe per second at 30 fps).' framing pinned", () => {
    expect(body).toMatch(
      /export interface EncodePipelineStats \{\s*framesIn: number;\s*chunksOut: number;\s*bytesOut: number;\s*\/\*\* Frames the source returned null for \(end-of-stream \/ stopped\)\. \*\/\s*framesDropped: number;\s*\}/,
    );
    expect(body).toMatch(
      /\*\s*Keyframe interval in frames\. Every Nth chunk is marked as a keyframe\.\s*\*\s*Default 30 \(≈ 1 keyframe per second at 30 fps\)\./,
    );
  });

  it("EncodePipeline framing pinned: 'Server-side encode pipeline. Pulls frames from the source, runs them through the encoder, and emits encoded chunks via callback.' + 4-item pass-through test scope (frame→chunk sequence correctness + keyframe interval marking + end-of-stream handling + stop/drain semantics)", () => {
    expect(body).toMatch(
      /\* Server-side encode pipeline\. Pulls frames from the source, runs them\s*\*\s*through the encoder, and emits encoded chunks via callback\./,
    );
    expect(body).toMatch(
      /\*\s*V-531\.A pass-through behaviour: chunks carry the raw frame bytes\s*\*\s*unchanged with codec='raw'\. This is sufficient to test:\s*\*\s*- Frame → chunk sequence correctness\.\s*\*\s*- Keyframe interval marking\.\s*\*\s*- End-of-stream handling\.\s*\*\s*- Stop \/ drain semantics\./,
    );
    expect(body).toMatch(/\*\s*V-531\.B will swap in real encoders behind the same surface\./);
  });

  it("EncodePipeline class: 3-state union ('idle'|'running'|'stopped') + private fields (source readonly + keyframeIntervalFrames readonly + state default 'idle' + chunkHandler + endHandler + stats); keyframeIntervalFrames default 30", () => {
    expect(body).toMatch(/private state: 'idle' \| 'running' \| 'stopped' = 'idle';/);
    expect(body).toMatch(
      /private chunkHandler: \(\(chunk: EncodedChunk\) => void\) \| null = null;/,
    );
    expect(body).toMatch(/private endHandler: \(\(\) => void\) \| null = null;/);
    expect(body).toMatch(
      /private stats: EncodePipelineStats = \{\s*framesIn: 0,\s*chunksOut: 0,\s*bytesOut: 0,\s*framesDropped: 0,\s*\};/,
    );
    expect(body).toMatch(/const keyframeIntervalFrames = opts\.keyframeIntervalFrames \?\? 30;/);
    expect(body).toMatch(/this\.keyframeIntervalFrames = keyframeIntervalFrames;/);
    // Positive-integer guard: N=0 makes `% 0` → NaN (keyframeless stream).
    expect(body).toMatch(
      /if \(!Number\.isInteger\(keyframeIntervalFrames\) \|\| keyframeIntervalFrames < 1\) \{/,
    );
    expect(body).toMatch(
      /keyframeIntervalFrames must be a positive integer \(got \$\{keyframeIntervalFrames\}\)/,
    );
  });

  it("start framing pinned: 'Runs an internal pull loop until the source returns null or stop() is called.' + idle→running guard 'throw EncodePipeline.start: invalid state X' + while-running pull loop + null-frame→framesDropped+=1 + state→stopped + break + endHandler fires post-loop", () => {
    expect(body).toMatch(
      /\*\s*Start the pipeline\. Runs an internal pull loop until the source returns\s*\*\s*null or `stop\(\)` is called\./,
    );
    expect(body).toMatch(
      /if \(this\.state !== 'idle'\) \{\s*throw new Error\(`EncodePipeline\.start: invalid state \$\{this\.state\}`\);\s*\}/,
    );
    expect(body).toMatch(
      /while \(this\.state === 'running'\) \{\s*const frame = await this\.source\.pullNextFrame\(\);\s*if \(frame === null\) \{\s*this\.stats\.framesDropped \+= 1;\s*this\.state = 'stopped';\s*break;\s*\}/,
    );
    expect(body).toMatch(/this\.endHandler\?\.\(\);/);
  });

  it("Frame processing: framesIn+=1 + encode + chunksOut+=1 + bytesOut+=payload.byteLength + chunkHandler emit (guarded by try/catch so a throwing consumer doesn't leak); stop() sets state='stopped'; getStats returns spread copy (defensive)", () => {
    expect(body).toMatch(
      /this\.stats\.framesIn \+= 1;\s*const chunk = this\.encode\(frame\);\s*this\.stats\.chunksOut \+= 1;\s*this\.stats\.bytesOut \+= chunk\.payload\.byteLength;/,
    );
    // The chunk consumer call is wrapped so a throwing subscriber can't abort
    // the loop without teardown — it re-throws to the `finally` that runs
    // cleanup (release source + fire onEnd).
    expect(body).toMatch(
      /try \{\s*this\.chunkHandler\?\.\(chunk\);\s*\} catch \(err\) \{\s*this\.state = 'stopped';\s*throw err;\s*\}/,
    );
    expect(body).toMatch(/stop\(\): void \{\s*this\.state = 'stopped';\s*\}/);
    expect(body).toMatch(
      /getStats\(\): EncodePipelineStats \{\s*return \{ \.\.\.this\.stats \};\s*\}/,
    );
  });

  it('Teardown is guaranteed on every exit path: a `finally` releases the source (await source.stop()) then fires endHandler exactly once', () => {
    // Guard the source release so a failing stop() can't suppress onEnd.
    expect(body).toMatch(
      /\} finally \{[\s\S]*?this\.state = 'stopped';\s*try \{\s*await this\.source\.stop\(\);\s*\} finally \{\s*this\.endHandler\?\.\(\);\s*\}\s*\}/,
    );
  });

  it('encode: pass-through raw codec; isKeyframe = (sequence - 1) % keyframeIntervalFrames === 0; payload = frame.data unchanged; sequence + timestampMicros copy through', () => {
    expect(body).toMatch(
      /const isKeyframe = \(frame\.sequence - 1\) % this\.keyframeIntervalFrames === 0;/,
    );
    expect(body).toMatch(/codec: 'raw',/);
    expect(body).toMatch(/payload: frame\.data,/);
    expect(body).toMatch(/sequence: frame\.sequence,/);
    expect(body).toMatch(/timestampMicros: frame\.timestampMicros,/);
  });

  it("getState public accessor: returns 'idle'|'running'|'stopped'; onChunk + onEnd registration single-handler (not Set-of-handlers)", () => {
    expect(body).toMatch(
      /getState\(\): 'idle' \| 'running' \| 'stopped' \{\s*return this\.state;\s*\}/,
    );
    expect(body).toMatch(
      /onChunk\(handler: \(chunk: EncodedChunk\) => void\): void \{\s*this\.chunkHandler = handler;\s*\}/,
    );
    expect(body).toMatch(
      /onEnd\(handler: \(\) => void\): void \{\s*this\.endHandler = handler;\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
