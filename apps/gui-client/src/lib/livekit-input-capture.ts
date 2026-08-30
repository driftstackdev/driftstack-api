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
//   - the first committed touchMove and the final pre-end touchMove are
//     reliable lifecycle anchors. LiveKit does not preserve order ACROSS its
//     reliable/lossy DataChannels, so these keep every committed gesture's
//     start→move→end causally ordered even if all lossy moves reorder/drop.
//   - intermediate touchMoves remain reliable=false (lossy ok — a dropped move
//     jitters then recovers; making the high-rate stream reliable congests it).
//
// Pointer-capture: when the press (mousedown) fires the capture pointer-
// captures the video element so subsequent move/release land even when the
// cursor leaves the element bounds (matches remote-desktop UX expectation).

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useRef } from 'react';
import { type CanonicalModifier } from '@driftstack/sdk';
import { sendInputEvent, RoomEvent, type InputEvent, type Room } from './livekit';
import {
  isReliableInputCongested,
  ReliableInputCongestedError,
  setReliableInputCongested,
} from './livekit-input-congestion';

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
  /** Epoch captured when the listeners are installed. A mode/capability/Room
   *  replacement re-keys the effect and makes every older deferred callback stale. */
  authorityEpoch?: number;
  /** Invocation-time authority proof for the exact Room + captured epoch.
   *  Omission is fail-closed even when `enabled` is true. */
  canSend?: (room: Room, authorityEpoch: number) => boolean;
  /** Surfaced when the FIRST input publish fails — the data channel is
   *  effectively dead, so control isn't reaching the device. The parent wires
   *  this to a small non-fatal badge. Fired at most once per effect run. */
  onPublishError?: (room: Room) => void;
  /** Temporary reliable-channel backpressure state. Fresh input is intentionally
   * paused until LiveKit reports the ordered buffer low again. */
  onCongestionChange?: (congested: boolean, room: Room) => void;
  /** The live captured-frame logical device-CSS-px dims the Mac touch injector
   *  addresses (per-archetype, A3 84de32ad4d). The parent computes this from the
   *  <video> element's FIRST full-res natural size ÷ dpr (= screen_width ×
   *  inner_height per archetype) and threads it here so the coordinate mapping +
   *  the scroll/glide clamps adapt to the dispatched device. Undefined until the
   *  first frame reports → the 402×874 fallback default is used (a harmless
   *  pre-stream value; capture is a no-op until a track arrives anyway). NOT a
   *  live read of video.videoWidth/Height — that downscales (A3 W2811). */
  logical?: { width: number; height: number };
}

/** The launch archetype's logical device-CSS-px frame, used as the FALLBACK when
 *  no live frame has reported its size yet (iphone16pro content-only = 402×714 web
 *  viewport; the historical 402×874 screen is the safe default before metadata).
 *
 *  Per-archetype dispatch (A3 84de32ad4d, fork content-only window sizing on box
 *  mac-macstadium-us-001) sizes the captured video PER archetype — the captured
 *  frame == the web content edge-to-edge (NO chrome bands), so the touch injector
 *  addresses that captured-frame logical space (= screen_width × inner_height per
 *  archetype: 16pro 402×714, 14promax 430×739, 13pro 390×699). The live logical
 *  dims are threaded through `logical` (on UseInputCaptureOpts + pointerToViewport)
 *  from the <video> element's first-reported natural size ÷ dpr.
 *
 *  A3 W2811 (downscale invariance) still holds: the source of `logical` is the
 *  FIRST full-res metadata (captured once parent-side), NOT a live read of
 *  video.videoWidth/Height — the SFU REMB-downscales the track under bandwidth
 *  pressure (e.g. to ~200×436), so reading it per-event would halve every
 *  coordinate on a throttle. Mapping against the stable per-archetype `logical`
 *  keeps the touch space invariant to the track resolution. */
const DEVICE_LOGICAL_WIDTH = 402;
const DEVICE_LOGICAL_HEIGHT = 874;

