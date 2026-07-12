// Slice 4 (Wave 29-NNN ARC 3) — LK.6 InputEvent wire contract shared
// across LiveKit DataChannel (gui-client direct path) AND HTTP route
// POST /v1/agent-sessions/:id/input-event (customer-dashboard path).
//
// Originally defined in apps/gui-client/src/lib/livekit.ts:23 as
// `type InputEvent`. Slice 4 promotes the type here so all 3 SDKs +
// the dashboard + the server route share the same discriminated
// union; the gui-client retains a local copy that's pinned to this
// definition via a cross-surface parity test (drift would diverge
// the Mac harness's Swift decoder from the dashboard's encoder).
//
// State-of-the-art reference: Quartz `CGEventType` on macOS — these
// 7 variants map 1:1 onto the harness side's CGEvent dispatch.

import { z } from 'zod';

/** Maximum byte length for an interpolated `key` field. macOS Quartz
 *  CGEvent expects single-character or named key strings ("Enter",
 *  "Backspace", "ArrowUp", etc.); 64 chars caps the longest reasonable
 *  named key without allowing pathological JSON-bloating attacks. */
const MAX_KEY_LENGTH = 64;

/** Maximum modifier count. Practical max is 4 (Cmd+Shift+Option+Ctrl). */
const MAX_MODIFIERS = 8;

/** Canonical modifier vocabulary (Slice 6 cross-SDK lock 2026-05-20).
 *
 * The 4 names below map 1:1 onto Quartz `CGEventFlags` on the macOS
 * harness side; the harness decoder rejects DOM-standard variants
 * (`Shift / Control / Alt / Meta`). Both gui-client and
 * customer-dashboard emit this vocabulary — the cross-surface parity
 * test at apps/server/tests/unit/lk6-modifier-vocabulary-cross-surface-
 * parity.test.ts negatively guards against either surface drifting back.
 *
 * The schema deliberately keeps `modifiers: z.array(z.string())` (no
 * z.enum) so the wire stays forward-compatible for additional Quartz
 * flag-bits (`fn / capsLock / numericPad / help`) without a schema
 * version bump. Customers building their own input-event producer
 * MUST use the 4 names below; anything else round-trips through the
 * schema unchanged but is dropped on the harness side. */
export const CANONICAL_MODIFIER_NAMES = ['cmd', 'ctrl', 'shift', 'option'] as const;
export type CanonicalModifier = (typeof CANONICAL_MODIFIER_NAMES)[number];

/** Bounds for screen-space coordinates. The harness clamps to the
 *  actual viewport at dispatch time; we cap here to block obviously
 *  malformed input + JSON-bloating attacks. 100_000 is generous —
 *  no real screen is bigger than ~20k px on a side. */
const MAX_COORD = 100_000;

/** Bounds for wheel delta. macOS Quartz CGEventCreateScrollWheelEvent
 *  accepts int32 but the realistic range is much narrower. */
const MAX_WHEEL_DELTA = 100_000;

/** Max touch identifier — 10-finger cap for multi-touch (pinch etc.). */
const MAX_TOUCH_ID = 9;

/** Max swipe duration. A gesture longer than a minute is malformed. */
const MAX_SWIPE_DURATION_MS = 60_000;

