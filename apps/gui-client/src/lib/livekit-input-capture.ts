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

/** The archetype's FIXED logical device-CSS-px screen (iPhone 17 = 402×874).
 *  A3 W2811: the Mac touch injector addresses the CSS content viewport in this
 *  fixed space, NOT the streamed track's pixel size. The SFU REMB-downscales the
 *  published track under bandwidth pressure (e.g. to ~200×436), so any coordinate
 *  derived from video.videoWidth/Height halves on a throttle. Map against this
 *  constant instead so the touch space is invariant to the track resolution.
 *  v1 constant for iphone17 (the only shipped archetype); thread a per-archetype
 *  size through `logical` below when a second device profile ships. */
const DEVICE_LOGICAL_WIDTH = 402;
const DEVICE_LOGICAL_HEIGHT = 874;

/** Map a browser pointer event to the FIXED logical device-CSS-px frame
 *  (402×874 — the space the Mac touch injector expects, A3 W2811), object-
 *  contain-aware. Returns null when the element isn't sized yet (race on first
 *  mount) or the pointer is in a letterbox/pillarbox bar (off-surface).
 *
 *  The `logical` size is a parameter (default 402×874) so a future archetype can
 *  pass its own screen size and the pure unit tests can pin the object-contain
 *  math at any size. Crucially it does NOT read video.videoWidth/Height for the
 *  scale: the SFU downscales the track, and pre-2026-06-23 that made a tap land
 *  high-and-left ("above where I tap") whenever the track was throttled, snapping
 *  back when it recovered (founder 2026-06-23; root-caused A3 W2811).
 *
 *  Exported (alongside `modifiersFromEvent` and `mouseButton`) so pure-function
 *  unit tests can pin the coordinate math without jsdom + a fake LiveKit Room. */