/** Map a browser pointer event to the logical device-CSS-px frame the Mac touch
 *  injector expects (per-archetype captured-frame space — A3 84de32ad4d; defaults
 *  to 402×874 until the live frame size is known), object-contain-aware. Returns
 *  null when the element isn't sized yet (race on first mount) or the pointer is in
 *  a letterbox/pillarbox bar (off-surface).
 *
 *  The `logical` size is a parameter (default 402×874) so each archetype passes its
 *  own captured-frame logical size (= screen_width × inner_height ÷ dpr — the
 *  content-only fork makes the captured video the web content edge-to-edge) and the
 *  pure unit tests can pin the object-contain math at any size. Crucially it does
 *  NOT read video.videoWidth/Height for the scale: the SFU downscales the track, and
 *  pre-2026-06-23 that made a tap land high-and-left ("above where I tap") whenever
 *  the track was throttled, snapping back when it recovered (founder 2026-06-23;
 *  root-caused A3 W2811). The caller threads `logical` from the FIRST full-res
 *  metadata, which is stable across SFU downscale.
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
  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    !Number.isFinite(event.clientX) ||
    !Number.isFinite(event.clientY)
  )
    return null;
  // FIXED logical frame, not the (SFU-downscaled) track px — see above + A3 W2811.
  const nw = logical.width;
  const nh = logical.height;
  if (!Number.isFinite(nw) || !Number.isFinite(nh) || nw <= 0 || nh <= 0) return null;
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
  if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || px > dispW || py < 0 || py > dispH)
    return null;
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

/** Tap-landing Y compensation. ZEROED 2026-06-28 — the content-only "(B)" stream
 *  has shipped (A1 fork 84de32ad4d, deployed on mac-macstadium-us-001 with
 *  MULTI_ARCHETYPE_DISPATCH=1; A3 confirmed via the bus 2026-06-27 W2993): in
 *  content-only mode the 92px hidden-bar reserve AND the 32px macOS title band are
 *  DROPPED, so the captured frame is the web content edge-to-edge (screen_width ×
 *  inner_height) and the injector addresses that web-content space (origin:viewport;
 *  A3 confirmed W2976-Q1). There is NO LONGER a title band to compensate for, so the
 *  old +32 subtraction now lands every tap ~32px TOO HIGH — directly the founder's
 *  "taps do nothing on gmail" (the tap hits the element 32px above the target).
 *
 *  HISTORY: when the box published the FULL 402×874 screen (chrome rendered) the
 *  fork baked a ~32px iOS title band atop the captured screen that the box's tap
 *  mapping did not subtract, so the GUI subtracted it here (probe-measured +32, X
 *  exact). The original comment said "set TAP_Y_OFFSET=0 when (B) ships" — (B) has
 *  shipped, so it is now 0. The harness does NOT re-subtract a devY (it injects the
 *  GUI's wire Y verbatim — A3 W2940 box-trace `wire-y=218 (devY 250−32)` showed the
 *  injected value == the GUI-sent value), so there is no double-count risk; the GUI
 *  was the sole applier and is now the sole zeroer. Kept as a named constant (not
 *  inlined) so a future archetype that re-introduces a title band can re-set it.
 *  Applied to SENT coords ONLY (the scroll-vs-tap deadzone keeps RAW coords). */
const TAP_Y_OFFSET = 0;
const devY = (y: number): number => Math.max(0, y - TAP_Y_OFFSET);

/** Inertial slide (founder 2026-06-21 "slide simulation like a new iphone"): on a
 *  fast drag-release the touch keeps GLIDING and decelerates to a stop. ⚠️ DISABLED
 *  2026-06-21 (FLING_ENABLED=false): once it actually fired (the B1 pointerup-race
 *  fix), the founder hit "awful latency, much scrolling AFTER i'm done" — the glide
 *  over-drove the fork's per-move scroll (A3 W2736 warned of this), so a click-drag
 *  scroll kept moving after release. A click-drag scroll now stops dead on release
 *  (reliable > over-scroll). The pure computeFlingPath + the cancellable runtime are
 *  kept for a future box-smoked re-enable. Its dormant safety envelope is deliberately
 *  short: release velocity, each frame, total duration, and total distance are all
 *  capped before any touchMove reaches the reliable channel. FLING_MIN_SPEED = release
 *  speed (px/ms) to trigger; FLING_STALE_MS = a settle pause that cancels it. */
