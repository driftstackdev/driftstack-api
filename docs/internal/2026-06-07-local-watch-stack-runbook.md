# Local self-serve watch stack — runbook

Bring up the local stack so the founder opens the gui-client, **creates a
profile, and watches that session stream live**. Server-side dispatch is fully
merged (`2de1b5ac` primitive → `17ec0f37` route caller → `885d0561` activation);
this is the local bring-up + the one node-seed row.

LOCAL DEV ONLY — never run against prod. The dispatch path is gated by
`FLEET_CONTROL_PLANE_ENABLED`, which stays OFF in production.

## Components

| Component        | How                                                                | Owner   |
| ---------------- | ------------------------------------------------------------------ | ------- |
| LiveKit `--dev`  | `livekit-server --dev` (ws://localhost:7880, devkey/secret)        | A3 (up) |
| gost SOCKS5      | `gost -L socks5://:1080`                                           | A3 (up) |
| Postgres + Redis | local dev services (DATABASE_URL / REDIS_URL)                      | A2      |
| API server       | `:3000`, `FLEET_CONTROL_PLANE_ENABLED=true` + `MFA_ENCRYPTION_KEY` | A2      |
| Seed node row    | `seed-local-fleet-node.ts` (below) → prints the node uuid          | A2      |
| Harness daemon   | `DriftstackHarnessd` with `DRIFTSTACK_MAC_NODE_ID=<uuid>`          | A3      |
| gui-client       | Tauri app pointed at `http://localhost:3000`                       | Founder |

## Steps

1. **A2 — seed the harness node row** (mints the uuid the daemon must use):

   ```sh
   DATABASE_URL=postgres://localhost/driftstack \
   MFA_ENCRYPTION_KEY=<base64 32-byte key> \
   FLEET_NODE_PUBLIC_KEY_BASE64URL=w_vAYfR1QbAEp-ZjiGRorRj4T265Zey2n2lzzg7lg8o \
   npx tsx apps/server/src/scripts/seed-local-fleet-node.ts
   ```

   Note the printed `node uuid`. (The pubkey above is A3's W296 key; LiveKit
   creds default to devkey/secret/ws://localhost:7880.)

2. **A2 — run the API server** on `:3000` with the SAME `MFA_ENCRYPTION_KEY`,
   `FLEET_CONTROL_PLANE_ENABLED=true`, and the local LiveKit env. Bootstrap then
   constructs the `FleetControlRegistry` + the demo `sessionDispatch` config
   (archetype `iphone16pro_ios18_6_safari18_6`, `https://example.com`, local gost
   proxy with `udp_associate:true`).

3. **A3 — run the daemon** pointed at the local CP, using the uuid from step 1:

   ```sh
   DRIFTSTACK_NODE_SIGNING_KEY_PATH=~/.driftstack/node-dev.b64 \
   DRIFTSTACK_CONTROL_ENDPOINT=ws://localhost:3000/v1/fleet/events \
   DRIFTSTACK_MAC_NODE_ID=<uuid-from-step-1> \
   DRIFTSTACK_REQUIRE_PROXY=1 \
   .build/debug/DriftstackHarnessd
   ```

   It connects-as-node over the fleet-events WSS (the registry now has it).

4. **Founder — gui-client → create a profile → start a session.** session-create
   dispatches the `sessionAssign` to the connected node; the harness spawns the
   fork (browses example.com through gost), captures, and publishes. The
   gui-client's `AgentSessionPanel` subscribes via the session's `livekit` block
   → **the founder watches it live.**

## Notes

- **nodeId is the minted uuid, not a chosen string** — `fleet_nodes.id` is a
  uuid; A3's daemon `iss`/header must equal it (W163).
- v0 dispatch = on-create, only if the node is connected (no queue; A3 W298).
- Interactive control (click/type) is still item-9-gated — this is passive watch.
- To tear down: stop the daemon + server; the node row can stay (idempotent
  re-runs would create duplicates, so seed once).
