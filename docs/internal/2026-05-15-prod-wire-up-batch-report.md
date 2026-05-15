# Prod wire-up batch report (2026-05-15)

Surfaced for founder verdict. Tracks listed in the Wave 1038+ HARD
priority queue, with current status, what was done this batch, what's
deferred, and an ETA for each deferred slice.

## A — Postmark go-live (V-665 + V-486)

**Status:** code DONE. Env wiring pending operator.

**This batch:**

- `docs/runbooks/postmark-go-live.md` — step-by-step procedure for
  the founder to wire the 3 env vars on /etc/driftstack/api.env on
  prod + staging, restart, and verify Postmark Activity.
- `scripts/smoke-postmark.mjs` — sends signup-verification +
  password-reset + signup-welcome fixtures against the live API and
  reports per-template OK/FAIL with msgId or postmark error code.
  Non-zero exit on any failure for CI gating.

**Deferred:** the actual env-var write on the two app servers + the
smoke-test run. Operator action, ~10 min.

## B — NowPayments IPN (V-666 / V-487)

**Status:** code DONE. Env wiring pending operator.

**This batch:**

- `apps/server/src/lib/bootstrap.ts` — wired `config.nowpayments?.
ipnSecret` through to `buildApp.deps.nowpaymentsIpnSecret`. Without
  this, even with `NOWPAYMENTS_IPN_SECRET` set on prod, the IPN route
  would never register — the gap that was blocking the wire-up.

**Deferred:**

1. Operator writes `NOWPAYMENTS_API_KEY` + `NOWPAYMENTS_IPN_SECRET`
   - `NOWPAYMENTS_PUBLIC_KEY` to /etc/driftstack/api.env (~10 min).
2. Smoke test: trigger a NowPayments test IPN delivery from the
   NowPayments merchant dashboard against `https://api.driftstack.dev
/v1/webhooks/nowpayments` and confirm 200 + Activity-log entry
   (~15 min).
3. Customer-side checkout-page smoke (only after frontend
   `/checkout/crypto` lands).

## C — OAuth Google + GitHub social login (V-667)

**Status:** GAP discovered — no code yet for social-login client.

**This batch:** none — surveyed and surfaced the gap.

**What's wired:** V-667.B implements Driftstack-as-OAuth-server (3rd-
party apps authorize against us). That's the existing
`apps/server/src/{routes,services}/oauth.ts` + `lib/oauth-pkce.ts`.

**What's NOT wired:** Driftstack-as-OAuth-client (sign in with Google
/ GitHub for _our_ customers). No code currently exists for:

- Outbound OAuth flow to accounts.google.com / github.com/login.
- Identity-provider callback handler that maps an external sub to
  an internal Driftstack account.
- Account-linking semantics (existing-email-different-IDP collision,
  rename/avatar sync, IDP-revocation handling).
- DB table for `account_identity_links` (provider + provider_sub +
  account_id + linked_at, with unique-index per provider+sub).
- UI affordance on signup + login screens to invoke the flow.

**ETA to complete:** ~6-8h focused (closer to a full V-NNN-scope
implementation slice than a wire-up). Recommend it lands as its own
V-NNN with founder verdict on the account-linking edge cases first
(those tend to be the surprise rebuilds when half-finished). The
credentials pasted into the directive (Google CLIENT_ID/SECRET,
GitHub CLIENT_ID/SECRET) are ready in 1Password equivalent;
nothing about Track C is blocked by missing credentials.

**Provision-first-OAuth-client (separate, smaller sub-slice):** the
existing V-667.B `/v1/admin/oauth/clients` endpoint is ready and can
register an invite-only third-party app today. That's ~15 min via
curl with an admin key — recommended path if the immediate goal is
to onboard a partner app, separate from social-login customer
signup.

## D — Sentry per-service projects (V-469 follow-up)

**Status:** 2 of 6 projects DONE this batch.

**This batch:**

- Created `driftstack-dashboard` + `driftstack-marketing` Sentry
  projects in the `driftstack` org (EU region, `de.sentry.io`).
- Captured public DSNs and set as GitHub repo secrets:
  `PUBLIC_SENTRY_DSN_DASHBOARD` + `PUBLIC_SENTRY_DSN_MARKETING`.
- Re-triggered the `Deploy customer dashboard` + `Deploy marketing
site` workflows so the next build bakes the new DSNs into the
  client bundles.
- `scripts/sentry-create-per-service-projects.mjs` is the idempotent
  artefact for repeating this on the remaining 4 projects.
- `docs/runbooks/observability.md` project-layout table updated with
  current status and per-app gh-secret mapping.

**Deferred:** 4 more projects per the observability runbook
inventory:

- `driftstack-server` — should be created next; this is the highest-
  signal project (every API request can throw). ~5 min.
- `driftstack-docs` — lower priority; create when docs site is live.
  ~5 min.
- `driftstack-status-site` — outage-time critical; should be created
  before the status site goes live. ~5 min.
- `driftstack-admin-panel` — internal-only; can defer to post-launch.
  ~5 min.

Run `scripts/sentry-create-per-service-projects.mjs` with the
`PROJECTS` array extended to cover each in turn.

## E — LiveKit V-531.B real codec swap

**Status:** surveyed + config-schema groundwork DONE this batch.

**This batch (survey + groundwork):**

- Surveyed `packages/webrtc-streaming/`: only mock surface exists today
  (`MockWebRtcStreamingService` + `MockFrameSource` + `EncodePipeline`
  with `codec='raw'` pass-through). No `livekit-server-sdk` dep, no
  token-mint endpoint, no `LiveKitWebRtcStreamingService`.
