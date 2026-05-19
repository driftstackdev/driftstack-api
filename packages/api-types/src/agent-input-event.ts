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

/** Bounds for screen-space coordinates. The harness clamps to the
 *  actual viewport at dispatch time; we cap here to block obviously
 *  malformed input + JSON-bloating attacks. 100_000 is generous —
 *  no real screen is bigger than ~20k px on a side. */
const MAX_COORD = 100_000;

/** Bounds for wheel delta. macOS Quartz CGEventCreateScrollWheelEvent
 *  accepts int32 but the realistic range is much narrower. */
const MAX_WHEEL_DELTA = 100_000;

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
   * attribution. Required when the session is in mode='pair' AND
   * the current pair_mode_state.kind === 'ai-driving' (the first
   * customer-side input in this configuration fires the
   * takeover-request transition; client_id identifies which
   * browser tab / window initiated). Optional in all other shapes
   * (manual mode + already-human-driving pair mode just forward
   * the event to the harness without consulting client_id).
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
