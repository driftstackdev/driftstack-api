# A2 → A3 hand-off: live-video, taps, and session-end reporting (founder 2026-06-19)

> **⛔ SUPERSEDED — WRONG CHANNEL. Do not use this doc to reach A3.** A3 does NOT
> watch hand-off/contract docs; posting the taps diagnosis here instead of the bus
> caused a real "A2 hasn't replied" miss. The A2↔A3 channel is the BUS:
> `/Users/john/code/driftstack/operations/agent-bus/A2-A3-BUS.md`.
>
> **Taps status (resolved on the bus, W2660–W2663):** the LiveKit pipeline WORKS
> (worker joins → publishes video → consumes the data-channel taps → fork tap→click
> fires; the server livekit block is confirmed correct). The only remaining bug is a
> coordinate-space mismatch (GUI video-px 402×874 vs the 402×678 CSS content
> viewport), owned **A3-side** harness-only (`DRIFTSTACK_TAP_COORD_RECONCILE`,
> calibrating) — no GUI/server change. The "worker isn't in the room" framing below
> is STALE. Session-end orphan-close shipped server-side (migration 0086 +
> worker-disconnect reaper). Kept only as a historical record.

Founder ran a live-video test of the desktop GUI simulator. Three issues are
**worker-side (the fork / WebDriver harness on the Mac fleet node)** — A2 has
verified the control plane + GUI client are correct, so these are A3's:

## ⚡ TAPS ESCALATION — 2026-06-19 (founder asked A2 to escalate to A3)

Taps from the desktop GUI still do not land. **A2's side is DONE + verified — the
remaining work is entirely worker-side (A3).** A2 has shipped + e2e-verified the
full GUI/control-plane tap path:

- GUI sends each tap as a UTF-8 JSON `InputEvent` over the **LiveKit DataChannel**
  (`localParticipant.publishData(bytes, { reliable: true })`, **no topic**),
  `InputEventSchema` union (touchStart/Move/End, key, scroll). Schema-matched.
- GUI input fixes shipped: forwarded only in manual/pair (not AI), composer
  `activeElement` guard, window-level end-gesture fallback (no stuck finger),
  stable effect deps (no dropped in-flight gesture).
- The HTTP `POST /v1/agent-sessions/:id/input-event` route is **503 / harness-gated**
  — NOT the transport. The data channel is the only live path and bypasses the server.

**The single A3 ask:** get the fork worker to (1) **join the LiveKit room** (named =
the agent-session id) and publish, and (2) **consume the untopiced DataChannel
`InputEvent`s** via `RoomDataDispatcher` → `WebDriverManualTouchInjector`. If a topic
is required, name it and A2 sets it GUI-side in one line. A worker **ack of the first
input** would let the GUI show a live "control reaching the device" badge (hook
already added).

Evidence: session `agt_a076bb5e…` dispatched to `mac-macstadium-us-001` but published
**no video AND no page-state** → the worker isn't in the room → that single fact
explains BOTH the blank video and the dead taps. Fix that and both light up.

**VERIFIED (A2, 2026-06-19) — the server hands the worker EVERYTHING; zero server gap:**

- The node `mac-macstadium-us-001` HAS its LiveKit registered server-side (`fleet_nodes`:
  `livekit_api_key`/`livekit_api_secret_ciphertext`/`livekit_ws_url` all present,
  ws_url `wss://driftstack-jrluij9g.livekit.cloud`).
- So `enqueueSessionAssign` (agent-sessions.ts:452,526) mints a **PUBLISHER** token
  (`video: { room: <sessionId>, roomJoin:true, canPublish:true, canSubscribe:true }`)
  and includes the `livekit` block on the `sessionAssign` frame the worker receives:
  `{ room: <sessionId>, token: <publisher JWT>, ws_url, expires_at }` (snake_case wire).
- Therefore the **fork/harness worker code** must, on `sessionAssign`: (1) read the
  `livekit` block, (2) **join the room** at `ws_url` with that publisher token,
  (3) **publish the video track**, (4) **subscribe to + decode the DataChannel
  `InputEvent`s** (RoomDataDispatcher → WebDriverManualTouchInjector). All four are
  worker-side; A2 has nothing left to provide. If the worker IS joining but not
  publishing/consuming, that's the bug to find; if it never joins, start there.

## Live-test evidence (prod, 2026-06-19 ~09:13Z)

- A2 launched a real agent session via the API (`agt_a076bb5e…`). Prod logged
  `fleet-session-dispatch … dispatched sessionAssign to fleet node` with
  `nodeId: mac-macstadium-us-001` — so the node IS connected and the dispatch
  succeeded.
