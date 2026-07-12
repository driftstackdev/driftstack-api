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

| Check                     | What it proves                                                                                         | The bug it catches                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `CREATE`                  | `POST /v1/agent-sessions` returns a session id                                                         | account/auth/dispatch broken         |
| `STREAM`                  | the box **publishes** a video track (or inbound bytes flow)                                            | "launch but no video"                |
| `NAVIGATE`                | a `navigate` data-channel op lands a `page_state` carrying the new URL                                 | address bar / nav path dead          |
| `TAB_SWITCH`              | the exact optimistic `tabListUpdate(active=B)` + `activateTab(B,prev=A)` wire is acked                 | tab-switch handler / prior-id dead   |
| `TAB_WARM_RETURN`         | B→A replies `activateTabResult{ok,wasWarm:true}`                                                       | cold fallback / full-page reload     |
| `TAB_NO_RELOAD`           | a list-only new-tab snapshot does not reload the prior active page                                     | eager list reconciliation reload     |
| `SCROLL`                  | a `touchStart→touchMove…→touchEnd` finger drag (the GUI's wheel→touch wire shape) is accepted          | "scroll does nothing" / dead input   |
| `TAP`                     | a `touchStart+touchEnd` is **received + injected** (box reacts with a `page_state`); proxy-INDEPENDENT | "taps do nothing"                    |
| `COOKIES`                 | `GET /:id/cookies` returns a live jar (`status:'ok'`), **account-Bearer** auth                         | cookie jar not served                |
| `COOKIES_VIA_CONTROL_KEY` | mint a `gui_control_key` then `GET /:id/cookies` with `x-driftstack-gui-control-key` (the GUI's path)  | **#58** cookies-throw (auth 401/404) |
| `RECORDINGS`              | a session recordings list/download endpoint responds sanely (if one exists)                            | recordings endpoint broken           |
| `FILE_UPLOAD`             | `POST /:id/files` with a tiny payload acks with an upload handle                                       | file-control upload path broken      |

The session is **always deleted** at the end (success, failure, or timeout).

Exit code: **0** when no check failed, **1** when any did. Missing-dependency or
deployment-gated conditions are reported as `SKIP` (not `FAIL`) so a missing local
WebRTC build or a LiveKit-less deployment doesn't read as a product regression.

### `TAB_SWITCH` / `TAB_WARM_RETURN` / `TAP`

`TAB_SWITCH` and `TAP` verify the box's **handler** WITHOUT requiring working
egress, and report **which tier** passed so the verdict is honest about what was
proven. The test account has **no proxy** (loopback egress), so a real page
**content load** hangs past the window — but the box's control-plane handlers
fire regardless (A3 box-trace, bus W2940/W2945), and those are what these checks
assert:

- **`TAB_SWITCH`** — the box replies `activateTabResult { type, requestId, ok? }`
  over the data channel the instant it accepts the `activateTab` (the switch
  handler ran) — **proxy-independent**.
  - `[tier=ack]` PASS — `activateTabResult{ok}` received (handler fired). The full
    content-switch to the target tab's url wasn't observed (needs egress).
  - `[tier=full-content]` PASS — the box additionally published a `page_state`
    whose url == the target tab (the page actually switched; needs egress).
  - FAIL only when the box **rejects** (`activateTabResult{ok:false}`/`error`) or
    sends **no ack at all** (the handler never reacted — the real regression).

- **`TAB_WARM_RETURN`** — after the first-touch A→B succeeds, the runner sends
  the shipping client's optimistic B→A order with `prevTabId:B`. PASS requires
  the correlated reply to carry both `ok:true` and `wasWarm:true`. Unlike a URL
  observation, `wasWarm:true` is the harness's explicit proof that it selected
  A's cached live browsing context and returned before the cold
  `/window/new` + `/url` fallback. Missing/false `wasWarm` is a hard FAIL.

- **`TAP`** — the input-event contract has **no input-ack message**, so the only
  control-plane-observable proof a tap landed is the box **reacting** (emitting a
  fresh `page_state` the tap kicked off) — **proxy-independent** (the box emits a
  `state:'loading'` frame the moment it begins a navigation, before egress).
  - `[tier=ack]` PASS — a fresh `page_state` followed the tap (received + injected).
  - `[tier=full-content]` PASS — the box reported a `page_state` url == the tapped
    link's target (the link navigated through; needs egress).
  - `SKIP` (not FAIL) — without egress the target page renders as an error page
    (no tappable link), so the tap hits empty space and the box has nothing to
    react to. With no ack message to fall back on, a dead tap can't be told apart
    from "there was no link to hit," so the honest verdict is `SKIP` — **re-run
    with `DRIFTSTACK_PROXY_ID`** to render the link and get a real ack/full PASS.
  - FAIL only when the target page **did** load a usable link yet the box still
    produced no reaction ("taps do nothing").

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
- `navigate` / optimistic `tabListUpdate` / `activateTab(prevTabId)` — `apps/gui-client/src/lib/livekit.ts` + `packages/api-types/src/agent-tab-ops.ts`
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

  Without it, `STREAM` / `NAVIGATE` / `TAB_SWITCH` / `TAB_WARM_RETURN` are
  reported `SKIP` with the install command; `CREATE` and `COOKIES` still run.

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

Run with **no proxy** (loopback egress — the `TAB_SWITCH`/`TAP` handlers still
self-verify proxy-independently):

```
[16:32:20.906] base=https://api.driftstack.dev  nav=https://example.com  profile=(none)  proxy=(none)
[16:32:21.370] PASS — CREATE: id=agt_… mode=manual
[16:32:28.987] PASS — STREAM: box is streaming video (video track PUBLISHED by box)
[16:32:29.239] PASS — NAVIGATE: page_state url == https://example.com
[16:32:35.509] PASS — TAB_SWITCH: [tier=ack] handler acked (activateTabResult ok); full content-switch to https://example.org/ needs egress
[16:32:35.712] PASS — TAB_WARM_RETURN: B→A activateTabResult ok + wasWarm:true (preserved live context selected; no cold fallback)
[16:32:40.813] PASS — TAB_NO_RELOAD: no reload of the prior tab after the new-tab op (warm switch)
[16:32:41.414] PASS — SCROLL: scroll drag accepted by box (no channel error, no stalled/errored frame)
[16:32:58.248] SKIP — TAP: tap could not be self-verified without egress: https://example.com/ never rendered a tappable link (loaded as a no-egress error page) and the input contract has no ack message — re-run with DRIFTSTACK_PROXY_ID to render the link and prove the tap
[16:32:58.717] PASS — COOKIES: jar returned (0 cookies)
[16:32:59.087] PASS — COOKIES_VIA_CONTROL_KEY: control-key auth OK (HTTP 200) + jar returned (0 cookies)
[16:32:59.174] SKIP — RECORDINGS: no recordings endpoint on this API
[16:32:59.352] PASS — FILE_UPLOAD: upload ack'd — handle id=… name=auto-verify.txt size=11
[16:32:59.472] cleanup — DELETE /v1/agent-sessions/agt_… → HTTP 204

──────────── SUMMARY ────────────
  PASS  CREATE        id=agt_… mode=manual
  PASS  STREAM        box is streaming video (video track PUBLISHED by box)
  PASS  NAVIGATE      page_state url == https://example.com
  PASS  TAB_SWITCH    [tier=ack] handler acked (activateTabResult ok); full content-switch needs egress
  PASS  TAB_WARM_RETURN  B→A activateTabResult ok + wasWarm:true
  PASS  TAB_NO_RELOAD  no reload of the prior tab after the new-tab op
  PASS  SCROLL        scroll drag accepted by box
  SKIP  TAP           tap could not be self-verified without egress (no-egress error page; re-run with a proxy)
  PASS  COOKIES       jar returned (0 cookies)
  PASS  COOKIES_VIA_CONTROL_KEY  control-key auth OK (HTTP 200) + jar returned (0 cookies)
  SKIP  RECORDINGS    no recordings endpoint on this API
  PASS  FILE_UPLOAD   upload ack'd — handle id=… name=auto-verify.txt size=11
─────────────────────────────────
  10 pass · 0 fail · 2 skip
  OVERALL: PASS
```

> **`TAB_SWITCH` now PASSES on the ack** with no proxy: A3's box-trace (bus
> W2940/W2945) proved the box DOES fire `handleActivateTab ENTER gate=true` and
> emits an `activateTabResult{ok}` on a no-profile session — the handler is
> healthy; only the egress-dependent **content** load was hanging past the
> window, which the old url-change-only assertion mis-read as a handler fault.
> The check now asserts the proxy-independent ack and reports `[tier=ack]` vs
> `[tier=full-content]` so the verdict is honest about what was proven.
>
> **`TAP` cannot self-verify without egress** and now `SKIP`s honestly: a tap on
> a no-egress error page has no link to hit, the box reacts with no `page_state`,
> and the input-event contract has no ack message — so a dead tap is
> indistinguishable from "no link to hit." Re-run **with a proxy**
> (`DRIFTSTACK_PROXY_ID`) to render the tappable link and turn `TAP` into a real
> `[tier=ack]`/`[tier=full-content]` PASS (or a true FAIL if taps are dead).
