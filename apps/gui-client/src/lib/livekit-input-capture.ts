// LK.6.d — input capture on the simulator's video element. Translates the
// user's mouse/trackpad gestures into iPhone-COHERENT TOUCH InputEvents and
// ships them over the LiveKit DataChannel to Agent-1's Mac-side W3C touch
// injector (WebDriverManualTouchInjector → genuine pointerType:touch events).
//
// WHY touch, not mouse (A3 W198/W1249): a real iPhone NEVER fires mouse
// events, so emitting mouseMove/mouseDown/mouseUp is (a) a detectable
// fingerprint tell and (b) dropped by the harness decoder (touch-only). The
// user drives with a mouse/trackpad locally; we translate to touch on the wire.
//
// Gesture → touch mapping (A3 W207/W1249):
//   - press (mousedown, left button)   → touchStart{x,y,touchId}
//   - drag  (mousemove while pressed)  → touchMove{x,y,touchId}  (lossy ok)
//   - release (mouseup)                → touchEnd{x,y,touchId}
//     (a press+release with no move = a genuine tap/click)
//   - wheel / trackpad scroll          → swipe{x1,y1,x2,y2,durationMs}
//     (scrolling content DOWN = a finger swiping UP, so y decreases)
//   - keydown / keyup                  → keyDown/keyUp (iPhone Safari fires
//     these; A3's genuine-WebKit-key injector accepts them). Modifier set
//     captured from event.shiftKey/ctrlKey/altKey/metaKey.
//
// Coordinate translation:
//   - <video> renders the remote stream with object-contain and fills
//     its container, so when the stream aspect differs from the element
//     aspect the video is bar-boxed — the element's bounding rect is NOT
//     the visible video region. Map against the contained sub-rect
//     (centering offset + scaled size); touches in the bars are off-surface
//     and return null.
//   - The Mac side expects viewport-space coordinates (the fork's logical
//     px). Convert the in-region pointer via the `naturalWidth /
//     displayedWidth` ratio.
//
// Reliability:
//   - touchStart/touchEnd, key down/up, swipe: reliable=true (must arrive
//     in order; a missed start/end breaks the gesture).
//   - touchMove: reliable=false (lossy ok — a dropped move jitters then
//     recovers; reliable=true would congest the data channel on a fast drag).
//
// Pointer-capture: when the press (mousedown) fires the capture pointer-
// captures the video element so subsequent move/release land even when the
// cursor leaves the element bounds (matches remote-desktop UX expectation).

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */

import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';
import { type CanonicalModifier } from '@driftstack/sdk';
import { sendInputEvent, type InputEvent, type Room } from './livekit';

export interface UseInputCaptureOpts {
  /** The LiveKit room — null when not connected. Capture is a
   *  no-op until a room is present. */
  room: Room | null;
  /** The <video> element receiving the live stream. */
  videoRef: RefObject<HTMLVideoElement>;
  /** Capture toggle. Off by default (subscriber-only viewing); the
   *  parent view flips this when the customer engages "Take
   *  control". */
  enabled: boolean;
}

/** Map a browser pointer event to the video's intrinsic logical
 *  coordinate space. Returns null when the element isn't sized
 *  yet (race on first mount).
 *
 *  Exported (alongside `modifiersFromEvent` and `mouseButton`) so
 *  pure-function unit tests can pin the coordinate math without
 *  spinning up jsdom + a fake LiveKit Room. */
export function pointerToViewport(
  event: PointerEvent | MouseEvent | WheelEvent,
  video: HTMLVideoElement,
): { x: number; y: number } | null {
  const rect = video.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const nw = video.videoWidth || rect.width;
  const nh = video.videoHeight || rect.height;
  // object-contain: the stream is scaled to fit the element while
  // preserving aspect ratio, so when the stream aspect differs from the
  // element aspect it is bar-boxed within the rect. Compute the displayed
  // sub-rect (centering offset + scaled size); a pointer outside it is in
  // a bar — off-surface — so return null (callers skip null). When the
  // aspects match (the common case) the offsets are zero and this reduces
  // to the plain rect ratio.
  const elementAspect = rect.width / rect.height;
  const videoAspect = nw / nh;
  let dispW = rect.width;
  let dispH = rect.height;
  if (videoAspect > elementAspect) {
    dispH = rect.width / videoAspect; // wider stream → top/bottom bars
  } else if (videoAspect < elementAspect) {
    dispW = rect.height * videoAspect; // taller stream → left/right bars
  }
  const px = event.clientX - rect.left - (rect.width - dispW) / 2;
  const py = event.clientY - rect.top - (rect.height - dispH) / 2;
  if (px < 0 || px > dispW || py < 0 || py > dispH) return null;
  const x = (px / dispW) * nw;
  const y = (py / dispH) * nh;
  return { x: Math.round(x), y: Math.round(y) };
}

/** Capture the modifier-set from a KeyboardEvent. Returns
 *  undefined when no modifier is held (matches the InputEvent
 *  optional `modifiers` field).
 *
 *  Vocabulary: cmd/ctrl/shift/option (Mac-native labels) — 1:1
 *  with Quartz CGEventFlags on the harness side
 *  (kCGEventFlagMaskCommand → cmd, etc.) and matches the
 *  customer-dashboard's ManualControlOverlay inline copy.
 *  Pre-2026-05-20 this used the DOM-standard Shift/Control/Alt/
 *  Meta names, which forced the harness to remap Meta → Command
 *  on every key press; aligning to Mac-native labels here
 *  collapses the drift. */
