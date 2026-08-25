// W459.A — drift guard for packages/webrtc-streaming/src/mock.ts.
// V-149 MockWebRtcStreamingService. Drift here either drops the
// deterministic clock (tests asserting exact ageMs/stats values
// flake under real timing) or breaks the negotiate('answer') →
// transition('connected') trigger (subscribers never get the
// connected event, GUI tests stall waiting for stream-ready).
//
//   • V-149 framing pinned + 'Deterministic outputs so tests can
//     assert exact shape without timing flakiness. Real production
//     implementation runs on the Mac mini fleet with browser-side
//     WebRTC peer connections.'
//   • MockStreamState: 5-field private interface (streamId +
//     sessionId + state + createdAtMs + subscribers Set).
//   • FAKE_OFFER_SDP constant with SDP m=video line.
//   • Implements both WebRtcStreamingService AND StreamRegistry.
//   • advanceClock test seam.
//   • createStream: id format `mock_stream_${padStart(8,'0')}`;
//     initial state 'connecting'; returns offer with FAKE_OFFER_SDP.
//   • negotiate: rejects on missing stream; answer→transition
//     ('connected'); always returns answer/FAKE_OFFER_SDP.
//   • submitIceCandidate: rejects on missing stream; otherwise
//     no-op resolve.
//   • subscribe: missing-stream returns no-op unsubscribe;
//     otherwise adds to set + returns delete-from-set unsubscribe.
//   • getStats: returns null on missing; otherwise snapshotStats.
//   • close: idempotent (resolve on missing); transitions to
//     'closed' + clears subscribers.
//   • StreamRegistry.list: accountId no-op framing pinned;
//     state filter.
//   • transition: sets state + fires state_changed event to all
//     subscribers.
//   • snapshotStats framing pinned 'Deterministic mock numbers —
//     connected streams report 30 fps, pre-connected streams
//     report 0. Real impl reads from the peer connection's
//     RTCStatsReport.' + 1500 kbps + 35ms RTT when connected.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/webrtc-streaming/src/mock.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W459.A packages/webrtc-streaming/src/mock.ts content parity', () => {
  const body = read(LIB);

  it("V-149 framing pinned: 'V-149 — mock WebRTC streaming service.' + 'Deterministic outputs so tests can assert exact shape without timing flakiness. Real production implementation runs on the Mac mini fleet with browser-side WebRTC peer connections.'", () => {
    expect(body).toMatch(/\/\/ V-149 — mock WebRTC streaming service\./);
    expect(body).toMatch(
      /\/\/ Deterministic outputs so tests can assert exact shape without\s*\/\/ timing flakiness\. Real production implementation runs on the Mac\s*\/\/ mini fleet with browser-side WebRTC peer connections\./,
    );
  });

  it("MockStreamState: 5-field private interface (streamId + sessionId + state + createdAtMs + subscribers Set); FAKE_OFFER_SDP constant with 'm=video 9 UDP/TLS/RTP/SAVPF 96' line", () => {
    expect(body).toMatch(
      /interface MockStreamState \{\s*streamId: StreamId;\s*sessionId: string;\s*state: StreamState;\s*createdAtMs: number;\s*subscribers: Set<\(event: StreamEvent\) => void>;\s*\}/,
    );
    expect(body).toMatch(
      /const FAKE_OFFER_SDP =\s*'v=0\\r\\no=- 0 0 IN IP4 127\.0\.0\.1\\r\\ns=-\\r\\nt=0 0\\r\\nm=video 9 UDP\/TLS\/RTP\/SAVPF 96\\r\\n';/,
    );
  });

  it("MockWebRtcStreamingService implements both WebRtcStreamingService AND StreamRegistry; nowMs deterministic clock 1714867200000 (2024-05-04Z); advanceClock test seam framing pinned 'Test seam: advance the deterministic clock.'", () => {
    expect(body).toMatch(
      /export class MockWebRtcStreamingService implements WebRtcStreamingService, StreamRegistry \{[\s\S]*?private readonly streams = new Map<StreamId, MockStreamState>\(\);[\s\S]*?private nextSeq = 1;[\s\S]*?private nowMs = 1714867200000;/,
    );
    expect(body).toMatch(
      /\/\*\* Test seam: advance the deterministic clock\. \*\/\s*advanceClock\(deltaMs: number\): void \{\s*this\.nowMs \+= deltaMs;\s*\}/,
    );
  });

  it("createStream: id format `mock_stream_${padStart(8, '0')}` + initial state:'connecting' + createdAtMs:nowMs + empty subscribers Set; returns offer with FAKE_OFFER_SDP", () => {
    expect(body).toMatch(
      /const streamId = `mock_stream_\$\{this\.nextSeq\.toString\(\)\.padStart\(8, '0'\)\}`;\s*this\.nextSeq \+= 1;\s*this\.streams\.set\(streamId, \{\s*streamId,\s*sessionId: opts\.sessionId,\s*state: 'connecting',\s*createdAtMs: this\.nowMs,\s*subscribers: new Set\(\),\s*\}\);/,
    );
    expect(body).toMatch(
      /return Promise\.resolve\(\{\s*streamId,\s*offer: \{ type: 'offer', sdp: FAKE_OFFER_SDP \},\s*\}\);/,
    );
  });

  it("negotiate: rejects 'stream not found: ${streamId}' on missing; answer payload → transition('connected') framing pinned 'Caller answered our offer. Transition to connected.'; always returns answer/FAKE_OFFER_SDP", () => {
    expect(body).toMatch(
      /return Promise\.reject\(new Error\(`stream not found: \$\{streamId\}`\)\);/,
    );
    expect(body).toMatch(
      /if \(payload\.type === 'answer'\) \{\s*\/\/ Caller answered our offer\. Transition to connected\.\s*this\.transition\(stream, 'connected'\);\s*\}\s*return Promise\.resolve\(\{ type: 'answer', sdp: FAKE_OFFER_SDP \}\);/,
    );
  });

  it("subscribe framing pinned: 'Subscriber to non-existent stream gets a no-op unsubscribe.' + missing-stream returns () => undefined; otherwise adds to set + returns delete-from-set fn", () => {
    expect(body).toMatch(
      /\/\/ Subscriber to non-existent stream gets a no-op unsubscribe\.\s*return \(\) => undefined;/,
    );
    expect(body).toMatch(
      /stream\.subscribers\.add\(handler\);\s*return \(\) => \{\s*stream\.subscribers\.delete\(handler\);\s*\};/,
    );
  });

  it("getStats: returns Promise.resolve(null) on missing; otherwise snapshotStats; close: idempotent (resolve on missing) + transition('closed') + subscribers.clear()", () => {
    expect(body).toMatch(
      /getStats\(streamId: StreamId\): Promise<StreamStats \| null> \{\s*const stream = this\.streams\.get\(streamId\);\s*if \(!stream\) return Promise\.resolve\(null\);\s*return Promise\.resolve\(this\.snapshotStats\(stream\)\);\s*\}/,
    );
    expect(body).toMatch(
      /close\(streamId: StreamId\): Promise<void> \{\s*const stream = this\.streams\.get\(streamId\);\s*if \(!stream\) return Promise\.resolve\(\);\s*this\.transition\(stream, 'closed'\);\s*stream\.subscribers\.clear\(\);\s*return Promise\.resolve\(\);\s*\}/,
    );
  });

  it("StreamRegistry.list framing pinned: 'accountId filtering is a no-op in the mock since we don't model account ownership. Tests that need it pass scoped fixtures.' + state filter via .filter on snapshotStats", () => {
    expect(body).toMatch(
      /\/\/ accountId filtering is a no-op in the mock since we don't model\s*\/\/ account ownership\. Tests that need it pass scoped fixtures\./,
    );
    expect(body).toMatch(
      /const all = \[\.\.\.this\.streams\.values\(\)\]\.map\(\(s\) => this\.snapshotStats\(s\)\);\s*const filtered = opts\.state === undefined \? all : all\.filter\(\(s\) => s\.state === opts\.state\);/,
    );
  });

  it('transition helper: sets stream.state + fires state_changed event with kind+state+at:nowMs to all subscribers', () => {
    expect(body).toMatch(
      /private transition\(stream: MockStreamState, next: StreamState\): void \{\s*stream\.state = next;\s*const event: StreamEvent = \{ kind: 'state_changed', state: next, at: this\.nowMs \};\s*for \(const handler of stream\.subscribers\) \{\s*handler\(event\);\s*\}/,
    );
  });

  it("snapshotStats framing pinned: 'Deterministic mock numbers — connected streams report 30 fps, pre-connected streams report 0. Real impl reads from the peer connection's RTCStatsReport.' + connected→1500kbps+35ms RTT; pre-connected→0+null RTT; packetLossFraction:0", () => {
    expect(body).toMatch(
      /\/\/ Deterministic mock numbers — connected streams report 30 fps,\s*\/\/ pre-connected streams report 0\. Real impl reads from the peer\s*\/\/ connection's RTCStatsReport\./,
    );
    expect(body).toMatch(
      /const fpsAvg = stream\.state === 'connected' \? 30 : 0;[\s\S]*?framesSent: Math\.floor\(\(ageMs \/ 1000\) \* fpsAvg\),[\s\S]*?bitrateKbpsAvg: stream\.state === 'connected' \? 1500 : 0,[\s\S]*?rttMs: stream\.state === 'connected' \? 35 : null,[\s\S]*?packetLossFraction: 0,/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
