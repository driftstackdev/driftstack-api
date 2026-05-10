# V-531 — cross-agent contract: WKWebView frame extraction

**Date:** 2026-05-10
**Wave:** 17
**Status:** STAGED — interface lives in `packages/webrtc-streaming/src/frame-source.ts`;
WebKit-side implementation is Agent 1's scope.

## Purpose

V-531 builds the server-side encode pipeline for live-streaming a session's
browser. The frame source (input to the pipeline) lives on the harness side —
in the WebKit fork, where the WKWebView surface is accessible. The pipeline
(output to WebRTC) lives in this repo.

This document captures the cross-agent handshake: the interface contract,
the IPC envelope, and the coordination protocol.

## Cross-agent scope

| Agent | Repo                              | Responsibility                                                                                                                                                                                                        |
| ----- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2     | `driftstack-api` (this repo)      | Pipeline consumer side: `FrameSource` interface declaration + `MockFrameSource` for solo testing + `EncodePipeline` that consumes frames + emits WebRTC-ready chunks.                                                 |
| 1     | `webkit-driftstack` (sister repo) | Pipeline producer side: real `WkWebViewFrameSource` implementing the `FrameSource` interface contract, sourcing frames from `WKWebView` surface capture, shipping them across an IPC boundary into the control plane. |

Per Rule G, this repo (Agent 2) does NOT touch the webkit-driftstack repo.
Agent 1 picks up the WebKit-side implementation in coordination with this
contract.

## Interface contract

The language-level interface is declared at
`packages/webrtc-streaming/src/frame-source.ts`:

```ts
export interface FrameSource {
  start(config: FrameSourceConfig): Promise<void>;
  pullNextFrame(): Promise<VideoFrame | null>;
  stop(): Promise<void>;
  getState(): 'idle' | 'starting' | 'running' | 'stopped' | 'failed';
}

export interface VideoFrame {
  timestampMicros: number;
  width: number;
  height: number;
  pixelFormat: 'I420' | 'NV12' | 'BGRA' | 'RGBA';
  data: Uint8Array;
  sequence: number;
}

export interface FrameSourceConfig {
  targetFps: number;
  targetWidth: number;
  targetHeight: number;
  preferredPixelFormat: FramePixelFormat;
}
```

The `MockFrameSource` in the same file is the reference implementation
the encode pipeline tests against. Agent 1's `WkWebViewFrameSource` must
satisfy the same interface contract so callers can swap implementations
without code changes on the pipeline side.

## IPC envelope

The WebKit fork process is separate from the control-plane Node process.
Frames cross the boundary. Proposed envelope (Agent 1 confirms in their
implementation wave):

**Channel:** Unix domain socket at `/var/run/driftstack/wkwebview-<session-id>.sock`
(production) OR a stdio pipe (dev mode).

**Envelope (per frame):**

```
+---------------------+----------------------+
| 16-byte header      |  variable-byte data  |
+---------------------+----------------------+
```

Header layout (little-endian):

| Bytes  | Field           | Notes                                                                                            |
| ------ | --------------- | ------------------------------------------------------------------------------------------------ |
| 0..3   | magic           | `0xDF 0x57 0x46 0x53` ('DSFS' — DriftStack Frame Source)                                         |
| 4..7   | sequence        | u32 — matches `VideoFrame.sequence`                                                              |
| 8..11  | timestampMicros | u32 low bits — combine with `timestampMicrosHi` in next frame OR widen to u64 (TBD with Agent 1) |
| 12..13 | width           | u16                                                                                              |
| 14..15 | height          | u16                                                                                              |

A 1-byte pixel-format code follows in the first data byte if width <
65535; alternatively, format is fixed at session start in `FrameSourceConfig`.
TBD with Agent 1 — the envelope is small enough that explicit per-frame
format costs nothing.

Data bytes are the raw pixel payload, length = derived from (format, width, height).

## Coordination protocol

1. **Wave 17 (this wave):** Agent 2 ships the interface, mock, and
   pipeline (this directory). Pipeline tests pass against the mock.
   Cross-agent contract document published (this file).
2. **Wave 18 onward:** Agent 1 implements `WkWebViewFrameSource` in
   webkit-driftstack against this contract. Lands the IPC envelope
   parser on the WebKit side + the wire-format on the C++/Obj-C side
   of the bridge.
3. **Integration wave (Agent 2 — TBD):** Agent 2 wires the real
   `WkWebViewFrameSource` consumer-side (an IPC envelope reader that
   implements the `FrameSource` interface from the Unix socket). At that
   point, swap `MockFrameSource` for `IpcFrameSource` in the production
   `WebRtcStreamingService` impl; integration test covers the full path.

## Changes to this contract

ANY interface change requires a coordinated commit pair (one in each repo)
referencing the same V-531-update slice. The two commits must land before
either repo's CI passes for the wave that introduced the change.

If Agent 1 needs an IPC envelope tweak that doesn't change the language-
level interface, no Agent 2 work is needed — the envelope is hidden behind
the language interface.

## Acceptable Wave 17 verification

- `npx vitest run packages/webrtc-streaming/tests/` passes including the
  new `encode-pipeline.test.ts` (12 tests this wave).
- `MockFrameSource` honours the `FrameSource` interface as compiled by
  `tsc --noEmit`.
- This document committed to `docs/internal/v531-cross-agent-contract.md`
  so Agent 1 can pick up the WebKit-side work next.

Real wire-protocol negotiation between agents happens in the next wave on
each side.