export function modifiersFromEvent(event: KeyboardEvent): readonly CanonicalModifier[] | undefined {
  const mods: CanonicalModifier[] = [];
  if (event.metaKey) mods.push('cmd');
  if (event.ctrlKey) mods.push('ctrl');
  if (event.shiftKey) mods.push('shift');
  if (event.altKey) mods.push('option');
  return mods.length > 0 ? mods : undefined;
}

/** Translate a mouse `button` field (0=left/1=middle/2=right) to
 *  the bounded InputEvent type. Returns null for unsupported
 *  buttons (e.g. back/forward — not yet in the Mac-side decoder). */
export function mouseButton(raw: number): 0 | 1 | 2 | null {
  if (raw === 0 || raw === 1 || raw === 2) return raw;
  return null;
}

/** React hook that wires the user's mouse/keyboard gestures on the simulator's
 *  video element to iPhone-COHERENT TOUCH InputEvents (W198/W1249 — a real
 *  iPhone never fires mouse events; emitting them is detectable + dropped by
 *  the harness). Calls sendInputEvent asynchronously; rejections are swallowed
 *  (input capture is best-effort and shouldn't throw out of an event handler). */
export function useInputCapture(opts: UseInputCaptureOpts): void {
  const lastSend = useRef<Promise<void>>(Promise.resolve());
  // The in-flight touch gesture: a press holds a touchId until release so the
  // matching move/end reuse it. null = no finger down → no move is sent (a real
  // iPhone has no hover/pointer-move without a touch).
  const active = useRef<{ touchId: number } | null>(null);
  const touchIdSeq = useRef(0);

  useEffect(() => {
    const { room, videoRef, enabled } = opts;
    if (!enabled || room === null) return;
    const video = videoRef.current;
    if (video === null) return;

    const send = (event: InputEvent, reliable: boolean): void => {
      lastSend.current = sendInputEvent(room, event, { reliable }).catch(() => undefined);
    };

    // A left-button mouse press = a finger down → touchStart. Right/middle
    // buttons have no iPhone touch analogue, so they're ignored.
    const onMouseDown = (e: MouseEvent): void => {
      if (mouseButton(e.button) !== 0) return;
      const p = pointerToViewport(e, video);
      if (p === null) return;
      try {
        if ('setPointerCapture' in video && 'pointerId' in e) {
          (video as any).setPointerCapture((e as any).pointerId);
        }
      } catch {
        // Browser may refuse pointer-capture — non-fatal.
      }
      const touchId = touchIdSeq.current++;
      active.current = { touchId };
      send({ type: 'touchStart', x: p.x, y: p.y, touchId }, true);
    };
    // Move only while a finger is down (no iPhone hover). Lossy — a dropped
    // touchMove jitters then recovers; reliable=true would congest a fast drag.
    const onMouseMove = (e: MouseEvent): void => {
      const g = active.current;
      if (g === null) return;
      const p = pointerToViewport(e, video);
      if (p === null) return;
      send({ type: 'touchMove', x: p.x, y: p.y, touchId: g.touchId }, false);
    };
    // Release = touchEnd. A press+release with no move is a genuine tap/click.
    const onMouseUp = (e: MouseEvent): void => {
      const g = active.current;
      active.current = null;
      if (g === null) return;
      const p = pointerToViewport(e, video);
      if (p === null) return;
      send({ type: 'touchEnd', x: p.x, y: p.y, touchId: g.touchId }, true);
    };
    // Wheel/trackpad scroll = a swipe gesture. Scrolling content DOWN
    // (deltaY > 0, reveal below) maps to a finger swiping UP, so y decreases.
    // Clamp the delta so one scroll notch is a short flick, not a fling.
    const onWheel = (e: WheelEvent): void => {
      const p = pointerToViewport(e, video);
      if (p === null) return;
      const clamp = (d: number): number => Math.max(-240, Math.min(240, d));
      send(
        {
          type: 'swipe',
          x1: p.x,
          y1: p.y,
          x2: p.x - clamp(e.deltaX),
          y2: p.y - clamp(e.deltaY),
          durationMs: 120,
        },
        true,
      );
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      const modifiers = modifiersFromEvent(e);
      send(
        {
          type: 'keyDown',
          key: e.key,
          ...(modifiers !== undefined ? { modifiers } : {}),
        },
        true,
      );
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      const modifiers = modifiersFromEvent(e);
      send(
        {
          type: 'keyUp',
          key: e.key,
          ...(modifiers !== undefined ? { modifiers } : {}),
        },
        true,
      );
    };

    video.addEventListener('mousemove', onMouseMove);
    video.addEventListener('mousedown', onMouseDown);
    video.addEventListener('mouseup', onMouseUp);
    video.addEventListener('wheel', onWheel, { passive: true });
    // Keyboard events go on window so capture works even when the
    // <video> isn't directly focused. Side-effect: the customer can
    // type into the remote browser without first clicking on the
    // video. Trade-off: pressing a key with the panel mounted
    // forwards it everywhere — acceptable because the panel is the
    // only LK consumer in v1.0.
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      video.removeEventListener('mousemove', onMouseMove);
      video.removeEventListener('mousedown', onMouseDown);
      video.removeEventListener('mouseup', onMouseUp);
      video.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      // Drop any in-flight gesture so a remount can't reuse a stale touchId.
      active.current = null;
    };
  }, [opts]);
}
