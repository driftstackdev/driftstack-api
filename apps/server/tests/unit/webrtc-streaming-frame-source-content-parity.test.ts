// W459.C — drift guard for packages/webrtc-streaming/src/frame-source.ts.
// V-531 FrameSource cross-agent contract + MockFrameSource. Drift
// here either drops the cross-agent compatibility framing
// ('changes to this interface require a coordinated change to the
// WebKit-fork implementation in the same wave' — silent divergence
// across the IPC boundary) or breaks the consumer-driven pull-rate
// framing (source emits multiple frames per pull, breaking the
// throttle the pipeline depends on).
//
//   • V-531 framing pinned + cross-agent contract framing
//     ('contract between this repo (driftstack-api control plane)
//     and the WebKit fork (Agent 1's scope)').
//   • IPC envelope doc reference at docs/internal/v531-cross-agent-
//     contract.md.
//   • FramePixelFormat: 4-value union (I420 + NV12 + BGRA + RGBA).
//   • VideoFrame: 6-field (timestampMicros 'matches WebRTC's
//     RTCRtpScriptTransformer timestamp resolution' + width + height
//     + pixelFormat + data Uint8Array + sequence 'monotonically
//     increasing from 1 within a single FrameSource.start()
//     lifetime. Resets on stop+restart').
//   • FrameSourceConfig: 4-field (targetFps + targetWidth +
//     targetHeight + preferredPixelFormat 'Implementations may fall
//     back').
//   • FrameSource framing pinned: 2-impl enumeration (MockFrameSource
//     + WkWebViewFrameSource 'WebKit fork; Agent 1 scope') +
//     cross-agent compatibility constraint 'changes to this interface
//     require a coordinated change to the WebKit-fork implementation
//     in the same wave'.
//   • FrameSource interface: 4 methods (start + pullNextFrame
//     consumer-driven-pull-rate framing 'source emits at most one
//     frame per pull regardless of how many frames the underlying
//     surface has produced' + stop idempotent + getState 5-value
//     union).
//   • MockFrameSource framing pinned 'Synthetic frame source for
//     solo testing ... Produces deterministic frames at the
//     configured rate without any actual WKWebView dependency.';
//     state default 'idle' + nextSequence 1 + nowMicros
//     1_714_867_200_000_000 deterministic start.
//   • options: 2-field test seams (fillByte default 0x80 + maxFrames
//     cap).
//   • start: sets running state + resets nextSequence to 1; pullNext
//     Frame: state-or-config null guard + maxFrames cap →
//     null; otherwise allocates frame data + fills + emits frame +
//     advances sequence + nowMicros by 1_000_000/targetFps.
//   • stop: state→'stopped'.
//   • advanceClockMicros test seam.
//   • allocateFrameData: planar 4:2:0 = floor(pixels * 1.5);
//     packed BGRA/RGBA = pixels * 4.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/webrtc-streaming/src/frame-source.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W459.C packages/webrtc-streaming/src/frame-source.ts content parity', () => {
  const body = read(LIB);

  it("V-531 framing pinned: 'V-531 — frame source interface (cross-agent contract).' + 'This is the contract between this repo (driftstack-api control plane) and the WebKit fork (Agent 1's scope). The WebKit fork implements WkWebViewFrameSource on the harness side — extracting frames from a WKWebView's surface — and ships them across the IPC boundary to the control plane's encode pipeline (see encode-pipeline.ts).'", () => {
    expect(body).toMatch(/\/\/ V-531 — frame source interface \(cross-agent contract\)\./);
    expect(body).toMatch(
      /\/\/ This is the contract between this repo \(driftstack-api control plane\) and\s*\/\/ the WebKit fork \(Agent 1's scope\)\. The WebKit fork implements\s*\/\/ `WkWebViewFrameSource` on the harness side — extracting frames from a\s*\/\/ WKWebView's surface — and ships them across the IPC boundary to the\s*\/\/ control plane's encode pipeline \(see `encode-pipeline\.ts`\)\./,
    );
  });

  it("IPC envelope doc reference framing pinned: 'Document at docs/internal/v531-cross-agent-contract.md describes the IPC envelope; this file is the language-level interface the server-side pipeline depends on.'", () => {
    expect(body).toMatch(
      /\/\/ Document at `docs\/internal\/v531-cross-agent-contract\.md` describes the\s*\/\/ IPC envelope; this file is the language-level interface the server-side\s*\/\/ pipeline depends on\./,
    );
  });

  it("FramePixelFormat: 4-value union ('I420'|'NV12'|'BGRA'|'RGBA')", () => {
    expect(body).toMatch(
      /\/\*\* Pixel format the frame source emits\. \*\/\s*export type FramePixelFormat = 'I420' \| 'NV12' \| 'BGRA' \| 'RGBA';/,
    );
  });

  it("VideoFrame: 6-field (timestampMicros 'matches WebRTC's RTCRtpScriptTransformer timestamp resolution' framing + width + height + pixelFormat + data Uint8Array with planar concatenation framing + sequence 'monotonically increasing from 1 within a single FrameSource.start() lifetime. Resets on stop+restart' framing)", () => {
    expect(body).toMatch(
      /\*\s*Wall-clock capture timestamp in microseconds \(matches WebRTC's\s*\*\s*`RTCRtpScriptTransformer` timestamp resolution\)\./,
    );
    expect(body).toMatch(
      /\*\s*Raw pixel data\. For planar formats \(I420 \/ NV12\) the planes are\s*\*\s*concatenated in standard order \(Y, then U, then V; or Y, then UV\s*\*\s*interleaved\)\. For packed formats \(BGRA \/ RGBA\) one buffer holds the\s*\*\s*interleaved pixels\./,
    );
    expect(body).toMatch(
      /\*\s*Per-frame sequence number \(monotonically increasing from 1 within a\s*\*\s*single FrameSource\.start\(\) lifetime\)\. Resets on stop\+restart\./,
    );
  });

  it("FrameSourceConfig: 4-field (targetFps + targetWidth 'The source may degrade to a smaller size' + targetHeight + preferredPixelFormat 'Implementations may fall back')", () => {
    expect(body).toMatch(
      /export interface FrameSourceConfig \{[\s\S]*?targetFps: number;[\s\S]*?\/\*\* Target width in pixels\. The source may degrade to a smaller size\. \*\/\s*targetWidth: number;[\s\S]*?targetHeight: number;[\s\S]*?\/\*\* Preferred pixel format\. Implementations may fall back\. \*\/\s*preferredPixelFormat: FramePixelFormat;/,
    );
  });

  it("FrameSource framing pinned: 2-impl enumeration (MockFrameSource for solo testing + WkWebViewFrameSource 'WebKit fork; Agent 1 scope — real frames from a WKWebView surface via the IPC envelope') + cross-agent compatibility constraint 'changes to this interface require a coordinated change to the WebKit-fork implementation in the same wave'", () => {
    expect(body).toMatch(
      /\*\s*1\. `MockFrameSource` \(this file\) — synthetic frames for solo testing\.\s*\*\s*2\. `WkWebViewFrameSource` \(WebKit fork; Agent 1 scope\) — real frames\s*\*\s*from a WKWebView surface via the IPC envelope in V-531 cross-agent\s*\*\s*contract doc\./,
    );
    expect(body).toMatch(
      /\*\s*Cross-agent compatibility constraint: the interface contract here MUST\s*\*\s*match the IPC envelope shape\. Changes to this interface require a\s*\*\s*coordinated change to the WebKit-fork implementation in the same wave\./,
    );
  });

  it("FrameSource interface: 4 methods (start + pullNextFrame consumer-driven-pull-rate framing 'The consumer drives the pull rate — the source emits at most one frame per pull regardless of how many frames the underlying surface has produced.' + stop 'Idempotent' + getState 5-value union)", () => {
    expect(body).toMatch(/start\(config: FrameSourceConfig\): Promise<void>;/);
    expect(body).toMatch(
      /\*\s*Pull the next frame\. Returns null if the source has been stopped or\s*\*\s*has hit end-of-stream \(e\.g\. WKWebView closed\)\. The consumer drives the\s*\*\s*pull rate — the source emits at most one frame per pull regardless of\s*\*\s*how many frames the underlying surface has produced\./,
    );
    expect(body).toMatch(/pullNextFrame\(\): Promise<VideoFrame \| null>;/);
    expect(body).toMatch(
      /\/\*\* Stop emitting frames \+ release resources\. Idempotent\. \*\/\s*stop\(\): Promise<void>;/,
    );
    expect(body).toMatch(
      /getState\(\): 'idle' \| 'starting' \| 'running' \| 'stopped' \| 'failed';/,
    );
  });

  it("MockFrameSource framing pinned: 'Synthetic frame source for solo testing of the server-side encode pipeline. Produces deterministic frames at the configured rate without any actual WKWebView dependency.' + 'Frame data is a solid colour fill (configurable) so byte counts and shape assertions in tests are predictable.' + state default 'idle' + nextSequence 1 + nowMicros 1_714_867_200_000_000 'deterministic start'", () => {
    expect(body).toMatch(
      /\* Synthetic frame source for solo testing of the server-side encode\s*\*\s*pipeline\. Produces deterministic frames at the configured rate without\s*\*\s*any actual WKWebView dependency\./,
    );
    expect(body).toMatch(
      /\*\s*Frame data is a solid colour fill \(configurable\) so byte counts and\s*\*\s*shape assertions in tests are predictable\. Real frames carry pixel-\s*\*\s*complexity, which downstream codec tests will exercise separately\./,
    );
    expect(body).toMatch(
      /private state: 'idle' \| 'starting' \| 'running' \| 'stopped' \| 'failed' = 'idle';\s*private nextSequence = 1;\s*private config: FrameSourceConfig \| null = null;\s*private nowMicros = 1_714_867_200_000_000;[\s\S]*?\/\/ deterministic start/,
    );
  });

  it("MockFrameSource options: fillByte 'Fixed byte value for the data plane (test determinism)' + maxFrames 'Cap on total frames produced (then pullNextFrame returns null)'; fillByte default 0x80", () => {
    expect(body).toMatch(
      /\/\*\* Fixed byte value for the data plane \(test determinism\)\. \*\/\s*fillByte\?: number;\s*\/\*\* Cap on total frames produced \(then pullNextFrame returns null\)\. \*\/\s*maxFrames\?: number;/,
    );
    expect(body).toMatch(/const fill = this\.options\.fillByte \?\? 0x80;/);
  });

  it('start: sets running state + resets nextSequence to 1; pullNextFrame: state-or-config-null guard returns null; maxFrames cap (this.nextSequence > maxFrames) returns null; frame { timestampMicros + width + height + pixelFormat + data + sequence }; advance nextSequence+1 + nowMicros by Math.floor(1_000_000 / targetFps)', () => {
    expect(body).toMatch(
      /start\(config: FrameSourceConfig\): Promise<void> \{\s*this\.config = config;\s*this\.state = 'running';\s*this\.nextSequence = 1;\s*return Promise\.resolve\(\);\s*\}/,
    );
    expect(body).toMatch(
      /if \(this\.state !== 'running' \|\| this\.config === null\) \{\s*return Promise\.resolve\(null\);\s*\}\s*if \(this\.options\.maxFrames !== undefined && this\.nextSequence > this\.options\.maxFrames\) \{\s*return Promise\.resolve\(null\);\s*\}/,
    );
    expect(body).toMatch(
      /this\.nextSequence \+= 1;\s*this\.nowMicros \+= Math\.floor\(1_000_000 \/ config\.targetFps\);/,
    );
  });

  it("stop: state→'stopped'; advanceClockMicros test seam framing 'Test seam: advance the deterministic clock by N microseconds.'; allocateFrameData: planar 4:2:0 (I420|NV12) = floor(pixels * 1.5); packed (BGRA|RGBA) = pixels * 4", () => {
    expect(body).toMatch(
      /stop\(\): Promise<void> \{\s*this\.state = 'stopped';\s*return Promise\.resolve\(\);\s*\}/,
    );
    expect(body).toMatch(
      /\/\*\* Test seam: advance the deterministic clock by N microseconds\. \*\/\s*advanceClockMicros\(deltaMicros: number\): void \{\s*this\.nowMicros \+= deltaMicros;\s*\}/,
    );
    expect(body).toMatch(
      /case 'I420':\s*case 'NV12':\s*\/\/ Y plane \+ chroma at half resolution \(4:2:0\)\. Total bytes = 1\.5 \* pixels\.\s*return new Uint8Array\(Math\.floor\(pixels \* 1\.5\)\);\s*case 'BGRA':\s*case 'RGBA':\s*return new Uint8Array\(pixels \* 4\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
