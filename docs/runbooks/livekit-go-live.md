# LiveKit go-live runbook (V-531.B follow-up)

LiveKit SFU is the real-codec replacement for the
`MockWebRtcStreamingService` placeholder. This runbook walks the
operator through activating LiveKit on prod + staging once the
server-side token-mint + client-side connect slices land, smoke-testing
a publisher + subscriber round-trip against the production WS endpoint,
and confirming the same fall-back-to-HTTP-polling path the GUI takes
today still behaves when LiveKit is misconfigured.

## Current state (2026-05-15)

Server-side ladder is **end-to-end complete**. The operator can wire
env + smoke today; the only remaining slice is the customer-side
subscriber probe.

- [x] `apps/server/src/lib/config.ts` accepts `LIVEKIT_API_KEY` +
      `LIVEKIT_API_SECRET` + `LIVEKIT_WS_URL` via the optional
      `livekit` schema block (V-531.B groundwork, commit `70e98136`).
- [x] `LivekitConfig` type exported.
- [x] `apps/server/src/lib/livekit-token.ts` — pure `node:crypto`
      HS256 JWT minter mirroring LiveKit's `AccessToken` claim shape
      (commit `2b92d957`). No `livekit-server-sdk` dependency.
- [x] `apps/server/src/routes/agent-sessions-livekit-token.ts` —
      `POST /v1/agent-sessions/:id/livekit-token` route (commit `1eea466d`)
      with cross-account 404 + shape-check on session id. The token is
      **subscriber-only**: `role` is hardcoded to `'subscriber'` and the
      grants are `canPublish: false`, `canSubscribe: true`,
      `canPublishData: true` (the data channel carries input events, which
      is why the mint requires the `write` scope). There is no
      caller-selectable role.
- [x] `apps/server/src/lib/app.ts` + `bootstrap.ts` — route
      registration gated on `config.livekit` presence (3-field
      all-or-nothing). Access is checked with `callerCanAccessAgentSession`,
      the canonical helper shared with the sibling agent-session routes,
      which admits a team admin of the owning account.

      ⛔ Two claims stood here and both were false. This entry said the
      route mapped a caller-supplied publisher/subscriber role, and that
      ownership went through a `findOwnedSessionLite` seam in the sessions
      service. Both described the **V-531.B route that was deleted** in
      `58a0a2521` (`/v1/sessions/:id/livekit-token`, removed because a
      customer could mint a *publisher* token). The surviving route is a
      different surface over a different subject — agent sessions, not
      browser session records — and the seam it named now has no callers
      anywhere. An operator reading this while go-live was already going
      badly would have gone looking for a check that is not there.

- [x] `scripts/smoke-livekit.mjs` — operator smoke script using Node
      22+ global WebSocket, dep-free (commit `e3662779`).
- [ ] `gui-client` `LiveSessionView` LiveKit-subscriber path with
      HTTP-polling fall-back when `config.livekit.wsUrl` is unset.
      Adds `livekit-client` as a dep when this slice lands.

What's already live for the operator: writing the 3 env vars +
restarting the api service is sufficient to enable the
`/v1/agent-sessions/:id/livekit-token` endpoint. The gui-client + customer-
dashboard continue using HTTP polling until the subscriber probe
lands; LiveKit Cloud usage stays zero until then.

## Pre-flight

- [ ] LiveKit Cloud project created in the **EU** region (data-residency
      parity with the rest of the stack — Sentry, Postmark, R2 all
      enforce EU). LiveKit's region picker is on the project create
      screen; cannot be changed retroactively without recreating the
      project.
- [ ] API key + secret pair issued from the LiveKit Cloud dashboard
      (Project → Settings → Keys → Create new key). The key is
      labelled `driftstack-prod` or `driftstack-staging` so audit
      logs disambiguate.
- [ ] WS URL recorded from the project overview page
      (`wss://<project-id>.livekit.cloud` format).
- [ ] LiveKit Cloud webhook URL set to `https://api.driftstack.dev/
v1/webhooks/livekit` once the future webhook route lands (room
      lifecycle events — out of V-531.B scope).

## Step 1 — wire env on prod + staging

Write the three vars to `/opt/driftstack/api/.env` on each app server.
Values come from `1Password / Driftstack / LiveKit prod key` — **not**
from this runbook, the repo, or any chat transcript.

```
LIVEKIT_API_KEY=<paste from 1Password>
LIVEKIT_API_SECRET=<paste from 1Password>
LIVEKIT_WS_URL=wss://<project-id>.livekit.cloud
```

Restart the api service:

```sh
systemctl restart driftstack-api
```

