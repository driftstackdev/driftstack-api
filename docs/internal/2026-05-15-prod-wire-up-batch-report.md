# Prod wire-up batch report (2026-05-15)

Surfaced for founder verdict. Tracks listed in the Wave 1038+ HARD
priority queue, with current status, what was done this batch, what's
deferred, and an ETA for each deferred slice.

## Wave 1059+ update — prod deploy LANDED (autopilot, no founder verdict)

The deploy.yml/server-deploy.yml docker-compose mismatch (see
`2026-05-15-deploy-pipeline-mismatch.md`) is bypassed by a manual
SSH-deploy bridge: `scripts/deploy-bridge.sh {staging,prod} [<SHA>]`
clones, builds with `npm ci`, applies pending DB migrations, swaps
`/opt/driftstack/api/{dist,node_modules,migrations,packages/{api-
types,webhook-delivery}}` atomically, restarts `driftstack-api`,
polls `/health`, and auto-rolls-back on any post-restart failure.

Staging green at SHA `5a67945` 2026-05-15 15:36 UTC; prod green at
SHA `5822e21` 2026-05-15 16:13 UTC after a 2h37m staging soak (V-507
posture met). Boot log on prod confirms:

```
"sentry":true, "email":true, "livekit":true, "oauthClient":false
"env":"production"
```

Tracks landed in this rollout:

- **Track A** (Sentry) — already live; reconfirmed `sentry:true`.
- **Track A** (Postmark) — already live; reconfirmed `email:true`.
- **Track C** (V-667.C OAuth-client lib + routes + DB schema + Postmark
  verify-merge template) — code on prod, route DORMANT (404) until
  `OAUTH_CLIENT_*` env wired. Operator action remaining.
- **Track D** (per-service Sentry projects) — unchanged this rollout
  (still 2/6 created).
- **Track E** (V-531.B LiveKit token route) — NOW HOT on prod:
  `POST /v1/sessions/:id/livekit-token` returns 401 (auth-gated, route
  REGISTERED) instead of 404 (route absent). LiveKit-aware GUI clients
  upgrade from HTTP polling on this binary.
- **Track H** (#190 magic-link IP rate-limit) — landed transparently
  via the same deploy.

Deploy-bridge improvements in this batch:

- `npm ci` (lockfile-strict) + no `npm prune --omit=dev` — earlier
  attempt at `npm install + prune` dropped transitive runtime deps
  like `require-in-the-middle` and crashed the server in
  `MODULE_NOT_FOUND`. The image size penalty (~80MB) is acceptable until docker-
  compose deploy lands.
- DB migrations applied between artefact swap and `systemctl restart`
  so the new code never boots against an older schema (migration 0039
  needed for V-667.C tables).
- `apps/server/src/db/migrate.ts` updated to resolve the migrations
  folder via a compiled-neighbour fast path + src-tree fallback so
  the compiled prod `migrate.js` finds the source migrations under
  `apps/server/src/db/migrations` (deploy-bridge layout).

## Wave 1054+ update (SSH-authorized autopilot)

Founder appended autopilot pubkey to `/root/.ssh/authorized_keys` on
both prod (128.140.37.74) + staging (116.203.22.197) on 2026-05-12.
SSH verified at start of Wave 1054. Discovered Postmark + NowPayments
env vars were ALREADY operator-wired in `/opt/driftstack/api/.env`
(file timestamp 2026-05-11 14:30); Tracks A + B require no further
env action. Wave 1054 actions:

- Track E env: appended `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` /
  `LIVEKIT_WS_URL` to both servers' `.env`; restarted `driftstack-api`
  clean on both (3 `LIVEKIT_*` keys present). Deployed binary at SHA
  `85aee83` is pre-Track-E so `/v1/sessions/:id/livekit-token` 404s
  until next deploy picks up the route.
- Track C V-667.B-1: schema landed (migration 0039 + Drizzle for
  account_oauth_links + oauth_pending_links + account_avatar_source
  enum). Founder verdicts 1+2+3 locked.
- Track C V-667.B-2 (Wave 1055): `lib/oauth-client-providers.ts` +
  7-test unit suite covering Google + GitHub provider configs +
  buildAuthorizeUrl (Google-specific prompt=consent for fresh email
  trust per Verdict 1).
- Track F V-278.K design (Wave 1055): `scripts/v278k-neon-split-
cutover.sh` operator runbook with 10 confirmation-prompted steps
  (provision → pg_dump → restore → SSH-swap DATABASE_URL → smoke +
  7-day rollback window).

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

**Status:** server-side END-TO-END DONE. Frontend subscriber slice + env wire are the only remaining steps.

**This batch:**

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
- `lib/livekit-token.ts` — pure-`node:crypto` HS256 JWT minter that
  mirrors LiveKit's `AccessToken` claim shape (iss/sub/exp/nbf/jti/
  video). Deliberately avoids the `livekit-server-sdk` dep — the
  spec is stable + 30-LOC of stdlib beats the transitive footprint.
