// W455.A — drift guard for packages/webrtc-streaming/src/index.ts.
// @driftstack/webrtc-streaming public surface barrel. Drift here
// either drops a stream-lifecycle type re-export (consumers building
// against the package break mid-refactor) or accidentally re-exports
// an internal codec helper (locks the public API to an unstable
// name).
//
//   • header framing pinned.
//   • 8 type-only re-exports from ./types.js (IceCandidate +
//     IceServer + SdpPayload + StreamConfig + StreamEvent +
//     StreamId + StreamState + StreamStats).
//   • 4 interface re-exports from ./interfaces.js (CreateStreamOpts
//     + CreateStreamResult + StreamRegistry + WebRtcStreamingService).
//   • MockWebRtcStreamingService value export.
//   • 4 frame-source types + MockFrameSource value export.
//   • 3 encode-pipeline types + EncodePipeline value export.
//   • 2 mock-codec-wrapper types + createMockEncodedStream value
//     export.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/webrtc-streaming/src/index.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W455.A packages/webrtc-streaming/src/index.ts content parity', () => {
  const body = read(LIB);

  it("header framing pinned: '@driftstack/webrtc-streaming public surface.'", () => {
    expect(body).toMatch(/\/\/ @driftstack\/webrtc-streaming public surface\./);
  });

  it('8 type-only re-exports from ./types.js (IceCandidate + IceServer + SdpPayload + StreamConfig + StreamEvent + StreamId + StreamState + StreamStats)', () => {
    expect(body).toMatch(
      /export type \{\s*IceCandidate,\s*IceServer,\s*SdpPayload,\s*StreamConfig,\s*StreamEvent,\s*StreamId,\s*StreamState,\s*StreamStats,\s*\} from '\.\/types\.js';/,
    );
  });

  it('4 interface re-exports from ./interfaces.js (CreateStreamOpts + CreateStreamResult + StreamRegistry + WebRtcStreamingService)', () => {
    expect(body).toMatch(
      /export type \{\s*CreateStreamOpts,\s*CreateStreamResult,\s*StreamRegistry,\s*WebRtcStreamingService,\s*\} from '\.\/interfaces\.js';/,
    );
  });

  it('MockWebRtcStreamingService value export from ./mock.js', () => {
    expect(body).toMatch(/export \{ MockWebRtcStreamingService \} from '\.\/mock\.js';/);
  });

  it('frame-source: 4 type re-exports (FramePixelFormat + FrameSource + FrameSourceConfig + VideoFrame) + MockFrameSource value export', () => {
    expect(body).toMatch(
      /export type \{\s*FramePixelFormat,\s*FrameSource,\s*FrameSourceConfig,\s*VideoFrame,\s*\} from '\.\/frame-source\.js';/,
    );
    expect(body).toMatch(/export \{ MockFrameSource \} from '\.\/frame-source\.js';/);
  });

  it('encode-pipeline: 3 type re-exports (EncodedChunk + EncodePipelineOpts + EncodePipelineStats) + EncodePipeline value export', () => {
    expect(body).toMatch(
      /export type \{ EncodedChunk, EncodePipelineOpts, EncodePipelineStats \} from '\.\/encode-pipeline\.js';/,
    );
    expect(body).toMatch(/export \{ EncodePipeline \} from '\.\/encode-pipeline\.js';/);
  });

  it('mock-codec-wrapper: 2 type re-exports (MockEncodedStream + MockEncodedStreamOpts) + createMockEncodedStream value export', () => {
    expect(body).toMatch(
      /export type \{ MockEncodedStream, MockEncodedStreamOpts \} from '\.\/mock-codec-wrapper\.js';/,
    );
    expect(body).toMatch(/export \{ createMockEncodedStream \} from '\.\/mock-codec-wrapper\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
