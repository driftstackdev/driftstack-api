// W564.C — drift guard for /docs/internal/v531-cross-agent-contract.md.
// V-531 STAGED 2026-05-10 Wave-17. Drift here either weakens the
// FrameSource interface contract for WebKit-fork frame extraction,
// drops the IPC envelope wire-format (16-byte header + magic-DSFS),
// or unsets the Agent-1 vs Agent-2 cross-repo coordination protocol.
//
//   • V-531. STAGED. WKWebView frame extraction cross-agent contract.
//   • Agent 2 (this repo) owns pipeline consumer side + MockFrameSource.
//   • Agent 1 (webkit-driftstack) owns WkWebViewFrameSource producer.
//   • Rule G: this repo does NOT touch webkit-driftstack.
//   • FrameSource interface at packages/webrtc-streaming/src/frame-
//     source.ts (start + pullNextFrame + stop + getState).
//   • IPC envelope: 16-byte header + variable data; Unix socket
//     /var/run/driftstack/wkwebview-<session-id>.sock; magic DSFS.
//   • Wave-17 ships interface+mock+pipeline+contract doc; Wave-18+
//     Agent 1 implements WebKit-side; integration wave Agent 2 wires.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v531-cross-agent-contract.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W564.C /docs/internal/v531-cross-agent-contract.md content parity', () => {
  const body = read(LIB);

  it("Header + V-531-STAGED-Wave-17 + cross-agent-scope framing pinned: '# V-531 — cross-agent contract: WKWebView frame extraction' + '**Date:** 2026-05-10' + '**Wave:** 17' + '**Status:** STAGED — interface lives in `packages/webrtc-streaming/src/frame-source.ts`;' + 'WebKit-side implementation is Agent 1's scope.' + 'V-531 builds the server-side encode pipeline for live-streaming a session's' + 'browser. The frame source (input to the pipeline) lives on the harness side —' + 'in the WebKit fork, where the WKWebView surface is accessible. The pipeline' + '(output to WebRTC) lives in this repo.' + '| 2     | `driftstack-api` (this repo)      | Pipeline consumer side: `FrameSource` interface declaration + `MockFrameSource` for solo testing + `EncodePipeline` that consumes frames + emits WebRTC-ready chunks.' + '| 1     | `webkit-driftstack` (sister repo) | Pipeline producer side: real `WkWebViewFrameSource` implementing the `FrameSource` interface contract, sourcing frames from `WKWebView` surface capture' + 'Per Rule G, this repo (Agent 2) does NOT touch the webkit-driftstack repo.' — pinned so the V-531-STAGED-Wave-17-2026-05-10 + Agent-1-WebKit-fork-Agent-2-this-repo + Agent-2-pipeline-consumer-MockFrameSource + Agent-1-WkWebViewFrameSource-producer-WKWebView-surface-capture + Rule-G-no-cross-touch commitment survives", () => {
    expect(body).toMatch(/^# V-531 — cross-agent contract: WKWebView frame extraction$/m);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-10/);
    expect(body).toMatch(/\*\*Wave:\*\* 17/);
    expect(body).toMatch(
      /\*\*Status:\*\* STAGED — interface lives in `packages\/webrtc-streaming\/src\/frame-source\.ts`;/,
    );
    expect(body).toMatch(/WebKit-side implementation is Agent 1's scope\./);
    expect(body).toMatch(
      /V-531 builds the server-side encode pipeline for live-streaming a session's/,
    );
    expect(body).toMatch(
      /browser\. The frame source \(input to the pipeline\) lives on the harness side —/,
    );
    expect(body).toMatch(
      /in the WebKit fork, where the WKWebView surface is accessible\. The pipeline/,
    );
    expect(body).toMatch(/\(output to WebRTC\) lives in this repo\./);
    expect(body).toMatch(
      /\| 2\s+\| `driftstack-api` \(this repo\)\s+\| Pipeline consumer side: `FrameSource` interface declaration \+ `MockFrameSource` for solo testing \+ `EncodePipeline` that consumes frames \+ emits WebRTC-ready chunks\./,
    );
    expect(body).toMatch(
      /\| 1\s+\| `webkit-driftstack` \(sister repo\) \| Pipeline producer side: real `WkWebViewFrameSource` implementing the `FrameSource` interface contract, sourcing frames from `WKWebView` surface capture/,
    );
    expect(body).toMatch(
      /Per Rule G, this repo \(Agent 2\) does NOT touch the webkit-driftstack repo\./,
    );
  });

  it("Interface contract + IPC envelope framing pinned: '## Interface contract' + '`packages/webrtc-streaming/src/frame-source.ts`' + 'export interface FrameSource' + 'start(config: FrameSourceConfig): Promise<void>' + 'pullNextFrame(): Promise<VideoFrame | null>' + 'stop(): Promise<void>' + 'getState(): 'idle' | 'starting' | 'running' | 'stopped' | 'failed'' + 'export interface VideoFrame' + 'timestampMicros: number' + 'pixelFormat: 'I420' | 'NV12' | 'BGRA' | 'RGBA'' + 'sequence: number' + 'export interface FrameSourceConfig' + 'targetFps: number' + 'preferredPixelFormat: FramePixelFormat' + 'The `MockFrameSource` in the same file is the reference implementation' + 'Agent 1's `WkWebViewFrameSource` must satisfy the same interface contract' + '## IPC envelope' + '**Channel:** Unix domain socket at `/var/run/driftstack/wkwebview-<session-id>.sock`' + '(production) OR a stdio pipe (dev mode).' + '16-byte header' + 'variable-byte data' + 'magic           | `0xDF 0x57 0x46 0x53` ('DSFS' — DriftStack Frame Source)' + 'sequence        | u32 — matches `VideoFrame.sequence`' + 'width           | u16' + 'height          | u16' — pinned so the FrameSource-4-method (start/pullNextFrame/stop/getState) + VideoFrame-pixelFormat-4-options (I420/NV12/BGRA/RGBA) + FrameSourceConfig-targetFps + MockFrameSource-reference + Unix-socket-/var/run/driftstack-stdio-dev + 16-byte-header + magic-DSFS-0xDF0x570x460x53 + u32-sequence + u16-width-height commitment survives", () => {
    expect(body).toMatch(/## Interface contract/);
    expect(body).toMatch(/`packages\/webrtc-streaming\/src\/frame-source\.ts`/);
    expect(body).toMatch(/export interface FrameSource \{/);
    expect(body).toMatch(/start\(config: FrameSourceConfig\): Promise<void>;/);
    expect(body).toMatch(/pullNextFrame\(\): Promise<VideoFrame \| null>;/);
    expect(body).toMatch(/stop\(\): Promise<void>;/);
    expect(body).toMatch(
      /getState\(\): 'idle' \| 'starting' \| 'running' \| 'stopped' \| 'failed';/,
    );
    expect(body).toMatch(/export interface VideoFrame \{/);
    expect(body).toMatch(/timestampMicros: number;/);
    expect(body).toMatch(/pixelFormat: 'I420' \| 'NV12' \| 'BGRA' \| 'RGBA';/);
    expect(body).toMatch(/sequence: number;/);
    expect(body).toMatch(/export interface FrameSourceConfig \{/);
    expect(body).toMatch(/targetFps: number;/);
    expect(body).toMatch(/preferredPixelFormat: FramePixelFormat;/);
    expect(body).toMatch(/The `MockFrameSource` in the same file is the reference implementation/);
    expect(body).toMatch(/Agent 1's `WkWebViewFrameSource` must/);
    expect(body).toMatch(/satisfy the same interface contract/);
    expect(body).toMatch(/## IPC envelope/);
    expect(body).toMatch(
      /\*\*Channel:\*\* Unix domain socket at `\/var\/run\/driftstack\/wkwebview-<session-id>\.sock`/,
    );
    expect(body).toMatch(/\(production\) OR a stdio pipe \(dev mode\)\./);
    expect(body).toMatch(/16-byte header/);
    expect(body).toMatch(/variable-byte data/);
    expect(body).toMatch(/magic\s+\| `0xDF 0x57 0x46 0x53` \('DSFS' — DriftStack Frame Source\)/);
    expect(body).toMatch(/sequence\s+\| u32 — matches `VideoFrame\.sequence`/);
    expect(body).toMatch(/width\s+\| u16/);
    expect(body).toMatch(/height\s+\| u16/);
  });

  it("Coordination protocol + changes + acceptable-verification framing pinned: '## Coordination protocol' + '**Wave 17 (this wave):** Agent 2 ships the interface, mock, and' + 'Cross-agent contract document published (this file).' + '**Wave 18 onward:** Agent 1 implements `WkWebViewFrameSource` in' + 'webkit-driftstack against this contract.' + '**Integration wave (Agent 2 — TBD):** Agent 2 wires the real' + 'swap `MockFrameSource` for `IpcFrameSource` in the production' + '`WebRtcStreamingService` impl' + '## Changes to this contract' + 'ANY interface change requires a coordinated commit pair (one in each repo)' + 'referencing the same V-531-update slice.' + 'The two commits must land before' + 'either repo's CI passes for the wave that introduced the change.' + 'If Agent 1 needs an IPC envelope tweak that doesn't change the language-' + 'level interface, no Agent 2 work is needed' + '## Acceptable Wave 17 verification' + 'npx vitest run packages/webrtc-streaming/tests/' + 'encode-pipeline.test.ts (12 tests this wave).' + '`MockFrameSource` honours the `FrameSource` interface as compiled by' + '`tsc --noEmit`' + 'Real wire-protocol negotiation between agents happens in the next wave' — pinned so the 3-coordination-step (Wave-17-interface-mock-pipeline + Wave-18-Agent-1-WebKit + Integration-Agent-2-IpcFrameSource-swap) + coordinated-commit-pair-per-V-531-update + Agent-1-envelope-tweak-no-Agent-2-work + 12-encode-pipeline-tests + tsc-noEmit-compile-check commitment survives", () => {
    expect(body).toMatch(/## Coordination protocol/);
    expect(body).toMatch(
      /1\. \*\*Wave 17 \(this wave\):\*\* Agent 2 ships the interface, mock, and/,
    );
    expect(body).toMatch(/Cross-agent contract document published \(this file\)\./);
    expect(body).toMatch(
      /2\. \*\*Wave 18 onward:\*\* Agent 1 implements `WkWebViewFrameSource` in/,
    );
    expect(body).toMatch(/webkit-driftstack against this contract\./);
    expect(body).toMatch(/3\. \*\*Integration wave \(Agent 2 — TBD\):\*\* Agent 2 wires the real/);
    expect(body).toMatch(/swap `MockFrameSource` for `IpcFrameSource` in the production/);
    expect(body).toMatch(/`WebRtcStreamingService` impl/);
    expect(body).toMatch(/## Changes to this contract/);
    expect(body).toMatch(
      /ANY interface change requires a coordinated commit pair \(one in each repo\)/,
    );
    expect(body).toMatch(/referencing the same V-531-update slice\./);
    expect(body).toMatch(/The two commits must land before/);
    expect(body).toMatch(/either repo's CI passes for the wave that introduced the change\./);
    expect(body).toMatch(
      /If Agent 1 needs an IPC envelope tweak that doesn't change the language-/,
    );
    expect(body).toMatch(/level interface, no Agent 2 work is needed/);
    expect(body).toMatch(/## Acceptable Wave 17 verification/);
    expect(body).toMatch(/npx vitest run packages\/webrtc-streaming\/tests\//);
    expect(body).toMatch(/new `encode-pipeline\.test\.ts` \(12 tests this wave\)/);
    expect(body).toMatch(/`MockFrameSource` honours the `FrameSource` interface as compiled by/);
    expect(body).toMatch(/`tsc --noEmit`/);
    expect(body).toMatch(/Real wire-protocol negotiation between agents happens in the next wave/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
