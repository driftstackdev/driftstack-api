# Self-serve GUI: create a profile → watch it live (plan)

**Founder goal (2026-06-07):** open the gui-client on their MacBook, **create a
new profile, start a session, and watch THAT session stream live** — the real
product flow, not the `demo-viewer.html` workaround or a manual `--demo-session`.

## What already works

- **gui-client watch UI** — `AgentSessionPanel` takes a `LiveKitInfo` (from
  session-create's `livekit` field, or `POST /v1/agent-sessions/:id/livekit-token`)
  and subscribes (`connectToAgentSession(room, info)`). Built + tested.
- **Harness stream pipeline** — fork spawns, browses through SOCKS5, SCStream
  captures, publishes to a LiveKit room (A3 W290, proven end-to-end via
  `--demo-session`). The `CGS_REQUIRE_INIT`/`NSApplication.shared` prod-critical
  capture bug was fixed there.
- **session-create can mint a `livekit` block** — `agent-sessions.ts`
  `maybeMintLivekit` mints a token (room = sessionId) IF `fleetNodesRepo` +
  `livekitSecretEncryptionKey` are wired AND a Mac node is registered with
  livekit creds (`findAnyWithLivekit`).

## The gap (why it's not self-serve yet)

1. **[A2] No live session→harness assign dispatch.** `serializeSessionAssign`
   has ZERO live callers — session-create never pushes the assign to a connected
   harness. The `FleetControlRegistry` exists but only when
   `FLEET_CONTROL_PLANE_ENABLED=true`, and the agent-sessions route isn't handed
   the registry to dispatch on create. (Same "built-but-unwired" class the
   webhook worker was.)
2. **[A2] No registered local Mac node** → `maybeMintLivekit` returns undefined
   → session-create omits the `livekit` block.
3. **[A3] Harness inbound channel.** `--demo-session` is file-fed. For self-serve
   the harness must connect to `/v1/fleet/events` (WSS) as a node, register, and
   consume a server-dispatched `sessionAssign` frame (reuse `handleInboundFull`).
   _Open question on the bus (W158): does this WSS client already exist?_
4. **Local config** — `FLEET_CONTROL_PLANE_ENABLED=true`, gost SOCKS5, LiveKit
   `--dev` (all proven locally already).

## Plan (local stack on the founder's MacBook — NOT a prod flip)

- **Step A [A2]:** hand `fleetControlRegistry` to the agent-sessions route; on
  session-create, when CP is enabled and a node is connected, `serializeSessionAssign`
  (archetype/profile + initialUrl + inlineProxyConfig + livekit) and dispatch it
  to the node via the registry. Gated behind the existing flag (no prod behavior
  change while `FLEET_CONTROL_PLANE_ENABLED=false`).
- **Step B [A2]:** local Mac-node registration with the `--dev` livekit creds so
  the `livekit` block mints on create.
- **Step C [A3]:** harness fleet-events WSS consumer (or confirm it exists) →
  `handleInboundFull` on the dispatched frame.
- **Step D [docs]:** a one-command local-stack runbook (server + harness + gost +
  LiveKit + gui-client pointed at localhost) so the founder runs it + clicks
  "create profile" → watches.

## Decisions to confirm

- **Architecture:** auto-dispatch on session-create is the fleet-CP consumer
  wiring that's been gated. Enabling it LOCALLY for the demo is low-risk; doing it
  in PROD is the founder-gated fleet-CP activation — keep this local-only for now.
- Blocked on the A3 W158 answer (harness WSS consumer status) before A2 wires the
  dispatch end (so the frame contract is agreed).

## Interim (works today)

The coordinated watch-run (A3 W290 + A2 W157): A3 runs the session, founder
watches the same pipeline in `demo-viewer.html`. Same stream, not yet self-serve.
