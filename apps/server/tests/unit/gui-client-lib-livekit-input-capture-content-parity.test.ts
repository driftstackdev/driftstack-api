// Drift guard for apps/gui-client/src/lib/livekit-input-capture.ts.
// Pins LK.6.d keyboard + mouse capture on the AgentSessionPanel
// video element. Coordinate translation viewport-space via
// naturalWidth/rect.width ratio + reliable gesture boundaries/lifecycle
// anchors with lossy intermediate moves. Pointer-capture on mouseDown keeps
// subsequent move/up landing even when cursor leaves bounds.

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

  it("LK.6.d module-level framing pinned (touch translation, W198/W1249): input capture translating the user's mouse/trackpad gestures into iPhone-COHERENT TOUCH InputEvents shipped over the LiveKit DataChannel to Agent-1's W3C touch injector — pinned so the LK.6.d anchor + the why-touch-not-mouse coherence contract (a real iPhone never fires mouse events) stays documented", () => {
    expect(body).toMatch(
      /\/\/ LK\.6\.d — input capture on the simulator's video element\. Translates the\s*\/\/ user's mouse\/trackpad gestures into iPhone-COHERENT TOUCH InputEvents and\s*\/\/ ships them over the LiveKit DataChannel to Agent-1's Mac-side W3C touch\s*\/\/ injector \(WebDriverManualTouchInjector → genuine pointerType:touch events\)\./,
    );
    // The coherence rationale: mouse events are a detectable iPhone tell.
    expect(body).toMatch(/a real iPhone NEVER fires mouse/);
  });

  it("Coordinate-translation framing pinned (#7 letterbox-aware): the <video> uses object-contain + FILLS its container, so the bounding rect is NOT the visible video region — map against the contained sub-rect + return null for clicks in the bars; convert the in-region pointer via the naturalWidth / displayedWidth ratio. Pinned so the letterbox-aware contract stays documented (the prior 'rect IS the visible region' assumption mis-mapped clicks on aspect-mismatched streams).", () => {
    expect(body).toMatch(/the element's bounding rect is NOT\s*\/\/\s+the visible video region\./);
    expect(body).toMatch(/touches in the bars are off-surface\s*\/\/\s+and return null\./);
    expect(body).toMatch(/`naturalWidth \/\s*\/\/\s+displayedWidth` ratio\./);
  });

  it('Reliability framing pins reliable gesture boundaries plus first/final move anchors while keeping intermediate high-rate moves lossy', () => {
    expect(body).toMatch(
      /\/\/\s+- touchStart\/touchEnd, key down\/up, swipe: reliable=true \(must arrive\s*\/\/\s+in order; a missed start\/end breaks the gesture\)\./,
    );
    expect(body).toMatch(
      /\/\/\s+- the first committed touchMove and the final pre-end touchMove are\s*\/\/\s+reliable lifecycle anchors\./,
    );
    expect(body).toMatch(
      /\/\/\s+- intermediate touchMoves remain reliable=false \(lossy ok — a dropped move\s*\/\/\s+jitters then recovers; making the high-rate stream reliable congests it\)\./,
    );
  });

  it("Pointer-capture framing pinned: 'when the press (mousedown) fires the capture pointer-captures the video element so subsequent move/release land even when the cursor leaves the element bounds (matches remote-desktop UX expectation).' + setPointerCapture(pointerId) inside try/catch with 'Browser may refuse pointer-capture — non-fatal.' — pinned so the remote-desktop-UX + non-fatal-refuse contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Pointer-capture: when the press \(mousedown\) fires the capture pointer-\s*\/\/ captures the video element so subsequent move\/release land even when the\s*\/\/ cursor leaves the element bounds \(matches remote-desktop UX expectation\)\./,
    );
    expect(body).toMatch(
      /try \{\s*if \('setPointerCapture' in video && 'pointerId' in e\) \{\s*\(video as any\)\.setPointerCapture\(\(e as any\)\.pointerId\);\s*\}\s*\} catch \{\s*\/\/ Browser may refuse pointer-capture — non-fatal\./,
    );
  });

  it('pointerToViewport letterbox-aware coord math pinned (#7): elementAspect/videoAspect object-contain fit → displayed sub-rect, pointer offset by the centering bars, null when outside the contained region (a bar click), then (px/dispW)*nw + (py/dispH)*nh + Math.round — pinned so the object-contain mapping + bar-rejection stays documented (drift back to the full-rect ratio mis-places every click on an aspect-mismatched stream; dropping Math.round lets fractional CGEvent coords slip through)', () => {
    expect(body).toMatch(/const elementAspect = rect\.width \/ rect\.height;/);
    expect(body).toMatch(/const videoAspect = nw \/ nh;/);
    expect(body).toMatch(
      /if \(!Number\.isFinite\(px\) \|\| !Number\.isFinite\(py\) \|\| px < 0 \|\| px > dispW \|\| py < 0 \|\| py > dispH\)\s*return null;/,
    );
    expect(body).toMatch(
      /const x = \(px \/ dispW\) \* nw;\s*const y = \(py \/ dispH\) \* nh;\s*return \{ x: Math\.round\(x\), y: Math\.round\(y\) \};/,
    );
  });

  it('2026-05-20 — modifiersFromEvent roster swapped from DOM-standard Shift/Control/Alt/Meta to Mac-native cmd/ctrl/shift/option (1:1 with kCGEventFlagMask* on the harness side; eliminates the harness-side Meta→Command remap on every key press). Order swapped to metaKey/ctrlKey/shiftKey/altKey so cmd surfaces first in the canonical label sequence.', () => {
    expect(body).toMatch(
      /if \(event\.metaKey\) mods\.push\('cmd'\);\s*if \(event\.ctrlKey\) mods\.push\('ctrl'\);\s*if \(event\.shiftKey\) mods\.push\('shift'\);\s*if \(event\.altKey\) mods\.push\('option'\);\s*return mods\.length > 0 \? mods : undefined;/,
    );
  });

  it("Keyboard-on-window-not-video framing pinned: 'Keyboard events go on window so capture works even when the <video> isn't directly focused. Side-effect: the customer can type into the remote browser without first clicking on the video. Trade-off: pressing a key with the panel mounted forwards it everywhere — acceptable because the panel is the only LK consumer in v1.0.' — pinned so the v1.0-trade-off + only-LK-consumer-assumption contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Keyboard events go on window so capture works even when the\s*\/\/ <video> isn't directly focused\. Side-effect: the customer can\s*\/\/ type into the remote browser without first clicking on the\s*\/\/ video\. Trade-off: pressing a key with the panel mounted\s*\/\/ forwards it everywhere — acceptable because the panel is the\s*\/\/ only LK consumer in v1\.0\./,
    );
  });

  it('touch translation behavior pinned (W198/W1249 coherence): a press → touchStart, drag → touchMove, release → touchEnd, wheel → swipe; left-button-only; NO mouseDown/mouseMove/mouseUp/wheel InputEvents are ever sent (those are the detectable iPhone tell the harness drops). Drift back to mouse* event types would re-break the loop + the fingerprint coherence', () => {
    // Sends the touch variants. The sent y is wrapped in devY(...) — the iOS
    // title-band compensation (the box maps the streamed screen without
    // subtracting the ~32px title band, so an injected tap lands too low); x stays
    // raw. devY is applied at the SEND sites only. touchStart is BUFFERED and
    // emitted at the PRESS point (g.startX/g.startY) — on drag-commit AND on a
    // clean tap — so a tap never sends a touchMove (scroll-vs-tap gesture model).
    expect(body).toMatch(
      /send\(\{ type: 'touchStart', x: g\.startX, y: devY\(g\.startY\), touchId: g\.touchId \}, true\);/,
    );
    expect(body).toMatch(
      /let lifecycleAnchor = false;[\s\S]*?g\.committed = true;\s*lifecycleAnchor = true;[\s\S]*?send\(\{ type: 'touchMove', x: p\.x, y: devY\(p\.y\), touchId: g\.touchId \}, lifecycleAnchor\);/,
    );
    expect(body).toMatch(
      /const endCommittedTouch = \(x: number, y: number, touchId: number\): void => \{\s*send\(\{ type: 'touchMove', x, y, touchId \}, true\);\s*send\(\{ type: 'touchEnd', x, y, touchId \}, true\);\s*\};/,
    );
    expect(body).toMatch(/endCommittedTouch\(p\.x, devY\(p\.y\), g\.touchId\);/);
    // Wheel/trackpad scroll drives a touchStream drag (touchStart→touchMove→touchEnd
    // via wheelDrag), NOT a `swipe` — the fork adds its own momentum to every swipe
    // (A3 W2736), so per-event swipes stacked into jumpy overshoot. The GUI no longer
    // emits swipe.
    expect(body).toMatch(/wheelDrag/);
    expect(body).not.toMatch(/type: 'swipe'/);
    // Left-button-only press (right/middle have no touch analogue).
    expect(body).toMatch(/if \(mouseButton\(e\.button\) !== 0\) return;/);
    // NEVER emits mouse* / wheel InputEvent types on the wire.
    expect(body).not.toMatch(/type: 'mouseMove'/);
    expect(body).not.toMatch(/type: 'mouseDown'/);
    expect(body).not.toMatch(/type: 'mouseUp'/);
    expect(body).not.toMatch(/type: 'wheel'/);
  });
});
