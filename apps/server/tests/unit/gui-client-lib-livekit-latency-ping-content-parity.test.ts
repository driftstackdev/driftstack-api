// Drift guard for apps/gui-client/src/lib/livekit-latency-ping.ts.
// Pins LK.6.e synthetic-ping RTT measurement — 2s interval +
// 6s freshness window + dev-mode-only display gate + bounded-
// cardinality outstanding-map for out-of-order echoes.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/livekit-latency-ping.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('gui-client/lib/livekit-latency-ping content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("LK.6.e module-level framing pinned: 'synthetic-ping RTT measurement over the LiveKit DataChannel. The gui-client sends a ping InputEvent at LIVEKIT_PING_INTERVAL_MS cadence; Agent 1's harness-side RoomDataDispatcher + LatencyCollector echoes it back as a ping DataReceived event. gui-client measures the round-trip and exposes it via a React hook.' — pinned so the LK.6.e anchor + cross-agent RoomDataDispatcher + LatencyCollector cross-reference + React-hook surface contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ LK\.6\.e — synthetic-ping RTT measurement over the LiveKit\s*\/\/ DataChannel\./,
    );
    expect(body).toMatch(
      /The gui-client sends a `ping` InputEvent at\s*\/\/ LIVEKIT_PING_INTERVAL_MS cadence; Agent 1's harness-side\s*\/\/ RoomDataDispatcher \+ LatencyCollector echoes it back as a\s*\/\/ `ping` DataReceived event\./,
    );
  });

  it("Dev-mode-only display framing pinned: 'Display: dev mode only (the v1.0 production UI doesn't surface latency; ops infra has it via the LK Server's own metrics). The hook is hooked into a small footer overlay component that reads import.meta.env.DEV to gate rendering.' — pinned so the v1.0-production-doesn't-surface + ops-infra-LK-Server-metrics + import.meta.env.DEV gate contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Display: dev mode only \(the v1\.0 production UI doesn't surface\s*\/\/ latency; ops infra has it via the LK Server's own metrics\)\.\s*\/\/ The hook is hooked into a small footer overlay component that\s*\/\/ reads `import\.meta\.env\.DEV` to gate rendering\./,
    );
  });

  it("LIVEKIT_PING_INTERVAL_MS = 2000 + LIVEKIT_PING_FRESH_WINDOW_MS = 6000 framing pinned: 'Send a ping every 2s. Tight enough that a customer with eyes on the panel sees fresh numbers; loose enough that the ping stream doesn't congest the DataChannel under load.' + 'RTT samples older than this are discarded — the displayed number always reflects the \"last 6 seconds\" of liveness.' — pinned so the 2s-interval-rationale + 6s-freshness-window contract all stay documented (drift to a longer interval would let stale displayed numbers persist)", () => {
    expect(body).toMatch(
      /\/\*\* Send a ping every 2s\. Tight enough that a customer with eyes\s*\*\s+on the panel sees fresh numbers; loose enough that the ping\s*\*\s+stream doesn't congest the DataChannel under load\. \*\/\s*export const LIVEKIT_PING_INTERVAL_MS = 2000;/,
    );
    expect(body).toMatch(
      /\/\*\* RTT samples older than this are discarded — the displayed\s*\*\s+number always reflects the "last 6 seconds" of liveness\. \*\/\s*export const LIVEKIT_PING_FRESH_WINDOW_MS = 6000;/,
    );
  });

  it("Outstanding-map bounded-cardinality framing pinned: 'Track outstanding ping timestamps in a Map so out-of-order echoes still resolve. Cardinality is bounded by the polling interval and the freshness window.' + outstanding.has(ts) stray-echo-ignore + Date.now()-ts > LIVEKIT_PING_FRESH_WINDOW_MS GC. Drift to dropping the bounded-cardinality GC would let outstanding grow unbounded on a stuck harness", () => {
    expect(body).toMatch(
      /\/\/ Track outstanding ping timestamps in a Map so out-of-order\s*\/\/ echoes still resolve\. Cardinality is bounded by the polling\s*\/\/ interval and the freshness window\./,
    );
    expect(body).toMatch(/if \(!outstanding\.has\(ts\)\) return; \/\/ stray echo — ignore/);
    expect(body).toMatch(
      /for \(const ts of outstanding\.keys\(\)\) \{\s*if \(timestamp - ts > LIVEKIT_PING_FRESH_WINDOW_MS\) outstanding\.delete\(ts\);\s*\}/,
    );
  });

  it("Garbage-collect-stale + drop-stale-on-echo + reliable:false ping framing pinned: outstanding.delete on echo + 'Drop stale samples (the harness was slow / network-jittered).' + sendInputEvent({type:'ping', timestamp}, {reliable: false}) — pinned so the at-most-fresh-sample-shown + reliable:false ping-uses-lossy contract all stay documented", () => {
    expect(body).toMatch(/outstanding\.delete\(ts\);\s*const rttMs = Date\.now\(\) - ts;/);
    expect(body).toMatch(
      /\/\/ Drop stale samples \(the harness was slow \/ network-jittered\)\.\s*if \(rttMs > LIVEKIT_PING_FRESH_WINDOW_MS\) return;/,
    );
    expect(body).toContain(
      "sendInputEvent(room, { type: 'ping', timestamp }, { reliable: false })",
    );
    // The fire-and-forget ping is .catch-guarded (and Promise.resolve-wrapped) so a
    // publish landing after room teardown ("PC manager is closed") can't escalate
    // to the global unhandledrejection handler and blank the app.
    expect(body).toContain('.catch(() => undefined)');
  });

  it("formatRtt stable-string framing pinned: 'Format an RTT in ms for the dev-mode chrome. Returns a stable string the badge can render.' + null → '— ms' + rttMs → `${state.rttMs.toString()} ms`. Drift to dropping the null branch would surface NaN/null in the dev badge", () => {
    expect(body).toMatch(
      /export function formatRtt\(state: LatencyState\): string \{\s*if \(state\.rttMs === null\) return '— ms';\s*return `\$\{state\.rttMs\.toString\(\)\} ms`;\s*\}/,
    );
  });

  it('Effect deps are the PRIMITIVE room + enabled, NOT the opts object — pinned so an inline `{ room, enabled }` caller (the natural usage) cannot make `opts` a fresh ref every render and thrash the ping loop (re-arm + immediate ping per re-render = DataChannel flood). opts is destructured at the top; the effect depends on [room, enabled]', () => {
    expect(body).toMatch(/const \{ room, enabled \} = opts;/);
    // The effect closes over the primitives + depends on them — never on [opts].
    expect(body).toMatch(/\}, \[room, enabled\]\);/);
    expect(body).not.toMatch(/\}, \[opts\]\);/);
  });
});
