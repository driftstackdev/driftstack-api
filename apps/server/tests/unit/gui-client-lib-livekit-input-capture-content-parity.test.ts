// Drift guard for apps/gui-client/src/lib/livekit-input-capture.ts.
// Pins LK.6.d keyboard + mouse capture on the AgentSessionPanel
// video element. Coordinate translation viewport-space via
// naturalWidth/rect.width ratio + reliable=true on click/key/wheel +
// reliable=false on mouseMove (lossy ok). Pointer-capture on mouseDown
// keeps subsequent move/up landing even when cursor leaves bounds.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/livekit-input-capture.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('gui-client/lib/livekit-input-capture content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("LK.6.d module-level framing pinned: 'keyboard + mouse capture on the AgentSessionPanel video element. Translates browser events to the InputEvent JSON schema Agent 1's Mac-side Quartz CGEvent decoder (commit 9170da82) accepts, and ships them via the LiveKit DataChannel.' — pinned so the LK.6.d anchor + browser-to-InputEvent translation + Agent 1 commit 9170da82 cross-reference all stay documented", () => {
    expect(body).toMatch(
      /\/\/ LK\.6\.d — keyboard \+ mouse capture on the AgentSessionPanel\s*\n?\s*\/\/ video element\. Translates browser events to the InputEvent\s*\n?\s*\/\/ JSON schema Agent 1's Mac-side Quartz CGEvent decoder \(commit\s*\n?\s*\/\/ 9170da82\) accepts, and ships them via the LiveKit DataChannel\./,
    );
  });

  it("Coordinate-translation framing pinned (#7 letterbox-aware): the <video> uses object-contain + FILLS its container, so the bounding rect is NOT the visible video region — map against the contained sub-rect + return null for clicks in the bars; convert the in-region pointer via the naturalWidth / displayedWidth ratio. Pinned so the letterbox-aware contract stays documented (the prior 'rect IS the visible region' assumption mis-mapped clicks on aspect-mismatched streams).", () => {
    expect(body).toMatch(
      /the element's\s*\n?\s*\/\/\s+bounding rect is NOT the visible video region\./,
    );
    expect(body).toMatch(/clicks in\s*\n?\s*\/\/\s+the bars are off-surface and return null\./);
    expect(body).toMatch(/`naturalWidth \/ displayedWidth` ratio\./);
  });

  it("Reliability framing pinned: 'Mouse down/up, key down/up, wheel: reliable=true (must arrive in order; missed events break click logic).' + 'mouseMove: reliable=false (lossy ok — cursor jitter at the remote side is preferable to congesting the data channel when the user moves quickly).' — pinned so the reliability-split contract stays documented (drift to reliable=true on mouseMove would congest the DataChannel on fast cursor motion; drift to reliable=false on click would lose click events on transient congestion)", () => {
    expect(body).toMatch(
      /\/\/\s+- Mouse down\/up, key down\/up, wheel: reliable=true \(must\s*\n?\s*\/\/\s+arrive in order; missed events break click logic\)\./,
    );
    expect(body).toMatch(
      /\/\/\s+- mouseMove: reliable=false \(lossy ok — cursor jitter at the\s*\n?\s*\/\/\s+remote side is preferable to congesting the data channel\s*\n?\s*\/\/\s+when the user moves quickly\)\./,
    );
  });

  it("Pointer-capture framing pinned: 'when mouseDown fires the capture pointer-captures the video element so subsequent mouseMove / mouseUp land even when the cursor leaves the element bounds (matches remote-desktop UX expectation).' + setPointerCapture(pointerId) inside try/catch with 'Browser may refuse pointer-capture — non-fatal.' — pinned so the remote-desktop-UX + non-fatal-refuse contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Pointer-capture: when mouseDown fires the capture pointer-\s*\n?\s*\/\/ captures the video element so subsequent mouseMove \/ mouseUp\s*\n?\s*\/\/ land even when the cursor leaves the element bounds \(matches\s*\n?\s*\/\/ remote-desktop UX expectation\)\./,
    );
    expect(body).toMatch(
      /try \{\s*\n?\s*if \('setPointerCapture' in video && 'pointerId' in e\) \{\s*\n?\s*\(video as any\)\.setPointerCapture\(\(e as any\)\.pointerId\);\s*\n?\s*\}\s*\n?\s*\} catch \{\s*\n?\s*\/\/ Browser may refuse pointer-capture — non-fatal\./,
    );
  });

  it('pointerToViewport letterbox-aware coord math pinned (#7): elementAspect/videoAspect object-contain fit → displayed sub-rect, pointer offset by the centering bars, null when outside the contained region (a bar click), then (px/dispW)*nw + (py/dispH)*nh + Math.round — pinned so the object-contain mapping + bar-rejection stays documented (drift back to the full-rect ratio mis-places every click on an aspect-mismatched stream; dropping Math.round lets fractional CGEvent coords slip through)', () => {
    expect(body).toMatch(/const elementAspect = rect\.width \/ rect\.height;/);
    expect(body).toMatch(/const videoAspect = nw \/ nh;/);
    expect(body).toMatch(/if \(px < 0 \|\| px > dispW \|\| py < 0 \|\| py > dispH\) return null;/);
    expect(body).toMatch(
      /const x = \(px \/ dispW\) \* nw;\s*\n?\s*const y = \(py \/ dispH\) \* nh;\s*\n?\s*return \{ x: Math\.round\(x\), y: Math\.round\(y\) \};/,
    );
  });

  it('2026-05-20 — modifiersFromEvent roster swapped from DOM-standard Shift/Control/Alt/Meta to Mac-native cmd/ctrl/shift/option (1:1 with kCGEventFlagMask* on the harness side; eliminates the harness-side Meta→Command remap on every key press). Order swapped to metaKey/ctrlKey/shiftKey/altKey so cmd surfaces first in the canonical label sequence.', () => {
    expect(body).toMatch(
      /if \(event\.metaKey\) mods\.push\('cmd'\);\s*\n?\s*if \(event\.ctrlKey\) mods\.push\('ctrl'\);\s*\n?\s*if \(event\.shiftKey\) mods\.push\('shift'\);\s*\n?\s*if \(event\.altKey\) mods\.push\('option'\);\s*\n?\s*return mods\.length > 0 \? mods : undefined;/,
    );
  });

  it("Keyboard-on-window-not-video framing pinned: 'Keyboard events go on window so capture works even when the <video> isn't directly focused. Side-effect: the customer can type into the remote browser without first clicking on the video. Trade-off: pressing a key with the panel mounted forwards it everywhere — acceptable because the panel is the only LK consumer in v1.0.' — pinned so the v1.0-trade-off + only-LK-consumer-assumption contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Keyboard events go on window so capture works even when the\s*\n?\s*\/\/ <video> isn't directly focused\. Side-effect: the customer can\s*\n?\s*\/\/ type into the remote browser without first clicking on the\s*\n?\s*\/\/ video\. Trade-off: pressing a key with the panel mounted\s*\n?\s*\/\/ forwards it everywhere — acceptable because the panel is the\s*\n?\s*\/\/ only LK consumer in v1\.0\./,
    );
  });
});
