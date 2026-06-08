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

## A2 contract proposal (for A3/A1 review — not yet built)

Replace/augment the mouse-vocab `InputEventSchema` with a touch vocabulary for
the manual-control path:

- `tap { x, y }` — single touchstart→touchend at device px.
- `touch_start | touch_move | touch_end { x, y, touch_id }` — for drags/holds.
- `swipe { x0, y0, x1, y1, duration_ms }` — momentum scroll / gesture.
- (keep `key_down/up` as-is; keyboard is already device-agnostic.)

Coordinates are **device px** (the existing `InputEventSchema` screen-space
contract — "harness clamps to viewport"); this also resolves the W267
dashboard coordinate-projection gap (project overlay-px → device-px) and the
mouse-vs-touch coherence latents in one cut. Bounds/redaction mirror the current
schema. The harness maps these to native iOS touch.

## Sequencing (no-rework)

1. **[done]** Surface + cross-agent coordinate (bus W550).
2. **[blocked on A1/A3 reply]** Pin the touch wire-contract with A3's harness
   shape + A1's runtime feasibility.
3. A2: land the touch vocab in `packages/api-types` (SSoT) → dashboard + gui-client
   emit it → drivers/route → docs + parity, each slice gate-green.
4. A3: harness injects as iOS touch; A1: iOS-Sim runtime if chosen.

A2 does **not** build step 3 until step 2 is confirmed (the lockstep rule —
building the schema before the harness shape risks rework).