export function pointerToViewport(
  event: PointerEvent | MouseEvent | WheelEvent,
  video: HTMLVideoElement,
  logical: { width: number; height: number } = {
    width: DEVICE_LOGICAL_WIDTH,
    height: DEVICE_LOGICAL_HEIGHT,
  },
): { x: number; y: number } | null {
  const rect = video.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  // FIXED logical frame, not the (SFU-downscaled) track px — see above + A3 W2811.
  const nw = logical.width;
  const nh = logical.height;
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

/** Scroll-vs-tap as a TIME + DISTANCE gesture (founder 2026-06-21 "taps still
 *  scroll instead of tapping"): the touchStart is BUFFERED and a gesture stays a
 *  TAP — emitting a clean touchStart+touchEnd at the PRESS point with NO touchMove,
 *  so the box can't scroll it — until it COMMITS to a drag. It commits only when it
 *  moves past MOVE_DEADZONE AND is either sustained (held > DRAG_HOLD_MS — a
 *  deliberate scroll) or decisive (moved past DRAG_HARD_PX — a fast flick). So a
 *  QUICK press→release never scrolls, even with several px of mouse/trackpad drift;
 *  only a real drag scrolls. The inertial fling runs ONLY on a committed drag, so a
 *  tap (or a marginal flick) never flings into a scroll either. */
const DRAG_HOLD_MS = 140;
const DRAG_HARD_PX = 44;

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
 *  fast drag-release the touch keeps GLIDING and decelerates to a stop. ⚠️ DISABLED
 *  2026-06-21 (FLING_ENABLED=false): once it actually fired (the B1 pointerup-race
 *  fix), the founder hit "awful latency, much scrolling AFTER i'm done" — the glide
 *  over-drove the fork's per-move scroll (A3 W2736 warned of this), so a click-drag
 *  scroll kept moving after release. A click-drag scroll now stops dead on release
 *  (reliable > over-scroll). The pure computeFlingPath + the cancellable runtime are
 *  kept for a future re-enable (ideally native fork momentum). FLING_MIN_SPEED =
 *  release speed (px/ms) to trigger; FLING_STALE_MS = a settle pause that cancels it;
 *  FLING_STEP_MS = the move cadence during the glide. */
const FLING_ENABLED = false;
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
    // Press timestamp + whether the gesture has COMMITTED to a drag. Until it
    // commits the touchStart is buffered (a tap emits no touchMove → never scrolls).
    startT: number;
    committed: boolean;
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
    // Clamp a glide/scroll point inside the FIXED logical device frame (402×874),
    // NOT video.videoWidth/Height — the SFU downscales the track, so clamping to
    // the track px would shrink the usable surface on a throttle (same root cause
    // as the pointerToViewport fix, A3 W2811).
    const clampX = (v: number): number => Math.max(0, Math.min(DEVICE_LOGICAL_WIDTH, v));
    const clampY = (v: number): number => Math.max(0, Math.min(DEVICE_LOGICAL_HEIGHT, v));
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
      // A new press also lifts any in-flight wheel-scroll finger (symmetry with the
      // effect teardown) so the wheel + mouse paths never leave two fingers on the
      // wire — a residual wheel touch + a fresh press = a spurious multi-touch/pinch.
      window.clearTimeout(wheelTimer);
      endWheelDrag();
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
      // BUFFER the touchStart: record the press but send NOTHING yet. The gesture
      // stays a tap (→ clean touchStart+touchEnd at release, no move) until it
      // commits to a drag in onMouseMove. This is why a quick press→release never
      // scrolls, even with pointer drift (see DRAG_HOLD_MS / DRAG_HARD_PX).
      active.current = { touchId, startX: p.x, startY: p.y, startT: e.timeStamp, committed: false };
    };
    // Move only while a finger is down (no iPhone hover). Until the gesture COMMITS
    // to a drag we send nothing (it might still be a tap); on commit we emit the
    // buffered touchStart at the PRESS point, then stream moves. Commit needs the
    // cursor past MOVE_DEADZONE AND (held > DRAG_HOLD_MS = a deliberate scroll, OR
    // moved past DRAG_HARD_PX = a decisive/fast flick) — so a quick drifty click
    // never crosses into a scroll. touchMove is lossy (reliable=false); a dropped
    // move jitters then recovers, while reliable=true would congest a fast drag.
    const onMouseMove = (e: MouseEvent): void => {
      const g = active.current;
      if (g === null) return;
      let p = pointerToViewport(e, video);
      if (p === null) {
        // Off the video. An uncommitted gesture stays buffered (ignore). A COMMITTED
        // drag keeps scrolling: clamp the cursor to the video edge so wandering off
        // the small (~330px) frame doesn't FREEZE the scroll (audit S1) — the move
        // listener is on window, so we still receive these.
        if (!g.committed) return;
        const r = video.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        const cx = Math.max(r.left, Math.min(r.right, e.clientX));
        const cy = Math.max(r.top, Math.min(r.bottom, e.clientY));
        p = pointerToViewport({ clientX: cx, clientY: cy } as MouseEvent, video);
        if (p === null) {
          // The clamped EDGE point can land in a sub-pixel object-contain bar (W2820 #3:
          // the element's on-screen aspect can drift a hair from the logical 402×874 when
          // the SFU downscales the track to a not-exactly-402:874 even resolution), so
          // pointerToViewport returns null exactly at the edge — which would re-freeze the
          // committed drag the clamp exists to keep alive (audit S1). Fall back to a direct
          // rect-fraction map clamped to the logical frame so the scroll never freezes.
          p = {
            x: Math.round(Math.max(0, Math.min(1, (cx - r.left) / r.width)) * DEVICE_LOGICAL_WIDTH),
            y: Math.round(
              Math.max(0, Math.min(1, (cy - r.top) / r.height)) * DEVICE_LOGICAL_HEIGHT,
            ),
          };
        }
      }
      if (!g.committed) {
        const far = distSq(p.x, p.y, g.startX, g.startY);
        const elapsed = e.timeStamp - g.startT;
        const commit =
          (far > MOVE_DEADZONE * MOVE_DEADZONE && elapsed > DRAG_HOLD_MS) ||
          far > DRAG_HARD_PX * DRAG_HARD_PX;
        if (!commit) return; // still possibly a tap — keep buffering (send nothing)
        g.committed = true;
        // Emit the buffered touchStart at the press point so the scroll originates
        // there, then seed velocity tracking from the COMMIT point (the current move),
        // NOT the press — otherwise the initial dwell (up to DRAG_HOLD_MS) folds into
        // the first velocity sample and distorts the release speed (used by the fling).
        send({ type: 'touchStart', x: g.startX, y: devY(g.startY), touchId: g.touchId }, true);
        g.lastX = p.x;
        g.lastY = p.y;
        g.lastT = e.timeStamp;
      }
      // Track release velocity (EMA, px/ms) for the inertial slide: weight recent
      // motion so a fast flick at the very end produces a strong glide.
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
    // The SINGLE gesture-release handler, wired to the element mouseup AND the
    // window mouseup + pointerup. CRITICAL ordering (audit w5q5vvdca B1): a real
    // WebView dispatches `pointerup` (→ window) BEFORE the compat `mouseup`, so the
    // window listener wins the race — the FULL release logic (tap / off-surface /
    // inertial fling) must live HERE, not only in the element mouseup, or the fling
    // would never run (pointerup ended the gesture first → no glide). Idempotent:
    // it nulls active.current first, so whichever release event fires first owns
    // the gesture and the rest no-op (no double touchEnd, no double fling).
    const finishGesture = (e: MouseEvent): void => {
      const g = active.current;
      if (g === null) return;
      active.current = null;
      // Never committed = a TAP → clean touchStart+touchEnd at the press point (no
      // move, so the box can NEVER scroll it).
      if (!g.committed) {
        send({ type: 'touchStart', x: g.startX, y: devY(g.startY), touchId: g.touchId }, true);
        send({ type: 'touchEnd', x: g.startX, y: devY(g.startY), touchId: g.touchId }, true);
        return;
      }
      const p = pointerToViewport(e, video);
      if (p === null) {
        // Committed drag released OFF the surface → lift at the last in-bounds point
        // (NOT 0,0 — the Mac injector honors the end coord, so 0,0 reads as a flick).
        send(
          {
            type: 'touchEnd',
            x: clampX(g.lastX ?? g.startX),
            y: devY(clampY(g.lastY ?? g.startY)),
            touchId: g.touchId,
          },
          true,
        );
        return;
      }
      // Committed drag released in-bounds. The inertial fling is DISABLED
      // (FLING_ENABLED=false) — it over-drove the scroll ("much scrolling after i'm
      // done", founder 2026-06-21); a click-drag scroll now stops dead on release.
      const fresh = g.lastT !== undefined && e.timeStamp - g.lastT <= FLING_STALE_MS;
      const speed = g.vx !== undefined && g.vy !== undefined ? Math.hypot(g.vx, g.vy) : 0;
      if (FLING_ENABLED && fresh && speed >= FLING_MIN_SPEED) {
        startFling(g.touchId, p.x, p.y, g.vx as number, g.vy as number);
        return;
      }
      send({ type: 'touchEnd', x: p.x, y: devY(p.y), touchId: g.touchId }, true);
    };
    // Wheel/trackpad scroll → a CONTINUOUS touch drag on ONE virtual finger, NOT a
    // per-event `swipe` (the fork momentum-glides every `swipe` → overlapping glides =
    // jumpy/overshoot, W2736). The founder scrolls with a MacBook TRACKPAD (A3 W2764):
    // two-finger scroll fires HIGH-FREQUENCY `wheel` events INCLUDING the OS inertial
    // momentum stream after the fingers lift ("not even moving my finger and it scrolls").
    //
    // The wheel stream is NOT echoed as per-frame RELATIVE finger moves — the old
    // `ny = w.y - dy` reproduced EVERY spurious opposite-sign frame, so the page bounced
    // back UP mid-scroll (founder's "scrolls me back up", PROVEN by the agt_07aaeccf box
    // trace: one continuous scroll arrived as 9 centre-re-anchored, oscillating gestures).
    // Instead we accumulate the wheel deltas into ONE monotonic drag (A3 W2768):
    //   1. rAF-COALESCE: ≤1 touchMove per animation frame; per-frame delta capped at
    //      WHEEL_MAX_FRAME_DELTA, the remainder CARRIES so a fast flick scrolls its FULL
    //      distance smoothly (no per-event ±120 clamp = "big scroll only moves a bit").
    //   2. LOCK a dominant axis + direction once the cumulative intent clears a deadband;
    //      the off-axis is dropped so a near-vertical scroll stays vertical.
    //   3. RATCHET: the finger position is a strictly-monotonic projection of the
    //      cumulative displacement onto the locked direction — a single opposite-sign
    //      frame nudges the accumulator back but moves the finger by 0 (HOLD), so the page
    //      can never bounce. Only a SUSTAINED give-back (> WHEEL_REVERSAL_PX from the
    //      travel peak) is a genuine reversal: it cleanly touchEnds + seeds a fresh
    //      gesture in the new direction.
    //   4. Re-centre at a true edge CARRYING the locked direction (never a fresh-sign
    //      reset), so a long scroll never pins and a re-centre never reverses the scroll.
    //   5. The OS momentum is ALREADY in the wheel stream → the fork must NOT add its own
    //      touchEnd momentum on THIS path (would double it — A3 keeps Step-B fork momentum
    //      to genuine finger-touch only).
    // Content DOWN (deltaY>0) = finger swipes UP (y↓).
    let wheelDrag: { touchId: number; x: number; y: number } | null = null;
    let wheelTimer = 0;
    let wheelRaf = 0;
    let wheelPendingDx = 0;
    let wheelPendingDy = 0;
    let wheelCursorX = 0;
    // Signed cumulative wheel displacement consumed into the current drag (origin = the
    // touchStart anchor, in wheel-delta space). The finger position is a monotone ratchet
    // of this, projected onto the locked direction.
    let wheelAccDx = 0;
    let wheelAccDy = 0;
    let wheelTravel = 0; // ratcheted scalar travel applied to the finger (≥0, never decreases)
    let wheelDirX = 0; // locked dominant-axis direction (−1/0/1); 0/0 = not yet locked
    let wheelDirY = 0;
    // Per-frame applied-delta cap ≤ the virtual finger's travel from centre (≈389px), so a
    // single frame never needs an intra-frame re-centre; the remainder carries.
    const WHEEL_MAX_FRAME_DELTA = 320;
    const WHEEL_DIR_LOCK_PX = 8; // cumulative magnitude before the axis/sign locks (ignore first-sample jitter)
    const WHEEL_REVERSAL_PX = 96; // give-back from the travel peak that = a GENUINE reversal (else HOLD)
    const WHEEL_IDLE_MS = 320; // no wheel for this long = the scroll (incl OS momentum) is over
    const resetWheelAccum = (): void => {
      wheelAccDx = 0;
      wheelAccDy = 0;
      wheelTravel = 0;
      wheelDirX = 0;
      wheelDirY = 0;
    };
    const endWheelDrag = (): void => {
      if (wheelRaf !== 0) {
        cancelAnimationFrame(wheelRaf);
        wheelRaf = 0;
      }
      wheelPendingDx = 0;
      wheelPendingDy = 0;
      const wd = wheelDrag;
      wheelDrag = null;
      resetWheelAccum();
      if (wd === null) return;
      send({ type: 'touchEnd', x: clampX(wd.x), y: devY(clampY(wd.y)), touchId: wd.touchId }, true);
    };
    const startWheelDrag = (x: number, y: number): { touchId: number; x: number; y: number } => {
      const touchId = touchIdSeq.current++;
      const wd = { touchId, x: clampX(x), y: clampY(y) };
      wheelDrag = wd;
      send({ type: 'touchStart', x: wd.x, y: devY(wd.y), touchId }, true);
      return wd;
    };
    // Lock the dominant-axis direction once the cumulative intent clears the deadband, so
    // the gesture is axis-locked (a near-vertical scroll stays vertical) and the sign is
    // the TRUE scroll sign — not a jittery first sample. Returns true once locked.
    const tryLockWheelDir = (): boolean => {
      if (wheelDirX !== 0 || wheelDirY !== 0) return true;
      if (Math.hypot(wheelAccDx, wheelAccDy) < WHEEL_DIR_LOCK_PX) return false;
      if (Math.abs(wheelAccDx) >= Math.abs(wheelAccDy)) {
        wheelDirX = Math.sign(wheelAccDx) || 1;
        wheelDirY = 0;
      } else {
        wheelDirX = 0;
        wheelDirY = Math.sign(wheelAccDy) || 1;
      }
      return true;
    };
    // Re-arm: keep draining a big flick this frame, else end the gesture after the idle
    // grace (spans macOS inter-burst + momentum-decay gaps so one scroll = one gesture).
    const armWheelTail = (): void => {
      if (Math.abs(wheelPendingDx) >= 0.5 || Math.abs(wheelPendingDy) >= 0.5) {
        wheelRaf = requestAnimationFrame(flushWheel);
      } else {
        wheelTimer = window.setTimeout(endWheelDrag, WHEEL_IDLE_MS);
      }
    };
    const flushWheel = (): void => {
      wheelRaf = 0;
      // A flush = activity → cancel any pending idle-end; re-armed below if the stream
      // has actually stopped.
      window.clearTimeout(wheelTimer);
      if (Math.abs(wheelPendingDx) < 0.5 && Math.abs(wheelPendingDy) < 0.5) {
        wheelPendingDx = 0;
        wheelPendingDy = 0;
        // A drag is still down → re-arm the idle-end we just cleared above. Without this a
        // sub-0.5 stray frame (common in the momentum tail) cancels the only pending touchEnd
        // and returns with no rAF + no timer → the virtual finger is left pressed forever.
        if (wheelDrag !== null) {
          wheelTimer = window.setTimeout(endWheelDrag, WHEEL_IDLE_MS);
        }
        return;
      }
      // Fixed logical device frame (NOT the SFU-downscaled track px — A3 W2811).
      const vw = DEVICE_LOGICAL_WIDTH;
      const vh = DEVICE_LOGICAL_HEIGHT;
      const margin = 48;
      const cap = (d: number): number =>
        Math.max(-WHEEL_MAX_FRAME_DELTA, Math.min(WHEEL_MAX_FRAME_DELTA, d));
      // Apply at most one per-frame cap worth of delta; carry the remainder.
      const frameDx = cap(wheelPendingDx);
      const frameDy = cap(wheelPendingDy);
      wheelPendingDx -= frameDx;
      wheelPendingDy -= frameDy;
      // Fold this frame's (capped) delta into the signed cumulative displacement: the
      // finger speed is bounded per frame while the FULL distance is delivered over frames.
      wheelAccDx += frameDx;
      wheelAccDy += frameDy;

      // Not enough intent yet → accumulate, emit NOTHING (no moveless touchStart spam for
      // a sub-deadband jiggle), keep draining / arm idle.
      if (!tryLockWheelDir()) {
        armWheelTail();
        return;
      }

      // Lazily START the drag at the moment direction locks, anchored at centre (cursor x,
      // mid-height) for symmetric runway — NOT an edge anchor, so a tiny scroll doesn't
      // start the finger at the screen edge (where the fork's hit-test row differs).
      if (wheelDrag === null) {
        startWheelDrag(wheelCursorX, Math.round(vh / 2));
      }

      // Signed travel along the locked direction.
      let proj = wheelAccDx * wheelDirX + wheelAccDy * wheelDirY;

      // GENUINE sustained reversal (gave back > WHEEL_REVERSAL_PX from the ratchet peak):
      // cleanly END this gesture and seed a fresh one in the NEW direction with the
      // residual reverse displacement, so distance is not lost and the new lock takes the
      // new sign. A single/transient opposite frame instead just HOLDS (ratchet below).
      if (proj < wheelTravel - WHEEL_REVERSAL_PX) {
        // Signed reverse travel ALONG the locked axis (≤ -WHEEL_REVERSAL_PX). Seed the fresh
        // gesture with ONLY this along-axis residual — dropping the off-axis accumulator — so
        // the new direction-lock can't grab the wrong (off-axis) direction on a near-pure
        // vertical/horizontal reversal. (Capturing dir before endWheelDrag, which resets it.)
        const reverseProj = proj - wheelTravel;
        const lockedDirX = wheelDirX;
        const lockedDirY = wheelDirY;
        endWheelDrag(); // touchEnd at the current finger position; resets accum + dir
        wheelAccDx = reverseProj * lockedDirX;
        wheelAccDy = reverseProj * lockedDirY;
        if (!tryLockWheelDir()) {
          // New direction not yet decisive → hold; next frame re-establishes it.
          armWheelTail();
          return;
        }
        startWheelDrag(wheelCursorX, Math.round(vh / 2));
        proj = wheelAccDx * wheelDirX + wheelAccDy * wheelDirY;
      }

      // RATCHET: the finger only ever advances. A back-nudge within the reversal band
      // (proj ≤ travel) HOLDS the finger → NO touchMove → the page never bounces.
      const newTravel = Math.max(wheelTravel, proj);
      const advance = newTravel - wheelTravel;
      if (advance <= 0) {
        armWheelTail();
        return;
      }
      wheelTravel = newTravel;

      // Finger moves OPPOSITE to content along the locked direction.
      const w = wheelDrag as { touchId: number; x: number; y: number };
      const nx = w.x - wheelDirX * advance;
      const ny = w.y - wheelDirY * advance;

      // True-edge re-centre, CARRYING the locked direction (never a fresh-sign reset). The
      // fork resets lastTouchPoint on touchStart, so re-anchoring does NOT jump the page;
      // the next move continues in the identical direction. Re-base accum/travel to 0 at
      // the new centre and apply this frame's `advance` fresh from there.
      if (ny < margin || ny > vh - margin || nx < margin || nx > vw - margin) {
        const keepDirX = wheelDirX;
        const keepDirY = wheelDirY;
        endWheelDrag();
        const re = startWheelDrag(wheelCursorX, Math.round(vh / 2));
        wheelDirX = keepDirX;
        wheelDirY = keepDirY;
        re.x = clampX(re.x - keepDirX * advance);
        re.y = clampY(re.y - keepDirY * advance);
        send({ type: 'touchMove', x: re.x, y: devY(re.y), touchId: re.touchId }, false);
        armWheelTail();
        return;
      }
      w.x = clampX(nx);
      w.y = clampY(ny);
      send({ type: 'touchMove', x: w.x, y: devY(w.y), touchId: w.touchId }, false);
      armWheelTail();
    };
    const onWheel = (e: WheelEvent): void => {
      // A held mouse gesture owns the single virtual finger — ignore the wheel until
      // it releases, so a click-drag + trackpad scroll can't put a SECOND concurrent
      // touch on the wire (the device reads two touchIds as a pinch/multi-touch).
      if (active.current !== null) return;
      const p = pointerToViewport(e, video);
      if (p === null) return;
      wheelCursorX = clampX(p.x);
      wheelPendingDx += e.deltaX;
      wheelPendingDy += e.deltaY;
      if (wheelRaf === 0) wheelRaf = requestAnimationFrame(flushWheel);
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

    video.addEventListener('mousedown', onMouseDown);
    video.addEventListener('wheel', onWheel, { passive: true });
    // Move + release on WINDOW, not just the video: the streamed phone is small
    // (~330px wide), so a drag easily wanders off it. onMouseMove no-ops unless a
    // gesture is active, so a window listener keeps a drag scrolling once it leaves
    // the element (audit S1) instead of freezing. finishGesture owns release on
    // BOTH mouseup AND pointerup (the WebView fires pointerup first → it wins the
    // race → the fling actually runs, audit B1); it's idempotent so the duplicate
    // events no-op.
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', finishGesture);
    window.addEventListener('pointerup', finishGesture);
    // Keyboard events go on window so capture works even when the
    // <video> isn't directly focused. Side-effect: the customer can
    // type into the remote browser without first clicking on the
    // video. Trade-off: pressing a key with the panel mounted
    // forwards it everywhere — acceptable because the panel is the
    // only LK consumer in v1.0.
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      video.removeEventListener('mousedown', onMouseDown);
      video.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', finishGesture);
      window.removeEventListener('pointerup', finishGesture);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      // Lift any in-flight finger so a control-flip (manual→AI, which re-runs this
      // effect with enabled=false while the room is still up) or teardown never
      // leaves a STUCK touch on the live phone: end an in-progress committed drag,
      // then stop+lift an inertial glide. send() is best-effort — if the channel is
      // already gone the touchEnd is harmlessly swallowed. An UNcommitted (buffered)
      // gesture sent no touchStart, so it needs no touchEnd.
      const g = active.current;
      if (g !== null && g.committed) {
        send(
          {
            type: 'touchEnd',
            x: clampX(g.lastX ?? g.startX),
            y: devY(clampY(g.lastY ?? g.startY)),
            touchId: g.touchId,
          },
          true,
        );
      }
      cancelFling(true);
      // Lift an in-flight wheel-scroll finger + clear its end timer.
      window.clearTimeout(wheelTimer);
      endWheelDrag();
      active.current = null;
    };
  }, [room, video, enabled]);
}