export const InputEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('mouseMove'),
    x: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    y: z.number().int().min(-MAX_COORD).max(MAX_COORD),
  }),
  z.object({
    type: z.literal('mouseDown'),
    x: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    y: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    button: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  }),
  z.object({
    type: z.literal('mouseUp'),
    x: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    y: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    button: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  }),
  z.object({
    type: z.literal('keyDown'),
    key: z.string().min(1).max(MAX_KEY_LENGTH),
    modifiers: z.array(z.string().max(MAX_KEY_LENGTH)).max(MAX_MODIFIERS).optional(),
  }),
  z.object({
    type: z.literal('keyUp'),
    key: z.string().min(1).max(MAX_KEY_LENGTH),
    modifiers: z.array(z.string().max(MAX_KEY_LENGTH)).max(MAX_MODIFIERS).optional(),
  }),
  z.object({
    type: z.literal('wheel'),
    x: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    y: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    deltaX: z.number().int().min(-MAX_WHEEL_DELTA).max(MAX_WHEEL_DELTA),
    deltaY: z.number().int().min(-MAX_WHEEL_DELTA).max(MAX_WHEEL_DELTA),
  }),
  // Touch vocabulary (2026-06-08 product directive "real iPhone tap not macbook mouse";
  // 04-harness §226-228 + 05-behavioral-library). Coordinates are DEVICE-CSS px
  // (iPhone viewport space) — the GUI/dashboard projects stream-px → device-CSS
  // upstream; the harness injects via W3C Actions `pointerType:touch` and owns
  // the micro-settle / interpolation / momentum (A3 W551/W553). `tap` and
  // `swipe` are single events the harness expands; touchStart/Move/End carry a
  // `touchId` for multi-touch (concurrent ids = pinch).
  z.object({
    type: z.literal('tap'),
    x: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    y: z.number().int().min(-MAX_COORD).max(MAX_COORD),
  }),
  z.object({
    type: z.literal('touchStart'),
    x: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    y: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    touchId: z.number().int().min(0).max(MAX_TOUCH_ID),
  }),
  z.object({
    type: z.literal('touchMove'),
    x: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    y: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    touchId: z.number().int().min(0).max(MAX_TOUCH_ID),
  }),
  z.object({
    type: z.literal('touchEnd'),
    x: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    y: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    touchId: z.number().int().min(0).max(MAX_TOUCH_ID),
  }),
  z.object({
    type: z.literal('swipe'),
    x1: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    y1: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    x2: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    y2: z.number().int().min(-MAX_COORD).max(MAX_COORD),
    durationMs: z.number().int().min(0).max(MAX_SWIPE_DURATION_MS),
  }),
  z.object({
    type: z.literal('ping'),
    timestamp: z.number().int().nonnegative(),
  }),
]);

export type InputEvent = z.infer<typeof InputEventSchema>;

/** POST /v1/agent-sessions/:id/input-event request body. */
export const SendInputEventRequestSchema = z.object({
  event: InputEventSchema,
  /**
   * Slice 5 (Wave 29-NNN ARC 3) — pair-mode takeover-trigger
   * attribution and ownership. Required whenever mode='pair': in
   * ai-driving the first input fires takeover-request; in human-driving
   * every input must match the clientId that won takeover. This prevents
   * a sibling tab from injecting events into another tab's control turn.
   * Optional only in manual mode.
   * UUID-shape is typical; 128 cap matches the OAuth client_id
   * cap.
   */
  client_id: z.string().min(1).max(128).optional(),
});
export type SendInputEventRequest = z.infer<typeof SendInputEventRequestSchema>;

/** POST /v1/agent-sessions/:id/input-event response body — two
 *  shapes via a `kind` discriminator. */
export const SendInputEventResponseSchema = z.discriminatedUnion('kind', [
  /**
   * Slice 5 (Wave 29-NNN ARC 3) — pair-mode takeover-trigger
   * outcome. Returned when the first input-event in a pair-mode
   * `ai-driving` session fires the takeover-request transition.
   * The dashboard reads pair_mode_state to render the takeover
   * status (takeover-pending vs takeover-queued, etc.).
   */
  z.object({
    kind: z.literal('pair-mode-takeover-fired'),
    pair_mode_state: z.object({ kind: z.string() }).passthrough(),
  }),
  /**
   * Slice 4 (Wave 29-NNN ARC 3) — straight forward-to-harness
   * outcome. Returned when the event is dispatched directly to
   * the harness (manual mode OR pair mode after takeover-grant).
   * Today the harness end-to-end is gated; route returns 503 on
   * this path until Agent 1's Swift work lands.
   */
  z.object({
    kind: z.literal('forwarded'),
    /** Server-side dispatch latency in ms (NOT round-trip). */
    duration_ms: z.number().int().nonnegative(),
  }),
]);
export type SendInputEventResponse = z.infer<typeof SendInputEventResponseSchema>;
