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

> **⚠ V-825 — a SECOND mechanics surface shipped, and it meets none of
> the three conditions above.**
>
> The three bullets hold for `POST /v1/sessions/:id/gui-input`, which was
> built to them: its schema lives in `apps/server/src/schemas/gui-input.ts`,
> the route requires the `gui_control` scope, and `OAUTH_ALLOWED_SCOPES`
> omits that scope so an OAuth client cannot request it.
>
> `POST /v1/agent-sessions/:id/input-event` is a different surface and it
> does not:
>
> - **Schema is in `@driftstack/api-types`.** `InputEventSchema`
>   (`packages/api-types/src/agent-input-event.ts`) is a 12-variant union
>   re-exported through the barrel at `index.ts`. `mouseMove` and `tap`
>   carry raw integer `x`/`y`; `keyDown`/`keyUp` carry `key` + `modifiers`.
>   Those are precisely the ❌ examples this decision lists — `tap_at(x, y)`
>   and `key_down('a'); key_up('a')`.
> - **No `gui_control` gate.** The route's preHandler is
>   `controlKeyOrAccountAuth('write')`: either a per-session
>   `gui_control_key`, or an ordinary customer API key carrying `write`.
> - **Full SDK exposure.** `sendInputEvent` / `send_input_event` /
>   `SendInputEvent` ship in the TypeScript, Python and Go SDKs, and the
>   endpoint is in the published OpenAPI spec.
>
> The existing drift guard could not catch this: `gui-input-l001-cross-
source-invariant.test.ts` reads `schemas/gui-input.ts` and nothing else,
> so it watches the surface that complies and is blind to the one that does
> not.
>
> **V-864 — amend-or-withdraw was a false choice, and the answer is neither.**
>
> The exception above rests on one sentence: "there's no automation simulation
> to bypass because there's no automation." That is a claim about the CALLER,
> not about the endpoint. Nothing on the agent-sessions surface establishes
> that the caller is a human. `controlKeyOrAccountAuth('write')` accepts a
> per-session `gui_control_key` — which the GUI mints for a live takeover, and
> which does evidence a human — OR an ordinary customer API key carrying
> `write`, which evidences nothing. The same route therefore serves a human
> driving a pair-mode session and a script tapping coordinates in a loop, and
> only the first is the case this exception was written for.
>
> So the operative condition was never the use case; it is the **credential**.
> The three bullets above are one way to prove a human is on the other end
> (a scope customer keys never carry). A per-session control key minted for an
> observed takeover is another, and a better fit for pair mode. What cannot
> stand is a mechanics surface reachable with a credential that proves nothing.
>
> **Amended, therefore:** mechanics-level primitives may live on a surface
> whose credential establishes a human-driven session. `gui_control` scope
> qualifies. A per-session control key qualifies. An ordinary customer key
> carrying `write` does not.
>
> That makes the remedy narrower than withdrawal. `sendInputEvent` stays in all
> three SDKs and keeps working for control-key callers, which is how the GUI
> uses it; what changes is that an ordinary `write` key stops being sufficient.
> That is still a breaking change for any customer scripting it today — and
> that population is precisely the moat erosion this decision exists to
> prevent, so it is a deliberate call to make, not a silent flip. **Not yet
> applied.** The route still accepts a `write` key, the V-825 guard still pins
> that, and the guard fails the day it changes.

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
