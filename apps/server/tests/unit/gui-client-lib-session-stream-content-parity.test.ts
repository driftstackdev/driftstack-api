// W468.A — drift guard for apps/gui-client/src/lib/session-stream.ts.
// V-534.E session-stream polling source. Drift here either drops
// the fetchInFlight overlap-skip guard (slow capture endpoint
// queues up parallel fetches and the GUI hammers the server with
// concurrent requests until something blows up) or breaks the
// 4-frame moving-average fps window (UI shows 0fps spikes whenever
// a single frame is delayed because the average resets instead
// of smoothing).
//
//   • V-534.E framing pinned: 'session stream source abstraction.'
//     + 'LiveSessionView (apps/gui-client/src/views/
//     LiveSessionView.tsx) currently embeds the polling-capture
//     loop inline. V-534.E extracts that loop into a reusable,
//     testable stream-source: caller hands in a fetchFrame()
//     function, the module manages the interval, pause state,
//     fps measurement, error reporting, and listener fan-out.'
//   • Two-impl framing pinned: 'createPollingFrameStream(...)'
//     reference impl + 'createSseFrameStream(...) and
//     createWebRtcFrameStream(...) placeholders' for future slice.
//   • 'Pure TypeScript — no React hook.'
//   • Frame: 4-field (pngBase64 'Base64-encoded PNG bytes, no
//     data: prefix.' + bytes + capturedAt + durationMs).
//   • FrameStreamEvent 4-variant union (frame{frame,fpsActual} +
//     error{error: unknown} + paused + resumed).
//   • FrameStream 6-method (subscribe + pause + resume + isPaused
//     + getFpsActual + stop).
//   • PollingFrameStreamOpts: intervalMs default 500 + initialPaused
//     default false.
//   • computeFps: returns 0 for <2 timestamps; first/last
//     undefined → 0; dt <= 0 → 0; rounded to 1 decimal
//     ((n-1)/dt * 1000 * 10) / 10.
//   • createPollingFrameStream: 4-frame moving window
//     (frameTimestamps.length > 4 → shift); fetchInFlight skip;
//     stopped + paused guard on tick; pause clearTimeout + emit
//     'paused'; resume emit 'resumed' + immediate tick;
//     stop clearTimeout + listeners.clear.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/session-stream.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W468.A apps/gui-client/src/lib/session-stream.ts content parity', () => {
  const body = read(LIB);

  it("V-534.E framing pinned: 'V-534.E — session stream source abstraction.' + 'LiveSessionView (apps/gui-client/src/views/LiveSessionView.tsx) currently embeds the polling-capture loop inline. V-534.E extracts that loop into a reusable, testable stream-source: caller hands in a `fetchFrame()` function, the module manages the interval, pause state, fps measurement, error reporting, and listener fan-out.'", () => {
    expect(body).toMatch(/\/\/ V-534\.E — session stream source abstraction\./);
    expect(body).toMatch(
      /\/\/ LiveSessionView \(apps\/gui-client\/src\/views\/LiveSessionView\.tsx\) currently\s*\n?\s*\/\/ embeds the polling-capture loop inline\. V-534\.E extracts that loop into\s*\n?\s*\/\/ a reusable, testable stream-source: caller hands in a `fetchFrame\(\)`\s*\n?\s*\/\/ function, the module manages the interval, pause state, fps measurement,\s*\n?\s*\/\/ error reporting, and listener fan-out\./,
    );
  });

  it("Two-impl framing pinned: 'createPollingFrameStream(fetchFrame, opts) — the polling source LiveSessionView uses today. Drops in unchanged onto the existing polling architecture.' + 'createSseFrameStream(...) and createWebRtcFrameStream(...) placeholders — defer to a future slice. The polling impl is the reference contract.' + 'Pure TypeScript — no React hook.'", () => {
    expect(body).toMatch(
      /\/\/\s+- `createPollingFrameStream\(fetchFrame, opts\)` — the polling source\s*\n?\s*\/\/\s+LiveSessionView uses today\. Drops in unchanged onto the existing\s*\n?\s*\/\/\s+polling architecture\./,
    );
    expect(body).toMatch(
      /\/\/\s+- `createSseFrameStream\(\.\.\.\)` and `createWebRtcFrameStream\(\.\.\.\)`\s*\n?\s*\/\/\s+placeholders — defer to a future slice\. The polling impl is the\s*\n?\s*\/\/\s+reference contract\./,
    );
    expect(body).toMatch(
      /\/\/ Pure TypeScript — no React hook\. The hook wrapper lands when\s*\n?\s*\/\/ LiveSessionView migrates onto this module\./,
    );
  });

  it("Frame 4-field interface: pngBase64 'Base64-encoded PNG bytes, no data: prefix.' + bytes + capturedAt + durationMs", () => {
    expect(body).toMatch(
      /export interface Frame \{\s*\n?\s*\/\*\* Base64-encoded PNG bytes, no data: prefix\. \*\/\s*\n?\s*pngBase64: string;\s*\n?\s*bytes: number;\s*\n?\s*capturedAt: number;\s*\n?\s*durationMs: number;\s*\n?\s*\}/,
    );
  });

  it('FrameStreamEvent 4-variant union: frame{frame,fpsActual} + error{error:unknown} + paused + resumed', () => {
    expect(body).toMatch(
      /export type FrameStreamEvent =\s*\n?\s*\| \{ kind: 'frame'; frame: Frame; fpsActual: number \}\s*\n?\s*\| \{ kind: 'error'; error: unknown \}\s*\n?\s*\| \{ kind: 'paused' \}\s*\n?\s*\| \{ kind: 'resumed' \};/,
    );
  });

  it("FrameStream 6-method interface: subscribe (returns unsubscribe) + pause 'Frames buffer at the source side; we don't queue them.' + resume 'Triggers an immediate frame fetch.' + isPaused + getFpsActual '4-frame moving average' + stop", () => {
    expect(body).toMatch(
      /\/\*\* Subscribe to stream events; returns an unsubscribe fn\. \*\/\s*\n?\s*subscribe\(listener: FrameStreamListener\): \(\) => void;\s*\n?\s*\/\*\* Pause polling\. Frames buffer at the source side; we don't queue them\. \*\/\s*\n?\s*pause\(\): void;\s*\n?\s*\/\*\* Resume polling\. Triggers an immediate frame fetch\. \*\/\s*\n?\s*resume\(\): void;\s*\n?\s*\/\*\* Current paused state\. \*\/\s*\n?\s*isPaused\(\): boolean;\s*\n?\s*\/\*\* Latest computed fps \(4-frame moving average\)\. \*\/\s*\n?\s*getFpsActual\(\): number;\s*\n?\s*\/\*\* Tear down — no more frames, listeners cleared\. \*\/\s*\n?\s*stop\(\): void;/,
    );
  });

  it('PollingFrameStreamOpts: intervalMs default 500 + initialPaused default false', () => {
    expect(body).toMatch(
      /export interface PollingFrameStreamOpts \{\s*\n?\s*\/\*\* How often to request a frame \(ms\)\. Default 500\. \*\/\s*\n?\s*intervalMs\?: number;\s*\n?\s*\/\*\* Initial paused state\. Default false\. \*\/\s*\n?\s*initialPaused\?: boolean;\s*\n?\s*\}/,
    );
  });

  it("computeFps: returns 0 for timestamps.length < 2; first/last undefined fall-through → 0; dt <= 0 → 0; formula `((n-1)/dt * 1000 * 10) / 10` for 1-decimal rounding + framing '(n-1) intervals across (n) timestamps → frame rate = (n-1) / dt seconds.'", () => {
    expect(body).toMatch(
      /export function computeFps\(timestamps: readonly number\[\]\): number \{\s*\n?\s*if \(timestamps\.length < 2\) return 0;\s*\n?\s*const first = timestamps\[0\];\s*\n?\s*const last = timestamps\[timestamps\.length - 1\];\s*\n?\s*if \(first === undefined \|\| last === undefined\) return 0;\s*\n?\s*const dt = last - first;\s*\n?\s*if \(dt <= 0\) return 0;\s*\n?\s*\/\/ \(n-1\) intervals across \(n\) timestamps → frame rate = \(n-1\) \/ dt seconds\.\s*\n?\s*return Math\.round\(\(\(timestamps\.length - 1\) \/ dt\) \* 1000 \* 10\) \/ 10;\s*\n?\s*\}/,
    );
  });

  it('createPollingFrameStream: intervalMs default 500 + 4-frame moving window (frameTimestamps.length > 4 → shift) + fpsActual recompute on every frame + fetchInFlight overlap-skip', () => {
    expect(body).toMatch(/const intervalMs = opts\.intervalMs \?\? 500;/);
    expect(body).toMatch(
      /frameTimestamps\.push\(frame\.capturedAt\);\s*\n?\s*while \(frameTimestamps\.length > 4\) frameTimestamps\.shift\(\);\s*\n?\s*fpsActual = computeFps\(frameTimestamps\);\s*\n?\s*emit\(\{ kind: 'frame', frame, fpsActual \}\);/,
    );
    expect(body).toMatch(
      /if \(fetchInFlight\) \{\s*\n?\s*\/\/ Skip overlapping fetches — slow capture endpoint shouldn't queue\s*\n?\s*\/\/ up frames\. Just schedule the next tick\.\s*\n?\s*schedule\(\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it('tick: stopped + paused early returns; try fetchFrame + stopped-after-fetch guard; catch !stopped → emit error; finally fetchInFlight = false + schedule(); schedule: stopped + paused guard + setTimeout(intervalMs)', () => {
    expect(body).toMatch(
      /async function tick\(\): Promise<void> \{\s*\n?\s*if \(stopped \|\| paused\) return;/,
    );
    expect(body).toMatch(
      /\} catch \(err\) \{\s*\n?\s*if \(!stopped\) emit\(\{ kind: 'error', error: err \}\);\s*\n?\s*\} finally \{\s*\n?\s*fetchInFlight = false;\s*\n?\s*schedule\(\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /function schedule\(\): void \{\s*\n?\s*if \(stopped \|\| paused\) return;\s*\n?\s*handle = setTimeout\(\(\) => \{\s*\n?\s*void tick\(\);\s*\n?\s*\}, intervalMs\);\s*\n?\s*\}/,
    );
  });

  it("pause: idempotent (if paused return) + clearTimeout + emit 'paused'; resume: idempotent (if !paused || stopped return) + emit 'resumed' + void tick(); stop: stopped=true + clearTimeout + listeners.clear()", () => {
    expect(body).toMatch(
      /pause\(\) \{\s*\n?\s*if \(paused\) return;\s*\n?\s*paused = true;\s*\n?\s*if \(handle !== null\) \{\s*\n?\s*clearTimeout\(handle\);\s*\n?\s*handle = null;\s*\n?\s*\}\s*\n?\s*emit\(\{ kind: 'paused' \}\);\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /resume\(\) \{\s*\n?\s*if \(!paused \|\| stopped\) return;\s*\n?\s*paused = false;\s*\n?\s*emit\(\{ kind: 'resumed' \}\);\s*\n?\s*void tick\(\);\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /stop\(\) \{\s*\n?\s*stopped = true;\s*\n?\s*if \(handle !== null\) \{\s*\n?\s*clearTimeout\(handle\);\s*\n?\s*handle = null;\s*\n?\s*\}\s*\n?\s*listeners\.clear\(\);\s*\n?\s*\},/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
