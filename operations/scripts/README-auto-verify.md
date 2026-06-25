# auto-verify-session — headless simulator self-verify

`auto-verify-session.mjs` drives a **real** Driftstack agent session end-to-end —
exactly the way the desktop GUI (`apps/gui-client`) does — and asserts the
behaviours that otherwise have to be checked by hand in the floating-iPhone
simulator. Run it on autopilot (CI, a cron, a `/loop`) to catch regressions in
the launch → stream → navigate → tabs → cookies path before a human notices.

## What it checks

Each check prints `PASS` / `FAIL` / `SKIP` with a reason. **Every check is
independent** — a failure in one never blocks the others, and any op/endpoint
that isn't wired on the deployment is reported as `SKIP` (with the reason), not
`FAIL`.

| Check                     | What it proves                                                                                        | The bug it catches                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `CREATE`                  | `POST /v1/agent-sessions` returns a session id                                                        | account/auth/dispatch broken         |
| `STREAM`                  | the box **publishes** a video track (or inbound bytes flow)                                           | "launch but no video"                |
| `NAVIGATE`                | a `navigate` data-channel op lands a `page_state` carrying the new URL                                | address bar / nav path dead          |
| `TAB_SWITCH`              | `tabListUpdate` + `activateTab` switches the published page                                           | tab switching dead                   |
| `SCROLL`                  | a `touchStart→touchMove…→touchEnd` finger drag (the GUI's wheel→touch wire shape) is accepted         | "scroll does nothing" / dead input   |
| `TAP`                     | a `touchStart+touchEnd` on a known link lands a `page_state` url change                               | "taps do nothing"                    |
| `COOKIES`                 | `GET /:id/cookies` returns a live jar (`status:'ok'`), **account-Bearer** auth                        | cookie jar not served                |
| `COOKIES_VIA_CONTROL_KEY` | mint a `gui_control_key` then `GET /:id/cookies` with `x-driftstack-gui-control-key` (the GUI's path) | **#58** cookies-throw (auth 401/404) |
| `RECORDINGS`              | a session recordings list/download endpoint responds sanely (if one exists)                           | recordings endpoint broken           |
| `FILE_UPLOAD`             | `POST /:id/files` with a tiny payload acks with an upload handle                                      | file-control upload path broken      |

The session is **always deleted** at the end (success, failure, or timeout).

Exit code: **0** when no check failed, **1** when any did. Missing-dependency or
deployment-gated conditions are reported as `SKIP` (not `FAIL`) so a missing local
WebRTC build or a LiveKit-less deployment doesn't read as a product regression.

### `COOKIES_VIA_CONTROL_KEY` — the real #58 reproducer

The separate "Driftstack Simulator" macOS app has **no account Bearer key** (a
different app → a different keychain), so it can't auth cookies the way the
account-Bearer `COOKIES` check does. Instead the **main** app mints a per-session
`gui_control_key` (`GET /:id/gui-control-key`) and hands it off, and the simulator
presents it in the `x-driftstack-gui-control-key` header. This check reproduces
**both** steps and reports the **exact HTTP status + body** of the control-key
cookies call. A `401`/`403`/`404` here — while account-Bearer `COOKIES` passes —
is the real **#58** cookies-throw root cause (the GUI's actual auth path is denied)
and is invisible to the Bearer probe. The control-key plaintext is **never logged**.

## Wire fidelity

Every op is byte-mirrored from the shipping client so this is a true probe of the
same contract:

- session create / livekit-token / delete — `packages/sdk-typescript/src/resources/agent-sessions.ts`
- Room config + connect — `apps/gui-client/src/lib/livekit.ts` (`createLivekitRoom` / `connectToAgentSession`)
- `navigate` / `tabListUpdate` / `activateTab` — `apps/gui-client/src/lib/livekit.ts` + `packages/api-types/src/agent-tab-ops.ts`
- `tap` / `scroll` touch wire shape — `apps/gui-client/src/lib/livekit-input-capture.ts` (tap = `touchStart`+`touchEnd`; wheel → a `touchStart`/`touchMove`/`touchEnd` finger drag) + `packages/api-types/src/agent-input-event.ts`
- `page_state` / `activateTabResult` consumer — `apps/gui-client/src/views/SimulatorWindow.tsx` (`onData`)
- cookies result shape — `apps/gui-client/src/lib/agent-session-control.ts` + `apps/server/src/routes/agent-sessions.ts`
- `gui_control_key` mint + control-auth header — `apps/gui-client/src/lib/agent-session-control.ts` (`mintGuiControlKey` / `authedFetch`) + `apps/server/src/routes/agent-sessions.ts` (`/:id/gui-control-key`, `controlKeyOrAccountAuth`)
- file upload shape — `apps/gui-client/src/lib/agent-session-control.ts` (`uploadAgentSessionFile`) + `apps/server/src/routes/agent-sessions.ts` (`POST /:id/files`)

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

| Var                         | Required | Default                      | Notes                                        |
| --------------------------- | -------- | ---------------------------- | -------------------------------------------- |
| `DRIFTSTACK_API_KEY`        | **yes**  | —                            | account Bearer key. **Never printed.**       |
| `DRIFTSTACK_BASE_URL`       | no       | `https://api.driftstack.dev` | API host                                     |
| `DRIFTSTACK_PROFILE_ID`     | no       | —                            | attach a saved profile (`prof_…`)            |
| `DRIFTSTACK_PROXY_ID`       | no       | —                            | route egress through a saved proxy           |
| `DRIFTSTACK_NAV_URL`        | no       | `https://example.com`        | URL the NAVIGATE check loads                 |
| `DRIFTSTACK_TAP_PAGE_URL`   | no       | `https://example.com/`       | page the TAP check loads (must have a link)  |
| `DRIFTSTACK_TAP_EXPECT_URL` | no       | `https://www.iana.org/`      | URL the TAP target link navigates to         |
| `DRIFTSTACK_TAP_X` / `_Y`   | no       | `200` / `250`                | device-CSS coord of the tap target link rect |

The `gui_control_key` plaintext minted for `COOKIES_VIA_CONTROL_KEY` is **never
printed** (only "fresh/existing" + the cookies-call HTTP status are logged).

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
[13:46:39.020] base=https://api.driftstack.dev  nav=https://example.com  profile=(none)  proxy=(none)
[13:46:39.468] PASS — CREATE: id=agt_… mode=manual
[13:46:48.183] PASS — STREAM: box is streaming video (video track PUBLISHED by box)
[13:46:48.436] PASS — NAVIGATE: page_state url == https://example.com
[13:47:10.569] FAIL — TAB_SWITCH: page did not switch to https://example.org/ within 20s
[13:47:11.487] PASS — SCROLL: scroll drag accepted by box (no channel error, no stalled/errored frame)
[13:47:33.391] FAIL — TAP: tap sent but no page_state at all within 20s (taps may not be reaching the device)
[13:47:33.850] PASS — COOKIES: jar returned (0 cookies)
[13:47:34.286] PASS — COOKIES_VIA_CONTROL_KEY: control-key auth OK (HTTP 200) + jar returned (0 cookies)
[13:47:34.358] SKIP — RECORDINGS: no recordings endpoint on this API
[13:47:34.528] PASS — FILE_UPLOAD: upload ack'd — handle id=… name=auto-verify.txt size=11
[13:47:34.650] cleanup — DELETE /v1/agent-sessions/agt_… → HTTP 204

──────────── SUMMARY ────────────
  PASS  CREATE        id=agt_… mode=manual
  PASS  STREAM        box is streaming video (video track PUBLISHED by box)
  PASS  NAVIGATE      page_state url == https://example.com
  FAIL  TAB_SWITCH    page did not switch to https://example.org/ within 20s
  PASS  SCROLL        scroll drag accepted by box
  FAIL  TAP           tap sent but no page_state at all within 20s
  PASS  COOKIES       jar returned (0 cookies)
  PASS  COOKIES_VIA_CONTROL_KEY  control-key auth OK (HTTP 200) + jar returned (0 cookies)
  SKIP  RECORDINGS    no recordings endpoint on this API
  PASS  FILE_UPLOAD   upload ack'd — handle id=… name=auto-verify.txt size=11
─────────────────────────────────
  7 pass · 2 fail · 1 skip
  OVERALL: FAIL
```

> The `TAB_SWITCH` / `TAP` `FAIL`s above are a **real, reproducible** product
> finding from a live `mode:manual` no-profile run (relayed to the harness team
> on the A2↔A3 bus, W2940): on the current prod box, `navigate` lands a
> `page_state` but `activateTab` returns no `activateTabResult` and a `tap`
> produces no reaction — i.e. the box-side handlers for these data-channel ops
> aren't reacting on a no-profile session, while `navigate` on the same channel
> works. This is exactly what the suite exists to surface.