- `LiveSessionView.tsx` (apps/gui-client) — confirmed still uses HTTP
  polling of `client.sessions.capture()` at 500ms cadence, not the
  streaming-service abstraction.
- `lib/config.ts` — added `livekit.{apiKey,apiSecret,wsUrl}` optional
  zod block with all-or-nothing route-gate semantics, mirroring the
  nowpayments precedent. `LivekitConfig` type exported.
- `tests/unit/config-lib-cross-source-invariant.test.ts` — drift-guard
  pin for the framing comment + zod block + type export.

**Remaining (~3h focused):**

1. Add `livekit-server-sdk` dependency to `apps/server/package.json`.
2. Build `lib/livekit-token.ts` — wraps `AccessToken` from SDK to mint
   per-session JWTs (publisher token for the Mac mini fleet, subscriber
   token for the customer-dashboard preview).
3. Add route `POST /v1/sessions/:id/livekit-token` (gated on
   `config.livekit` presence at app.ts).
4. Build `LiveKitWebRtcStreamingService` (or simpler: skip the
   StreamingService interface entirely and just have gui-client mint
   token + open `livekit-client` connection directly).
5. Wire `gui-client` `LiveSessionView` to use LiveKit subscriber when
   `config.livekit.wsUrl` is set, fall back to HTTP polling otherwise.
6. Smoke test WS handshake + first frame render against the pasted
   LIVEKIT_WS_URL.

## F — V-278.K Neon prod/staging split + V-278.L Upstash split

**Status:** requires SSH access I don't have wired here.

**This batch:** none.

**Deferred:** operator SSH operations:

1. Create separate Neon projects (prod + staging) via Neon console
   or `neonctl` CLI.
2. Create separate Upstash Redis instances (prod + staging) via
   Upstash console.
3. Write split DATABASE_URL + REDIS_URL to /etc/driftstack/api.env on
   each server.
4. Restart api service + smoke `curl /v1/status`.

**ETA:** ~3h operator time. Recommend founder do this hands-on; the
DATABASE_URL value rotation is the most consequential single
operation on the launch checklist (a typo here means prod silently
points at staging).

## G — V-657-V-670 Track Implementation queue

**Status:** queued behind A-F. No work this batch.

**Backlog inventory:** status page implementation, cost monitoring
hardening, chaos scripts expansion, deploy hardening, trust center,

- further V-NNN slices. Each is its own ~2-6h slice.

**Recommendation:** sequence post-A/B/D activation (Postmark +
NowPayments + Sentry-server-project live) so the V-NNN slices land
into a wired-up environment rather than racing the wire-up.

## H — Tasks #187 (resend-verification) + #190 (magic-link dashboard)

**Status:** server side DONE for both. Frontend slice pending.

**#190 magic-link server (this batch):**

- `routes/auth.ts` — added `magicLinkRequestGate` (3/min IP cap), attached
  to `POST /v1/auth/magic-link/request`. Pre-this-fix the endpoint had
  no rate-limit at all — surfaced during the wire-up audit, was a
  pre-launch abuse vector since each call fires a Postmark send.
- `middleware/ip-rate-limit.ts` — added `magicLink: 3/min` to the
  `AUTH_IP_LIMITS` table (7-entry map now).
- `tests/unit/ip-rate-limit-v251-cross-source-invariant.test.ts` — pinned
  the 7-entry shape including the new limit.

**#187 resend-verification audit (this batch):**

- Endpoint `POST /v1/auth/resend-verification` already wired with
  `resendVerificationGate` (3/min). Existed before this audit batch —
  the wire-up audit was a verification pass.
- Service `resendSignupVerification` already implements the no-leak
  flow: same response shape whether the email matched an unverified
  account, an already-verified account, or no account at all.
- Postmark integration: `this.email.sendSignupVerification(...)` is
  fire-and-forget per the rest of the auth-flow service.

**Deferred — both #187 + #190 frontend slices:**

- `apps/customer-dashboard/` — UI affordance on post-signup
  "check your email" screen (re-trigger button) for #187.
- `apps/customer-dashboard/` — magic-link request form for #190
  (server endpoint is live; nothing in the dashboard invokes it yet).

**ETA:** ~2h combined for the two frontend slices.

## Held tasks for founder verdict (Pasted credentials)

All 4 credential blocks the user pasted are not committed anywhere
in the repo. They live only in the active session conversation
context. The operator needs to:

1. Copy `NOWPAYMENTS_*` (3 vars) to /etc/driftstack/api.env on each
   server, mirror to 1Password.
2. Copy `GOOGLE_OAUTH_CLIENT_*` + `GITHUB_OAUTH_CLIENT_*` (4 vars)
   to /etc/driftstack/api.env on each server AND to 1Password —
   but note Track C needs the social-login code first.
3. `SENTRY_AUTH_TOKEN` should be rotated since it was pasted into a
   chat transcript (defensive hygiene; the bootstrap.ts schema does
   not need it — it's only used by the
   `scripts/sentry-create-per-service-projects.mjs` script when
   creating new projects).
4. `LIVEKIT_API_*` (3 vars) need to land in /etc/driftstack/api.env
   AND in the gui-client config when Track E lands.

## Rule M v2 enforcement

This batch interleaved 3 tracks (A → D → B) per the new
self-locked sub-rule: max 5 consecutive same-track waves. Track C
surfaced as a gap (greenfield, not a wire-up) and was deferred to
its own future slice rather than absorbed into this batch's time
budget.
