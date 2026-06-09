# iPhone-touch input pipeline — design + cross-agent plan (founder W-2026-06-08)

**Founder directive:** "Get real iPhone **tap** (e.g. iOS-Simulator touch) into
the browser/stream instead of the macbook mouse cursor. Look into getting it done
if not already planned."

It **is** planned (04-harness §226-228 + 05-behavioral-library) and **partly
built**. This note pins the current state, the gap, and A2's contract proposal
(under cross-agent review on the A2↔A3 bus W550 before any code lands — lockstep,
no rework).

## Current state (verified 2026-06-08)

| piece                                                                  | state                                                                                                                                                                             |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Behavioural touch-gen (`packages/behavioural-simulation`, A2, file 05) | **Built + sound** — `generateTouchEvent`, region-aware, multi-touch pinch, per-element distributions, jitter/pressure.                                                            |
| Streamed mac cursor                                                    | **Removed** — harness `showsCursor=false` (W459, the founder's earlier "mac mouse" flag).                                                                                         |
| AI-intent input (tap / fill_form / login)                              | **Already touch** — harness consumes behavioural-simulation for "behavioural tap w/ persona".                                                                                     |
| **Manual / live-drive input**                                          | **GAP** — dashboard + gui-client overlay emit **mouse vocab** (`InputEventSchema`: mouseMove/mouseDown/mouseUp/wheel); harness input-forward 503s ("pending harness end-to-end"). |
| Live-browsing runtime                                                  | macOS WebKit fork + CGEvent (mouse-on-simulator-window). Founder asks: should it be the **iOS Simulator** (native `UITouch`/WebKit `touchstart`)? — **A1 call.**                  |

So the AI path is already touch; the **manual-control path is the macbook-mouse
model the founder wants gone**, and the runtime (fork vs iOS-Sim) is A1's call.

## Cross-agent split

- **A1 (runtime):** fork-vs-iOS-Simulator for the live session — feasibility for
  v1.0 of genuine iOS touch vs CGEvent-mouse-on-the-sim-window.
- **A3 (harness injection):** wire the manual input-forward (currently 503) to
  inject **iOS touch** (touchstart/move/end), not CGEvent mouse. Manual control
  stays **precise** (human tap lands where tapped — no behavioural jitter; jitter
  is for AI intents only). Owns the harness-side touch contract.
- **A2 (this repo — driving):** evolve the manual-control **wire contract** from
  mouse-vocab → **touch vocab**; emit it from the dashboard + gui-client; the AI
  path already routes through behavioural-simulation.

## A2 contract proposal (SUPERSEDED — shipped; see Sequencing step 2/3 for the final shapes)

> Historical draft. The shipped contract used **camelCase** (`touchStart` not
> `touch_start`, `durationMs` not `duration_ms`) per A3's W553 review — see the
> Sequencing section below for what actually landed.

Original draft — augment the mouse-vocab `InputEventSchema` with a touch
vocabulary for the manual-control path:

- `tap { x, y }` — single touchstart→touchend at device px.
- `touch_start | touch_move | touch_end { x, y, touch_id }` — for drags/holds.
- `swipe { x0, y0, x1, y1, duration_ms }` — momentum scroll / gesture.
- (keep `key_down/up` as-is; keyboard is already device-agnostic.)

Coordinates are **device px** (the existing `InputEventSchema` screen-space
contract — "harness clamps to viewport"); this also resolves the W267
dashboard coordinate-projection gap (project overlay-px → device-px) and the
mouse-vs-touch coherence latents in one cut. Bounds/redaction mirror the current
schema. The harness maps these to native iOS touch.

## Sequencing — status as of 2026-06-08

1. **[done]** Surface + cross-agent coordinate (bus W550).
2. **[done]** Touch wire-contract pinned (A3 ✓ W553). Final shapes: `tap{x,y}` ·
   `touchStart/touchMove/touchEnd{x,y,touchId}` · `swipe{x1,y1,x2,y2,durationMs}`,
   **camelCase**, device-CSS px, `touchId` 0–9, `durationMs` ≤60s, ADDED
   alongside the mouse variants. **No iOS-Sim needed for v1.0** — the fork already
   does genuine WebKit `pointerType:touch` (A1/A3 runtime call).
3. **[done]** api-types touch vocab (SSoT) shipped `53e91907` — propagated to the
   gui-client `livekit.ts` copy + sdk-typescript `InputEvent` alias + openapi
   description + cross-surface/schema parity (sdk-go is `map[string]any`, untyped).
   Docs shipped `05d49c7a` (guides/live-video touch section) + `0cc47971` (W3C
   input model). The input-event **route is touch-ready** (type-agnostic: validates
   via the schema, treats any event as the takeover trigger, no per-type branch).
4. **[done — A3]** Harness `DataChannelInputReceiver` decodes the touch vocab →
   genuine WebKit touch (W561), + the manual-keyboard W3C-key injector (W568).
   CGEvent only as the legacy fallback. No mouse fallback for touch (no W198 tell).
5. **[REMAINING — A2, gated]** Wire the **dashboard** LiveKit-video subscription
   (currently a placeholder) → then switch its manual overlay from mouse → the
   touch vocab + project stream-px → device-CSS off `video.videoWidth/Height`
   (closes W267). **Gated on a live publishing session + A3's drive-bridge
   `ManualTouchInjecting` for end-to-end verification** — not shipped blind.
6. **[later]** Remove the mouse variants once the dashboard overlay has migrated.

**Net:** the touch contract is live end-to-end on the API + harness + docs; the
gui-client capture path already emits `tap_at` (touch). The one open A2 piece is
the dashboard live-stream-view + its overlay, gated on live verifiability.
