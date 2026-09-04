# Connecting the WebKit worker for real sessions (runbook)

**2026-06-11 (W626).** Founder asked: "why don't we connect the webkit
worker like we did before to run real sessions?" This is the grounded
answer + the exact steps, and which agent owns each.

## Why launches currently show no real browser

A launch (Profiles → Launch) creates an **agent session** and a LiveKit
room, then the control plane tries to hand the work to a **fleet node**
(the Mac running the harness + WebKit fork). The relevant A2 code path
(`apps/server/src/routes/agent-sessions.ts` →
`dispatchSessionAssignOnCreate`) does, in order:

1. requires `FLEET_CONTROL_PLANE_ENABLED` (set locally + prod) so the
   registry + dispatch deps are constructed;
2. `fleetNodesRepo.findAnyWithLivekit()` — find a **registered** node
   that has a LiveKit binding;
3. `fleetControlRegistry.get(node.id)` — confirm that node holds a
   **live control-plane connection**;
4. if both → send `sessionAssign`; the node spawns the fork, drives it,
   and publishes video into the room.

If step 2 or 3 misses, it logs **"fleet node not connected; session
created but sessionAssign not dispatched"** and returns. The room still
exists (so the GUI connects), but nothing publishes → the black /
empty-room screen the founder hit. The W617 GUI overlay surfaces this
("no browser worker is publishing"); W625 warns up front when the API
itself runs `driver=mock`.

**Key point: nothing in `driftstack-api` is broken or missing.** The
control-plane dispatch is complete + correct (it's the honest
"not connected" log). The `WebKitDriver` in this repo
(`apps/server/src/drivers/webkit.ts`) is a deliberate stub that throws —
it is the `DRIVER=webkit` _polling_ path and was never the real-session
path. Real sessions run on the **fleet node**, not in this process.

## What "like before" was

The drive-bridge is **A3-verified GREEN end-to-end** (A3 W710 / re-verified
W760 on the `iphone17` launch archetype): assign → spawn → port-file →
WebDriver connect → navigate lands → detect*challenge + touch. "Before"
= the Mac was running that harness, built against A1's
`--enable-webdriver` fork, registered to the control plane as a fleet
node, with `DRIFTSTACK_ENABLE_DRIVE_BRIDGE=1`, through a UDP-capable
proxy. It works; it just has to be \_running + connected*.

## Steps to reconnect it (owners marked)

1. **(A1)** Build/deploy the WebKit fork with `--enable-webdriver`
   (webkit-driftstack repo). This is the binary the harness spawns.
2. **(A3, on the Mac)** Run the harness/fleet-node process with
   `DRIFTSTACK_ENABLE_DRIVE_BRIDGE=1`, pointed at the control plane
   (local = the dev server; prod = api.driftstack.dev). On start it
   registers via the fleet-nodes table and opens the control-plane
   connection — satisfying dispatch steps 2 + 3 above.
3. **(A3)** Ensure the node advertises a LiveKit binding
   (`findAnyWithLivekit`); livekit-server is already up on the Mac
   (founder-verified, PID 2161 / UDP 7882).
4. **(founder / egress)** Point the session at a proxy that supports
   **UDP ASSOCIATE** — the `iphone17` archetype negotiates h3/QUIC, so a
   TCP-only proxy hangs the first navigate (A3 W700/W710 root-cause).
5. Launch a profile in the GUI → the control plane dispatches
   `sessionAssign` to the connected node → real browser + live video.

## How to verify it connected (W628/W629)

Two A2 surfaces now make the registration/connection state observable —
the exact facts dispatch checks:

- **`GET /v1/mac-nodes`** (staff-admin scope): JSON list of registered
  nodes with `last_seen_at`, `has_livekit`, and `connected` (live
  control-plane connection). `connected: true` + `has_livekit: true` on a
  node = launches will dispatch to it.
  `curl -H "Authorization: Bearer <admin-key>" https://api.driftstack.dev/v1/mac-nodes`
- **Admin → Fleet** (`admin.driftstack.io/fleet`): the same data as a
  live table (auto-refreshes every 15s), so you can watch a worker flip
  `offline → connected` as the harness attaches.

If a node shows registered but `connected: false`, the harness process
isn't holding a control-plane connection — restart it / check it points
at the right control plane. If `has_livekit: false`, it hasn't POSTed
LiveKit credentials (`POST /v1/mac-nodes/register`).

## A2 status: ready, nothing to do

The control-plane side (agent-session create → dispatch → LiveKit token
→ GUI viewer) is **done + live**. A2 cannot "connect the worker" from
this repo — the worker is the Mac-side harness + fork (A1 + A3). When a
node registers + connects, dispatch starts working with zero API change.
Surfaced to A3 (they own the Mac-side run) via the contract relay.
