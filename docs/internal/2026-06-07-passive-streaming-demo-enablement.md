# Passive streaming GUI demo — enablement runbook

**Goal:** the founder runs the GUI on their Mac and **watches a real WebKit
(iPhone-archetype) browser session stream live** over LiveKit. "Passive" =
watch-it-browse; the founder does NOT click/type (interactive control is
item-9-gated — see bottom).

**Status (2026-06-07):** all the _code_ exists and is real, but the real
end-to-end (real fork window → SCStream capture → real LiveKit server → GUI
subscribe) has **never been run** — it's unit-tested only. So this is an
integration-risk exercise, not a "flip a flag" — do A3's de-risk smoke first.

Source of truth for the harness side: A3 bus W278. A2 side confirmed ready
(W151): `SessionAssignSchema.livekit` + `lib/livekit-token.ts` + `LIVEKIT_*`
config.

---

## Who owns what

| #   | Step                                                                                                                               | Owner                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Stand up a **LiveKit server** + provide `wsURL` + API key/secret                                                                   | **Founder** (LiveKit Cloud = fastest; or self-hosted Hetzner per `livekit-server-self-hosted-setup.md`)      |
| 2   | Grant **Screen Recording (TCC)** to the harness daemon on the demo Mac                                                             | **Founder** (else `screen_capture_denied`)                                                                   |
| 3   | Make the **WebKit fork spawnable** (item-9 local `WebKitBuild/Release` + `DYLD_FRAMEWORK_PATH`)                                    | **Agent 1**                                                                                                  |
| 4   | **Mint a LiveKit publisher token** for the room (`lib/livekit-token.ts`)                                                           | **Agent 2** (this repo)                                                                                      |
| 5   | Run the **capture→publish smoke** (real SCStream of a spawned fork → the room) to de-risk TCC/track/format BEFORE the live attempt | **Agent 3** (ready on a wsURL+token)                                                                         |
| 6   | Build/deliver a **`SessionAssign{ livekit{ws_url, token}, initialURL }`** so a session navigates + publishes                       | **Agent 2** (`serializeSessionAssign`) — for the real flow; the smoke (step 5) can be fed the token directly |
| 7   | Point the **GUI** at the room (subscribe + display)                                                                                | **Agent 2** (gui-client)                                                                                     |

## Fastest path (LiveKit Cloud)

1. **Founder:** create a LiveKit Cloud project → note `wsURL` (e.g.
   `wss://<project>.livekit.cloud`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
   Grant Screen Recording to the harness daemon (System Settings → Privacy &
   Security → Screen Recording).
2. **A2:** set `LIVEKIT_WS_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` on the
   demo backend (or take them inline), mint a publisher token for a demo room
   via the existing token path, and hand A3 `{ wsURL, token, roomName }`.
3. **A1 + A3:** A1 makes the fork spawnable; A3 runs the capture→publish smoke
   into the room. Founder opens the GUI (or LiveKit's room inspector) subscribed
   to the same room → should SEE the fork window streaming.
4. If the smoke is green: A2 builds a real `SessionAssign` with the `livekit`
   block + an `initialURL`, A3 drives one real session, founder watches.

## What this does NOT need (vs a full launch)

- **NOT** the fleet control plane fully wired / `FLEET_CONTROL_PLANE_ENABLED` on
  prod — the smoke (step 5) feeds the harness the livekit block locally,
  bypassing CP delivery. (A real CP-delivered assign is step 6, nice-to-have.)
- **NOT** the `mock`→real driver flip on prod — this is a staging/local demo.
- **NOT** item-9. **Item-9 (the drive bridge) is required only for INTERACTIVE
  control** (founder clicks/types via HTTP `tap_at`→intent→touch). Passive
  watch-it-browse needs none of it.

## Integration risks to watch (A3 W278)

Screen-Recording TCC grant, LiveKit auth/track config, BGRA→track frame format,
codec negotiation. The smoke (step 5) exists specifically to surface these off
the founder's critical path.

## A2 readiness (no code gap)

- `apps/server/src/schemas/harness-control-protocol.ts` — `SessionAssignLivekitSchema`
  - `SessionAssignSchema.livekit` (snake_case `ws_url`/`token` wire).
- `apps/server/src/lib/livekit-token.ts` — token minting.
- `apps/server/src/lib/config.ts` — `LIVEKIT_*` env wiring (activation flag).
  So A2's only action is steps 4/6/7 once the founder provides a LiveKit server
  (step 1) — there is nothing to build first.
