// W456.C — drift guard for packages/webrtc-streaming/src/types.ts.
// V-149 WebRTC streaming types stub. Drift here either drops a
// state from StreamState 5-value union ('connecting'|'connected'|
// 'reconnecting'|'closed'|'failed' — caller switches lose case
// coverage and silently swallow lifecycle transitions) or breaks
// the StreamEvent 4-kind discriminated union (consumers fall
// through the unmatched case and silently drop events).
//
//   • V-149 framing pinned + 'Streaming is out of scope for v1 —
//     may land inside the GUI workstream if scope allows, otherwise
//     polling-based screenshots ship first. V-149 lands the seam
//     so future work can drop in behind a stable interface.'
//   • Use-case framing pinned: 'live-view a session running on a
//     Driftstack-controlled browser. Screenshots-on-demand work
//     today; WebRTC unlocks streaming — continuous frames at 30+
//     fps, low latency, no per-frame HTTP cost.'
//   • StreamId = string with 'Stable across re-attaches' framing.
//   • SdpPayload: 2-field (type 'offer'|'answer' + sdp opaque
//     string).
//   • IceCandidate: 3-field (candidate + sdpMLineIndex
//     'Media-section index' + sdpMid 'Media-section ID').
//   • StreamConfig: 4-field (targetFps + targetBitrateKbps +
//     audio 'Mostly false for browser sessions' + iceServers).
//   • IceServer: urls (string|readonly string[]) + optional
//     username + credential.
//   • StreamState: 5-value union with per-state inline comments.
//   • StreamStats: 8-field (streamId + state + ageMs + framesSent +
//     fpsAvg + bitrateKbpsAvg + rttMs nullable + packetLossFraction).
//   • StreamEvent: 4-kind discriminated union (state_changed +
//     stats_sample + ice_candidate + error with recoverable flag).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/webrtc-streaming/src/types.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W456.C packages/webrtc-streaming/src/types.ts content parity', () => {
  const body = read(LIB);

  it("V-149 framing pinned: 'V-149 — WebRTC streaming types.' + 'Streaming is out of scope for v1 — may land inside the GUI workstream if scope allows, otherwise polling-based screenshots ship first. V-149 lands the seam so future work can drop in behind a stable interface.'", () => {
    expect(body).toMatch(/\/\/ V-149 — WebRTC streaming types\./);
    expect(body).toMatch(
      /\/\/ Streaming is out of scope for v1 — may land inside the GUI workstream\s*\/\/ if scope allows, otherwise polling-based screenshots ship first\.\s*\/\/ V-149 lands the seam so future work can drop in behind a stable\s*\/\/ interface\./,
    );
  });

  it("Use-case framing pinned: 'live-view a session running on a Driftstack-controlled browser. Screenshots-on-demand work today (apps/server/src/routes/sessions.ts → /v1/sessions/:id/capture). WebRTC unlocks streaming — continuous frames at 30+ fps, low latency, no per-frame HTTP cost.'", () => {
    expect(body).toMatch(
      /\/\/ Use case: live-view a session running on a Driftstack-controlled\s*\/\/ browser\. Screenshots-on-demand work today \(apps\/server\/src\/routes\/\s*\/\/ sessions\.ts → \/v1\/sessions\/:id\/capture\)\. WebRTC unlocks streaming —\s*\/\/ continuous frames at 30\+ fps, low latency, no per-frame HTTP cost\./,
    );
  });

  it("StreamId = string 'Stable across re-attaches' framing pinned", () => {
    expect(body).toMatch(
      /\/\*\* Public stream identifier\. Stable across re-attaches\. \*\/\s*export type StreamId = string;/,
    );
  });

  it("SdpPayload: 2-field (type 'offer'|'answer' + sdp string) framing 'SDP offer/answer payload, opaque to consumers.'", () => {
    expect(body).toMatch(
      /\/\*\* SDP offer\/answer payload, opaque to consumers\. \*\/\s*export interface SdpPayload \{\s*type: 'offer' \| 'answer';\s*sdp: string;\s*\}/,
    );
  });

  it("IceCandidate: 3-field (candidate + sdpMLineIndex 'Media-section index' nullable + sdpMid 'Media-section ID' nullable); 'exchanged during connection establishment' framing pinned", () => {
    expect(body).toMatch(
      /\/\*\* ICE candidate — exchanged during connection establishment\. \*\/\s*export interface IceCandidate \{\s*candidate: string;\s*\/\*\* Media-section index\. \*\/\s*sdpMLineIndex: number \| null;\s*\/\*\* Media-section ID\. \*\/\s*sdpMid: string \| null;\s*\}/,
    );
  });

  it("StreamConfig: 4-field (targetFps 'Implementations may degrade under bandwidth pressure' + targetBitrateKbps + audio 'Mostly false for browser sessions' + iceServers); IceServer: urls string|readonly string[] + optional username + credential", () => {
    expect(body).toMatch(
      /export interface StreamConfig \{\s*\/\*\* Target frame rate\. Implementations may degrade under bandwidth pressure\. \*\/\s*targetFps: number;[\s\S]*?targetBitrateKbps: number;[\s\S]*?\/\*\* Audio capture in addition to video\? Mostly false for browser sessions\. \*\/\s*audio: boolean;[\s\S]*?\/\*\* ICE servers \(STUN \/ TURN\) for NAT traversal\. \*\/\s*iceServers: readonly IceServer\[\];/,
    );
    expect(body).toMatch(
      /export interface IceServer \{\s*urls: string \| readonly string\[\];\s*username\?: string;\s*credential\?: string;\s*\}/,
    );
  });

  it("StreamState: 5-value union with per-state inline comments (connecting 'signaling exchange in progress' + connected 'peer connection established + media flowing' + reconnecting 'transient failure, attempting recovery' + closed 'stream ended cleanly' + failed 'stream ended with an error')", () => {
    expect(body).toMatch(
      /export type StreamState =\s*\| 'connecting' \/\/ signaling exchange in progress\s*\| 'connected' \/\/ peer connection established \+ media flowing\s*\| 'reconnecting' \/\/ transient failure, attempting recovery\s*\| 'closed' \/\/ stream ended cleanly\s*\| 'failed'; \/\/ stream ended with an error/,
    );
  });

  it("StreamStats: 8-field (streamId + state + ageMs + framesSent 'Frames sent in the last sample window' + fpsAvg + bitrateKbpsAvg + rttMs nullable 'peer connection RTT' + packetLossFraction '0..1')", () => {
    expect(body).toMatch(
      /export interface StreamStats \{[\s\S]*?streamId: StreamId;[\s\S]*?state: StreamState;[\s\S]*?ageMs: number;[\s\S]*?\/\*\* Frames sent in the last sample window\. \*\/\s*framesSent: number;[\s\S]*?fpsAvg: number;[\s\S]*?bitrateKbpsAvg: number;[\s\S]*?\/\*\* Round-trip time in ms \(peer connection RTT\)\. \*\/\s*rttMs: number \| null;[\s\S]*?\/\*\* Packet loss fraction \(0\.\.1\)\. \*\/\s*packetLossFraction: number;/,
    );
  });

  it("StreamEvent: 4-kind discriminated union (state_changed {state + at} + stats_sample {stats} + ice_candidate {candidate} + error {message + recoverable boolean}); 'Event emitted by a stream during its lifecycle.' framing pinned", () => {
    expect(body).toMatch(
      /\/\*\* Event emitted by a stream during its lifecycle\. \*\/\s*export type StreamEvent =\s*\| \{ kind: 'state_changed'; state: StreamState; at: number \}\s*\| \{ kind: 'stats_sample'; stats: StreamStats \}\s*\| \{ kind: 'ice_candidate'; candidate: IceCandidate \}\s*\| \{ kind: 'error'; message: string; recoverable: boolean \};/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
