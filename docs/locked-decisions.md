# Driftstack API — locked decisions

Decisions that are **load-bearing** for the product moat. These are
not preferences or stylistic choices — flouting them is a regression
of the product itself, not just the implementation.

Any change to public schemas or driver-interface contracts must be
checked against this file. If a proposed change violates a locked
decision, surface as **drift**, not as a shape question.

---

## L-001 — The customer-facing API is intent-only

The public schemas exposed in `@driftstack/api-types` (and re-exported
through every SDK) describe **intent**, not **mechanics**. The
customer says _what they want to happen_, not _how to mechanically
make it happen_.

### What this means concretely

- ✅ `tap(selector)` — intent: "interact with this element".
  The behavioral simulation layer chooses real coordinates, motion
  curves, dwell, etc.
- ❌ `tap_at(x, y)` — mechanic: "click pixel (x, y)". Bypasses the
  simulation layer entirely.
- ✅ `type(selector, text)` — intent: "put this text in this field".
- ❌ `key_down('a'); key_up('a')` — mechanic: "produce a key event".
- ✅ `wait_for(selector)` — intent: "wait until this element exists".
- ❌ `sleep(ms)` — mechanic: "block for this long".

### Why this is the moat

The behavioral simulation layer (jitter, motion curves, fixation,
human cadence) is _mandatory_ when the customer can only express
intent. The simulation layer is the difference between "headful Safari
that looks human" and "every other automation tool that gets caught".

The moment a coordinate primitive ships in the customer SDK, customers
will use it — sometimes for legitimate reasons (their own
engine-tracking pipeline, A/B harness, etc.), but the simulation layer
becomes optional. Optional means most calls bypass it. Bypass at scale
means the population we serve is no longer uniformly stealth, and the
moat erodes faster than we can patch.

### Where mechanics-level primitives ARE allowed

The GUI's manual-control mode is a different use case: a human is
literally clicking pixels in a screenshot, and the human's own cadence
_is_ the behavior. There's no automation simulation to bypass because
there's no automation. Mechanics-level primitives there are fine —
**but** they live on a separate, scoped surface:

- Schemas: server-internal only, NOT in `@driftstack/api-types`.
- Endpoint: gated behind a separate API-key scope (`gui_control`)
  that customer keys never carry by default.
- SDK exposure: none. The GUI calls the gated endpoint via a thin
  helper, not via the customer SDK.

This keeps the customer SDK surface clean and the gating explicit.

### Drift detection

When proposing a change to a public schema, ask:

1. Is this exposing a coordinate, timing, or input mechanic that the
   simulation layer would otherwise own?
2. Is this enabling the customer to _bypass_ a simulation step?

If yes to either, surface as **drift against L-001** before writing
code. The right answer is almost always "expose a higher-intent
primitive on the public surface and put the mechanic on the
gui-control plane."

### History

V-032 (2026-05-02) added `tap_at` + `type_focused` to
`InteractActionSchema` for the GUI's manual-control input forwarding.
This was drift against L-001. V-036 (2026-05-03) re-cut: reverted the
public-surface additions, moved coordinate primitives behind the
`gui_control` scope on a separate schema.