Confirm the `livekit` block parses cleanly at boot. Until the
token-mint route lands, the only observable behaviour change is that
`/version` reports the activation flags (there is no
`/v1/config-summary` endpoint — it was never built) and shows `livekit: configured` rather
than `livekit: not configured`.

> All-or-nothing posture: missing any of the three vars (partial
> config) parses to `undefined` rather than an error. The route-gate
> at `lib/app.ts` (mirrors the nowpayments precedent) treats partial
> config as "not configured" — operator-facing typo on one var will
> not crash boot but will silently leave the route unregistered.
> Verify all three are present.

## Step 2 — smoke test (once token-mint route lands)

From a workstation with prod creds, mint a token + open a publisher
connection against the real WS URL:

```sh
node scripts/smoke-livekit.mjs \
  --session-id sess_demo123 \
  --role publisher \
  --duration-ms 5000
```

Expected (target script, not yet written):

- 1 `livekit token minted` info log in the api journal.
- 1 WS handshake against `wss://<project-id>.livekit.cloud` (visible in
  LiveKit Cloud dashboard → Rooms → live).
- Room `sess_demo123` appears active for ~5s then closes.
- 0 `livekit send failed` warns.

Subscriber smoke (run from a second shell while publisher is up):

```sh
node scripts/smoke-livekit.mjs \
  --session-id sess_demo123 \
  --role subscriber \
  --duration-ms 3000
```

Expected: 1 frame received within ~500ms of WS handshake; first-frame
latency logged.

## Step 3 — verify customer-flow integration

**Blocked until the GUI subscriber slice lands** — the `LiveSessionView`
checklist item above is still unchecked and no such view exists in
`apps/gui-client/src`. When it does, open it against a real Mac-mini session.
Expected:

- WS handshake to `wss://<project-id>.livekit.cloud` within ~1s.
- First frame paints within ~500ms of handshake (vs ~1s on the HTTP
  polling path).
- Real-time tap / scroll / key-press input still goes through the
  existing gui-control HTTP plane (V-531.B is read-only from the
  client's perspective).
- Closing the view tears down the LiveKit room within ~2s.

Fall-back smoke: unset `LIVEKIT_WS_URL` on a staging server, restart,
re-open `LiveSessionView`. Expected: the client detects the missing
WS URL via a config probe (or a 404 on the token-mint route) and
silently falls back to the HTTP polling path — no user-facing error.

## Step 4 — alerting

LiveKit Cloud dashboard alerts (Settings → Notifications):

- **Room concurrency hit** — alert on >50% of plan ceiling so we see
  the ramp before hitting a hard cap.
- **Publishing-bandwidth spike** — alert on >2x the trailing-7d
  average; surfaces accidental high-bitrate from a misconfigured
  encoder.
- **WS handshake failure rate** — alert on >5% in a 5-min window;
  signals certificate / network / project-misconfiguration.

Server-side alerts (via the existing Sentry per-project layout):

- `livekit token mint failed` warn rate > 5/min for 5 min — page.
  Typically means the API key + secret are mismatched.
- `livekit token mint denied` info rate spike > 50/min for 5 min —
  surfaces brute-force enumeration of session IDs.

## Rollback

If LiveKit Cloud goes down or rate-spikes the account:

1. Set `LIVEKIT_WS_URL=` (empty) on the affected server and restart.
2. `config.ts` returns `livekit: undefined`; the token-mint route
   un-registers at app.ts boot; the GUI client + customer-dashboard
   probe the missing route and fall back to the HTTP polling plane
   automatically.
3. Emails / billing / sessions / control plane all continue
   unaffected. The only customer-facing degradation is the ~1s
   polling-vs-realtime latency floor on the LiveSessionView.

The API key / secret can be rotated independently of WS URL via the
LiveKit dashboard; existing connections survive the rotation
(LiveKit signs ephemeral JWTs against the secret valid at mint-time,
not at WS-handshake time).

## Related

- `apps/server/src/lib/config.ts:LivekitConfig` — env-var schema.
- `packages/webrtc-streaming/` — `MockWebRtcStreamingService` is the
  fallback used today; will become the dev-mode / fallback
  implementation once `LiveKitWebRtcStreamingService` lands.
- `LiveSessionView` (NOT YET BUILT — see the unchecked item above; no such
  file exists under `apps/gui-client/src`) — viewport that
  will swap from HTTP polling to LiveKit subscribe.
- `apps/gui-client/src/lib/session-stream.ts` — `createPollingFrameStream`
  is the existing stream-source abstraction; a
  `createLiveKitFrameStream` sibling lands in the V-531.B follow-up.
- `docs/internal/2026-05-15-prod-wire-up-batch-report.md` — Track E
  status + 6-step remaining slice plan.