- The session then sat `active` with `page_state: null` and `updated_at ==
created_at` — **the worker reported no page-state and published no video.**
- Founder also reports taps not landing on a GUI-launched session.

## A3-1 — worker publishes no video track (live video shows nothing) — CRITICAL

The GUI subscribe path is verified correct: `AgentSessionPanel.tsx` attaches the
track on `RoomEvent.TrackSubscribed`, and the 30s no-publisher overlay is the
honest surface for "room is up, no worker publishing." **No GUI change.**

A3 action: verify the fork publishes a **video track** on session join, into the
LiveKit room **named after the agent-session id** (that is the room the GUI's
subscriber token targets). The dispatched-but-no-page-state above suggests the
browser/worker is not coming up or not publishing on this node.

## A3-2 — confirm the worker consumes the GUI's tap data-channel packets — HIGH

UPDATE 2026-06-19: taps and no-video share the SAME root (A3-1) — see "Unified
root" below. This section is the wire contract A3 must satisfy once the worker is
actually in the room.

The **only** tap transport for the desktop GUI is the **LiveKit data channel**:
`apps/gui-client/src/lib/livekit.ts::sendInputEvent` publishes UTF-8 JSON
`InputEvent`s via `room.localParticipant.publishData(bytes, { reliable: true })`
with **no topic**. The decode + W3C touch injection is entirely worker-side
(RoomDataDispatcher / WebDriverManualTouchInjector).

IMPORTANT — the HTTP route is NOT the transport: `POST
/v1/agent-sessions/:id/input-event` (which the customer dashboard targets)
currently returns **503 FeatureUnavailable** by design — it is harness-gated
(`apps/server/src/routes/agent-sessions.ts:1173-1179`: "no transport exists to
forward events to the harness" until A1's Swift harness lands). So neither the GUI
nor the dashboard can reach the worker over HTTP today. The data channel is the
live path and it bypasses the server.

A3 action: once the worker joins the room (A3-1), verify `RoomDataDispatcher`
consumes the **untopiced** `publishData` packets and injects them via
`WebDriverManualTouchInjector`. The GUI encoding (`InputEventSchema` union:
touchStart/Move/End, key, scroll) is correct and schema-matched. If a topic is
required, name it and A2 will set it on `publishData`. A worker **ack of the
first input** would let the GUI surface a live "control reaching the device"
signal (A2 already added a non-fatal badge hook for this).

## Unified root — both A3-1 and A3-2 are "the worker isn't in the room"

The live test (`agt_a076bb5e…`) dispatched to `mac-macstadium-us-001` but produced
NO video track AND NO page-state. Both the blank video and the dead taps follow
directly: if the worker browser isn't connected + publishing to the LiveKit room
(named after the session id), then (a) there's nothing to render and (b) the
data-channel InputEvents have no consumer. So A3's FIRST job is simply getting the
worker up and in the room for a GUI-launched session; A3-2's wire-contract check is
the second step, only meaningful once the worker is present.

GUI-side fixes A2 already shipped (so these are no longer confounders): taps are
now forwarded only in manual/pair mode (not AI), keyboard capture is guarded
against the composer, an end-gesture fallback prevents stuck finger-down, and the
input-capture effect no longer drops in-flight gestures on re-render.

## A3-3 — report session-end so orphaned sessions close (session-tracking root) — HIGH

Founder: sessions "still say open on every once-opened session." Root cause
(A2-verified): agent sessions only flip to `closed` on explicit DELETE or budget
exhaustion. When the worker's browser **closes / crashes / is idle-reclaimed**,
nothing closes the DB row → it lingers `active` forever and the GUI shows "Open
session."

A2 is adding a **wall-clock backstop reaper** (closes very old `active` sessions),
but that is coarse. The **precise** fix is worker-side: when the worker ends a
session (clean close, crash, or harness idle-reclaim), report session-end to the
control plane so the server calls `closeWithReason`. Mirror/extend the existing
`dispatchSessionEnd` path (`apps/server/src/services/agent-sessions.ts`). A2 will
wire the inbound endpoint/handler to match whatever signal A3 can emit — propose
the shape (HTTP callback vs fleet-events message) and A2 will implement the server
side.

## Ownership recap

- A2 (done / in progress): GUI client input + visuals fixed; server wall-clock
  reaper being added; will wire the server side of A3-3.
- A3 (this doc): video publish (A3-1), tap data-channel consumption (A3-2),
  session-end reporting (A3-3).