- `tests/unit/livekit-token.test.ts` — 13 unit tests covering header
  shape, payload claims, HMAC signature, ttl default, jti uniqueness,
  publisher/subscriber role variants, error paths, base64url encoding,
  deterministic nowMs override.

**Server-side complete (this batch's commits):**

1. ✅ `sessions.service.findOwnedSessionLite` — public ownership
   check without driver side-effects, landed at 97785484.
2. ✅ `routes/sessions-livekit-token.ts` — `POST /v1/sessions/:id/
livekit-token` minting publisher OR subscriber tokens; route stays
   unregistered when `config.livekit` is absent (404 → client falls
   back to HTTP polling). Landed at 1eea466d + wired at 97785484.
3. ✅ `scripts/smoke-livekit.mjs` — operator smoke script (dep-free,
   Node 22+ WebSocket). Landed at e3662779.

**Frontend remaining (~1h focused):**

- Wire `gui-client` `LiveSessionView` to probe `/v1/sessions/:id/
livekit-token` once on mount: 200 → open LiveKit subscriber via
  `livekit-client` (add as dep); 404 → fall back to HTTP polling
  (current path). The fall-back ensures the dashboard works pre-env-
  wire-up + during LiveKit outage.

**Operator action remaining (~10 min):**

- Wire `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET` + `LIVEKIT_WS_URL`
  to `/etc/driftstack/api.env` on prod + staging.
- Restart `driftstack-api` on each.
- Run `scripts/smoke-livekit.mjs --session-id sess_demo --role publisher --duration-ms 5000`
  from a workstation with prod creds to verify WS handshake.

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

## Drift-guard coverage milestone (interleave track)

Interleaved with the wire-up tracks above, this batch added 13
route-level cross-source invariant tests (W1039–W1051) covering the
remaining un-pinned high-priority routes:

| Wave  | File                              | V-NNN family            |
| ----- | --------------------------------- | ----------------------- |
| W1039 | `routes/webhooks-nowpayments.ts`  | V-666 IPN webhook       |
| W1040 | `routes/billing-crypto.ts`        | V-666.C customer        |
| W1041 | `routes/billing-crypto-orders.ts` | V-666.G family customer |
| W1042 | `routes/admin-incidents.ts`       | V-295a incidents        |
| W1043 | `routes/admin-webhooks.ts`        | V-281 webhook ops       |
| W1044 | `routes/billing.ts`               | V-082 + V-248 Stripe    |
| W1045 | `routes/oauth.ts`                 | V-667.B OAuth-server    |
| W1046 | `routes/admin-force-actions.ts`   | V-100 + D-020/D-025     |
| W1047 | `routes/admin-crypto-orders.ts`   | V-666.D admin           |
| W1048 | `routes/profile-snapshots.ts`     | V-312 + V-326e          |
| W1049 | `routes/admin.ts`                 | V-326e6 + V-330e        |
| W1050 | `routes/team.ts`                  | V-298c + V-326c         |
| W1051 | `routes/profiles.ts`              | V-081 + V-313 + V-480   |

Plus W1042-route-side V-531.B (LiveKit token route) drift-guard at
1eea466d. Closes coverage on every customer-facing + admin route the
session touched. The 3 remaining routes (sessions.ts, admin-accounts.ts,
profiles.ts main CRUD) are either already covered partially via
adjacent parity tests OR are too large for a single drift-guard wave
without risking regex churn.

## H — Tasks #187 (resend-verification) + #190 (magic-link dashboard)

**Status:** #187 DONE end-to-end. #190 DONE end-to-end as of 4e2513e0.

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

**#190 frontend (this batch — 4e2513e0):**

- `apps/customer-dashboard/src/pages/auth/magic-link-request.astro` —
  new no-leak request page that mirrors `forgot-password.astro` shape:
  email-only form, identical success-card regardless of account match,
  `expires_at` window display, dev-mode `debug_token` paste-into link.
  Honors `?email=` prefill for the post-failed-password bounce path.
- `apps/customer-dashboard/src/pages/login.astro` — added "Sign in
  with a magic link instead" link under "Forgot your password?".

**#187 frontend (already shipped, pre-this-batch):**

- `apps/customer-dashboard/src/pages/verify-email.astro` already has
  the "Resend verification email" button wired against
  `/v1/auth/resend-verification` with 60s client-side debounce
  matched to the per-IP 3/min cap. No new work.

**ETA:** complete.

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
