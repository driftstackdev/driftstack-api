// W457.C — drift guard for packages/webrtc-streaming/src/interfaces.ts.
// V-149 WebRTC streaming service + registry interfaces. Drift here
// either drops the subscribe() unsubscribe-return-fn contract
// (consumers can't tear down event handlers, lose memory-leak guard
// on long-running GUI session views) or weakens close() idempotence
// framing (consumers double-call close on cleanup paths and
// re-throw on the second call).
//
//   • V-149 framing pinned + 'Phase 3+ work fills these in with
//     browser-side WebRTC + server-side signaling. Today the seam
//     exists so consumers (GUI client LiveSessionView, future
//     customer-dashboard live preview) can integrate against the
//     contract.'
//   • imports: 7 type-only from ./types.
//   • CreateStreamOpts: 2-field (sessionId + config); CreateStreamResult:
//     2-field (streamId + offer 'Server-side SDP offer').
//   • WebRtcStreamingService framing pinned: 'Top-level streaming
//     service. GUI client + customer dashboard both go through this
//     interface; the production implementation runs on the Mac mini
//     fleet (where the browser session lives) and exposes its
//     signaling via a server-side relay.'
//   • 6 methods: createStream + negotiate (renegotiation framing)
//     + submitIceCandidate (multiplex framing) + subscribe (returns
//     unsubscribe fn; polling-fallback framing) + getStats (V-139
//     /sessions at-a-glance metrics) + close (idempotence framing).
//   • StreamRegistry framing pinned 'read-only enumeration for
//     admin observability' + list signature with optional accountId
//     + state filter.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/webrtc-streaming/src/interfaces.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W457.C packages/webrtc-streaming/src/interfaces.ts content parity', () => {
  const body = read(LIB);

  it("V-149 framing pinned: 'V-149 — WebRTC streaming interfaces.' + 'Phase 3+ work fills these in with browser-side WebRTC + server-side signaling. Today the seam exists so consumers (GUI client LiveSessionView, future customer-dashboard live preview) can integrate against the contract.'", () => {
    expect(body).toMatch(/\/\/ V-149 — WebRTC streaming interfaces\./);
    expect(body).toMatch(
      /\/\/ Phase 3\+ work fills these in with browser-side WebRTC \+ server-\s*\/\/ side signaling\. Today the seam exists so consumers \(GUI client\s*\/\/ LiveSessionView, future customer-dashboard live preview\) can\s*\/\/ integrate against the contract\./,
    );
  });

  it('imports: 7 type-only from ./types (IceCandidate + SdpPayload + StreamConfig + StreamEvent + StreamId + StreamStats + StreamState)', () => {
    expect(body).toMatch(
      /import type \{\s*IceCandidate,\s*SdpPayload,\s*StreamConfig,\s*StreamEvent,\s*StreamId,\s*StreamStats,\s*StreamState,\s*\} from '\.\/types\.js';/,
    );
  });

  it("CreateStreamOpts: 2-field (sessionId + config); CreateStreamResult: 2-field (streamId + offer 'Server-side SDP offer. Caller's WebRTC peer answers via negotiate.')", () => {
    expect(body).toMatch(
      /\/\*\* Options for creating a new stream against a session\. \*\/\s*export interface CreateStreamOpts \{[\s\S]*?sessionId: string;[\s\S]*?config: StreamConfig;\s*\}/,
    );
    expect(body).toMatch(
      /\/\*\* Result of CreateStream — caller exchanges SDP via the same StreamId\. \*\/\s*export interface CreateStreamResult \{\s*streamId: StreamId;\s*\/\*\* Server-side SDP offer\. Caller's WebRTC peer answers via `negotiate`\. \*\/\s*offer: SdpPayload;\s*\}/,
    );
  });

  it("WebRtcStreamingService framing pinned: 'Top-level streaming service. GUI client + customer dashboard both go through this interface; the production implementation runs on the Mac mini fleet (where the browser session lives) and exposes its signaling via a server-side relay.'", () => {
    expect(body).toMatch(
      /\* Top-level streaming service\. GUI client \+ customer dashboard both go\s*\*\s*through this interface; the production implementation runs on the\s*\*\s*Mac mini fleet \(where the browser session lives\) and exposes its\s*\*\s*signaling via a server-side relay\./,
    );
  });

  it("createStream framing pinned: 'Begin streaming a session's browser tab. Returns the stream id + server-side SDP offer. Caller's peer connection answers via negotiate(streamId, answer).' + signature returns CreateStreamResult", () => {
    expect(body).toMatch(
      /\*\s*Begin streaming a session's browser tab\. Returns the stream id \+\s*\*\s*server-side SDP offer\. Caller's peer connection answers via\s*\*\s*`negotiate\(streamId, answer\)`\./,
    );
    expect(body).toMatch(/createStream\(opts: CreateStreamOpts\): Promise<CreateStreamResult>;/);
  });

  it("negotiate framing pinned: 'Exchange the caller's SDP answer (or a renegotiation offer mid-stream). Resolves to the server's response payload (answer when caller offered, answer when caller answered the original — implementations may need a follow-up offer for codec changes).'", () => {
    expect(body).toMatch(
      /\*\s*Exchange the caller's SDP answer \(or a renegotiation offer mid-stream\)\.\s*\*\s*Resolves to the server's response payload \(answer when caller offered,\s*\*\s*answer when caller answered the original — implementations may need\s*\*\s*a follow-up offer for codec changes\)\./,
    );
    expect(body).toMatch(
      /negotiate\(streamId: StreamId, payload: SdpPayload\): Promise<SdpPayload>;/,
    );
  });

  it("submitIceCandidate framing pinned: 'Submit an ICE candidate from the caller's side. The server multiplexes caller candidates into the active peer connection.'", () => {
    expect(body).toMatch(
      /\*\s*Submit an ICE candidate from the caller's side\. The server multiplexes\s*\*\s*caller candidates into the active peer connection\./,
    );
    expect(body).toMatch(
      /submitIceCandidate\(streamId: StreamId, candidate: IceCandidate\): Promise<void>;/,
    );
  });

  it("subscribe framing pinned: 'Returns an unsubscribe fn. Implementations push state changes, periodic stats samples, ICE candidates from the server side (which the caller then adds to its peer connection), and errors. Polling-based fallbacks implement this as a periodic stats fetch + state change diff.' + signature returns () => void", () => {
    expect(body).toMatch(
      /\*\s*Subscribe to stream events\. Returns an unsubscribe fn\.\s*\*\s*\*\s*Implementations push state changes, periodic stats samples,\s*\*\s*ICE candidates from the server side \(which the caller then adds\s*\*\s*to its peer connection\), and errors\. Polling-based fallbacks\s*\*\s*implement this as a periodic stats fetch \+ state change diff\./,
    );
    expect(body).toMatch(
      /subscribe\(streamId: StreamId, handler: \(event: StreamEvent\) => void\): \(\) => void;/,
    );
  });

  it("getStats framing pinned: 'Look up the current state + stats for a stream without subscribing. Used by the customer dashboard for at-a-glance metrics on the sessions list page (V-139 /sessions).'", () => {
    expect(body).toMatch(
      /\*\s*Look up the current state \+ stats for a stream without subscribing\.\s*\*\s*Used by the customer dashboard for at-a-glance metrics on the\s*\*\s*sessions list page \(V-139 \/sessions\)\./,
    );
    expect(body).toMatch(/getStats\(streamId: StreamId\): Promise<StreamStats \| null>;/);
  });

  it("close framing pinned: 'End a stream cleanly. Implementations close the peer connection, release server-side capture resources, drop the signaling channel. Idempotent — calling close on an already-closed stream is a no-op.'", () => {
    expect(body).toMatch(
      /\*\s*End a stream cleanly\. Implementations close the peer connection,\s*\*\s*release server-side capture resources, drop the signaling channel\.\s*\*\s*Idempotent — calling close on an already-closed stream is a no-op\./,
    );
    expect(body).toMatch(/close\(streamId: StreamId\): Promise<void>;/);
  });

  it("StreamRegistry framing pinned 'Stream registry — read-only enumeration for admin observability.' + list signature with optional accountId + state filter; returns readonly StreamStats[]", () => {
    expect(body).toMatch(
      /\/\*\* Stream registry — read-only enumeration for admin observability\. \*\/\s*export interface StreamRegistry \{\s*\/\*\* List active streams, optionally scoped to an account\. \*\/\s*list\(opts\?: \{ accountId\?: string; state\?: StreamState \}\): Promise<readonly StreamStats\[\]>;\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