const FLING_ENABLED = false;
const FLING_MIN_SPEED = 0.45;
const FLING_STALE_MS = 60;
const FLING_STEP_MS = 16;
const FLING_FRICTION = 0.86;
const FLING_STOP_SPEED = 0.05;
const FLING_MAX_SPEED = 1.25;
const FLING_MAX_STEP_DISTANCE = 20;
const FLING_MAX_DURATION_MS = 240;
const FLING_MAX_DISTANCE = 160;

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
 *  and can never run away. The default envelope is intentionally conservative because
 *  the fork turns every move into scroll: ≤1.25 px/ms release speed, ≤20 px/frame,
 *  ≤240 ms, and ≤160 px total. Distance is truncated at the cap (never one-step
 *  overshot). Empty when the release velocity is already below the stop threshold
 *  (→ caller just ends the touch). Operates in raw video-px; the caller applies devY
 *  + surface clamping when it sends each point. */
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
    maxSpeed?: number;
    maxStepDist?: number;
    maxDurationMs?: number;
  } = {},
): Array<{ x: number; y: number }> {
  if (![x0, y0, vx, vy].every(Number.isFinite)) return [];
  const nonNegativeOr = (value: number | undefined, fallback: number): number =>
    value === undefined || Number.isNaN(value) ? fallback : Math.max(0, value);
  const requestedFriction = opts.friction;
  const friction =
    requestedFriction !== undefined && Number.isFinite(requestedFriction)
      ? Math.max(0, Math.min(0.99, requestedFriction))
      : FLING_FRICTION;
  const requestedStepMs = opts.stepMs;
  const stepMs =
    requestedStepMs !== undefined && Number.isFinite(requestedStepMs) && requestedStepMs > 0
      ? requestedStepMs
      : FLING_STEP_MS;
  const stopSpeed = nonNegativeOr(opts.stopSpeed, FLING_STOP_SPEED);
  const maxDist = nonNegativeOr(opts.maxDist, FLING_MAX_DISTANCE);
  const maxSpeed = nonNegativeOr(opts.maxSpeed, FLING_MAX_SPEED);
  const maxStepDist = nonNegativeOr(opts.maxStepDist, FLING_MAX_STEP_DISTANCE);
  const maxDurationMs = nonNegativeOr(opts.maxDurationMs, FLING_MAX_DURATION_MS);
  const requestedMaxSteps = Math.floor(nonNegativeOr(opts.maxSteps, Infinity));
  const durationMaxSteps = Math.max(0, Math.floor(maxDurationMs / stepMs));
  const maxSteps = Math.min(requestedMaxSteps, durationMaxSteps);
  const pts: Array<{ x: number; y: number }> = [];
  let x = x0;
  let y = y0;
  const releaseSpeed = Math.hypot(vx, vy);
  if (releaseSpeed < stopSpeed || maxSpeed === 0 || maxStepDist === 0 || maxDist === 0) {
    return pts;
  }
  const speedScale = releaseSpeed > maxSpeed ? maxSpeed / releaseSpeed : 1;
  let velX = vx * speedScale;
  let velY = vy * speedScale;
  let dist = 0;
  for (let i = 0; i < maxSteps; i++) {
    if (Math.hypot(velX, velY) < stopSpeed) break;
    let dx = velX * stepMs;
    let dy = velY * stepMs;
    const rawStepDist = Math.hypot(dx, dy);
    if (rawStepDist === 0) break;
    const remainingDist = maxDist - dist;
    if (remainingDist <= 0) break;
    const boundedStepDist = Math.min(rawStepDist, maxStepDist, remainingDist);
    const stepScale = boundedStepDist / rawStepDist;
    dx *= stepScale;
    dy *= stepScale;
    x += dx;
    y += dy;
    dist += boundedStepDist;
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
    authorityEpoch: number;
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
  const fling = useRef<{
    authorityEpoch: number;
    touchId: number;
    x: number;
    y: number;
    timer: number;
  } | null>(null);
  const touchIdSeq = useRef(0);
  // Keep the latest onPublishError in a ref so the capture effect does NOT
  // depend on the callback's identity — the natural usage is an inline arrow (a
  // fresh ref every render), and re-keying the effect on it would tear down +
  // re-attach the listeners (nulling the in-flight gesture) on every render.
  const onPublishErrorRef = useRef(opts.onPublishError);
  useEffect(() => {
    onPublishErrorRef.current = opts.onPublishError;
  }, [opts.onPublishError]);
  const onCongestionChangeRef = useRef(opts.onCongestionChange);
  // V-2168 — the capture effect's congestion-ONSET side effects (lift the
  // finger, cancel the fling, release held keys), registered here so the single
  // room-scoped subscription below can invoke them while capture is attached.
  // Null whenever capture is torn down — the state bookkeeping continues, the
  // input actions do not.
  const congestionInterruptRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    onCongestionChangeRef.current = opts.onCongestionChange;
  }, [opts.onCongestionChange]);

  // Destructure to PRIMITIVES so the effect depends on the actual room / element
  // / enabled VALUES, not the opts OBJECT. A caller passing an inline
  // `{ room, videoElement, enabled }` literal (the natural usage) makes `opts` a
  // fresh reference every render; with an `[opts]` dep the effect would re-attach
  // the listeners — and its cleanup nulls `active.current`, dropping any
  // in-flight finger-down gesture. Depending on the primitives (mirrors
  // livekit-latency-ping.ts) re-runs only on a real change, and keying on the
  // actual `videoElement` re-runs the effect when the element mounts.
  const { room, videoElement: video, enabled } = opts;
  const authorityEpoch = opts.authorityEpoch ?? 0;
  const canSend = opts.canSend;
  const ownsAuthority = useCallback(
    (ownerRoom: Room): boolean => canSend !== undefined && canSend(ownerRoom, authorityEpoch),
    [canSend, authorityEpoch],
  );
  // The per-archetype captured-frame logical dims (default 402×874 until the first
  // frame reports). Destructured to primitives so the effect re-keys on the actual
  // width/height VALUES — a parent passing an inline `{ width, height }` literal
  // makes `opts.logical` a fresh ref every render; depending on the object would
  // re-attach the listeners (and its cleanup nulls active.current, dropping an
  // in-flight gesture). The DEFAULTS land here so the in-effect closures below read
  // a single resolved pair.
  const logicalW = opts.logical?.width ?? DEVICE_LOGICAL_WIDTH;
  const logicalH = opts.logical?.height ?? DEVICE_LOGICAL_HEIGHT;
  // ⛔ V-2168 — the LATCH's life-support runs on a ROOM-scoped effect, never
  // gated by `enabled` or input authority. The capture effect below is torn
  // down for the entire duration of a reconnect (authority is suspended while
  // connState !== 'connected'), which unsubscribed BOTH of the latch's clearing
  // paths — so when an in-place reconnect replaced the DataChannel,
  // RoomEvent.Reconnected fired with nobody listening, the WeakSet latch stayed
  // set, the fresh channel started low (no crossing event would ever come), and
  // every input source shed at the source forever: "reconnects, but not
  // listening to any of my inputs anymore". Congestion belongs to the Room; its
  // bookkeeping must outlive whoever currently owns input.
  useEffect(() => {
    if (room === null) return;
    if (typeof (room as unknown as { on?: unknown }).on !== 'function') return;
    // Tell the panel the current state at attach (a re-mount must not assume
    // "not congested" while the store says otherwise).
    onCongestionChangeRef.current?.(isReliableInputCongested(room), room);
    // A retired effect's handlers go INERT rather than relying on `.off` alone:
    // a late event captured by a test double (or an emitter delivering after
    // unsubscribe) must not let a PREVIOUS room write congestion state.
    let disposed = false;
    const onDC = (isLow: boolean, kind: number): void => {
      if (disposed) return;
      // DataChannelKind.RELIABLE === 0 (livekit-client internal enum, stable).
      // The lossy channel already self-drops under congestion; if livekit ever
      // renumbered, the flag never trips and we degrade to no-backpressure.
      if (kind !== 0) return;
      setReliableInputCongested(room, !isLow);
      onCongestionChangeRef.current?.(!isLow, room);
      // Congestion ONSET: stop any in-flight gesture at the source (registered
      // only while capture is attached and owning input).
      if (!isLow) congestionInterruptRef.current?.();
    };
    const onReconnected = (): void => {
      if (disposed) return;
      // A reconnect replaced the channel with a fresh, empty one. Its buffer
      // begins low, so no low-threshold crossing is guaranteed; clear the prior
      // channel's latch or input stays paused forever.
      setReliableInputCongested(room, false);
      onCongestionChangeRef.current?.(false, room);
    };
    (room as { on: (e: string, cb: (isLow: boolean, kind: number) => void) => void }).on(
      RoomEvent.DCBufferStatusChanged,
      onDC,
    );
    (room as { on: (e: string, cb: () => void) => void }).on(RoomEvent.Reconnected, onReconnected);
    return () => {
      disposed = true;
      // ⛔ `.off?.` — optional on purpose. Plenty of test/stub Rooms implement
      // `on` without `off` (the latency-ping hook makes the same allowance); an
      // unguarded call here threw from a React unmount destructor, and one
      // throwing destructor took down not just its own suite but the worker
      // running it — the full gate went 3071-files-red off this single line.
      (room as { off?: (e: string, cb: (isLow: boolean, kind: number) => void) => void }).off?.(
        RoomEvent.DCBufferStatusChanged,
        onDC,
      );
      (room as { off?: (e: string, cb: () => void) => void }).off?.(
        RoomEvent.Reconnected,
        onReconnected,
      );
    };
  }, [room]);

  useEffect(() => {
    if (!enabled || room === null || video === null || !ownsAuthority(room)) return;
    // The captured-frame logical frame the injector addresses (per-archetype). Used
    // for the pointer mapping AND the scroll/glide clamps so both adapt together.
    const logical = { width: logicalW, height: logicalH };

    let warnedPublishFailure = false;

    // Reliable-channel BACKPRESSURE guard (founder 2026-07-08: "fast scrolling/
    // tapping → then it becomes unresponsive"). livekit's publishData does NOT drop
    // on the reliable DataChannel — it BLOCKS (`waitForBufferStatusLow`) once the
    // channel's bufferedAmount exceeds ~64KB. On a slow/lossy link (the founder's
    // ~620ms-RTT proxy) the ORDERED reliable channel stalls under packet loss, and
    // since taps, scroll re-centre/reversal legs, `navigate` and `activateTab` ALL
    // ride it, they queue head-of-line: input goes dead, then replays in a jarring
    // flurry when the link recovers (and a delayed touchEnd strands a finger "down",
    // freezing the page). We watch the reliable buffer status and, WHILE CONGESTED,
    // shed NEW user intent at its source (see pointer/wheel/keyboard handlers) so the
    // backlog DRAINS instead of growing — a stale tap, key, or mid-scroll position is
    // worse than dropping it because it can replay against a different page after recovery.
    // Releases for gestures/keys that were already sent remain mandatory.
    // On a healthy link this flag never leaves `false` (livekit only emits on a
    // threshold crossing, and it starts "low"), so behavior is byte-identical to
    // before; it only changes the actual failure case.
    // Congestion belongs to the Room, not this particular listener effect: the
    // V-2168 room-scoped effect above owns the single subscription, the store,
    // and the panel callback, and it SURVIVES this effect's teardown (the old
    // in-effect subscription was torn down for the whole of a reconnect, so the
    // latch's clearing paths went unheard and input stayed shed forever). Hot
    // paths read the room-keyed store directly — a WeakSet lookup — so this
    // effect re-keying can never resume input mid-stall, and a torn-down
    // capture can no longer strand the latch.
    const reliablyCongestedNow = (): boolean => isReliableInputCongested(room);
    // Congestion ONSET side effects, registered for the room-scoped handler to
    // invoke: stop any gesture already in progress as soon as congestion is
    // reported. A committed finger MUST still receive its release; an
    // uncommitted tap has put nothing on the wire and is simply discarded. This
    // bounds the stale tail at one essential touchEnd instead of letting later
    // moves/re-centres/taps queue.
    congestionInterruptRef.current = () => {
      liftActiveFinger();
      cancelFling(true);
      window.clearTimeout(wheelTimer);
      endWheelDrag();
      releaseForwardedKeys();
    };

    const send = (event: InputEvent, reliable: boolean): void => {
      if (!ownsAuthority(room)) return;
      lastSend.current = sendInputEvent(room, event, { reliable }).catch((err: unknown) => {
        // Expected backpressure shedding is not a control failure. It self-heals on
        // buffer-low and must not raise the persistent "control unreachable" badge.
        if (err instanceof ReliableInputCongestedError) return undefined;
        // Swallow per-event (a rejected move must not throw into the UI), but
        // surface the FIRST failure: a silently-dead control channel reads as
        // "view-only" with no diagnostic (founder-hit 2026-06-12).
        if (!warnedPublishFailure && ownsAuthority(room)) {
          warnedPublishFailure = true;
          console.warn(
            '[simulator] input publish failed — control will not reach the device:',
            err,
          );
          onPublishErrorRef.current?.(room);
        }
        return undefined;
      });
    };

    // LiveKit's reliable and lossy DataChannels are each ordered internally but
    // have NO cross-channel ordering. Ending a committed gesture directly on the
    // reliable channel can therefore overtake its lossy moves, producing
    // START→END(moves=0) at the harness while the orphan moves arrive outside the
    // lifecycle. Put one absolute final move immediately before the end on the
    // same reliable channel. Repeating the current coordinate is harmless (zero
    // delta) when a lossy copy already arrived; when it did not, this preserves the
    // full final displacement and makes the gesture observably scroll.
    const endCommittedTouch = (x: number, y: number, touchId: number): void => {
      send({ type: 'touchMove', x, y, touchId }, true);
      send({ type: 'touchEnd', x, y, touchId }, true);
    };

    // Clamp a glide/scroll point inside the per-archetype captured-frame logical
    // device frame (the live `logical` dims, default 402×874), NOT
    // video.videoWidth/Height — the SFU downscales the track, so clamping to the
    // track px would shrink the usable surface on a throttle (same root cause as
    // the pointerToViewport fix, A3 W2811). A flick path extends past where the
    // finger lifted, so this keeps us from sending a wild off-surface touch.
    const clampX = (v: number): number => Math.max(0, Math.min(logical.width, v));
    const clampY = (v: number): number => Math.max(0, Math.min(logical.height, v));
    // Halt an in-flight inertial glide. endTouch=true lifts the gliding finger (a
    // new press mid-glide, like tapping to stop iOS momentum); teardown passes
    // false (just clear the timer — the room is going away).
    const cancelFling = (endTouch: boolean): void => {
      const f = fling.current;
      if (f === null || f.authorityEpoch !== authorityEpoch) return;
      window.clearTimeout(f.timer);
      fling.current = null;
      if (endTouch) {
        endCommittedTouch(clampX(f.x), devY(clampY(f.y)), f.touchId);
      }
    };
    // Replay a decelerating flick as timed touchMove events, then a final touchEnd.
    // The held touchId stays down through the glide so the device reads ONE
    // continuous finger sliding + settling (iOS momentum), not a new gesture.
    const startFling = (touchId: number, x0: number, y0: number, vx: number, vy: number): void => {
      if (!ownsAuthority(room)) return;
      cancelFling(false);
      const path = computeFlingPath(x0, y0, vx, vy);
      if (path.length === 0) {
        endCommittedTouch(clampX(x0), devY(clampY(y0)), touchId);
        return;
      }
      fling.current = { authorityEpoch, touchId, x: x0, y: y0, timer: 0 };
      let i = 0;
      const step = (): void => {
        const f = fling.current;
        if (f === null || f.authorityEpoch !== authorityEpoch || !ownsAuthority(room)) return;
        const pt = i < path.length ? path[i] : undefined;
        i += 1;
        if (pt === undefined) {
          // Glide exhausted (or a defensive miss) — lift the finger at the last
          // point we sent (f.x/f.y track it), settling the momentum scroll.
          endCommittedTouch(clampX(f.x), devY(clampY(f.y)), touchId);
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
      if (!ownsAuthority(room)) return;
      if (mouseButton(e.button) !== 0) return;
      // Defense-in-depth: if a prior committed drag never saw its release (a lost
      // pointercancel/blur the handlers below missed), lift that orphaned finger BEFORE
      // starting this gesture — otherwise the box would have two touchIds down at once
      // (a spurious multi-touch/pinch or a wrong-place tap). A no-op normally.
      liftActiveFinger();
      // A new touch during a glide stops it (iOS: tap-to-halt momentum) and lifts
      // the gliding finger before this press starts its own.
      cancelFling(true);
      // A new press also lifts any in-flight wheel-scroll finger (symmetry with the
      // effect teardown) so the wheel + mouse paths never leave two fingers on the
      // wire — a residual wheel touch + a fresh press = a spurious multi-touch/pinch.
      window.clearTimeout(wheelTimer);
      endWheelDrag();
      // Do not enqueue a new press behind a stalled ordered channel. Replaying a
      // seconds-old tap after the page has changed is actively unsafe; the next press
      // works normally once DCBufferStatusChanged reports the buffer low again.
      if (reliablyCongestedNow()) return;
      const p = pointerToViewport(e, video, logical);
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
      active.current = {
        authorityEpoch,
        touchId,
        startX: p.x,
        startY: p.y,
        startT: e.timeStamp,
        committed: false,
      };
    };
    // Move only while a finger is down (no iPhone hover). Until the gesture COMMITS
    // to a drag we send nothing (it might still be a tap); on commit we emit the
    // buffered touchStart at the PRESS point, then stream moves. Commit needs the
    // cursor past MOVE_DEADZONE AND (held > DRAG_HOLD_MS = a deliberate scroll, OR
    // moved past DRAG_HARD_PX = a decisive/fast flick) — so a quick drifty click
    // never crosses into a scroll. The FIRST committed touchMove is reliable so it
    // cannot overtake the reliable touchStart on LiveKit's separate lossy channel;
    // later high-rate moves are lossy so a fast drag cannot congest reliable input.
    const onMouseMove = (e: MouseEvent): void => {
      const g = active.current;
      if (g === null || g.authorityEpoch !== authorityEpoch || !ownsAuthority(room)) return;
      let lifecycleAnchor = false;
      let p = pointerToViewport(e, video, logical);
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
        p = pointerToViewport({ clientX: cx, clientY: cy } as MouseEvent, video, logical);
        if (p === null) {
          // The clamped EDGE point can land in a sub-pixel object-contain bar (W2820 #3:
          // the element's on-screen aspect can drift a hair from the logical 402×874 when
          // the SFU downscales the track to a not-exactly-402:874 even resolution), so
          // pointerToViewport returns null exactly at the edge — which would re-freeze the
          // committed drag the clamp exists to keep alive (audit S1). Fall back to a direct
          // rect-fraction map clamped to the logical frame so the scroll never freezes.
          p = {
            x: Math.round(Math.max(0, Math.min(1, (cx - r.left) / r.width)) * logical.width),
            y: Math.round(Math.max(0, Math.min(1, (cy - r.top) / r.height)) * logical.height),
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
        lifecycleAnchor = true;
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
      send({ type: 'touchMove', x: p.x, y: devY(p.y), touchId: g.touchId }, lifecycleAnchor);
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
      if (g === null || g.authorityEpoch !== authorityEpoch || !ownsAuthority(room)) return;
      active.current = null;
      // Never committed = a TAP → clean touchStart+touchEnd at the press point (no
      // move, so the box can NEVER scroll it).
      if (!g.committed) {
        // Congestion may begin between press and release. No touchStart was emitted
        // yet, so discard the whole pending tap rather than enqueueing stale intent.
        if (reliablyCongestedNow()) return;
        send({ type: 'touchStart', x: g.startX, y: devY(g.startY), touchId: g.touchId }, true);
        send({ type: 'touchEnd', x: g.startX, y: devY(g.startY), touchId: g.touchId }, true);
        return;
      }
      const p = pointerToViewport(e, video, logical);
      if (p === null) {
        // Committed drag released OFF the surface → lift at the last in-bounds point
        // (NOT 0,0 — the Mac injector honors the end coord, so 0,0 reads as a flick).
        endCommittedTouch(
          clampX(g.lastX ?? g.startX),
          devY(clampY(g.lastY ?? g.startY)),
          g.touchId,
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
      endCommittedTouch(p.x, devY(p.y), g.touchId);
    };
    // Lift a COMMITTED active finger at its last known point + null the gesture. A no-op
    // for an uncommitted (buffered tap — no touchStart sent yet) or absent gesture. Used
    // by both the lost-gesture cleanup (pointercancel/blur) and the defense at the top of
    // onMouseDown, so a release we never see can't strand a pressed finger on the device.
    const liftActiveFinger = (): void => {
      const g = active.current;
      if (g !== null && g.authorityEpoch !== authorityEpoch) return;
      active.current = null;
      if (g === null || !g.committed) return;
      endCommittedTouch(clampX(g.lastX ?? g.startX), devY(clampY(g.lastY ?? g.startY)), g.touchId);
    };
    // A gesture stream interrupted mid-flight WITHOUT a release: a system gesture
    // (3/4-finger swipe, Mission Control → pointercancel), the window losing focus
    // (blur), or any lost pointer-capture. Without this the device keeps the finger
    // pressed (page frozen/half-scrolled) and the NEXT press would put a SECOND touch
    // down (a spurious pinch / wrong-place tap). Run the same lift cleanup a real
    // release would: lift the committed finger, end the wheel drag, cancel any fling.
    const onLostGesture = (): void => {
      if (!ownsAuthority(room)) return;
      liftActiveFinger();
      cancelFling(true);
      window.clearTimeout(wheelTimer);
      endWheelDrag();
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
    type WheelDrag = { touchId: number; x: number; y: number; hasReliableMove: boolean };
    let wheelDrag: WheelDrag | null = null;
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
    // Lift the virtual wheel-finger (touchEnd + reset the drag/accumulators) WITHOUT
    // clearing the pending carry. The mid-flush re-centre / reversal paths invoke this so
    // the remainder of a big flick (anything above WHEEL_MAX_FRAME_DELTA in a single
    // coalesced frame) keeps draining across the lift instead of being silently dropped —
    // the founder's "big scroll only moves a bit" class. The idle-end / cleanup paths call
    // endWheelDrag below, which lifts AND clears the pending (a true end of the gesture).
    const liftWheelFinger = (): void => {
      if (wheelRaf !== 0) {
        cancelAnimationFrame(wheelRaf);
        wheelRaf = 0;
      }
      const wd = wheelDrag;
      wheelDrag = null;
      resetWheelAccum();
      if (wd === null) return;
      endCommittedTouch(clampX(wd.x), devY(clampY(wd.y)), wd.touchId);
    };
    const endWheelDrag = (): void => {
      // True end of the gesture — drop any remainder too (idle timeout / new mousedown).
      wheelPendingDx = 0;
      wheelPendingDy = 0;
      liftWheelFinger();
    };
    const startWheelDrag = (x: number, y: number): WheelDrag => {
      const touchId = touchIdSeq.current++;
      const wd = { touchId, x: clampX(x), y: clampY(y), hasReliableMove: false };
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
      if (!ownsAuthority(room)) {
        wheelPendingDx = 0;
        wheelPendingDy = 0;
        return;
      }
      if (Math.abs(wheelPendingDx) >= 0.5 || Math.abs(wheelPendingDy) >= 0.5) {
        wheelRaf = requestAnimationFrame(flushWheel);
      } else {
        wheelTimer = window.setTimeout(endWheelDrag, WHEEL_IDLE_MS);
      }
    };
    const flushWheel = (): void => {
      if (!ownsAuthority(room)) {
        wheelRaf = 0;
        window.clearTimeout(wheelTimer);
        wheelPendingDx = 0;
        wheelPendingDy = 0;
        wheelDrag = null;
        return;
      }
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
      // Per-archetype captured-frame logical device frame (NOT the SFU-downscaled
      // track px — A3 W2811).
      const vw = logical.width;
      const vh = logical.height;
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
        // liftWheelFinger (NOT endWheelDrag): touchEnd + reset accum/dir but KEEP the
        // pending carry so the rest of a big flick still drains into the fresh gesture.
        liftWheelFinger();
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
      const w = wheelDrag as WheelDrag;
      const nx = w.x - wheelDirX * advance;
      const ny = w.y - wheelDirY * advance;

      // True-edge re-centre, CARRYING the locked direction (never a fresh-sign reset). The
      // fork resets lastTouchPoint on touchStart, so re-anchoring does NOT jump the page;
      // the next move continues in the identical direction. Re-base accum/travel to 0 at
      // the new centre and apply this frame's `advance` fresh from there. Check ONLY the
      // locked axis (wheelDirX/Y): the off-axis coord is constant (anchored at the start
      // x = wheelCursorX for a vertical scroll), so testing it against the edge fires a
      // SPURIOUS re-centre on EVERY frame whenever the cursor sits within `margin` of a
      // side edge of the narrow (~402px) phone — fragmenting one smooth vertical scroll
      // into a flood of touchEnd+touchStart legs (the very "9 re-anchored oscillating
      // gestures" the W2768 ratchet exists to prevent, re-triggered by a near-edge cursor).
      const hitEdge =
        (wheelDirY !== 0 && (ny < margin || ny > vh - margin)) ||
        (wheelDirX !== 0 && (nx < margin || nx > vw - margin));
      if (hitEdge) {
        const keepDirX = wheelDirX;
        const keepDirY = wheelDirY;
        // liftWheelFinger (NOT endWheelDrag): KEEP wheelPendingDx/Dy so a flick whose
        // single coalesced frame carried more than WHEEL_MAX_FRAME_DELTA still drains its
        // remainder after the re-centre instead of silently dropping it.
        liftWheelFinger();
        const re = startWheelDrag(wheelCursorX, Math.round(vh / 2));
        wheelDirX = keepDirX;
        wheelDirY = keepDirY;
        re.x = clampX(re.x - keepDirX * advance);
        re.y = clampY(re.y - keepDirY * advance);
        re.hasReliableMove = true;
        send({ type: 'touchMove', x: re.x, y: devY(re.y), touchId: re.touchId }, true);
        armWheelTail();
        return;
      }
      w.x = clampX(nx);
      w.y = clampY(ny);
      const lifecycleAnchor = !w.hasReliableMove;
      w.hasReliableMove = true;
      send({ type: 'touchMove', x: w.x, y: devY(w.y), touchId: w.touchId }, lifecycleAnchor);
      armWheelTail();
    };
    const onWheel = (e: WheelEvent): void => {
      if (!ownsAuthority(room)) return;
      // A held mouse gesture owns the single virtual finger — ignore the wheel until
      // it releases, so a click-drag + trackpad scroll can't put a SECOND concurrent
      // touch on the wire (the device reads two touchIds as a pinch/multi-touch).
      if (active.current?.authorityEpoch === authorityEpoch) return;
      // BACKPRESSURE shed (see reliableCongested): while the reliable channel is
      // backed up, DROP incoming wheel events so we don't pile seconds of stale
      // scroll onto a stalled ORDERED channel — that backlog is exactly what makes
      // taps + navigation go unresponsive, and it replays in a jarring flurry once
      // the link recovers. Dropping mid-stall scroll is harmless: the video is frozen
      // during the stall anyway, and this self-heals the instant the buffer drains
      // (the flag clears on the next DCBufferStatusChanged). An in-flight wheelDrag is
      // lifted cleanly by its WHEEL_IDLE_MS idle-end touchEnd (one essential message),
      // so no finger is left pressed.
      if (reliablyCongestedNow()) return;
      const p = pointerToViewport(e, video, logical);
      if (p === null) return;
      wheelCursorX = clampX(p.x);
      // Normalize deltaMode (line/page → px), mirroring LiveSessionView's wheel path. A
      // classic mouse wheel (or any input) that reports LINE (1) or PAGE (2) mode emits a
      // tiny raw count per notch (e.g. ±1/±3) instead of pixels; without this the cumulative
      // intent barely clears WHEEL_DIR_LOCK_PX and the page crawls (scrolling feels dead).
      // Page mode = one device viewport-height of scroll in the per-archetype logical
      // wire space.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? logical.height : 1;
      wheelPendingDx += e.deltaX * unit;
      wheelPendingDy += e.deltaY * unit;
      if (wheelRaf === 0) wheelRaf = requestAnimationFrame(flushWheel);
    };
    // True when a LOCAL GUI element owns the keyboard. The listeners are bound on
    // `window`, so checking only text editables lets Enter/Space/arrow activate a
    // focused GUI button/link/select/tab AND operate the live phone on the same
    // physical press. Root/body mean no local control owns focus, and the stream
    // video explicitly represents remote control; every other focused element is
    // local. The forwarded-key map below still owns keyUp after a forwarded key's
    // default action moves focus from root/video into a local control.
    const keyOwnedLocally = (): boolean => {
      const el = document.activeElement;
      return el !== null && el !== document.documentElement && el !== document.body && el !== video;
    };
    // The bare Escape key is the GUI's drawer-collapse shortcut (a document-level
    // keydown in SimulatorWindow). It has no iPhone-meaningful analogue for the
    // touch flows the device runs, so forwarding it ALSO to the device dismissed a
    // modal/menu/dropdown on the live page on the same press the founder used to
    // close the drawer — one keypress doing two things (audit). Skip forwarding a
    // bare Escape (no modifiers); a modified Escape still goes through (rare, but
    // it's not the drawer shortcut). Applies to both keyDown + keyUp so a half-key
    // never reaches the device.
    const isBareEscape = (e: KeyboardEvent): boolean =>
      e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    // Keys whose keyDown we forwarded to the device this capture run, tracked by
    // PHYSICAL key (e.code, stable across shift so a keyDown 'A' still matches its
    // keyUp 'a'). The keyUp gate MUST mirror the keyDown decision, not re-evaluate
    // keyOwnedLocally()/isBareEscape() at keyup time: a key whose default action
    // moves GUI focus INTO an input (Tab / Shift+Tab into the address bar or the
    // "Tell the agent" composer) fires its keyUp while editingLocally() is now
    // true, so re-checking there would forward keyDown but drop keyUp → a stuck
    // key (or stuck Shift corrupting every later key) on the remote device (Fable
    // GUI LiveKit re-audit). Always forward the keyUp iff we forwarded its keyDown.
    const forwardedKeys = new Map<string, string>();
    const keyId = (e: KeyboardEvent): string => (e.code !== '' ? e.code : e.key);
    const releaseForwardedKeys = (): void => {
      for (const key of forwardedKeys.values()) {
        // Cleanup is authoritative: an absent modifier snapshot makes the harness
        // reconcile every remotely-held modifier to neutral before releasing the
        // stored down-time key value.
        send({ type: 'keyUp', key }, true);
      }
      forwardedKeys.clear();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!ownsAuthority(room)) return;
      if (keyOwnedLocally()) return;
      if (isBareEscape(e)) return;
      // BACKPRESSURE shed (mirrors pointer/wheel): do not put a NEW keyDown behind a
      // stalled ordered channel. Even a single delayed character or Enter can replay
      // into the wrong field/page after recovery. Keys whose down was sent before the
      // stall remain in forwardedKeys, so their keyUp is still delivered below and no
      // remote modifier/key is stranded. Self-heals when the buffer reports low again.
      if (reliablyCongestedNow()) return;
      const modifiers = modifiersFromEvent(e);
      const id = keyId(e);
      const priorKey = forwardedKeys.get(id);
      // `KeyboardEvent.code` identifies the physical key, while `event.key` can
      // change during a held-key repeat as modifiers/layout state changes. Balance
      // the old W3C value before pressing its successor; otherwise both values stay
      // held remotely and the final physical keyUp can release only one of them.
      if (priorKey !== undefined && priorKey !== e.key) {
        send(
          {
            type: 'keyUp',
            key: priorKey,
            ...(modifiers !== undefined ? { modifiers } : {}),
          },
          true,
        );
      }
      forwardedKeys.set(id, e.key);
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
      if (!ownsAuthority(room)) return;
      // Mirror the keyDown decision: only forward the up for a key whose down we
      // forwarded (so composer typing still never leaks), but do so regardless of
      // the CURRENT editing/escape state so a focus-moving key can't strand a
      // half-press on the device.
      const id = keyId(e);
      const forwardedKey = forwardedKeys.get(id);
      if (forwardedKey === undefined) return;
      forwardedKeys.delete(id);
      const modifiers = modifiersFromEvent(e);
      send(
        {
          type: 'keyUp',
          // Release the exact stateful W3C value pressed at keyDown. The current
          // DOM key may differ after a Shift/layout transition (`A` → `a`).
          key: forwardedKey,
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
    // A gesture interrupted without a release (system swipe → pointercancel, the window
    // losing focus → blur) must lift the finger or the device stays pressed and the next
    // press double-touches. Both run the same lift cleanup a real release would.
    window.addEventListener('pointercancel', onLostGesture);
    window.addEventListener('blur', onLostGesture);
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
      // V-2168 — un-register the congestion-onset input actions; the room-scoped
      // subscription and its state bookkeeping deliberately stay live.
      congestionInterruptRef.current = null;
      // Do not clear the room-owned latch here: this cleanup can be a same-Room
      // logical-dimension reattach, not a disconnect. WeakSet ownership means an
      // actually discarded Room is collectible without explicit deletion. Do not
      // publish a synthetic `false` either: a same-Room re-key while the latch is
      // true would look like a real drain to the parent and briefly resume deferred
      // input/tab work before setup re-reported the still-congested state.
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', finishGesture);
      window.removeEventListener('pointerup', finishGesture);
      window.removeEventListener('pointercancel', onLostGesture);
      window.removeEventListener('blur', onLostGesture);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      // A mode flip/unmount can remove the keyup listener while a remote key is
      // still held. Release every forwarded down before teardown so modifiers and
      // focus-moving keys cannot remain latched on the device.
      releaseForwardedKeys();
      // Lift any in-flight finger so a control-flip (manual→AI, which re-runs this
      // effect with enabled=false while the room is still up) or teardown never
      // leaves a STUCK touch on the live phone: end an in-progress committed drag,
      // then stop+lift an inertial glide. send() is best-effort — if the channel is
      // already gone the touchEnd is harmlessly swallowed. An UNcommitted (buffered)
      // gesture sent no touchStart, so it needs no touchEnd.
      const g = active.current;
      if (g !== null && g.authorityEpoch === authorityEpoch && g.committed) {
        endCommittedTouch(
          clampX(g.lastX ?? g.startX),
          devY(clampY(g.lastY ?? g.startY)),
          g.touchId,
        );
      }
      cancelFling(true);
      // Lift an in-flight wheel-scroll finger + clear its end timer.
      window.clearTimeout(wheelTimer);
      endWheelDrag();
      if (active.current?.authorityEpoch === authorityEpoch) active.current = null;
    };
  }, [room, video, enabled, logicalW, logicalH, ownsAuthority]);
}
