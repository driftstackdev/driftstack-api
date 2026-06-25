# auto-verify-session — headless simulator self-verify

`auto-verify-session.mjs` drives a **real** Driftstack agent session end-to-end —
exactly the way the desktop GUI (`apps/gui-client`) does — and asserts the
behaviours that otherwise have to be checked by hand in the floating-iPhone
simulator. Run it on autopilot (CI, a cron, a `/loop`) to catch regressions in
the launch → stream → navigate → tabs → cookies path before a human notices.

## What it checks

Each check prints `PASS` / `FAIL` / `SKIP` with a reason.

| Check        | What it proves                                                         | The bug it catches           |
| ------------ | ---------------------------------------------------------------------- | ---------------------------- |
| `CREATE`     | `POST /v1/agent-sessions` returns a session id                         | account/auth/dispatch broken |
| `STREAM`     | a LiveKit **video track** is subscribed and receiving                  | "launch but no video"        |
| `NAVIGATE`   | a `navigate` data-channel op lands a `page_state` carrying the new URL | address bar / nav path dead  |
| `TAB_SWITCH` | `tabListUpdate` + `activateTab` switches the published page            | tab switching dead           |
| `COOKIES`    | `GET /:id/cookies` returns a live jar (`status:'ok'`)                  | cookie jar not served        |

The session is **always deleted** at the end (success, failure, or timeout).

Exit code: **0** when no check failed, **1** when any did. Missing-dependency or
deployment-gated conditions are reported as `SKIP` (not `FAIL`) so a missing local
WebRTC build or a LiveKit-less deployment doesn't read as a product regression.

## Wire fidelity

Every op is byte-mirrored from the shipping client so this is a true probe of the
same contract:

- session create / livekit-token / delete — `packages/sdk-typescript/src/resources/agent-sessions.ts`
- Room config + connect — `apps/gui-client/src/lib/livekit.ts` (`createLivekitRoom` / `connectToAgentSession`)
- `navigate` / `tabListUpdate` / `activateTab` — `apps/gui-client/src/lib/livekit.ts` + `packages/api-types/src/agent-tab-ops.ts`
- `page_state` / `activateTabResult` consumer — `apps/gui-client/src/views/SimulatorWindow.tsx` (`onData`)
- cookies result shape — `apps/gui-client/src/lib/agent-session-control.ts` + `apps/server/src/routes/agent-sessions.ts`

## Requirements

- **Node ≥ 20** (uses global `fetch`, global `WebSocket`, ESM). Tested on Node 25.
- **`livekit-client`** — already a `gui-client` dependency; resolved from the repo's
  hoisted `node_modules`, so run the script **from inside the repo**.
- **`@roamhq/wrtc`** (optional, for the LiveKit checks) — Node has `WebSocket` but
  no `RTCPeerConnection`, which `room.connect()` needs to receive the video track
  and the data channel. Install it on demand (it is **not** a committed dependency):

  ```sh
  npm install --no-save @roamhq/wrtc      # from the repo root
  ```

  Without it, `STREAM` / `NAVIGATE` / `TAB_SWITCH` are reported `SKIP` with the
  install command; `CREATE` and `COOKIES` still run.

## Environment variables

| Var                     | Required | Default                      | Notes                                  |
| ----------------------- | -------- | ---------------------------- | -------------------------------------- |
| `DRIFTSTACK_API_KEY`    | **yes**  | —                            | account Bearer key. **Never printed.** |
| `DRIFTSTACK_BASE_URL`   | no       | `https://api.driftstack.dev` | API host                               |
| `DRIFTSTACK_PROFILE_ID` | no       | —                            | attach a saved profile (`prof_…`)      |
| `DRIFTSTACK_PROXY_ID`   | no       | —                            | route egress through a saved proxy     |
| `DRIFTSTACK_NAV_URL`    | no       | `https://example.com`        | URL the NAVIGATE check loads           |

The API key and the LiveKit token are never written to stdout (the LiveKit client
log level is pinned to `warn`, and the token livekit puts in its own URL log is
self-redacted).

## Example run

```sh
# from the repo root (driftstack-api/)
npm install --no-save @roamhq/wrtc          # one-time, for the LiveKit checks

export DRIFTSTACK_API_KEY=sk_live_xxx        # never echoed by the script
export DRIFTSTACK_BASE_URL=https://api.driftstack.dev
node operations/scripts/auto-verify-session.mjs
echo "exit: $?"                              # 0 = all pass, 1 = a check failed
```

With a profile + proxy and a custom nav target:

```sh
DRIFTSTACK_API_KEY=sk_live_xxx \
DRIFTSTACK_PROFILE_ID=prof_… \
DRIFTSTACK_PROXY_ID=prx_… \
DRIFTSTACK_NAV_URL=https://httpbin.org/get \
node operations/scripts/auto-verify-session.mjs
```

## Sample output

```
[11:54:26.118] base=https://api.driftstack.dev  nav=https://example.com  profile=(none)  proxy=(none)
[11:54:27.402] PASS — CREATE: id=agt_… mode=manual
[11:54:31.880] PASS — STREAM: video track subscribed + live (bytesReceived=48213)
[11:54:34.221] PASS — NAVIGATE: page_state url == https://example.com
[11:54:38.640] PASS — TAB_SWITCH: page switched to https://example.org/ (activateTabResult ok)
[11:54:40.115] PASS — COOKIES: jar returned (3 cookies)
[11:54:40.330] cleanup — DELETE /v1/agent-sessions/agt_… → HTTP 204

──────────── SUMMARY ────────────
  PASS  CREATE        id=agt_… mode=manual
  PASS  STREAM        video track subscribed + live (bytesReceived=48213)
  PASS  NAVIGATE      page_state url == https://example.com
  PASS  TAB_SWITCH    page switched to https://example.org/ (activateTabResult ok)
  PASS  COOKIES       jar returned (3 cookies)
─────────────────────────────────
  5 pass · 0 fail · 0 skip
  OVERALL: PASS
```
