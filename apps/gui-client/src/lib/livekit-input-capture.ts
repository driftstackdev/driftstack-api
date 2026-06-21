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

import { useEffect, useRef } from 'react';
import { type CanonicalModifier } from '@driftstack/sdk';
import { sendInputEvent, type InputEvent, type Room } from './livekit';

export interface UseInputCaptureOpts {
  /** The LiveKit room — null when not connected. Capture is a
   *  no-op until a room is present. */
  room: Room | null;
  /** The <video> element receiving the live stream — null until it mounts.
   *  Passed as the actual element (not a ref) so the effect re-runs when the
   *  element mounts; a ref's `.current` is mutated without re-rendering, so an
   *  effect keyed on a ref would attach to a stale (null) element. */
  videoElement: HTMLVideoElement | null;
  /** Capture toggle. Off by default (subscriber-only viewing); the
   *  parent view flips this when the customer engages "Take
   *  control". */
  enabled: boolean;
  /** Surfaced when the FIRST input publish fails — the data channel is
   *  effectively dead, so control isn't reaching the device. The parent wires
   *  this to a small non-fatal badge. Fired at most once per effect run. */
  onPublishError?: () => void;
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

/** Move-deadzone (video-px) for the scroll-vs-tap fix (A3 W2668, founder's
 *  "sometimes a tap also scrolls"). The GUI streams a click as
 *  touchStart → touchMove* → touchEnd; every sub-slop cursor drift between
 *  mousedown and mouseup fires its OWN touchMove (no debounce). In the fork the
 *  FIRST touchMove crossing its 10px tapSlop flips the gesture tap→scroll, so a
 *  near-still click scrolls instead of clicking. We suppress touchMoves until the
 *  cursor moves more than MOVE_DEADZONE from the press point — a sub-deadzone
 *  jiggle emits no move (touchEnd synthesizes the click), a real drag (>6px)
 *  scrolls exactly as before.
 *
 *  14 video-px (was 6): A3's deep tap-path investigation (wpiyo8v6x, 2026-06-21)
 *  found the founder STILL hit "tap scrolls" at 6 — a real mouse/trackpad click
 *  easily drifts >6 video-px between down and up, so the move leaked through and
 *  the fork scrolled. There is NO ÷devicePixelRatio here (the video track is the
 *  402×874 CSS-POINT profile, not 1206×2622, so video→CSS is ~1.0×/~0.8×), so to
 *  prevent a drifty click from scrolling the GUI deadzone must sit ABOVE the
 *  fork's 10px tapSlop — otherwise the move that crosses our deadzone also
 *  crosses the fork's slop and scrolls. 14 clears typical click-drift with a 4px
 *  margin over the fork slop; the cost is only that a deliberate <14px micro-
 *  scroll registers as a tap (a tiny movement — far less jarring than a tap that
 *  scrolls the page away). A genuine scroll (>14px) still scrolls exactly as
 *  before. Do NOT change the fork's tapSlop (fork-side, fingerprint-bearing) —
 *  this deadzone sits just above it. */
const MOVE_DEADZONE = 14;

/** Tap-landing Y compensation (founder 2026-06-21; A3 W2725/26-ack). The device
 *  renders a ~32px iOS title band atop the streamed screen that the box's
 *  tap-coordinate mapping does NOT subtract, so an injected tap/touch lands ~32px
 *  too LOW — the autonomous probe (scripts/sim-tap-probe.mjs) measured a uniform
 *  +32px Y offset, X exact, across the screen. Subtract it from the Y we SEND so
 *  a tap lands where the operator clicked. v1 constant for iphone17 (the only
 *  shipped archetype); A3's content-only "(B)" stream (native content, no title
 *  band) zeroes it → set TAP_Y_OFFSET=0 when (B) ships. Applied to SENT coords
 *  ONLY: the scroll-vs-tap deadzone keeps RAW pointerToViewport coords (a uniform
 *  shift doesn't change distances) and pointerToViewport stays the pure mapping. */
const TAP_Y_OFFSET = 32;
const devY = (y: number): number => Math.max(0, y - TAP_Y_OFFSET);

/** Inertial slide (founder 2026-06-21 "slide simulation like a new iphone"): on a
 *  fast drag-release the touch keeps GLIDING and decelerates to a stop instead of
 *  stopping dead, mimicking iOS momentum scrolling. Only a genuine flick triggers
 *  it; a tap or slow drag is unchanged. The glide is bounded + cancellable (a new
 *  touch during it halts it, like iOS). FLING_MIN_SPEED = release speed (px/ms) to
 *  trigger; FLING_STALE_MS = a pause longer than this before lifting means the
 *  finger settled, so NO glide; FLING_STEP_MS = the move cadence during the glide. */
const FLING_MIN_SPEED = 0.45;
const FLING_STALE_MS = 60;
const FLING_STEP_MS = 16;

/** Squared Euclidean distance between two points — squared so the deadzone
 *  comparison avoids a sqrt per move event (we compare against MOVE_DEADZONE²). */
function distSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** Decelerating point path for an inertial "slide" (momentum) gesture. Given the
 *  release point + velocity (px/ms), returns the touch positions as the glide eases
 *  to a stop under friction — replayed as touchMove events so a fast flick keeps
 *  scrolling + settles like iOS rather than stopping dead. Pure + hard-bounded
 *  (caps on both step count and total distance) so it's deterministic, unit-testable
 *  and can never run away. Empty when the release velocity is already below the stop
 *  threshold (→ caller just ends the touch). Operates in raw video-px; the caller
 *  applies devY + surface clamping when it sends each point. */
export function computeFlingPath(
  x0: number,
  y0: number,
  vx: number,
  vy: number,
  opts: {
    friction?: number;
    stepMs?: number;
    stopSpeed?: number;
    maxSteps?: number;
    maxDist?: number;
  } = {},
): Array<{ x: number; y: number }> {
  const friction = opts.friction ?? 0.93;
  const stepMs = opts.stepMs ?? FLING_STEP_MS;
  const stopSpeed = opts.stopSpeed ?? 0.05;
  const maxSteps = opts.maxSteps ?? 38;
  const maxDist = opts.maxDist ?? 1000;
  const pts: Array<{ x: number; y: number }> = [];
  let x = x0;
  let y = y0;
  let velX = vx;
  let velY = vy;
  let dist = 0;
  for (let i = 0; i < maxSteps; i++) {
    if (Math.hypot(velX, velY) < stopSpeed) break;
    const dx = velX * stepMs;
    const dy = velY * stepMs;
    x += dx;
    y += dy;
    dist += Math.hypot(dx, dy);
    pts.push({ x: Math.round(x), y: Math.round(y) });
    if (dist >= maxDist) break;
    velX *= friction;
    velY *= friction;
  }
  return pts;
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
  // iPhone has no hover/pointer-move without a touch). `startX/startY` (the press
  // point in video-px) + `moved` drive the MOVE_DEADZONE scroll-vs-tap gate: no
  // touchMove is emitted until the cursor leaves the deadzone (A3 W2668).
  const active = useRef<{
    touchId: number;
    startX: number;
    startY: number;
    moved: boolean;
    // Release-velocity tracking for the inertial slide: the last move's position +
    // timestamp and an EMA-smoothed velocity (px/ms). Undefined until the first
    // post-deadzone move, so a tap (no drag) never carries velocity → no glide.
    lastX?: number;
    lastY?: number;
    lastT?: number;
    vx?: number;
    vy?: number;
  } | null>(null);
  // The in-flight inertial glide (null = none). Holds the held touchId + current
  // glide position + the step timer so a new press / teardown can halt it cleanly.
  const fling = useRef<{ touchId: number; x: number; y: number; timer: number } | null>(null);
  const touchIdSeq = useRef(0);
  // Keep the latest onPublishError in a ref so the capture effect does NOT
  // depend on the callback's identity — the natural usage is an inline arrow (a
  // fresh ref every render), and re-keying the effect on it would tear down +
  // re-attach the listeners (nulling the in-flight gesture) on every render.
  const onPublishErrorRef = useRef(opts.onPublishError);
  useEffect(() => {
    onPublishErrorRef.current = opts.onPublishError;
  }, [opts.onPublishError]);

  // Destructure to PRIMITIVES so the effect depends on the actual room / element
  // / enabled VALUES, not the opts OBJECT. A caller passing an inline
  // `{ room, videoElement, enabled }` literal (the natural usage) makes `opts` a
  // fresh reference every render; with an `[opts]` dep the effect would re-attach
  // the listeners — and its cleanup nulls `active.current`, dropping any
  // in-flight finger-down gesture. Depending on the primitives (mirrors
  // livekit-latency-ping.ts) re-runs only on a real change, and keying on the
  // actual `videoElement` re-runs the effect when the element mounts.
  const { room, videoElement: video, enabled } = opts;
  useEffect(() => {
    if (!enabled || room === null || video === null) return;

    let warnedPublishFailure = false;
    const send = (event: InputEvent, reliable: boolean): void => {
      lastSend.current = sendInputEvent(room, event, { reliable }).catch((err: unknown) => {
        // Swallow per-event (a rejected move must not throw into the UI), but
        // surface the FIRST failure: a silently-dead control channel reads as
        // "view-only" with no diagnostic (founder-hit 2026-06-12).
        if (!warnedPublishFailure) {
          warnedPublishFailure = true;
          console.warn(
            '[simulator] input publish failed — control will not reach the device:',
            err,
          );
          onPublishErrorRef.current?.();
        }
        return undefined;
      });
    };

    // Clamp a glide point inside the video — a flick path extends past where the
    // finger lifted, so this keeps us from sending a wild off-surface touch (read
    // live: the video's intrinsic size may not be known at effect-setup time).
    const clampX = (v: number): number => {
      const w = video.videoWidth || 0;
      return w > 0 ? Math.max(0, Math.min(w, v)) : Math.max(0, v);
    };
    const clampY = (v: number): number => {
      const h = video.videoHeight || 0;
      return h > 0 ? Math.max(0, Math.min(h, v)) : Math.max(0, v);
    };
    // Halt an in-flight inertial glide. endTouch=true lifts the gliding finger (a
    // new press mid-glide, like tapping to stop iOS momentum); teardown passes
    // false (just clear the timer — the room is going away).
    const cancelFling = (endTouch: boolean): void => {
      const f = fling.current;
      if (f === null) return;
      window.clearTimeout(f.timer);
      fling.current = null;
      if (endTouch) {
        send({ type: 'touchEnd', x: clampX(f.x), y: devY(clampY(f.y)), touchId: f.touchId }, true);
      }
    };
    // Replay a decelerating flick as timed touchMove events, then a final touchEnd.
    // The held touchId stays down through the glide so the device reads ONE
    // continuous finger sliding + settling (iOS momentum), not a new gesture.
    const startFling = (touchId: number, x0: number, y0: number, vx: number, vy: number): void => {
      cancelFling(false);
      const path = computeFlingPath(x0, y0, vx, vy);
      if (path.length === 0) {
        send({ type: 'touchEnd', x: clampX(x0), y: devY(clampY(y0)), touchId }, true);
        return;
      }
      fling.current = { touchId, x: x0, y: y0, timer: 0 };
      let i = 0;
      const step = (): void => {
        const f = fling.current;
        if (f === null) return;
        const pt = i < path.length ? path[i] : undefined;
        i += 1;
        if (pt === undefined) {
          // Glide exhausted (or a defensive miss) — lift the finger at the last
          // point we sent (f.x/f.y track it), settling the momentum scroll.
          send({ type: 'touchEnd', x: clampX(f.x), y: devY(clampY(f.y)), touchId }, true);
          fling.current = null;
          return;
        }
        f.x = pt.x;
        f.y = pt.y;
        send({ type: 'touchMove', x: clampX(pt.x), y: devY(clampY(pt.y)), touchId }, false);
        f.timer = window.setTimeout(step, FLING_STEP_MS);
      };
      step();
    };

    // A left-button mouse press = a finger down → touchStart. Right/middle
    // buttons have no iPhone touch analogue, so they're ignored.
    const onMouseDown = (e: MouseEvent): void => {
      if (mouseButton(e.button) !== 0) return;
      // A new touch during a glide stops it (iOS: tap-to-halt momentum) and lifts
      // the gliding finger before this press starts its own.
      cancelFling(true);
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
      // Record the press point + reset the moved flag so the MOVE_DEADZONE gate
      // restarts per gesture (a sub-deadzone jiggle then stays a tap).
      active.current = { touchId, startX: p.x, startY: p.y, moved: false };
      send({ type: 'touchStart', x: p.x, y: devY(p.y), touchId }, true);
    };
    // Move only while a finger is down (no iPhone hover). Lossy — a dropped
    // touchMove jitters then recovers; reliable=true would congest a fast drag.
    // Scroll-vs-tap deadzone (A3 W2668): drop the move while still within
    // MOVE_DEADZONE of the press point AND not yet moving — a near-still click
    // emits no touchMove, so the fork keeps it a tap (its first touchMove past
    // tapSlop is what flips tap→scroll). Once the cursor crosses the deadzone we
    // latch `moved` and stream every subsequent move normally, so a real drag
    // (>6px) scrolls exactly as before.
    const onMouseMove = (e: MouseEvent): void => {
      const g = active.current;
      if (g === null) return;
      const p = pointerToViewport(e, video);
      if (p === null) return;
      if (!g.moved && distSq(p.x, p.y, g.startX, g.startY) <= MOVE_DEADZONE * MOVE_DEADZONE) return;
      g.moved = true;
      // Track release velocity (EMA, px/ms) for the inertial slide: weight recent
      // motion so a fast flick at the very end produces a strong glide. Skip the
      // first post-deadzone sample (no prior point) and any zero-dt duplicate.
      const t = e.timeStamp;
      if (g.lastT !== undefined && g.lastX !== undefined && g.lastY !== undefined) {
        const dt = t - g.lastT;
        if (dt > 0) {
          const ivx = (p.x - g.lastX) / dt;
          const ivy = (p.y - g.lastY) / dt;
          g.vx = g.vx === undefined ? ivx : g.vx * 0.6 + ivx * 0.4;
          g.vy = g.vy === undefined ? ivy : g.vy * 0.6 + ivy * 0.4;
        }
      }
      g.lastX = p.x;
      g.lastY = p.y;
      g.lastT = t;
      send({ type: 'touchMove', x: p.x, y: devY(p.y), touchId: g.touchId }, false);
    };
    // Release = touchEnd. A press+release with no move is a genuine tap/click.
    const onMouseUp = (e: MouseEvent): void => {
      const g = active.current;
      active.current = null;
      if (g === null) return;
      const p = pointerToViewport(e, video);
      if (p === null) return;
      // Inertial slide: a fast flick-release keeps gliding (iOS momentum) instead
      // of stopping dead. Only when the gesture actually dragged AND the release
      // was recent (a pause before lifting = the finger settled → no glide).
      const fresh = g.lastT !== undefined && e.timeStamp - g.lastT <= FLING_STALE_MS;
      const speed = g.vx !== undefined && g.vy !== undefined ? Math.hypot(g.vx, g.vy) : 0;
      if (g.moved && fresh && speed >= FLING_MIN_SPEED) {
        startFling(g.touchId, p.x, p.y, g.vx as number, g.vy as number);
        return;
      }
      send({ type: 'touchEnd', x: p.x, y: devY(p.y), touchId: g.touchId }, true);
    };
    // Window-level release fallback: pointer-capture never engages (the listeners
    // are mouse* with no pointerId, while the capture call is pointerId-guarded),
    // so a drag that releases OFF the video element never fires the element's
    // mouseup → the finger stays down (a stuck touch). A window-level end ALWAYS
    // lifts the finger. It can't map coordinates off-surface, so it ends at the
    // last gesture position via touchEnd with the held touchId (no x/y change
    // needed — the Mac side ends the active touch).
    const endActiveGesture = (e: MouseEvent): void => {
      const g = active.current;
      if (g === null) return;
      active.current = null;
      // Best-effort: use the in-bounds point when available, else just end the
      // touch at its current position (the harness ends the active touchId).
      const p = pointerToViewport(e, video);
      if (p !== null) {
        send({ type: 'touchEnd', x: p.x, y: devY(p.y), touchId: g.touchId }, true);
      } else {
        send({ type: 'touchEnd', x: 0, y: 0, touchId: g.touchId }, true);
      }
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
          y1: devY(p.y),
          x2: p.x - clamp(e.deltaX),
          y2: devY(p.y - clamp(e.deltaY)),
          durationMs: 120,
        },
        true,
      );
    };
    // True when focus is in an editable element (a text field / textarea /
    // contenteditable). The keyboard listeners are bound on `window`, so without
    // this guard typing into the in-window "Tell the agent" composer would ALSO
    // forward every keystroke to the device. Skip forwarding while editing.
    const editingLocally = (): boolean => {
      const el = document.activeElement;
      if (el === null) return false;
      const tag = el.tagName;
      return (
        tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true
      );
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (editingLocally()) return;
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
      if (editingLocally()) return;
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
    // Window-level release fallback (mouse + pointer) so a drag that releases off
    // the element still lifts the finger — pointer-capture doesn't engage on the
    // mouse* listeners, so the element's own mouseup can be missed.
    window.addEventListener('mouseup', endActiveGesture);
    window.addEventListener('pointerup', endActiveGesture);

    return () => {
      video.removeEventListener('mousemove', onMouseMove);
      video.removeEventListener('mousedown', onMouseDown);
      video.removeEventListener('mouseup', onMouseUp);
      video.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mouseup', endActiveGesture);
      window.removeEventListener('pointerup', endActiveGesture);
      // Stop any in-flight inertial glide (just clear its timer — the room is
      // tearing down) and drop the gesture so a remount can't reuse a stale touchId.
      cancelFling(false);
      active.current = null;
    };
  }, [room, video, enabled]);
}
