# Autopilot block 3 wrap (2026-05-15)

Continuation of block 2 (`2026-05-15-autopilot-block-2-wrap.md`).
Block 2 closed with prod at SHA `712c892` and all tracks (A/B/C/D/E/H)
deployed. Block 3 added V-545.A end-to-end, hardened the deploy
verifier, added test coverage gaps, and rolled prod forward twice.

## TL;DR

Prod is hot at SHA `aa0d65c` with the same track set as block 2 +
the V-545.A public incident-detail surface. Two `main` commits sit
ahead of prod's binary (status-site Astro page + auth-tokens unit
tests) — neither alters server runtime so a redeploy is optional.

## What landed (10 commits since block 2)

| SHA       | Title                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------ |
| `f8dc2c9` | docs(deploy-mismatch): record migrate.js silent-skip observation + workarounds                   |
| `712c892` | ops(deploy-bridge): upsert GIT_SHA into /opt/driftstack/api/.env so /version tracks deployed SHA |
| `de0c310` | feat(status): V-545.A public incident-detail surface w/ update timeline                          |
| `a8c4210` | feat(openapi): document GET /v1/status/incidents/:id detail endpoint (V-545.A)                   |
| `3fb5ebd` | ops(scripts): post-deploy-verify.mjs — 8 invariants beyond /health                               |
| `8df785b` | ops(deploy-bridge): auto-run post-deploy-verify against public URL after SSH ack                 |
| `aa0d65c` | test(oauth-client): V-667.C route-level integration tests (7 cases)                              |
| `b0a46d4` | ops(post-deploy-verify): require /v1/status/incidents/{id} in /openapi.json                      |
| `86a1ba9` | feat(status-site): V-545.A incident detail page + linked from index card                         |
| `a51ea63` | test(auth-tokens): direct runtime unit coverage for lib/auth-tokens.ts                           |

## V-545.A — public incident-detail surface, end to end

Block 3's headline shipped. The status site already had a list view
of public incidents but no way to drill into one for the full
timeline. After this block:

- **Server route** `GET /v1/status/incidents/:id` (no-auth, public-only,
  404 for private/missing — same 404 shape so admin-only incidents
  can't be enumerated).
- **Integration tests** at `apps/server/tests/integration/admin-incidents.test.ts`
  covering happy path (incident + ≥2 timeline entries), private →
  404, malformed id → 400.
- **OpenAPI** entry under `/v1/status/incidents/{id}` with 200 / 400 /
  404 response shapes.
- **Drift-guard parity** in W420.B pins the route registration shape.
- **Status-site Astro page** at `/incident?id=inc_<uuid>` that reads
  the id from query string, fetches the API, renders title +
  description + severity/status badges + the update timeline. Loads
  hermetically (no build-time API call).
- **Index card linking** — each incident card on the home page now
  wraps its title in an anchor to the detail page.

Status-site deploys via Cloudflare Pages on `apps/status-site/**`
push to main; the new page goes live on the next CF Pages build.

## V-667.C — route-level integration tests added

Earlier blocks shipped the V-667.C OAuth-client end-to-end (route +
service + repos + Postmark template + bootstrap wire + dashboard
UI) and unit tests for the libs/service. Block 3 closed the route-
layer integration-test gap (`apps/server/tests/integration/auth-
oauth-client.test.ts`, 7 cases):

- POST /start: 200 + PKCE-shaped authorize URL + HMAC-signed
  HttpOnly PKCE cookie.
- POST /start: 400 on bad provider enum + 400 on
  requested-but-unconfigured-provider + 404 when env-pre-wire.
- POST /confirm-merge: 400 on malformed + 400 on unknown plaintext
  token (invalid/expired/consumed all share one error bucket so
  callers can't enumerate).

Fixture gained `opts.oauthClient` option that mirrors the prod
app.ts gate exactly (signing secret + callback + ≥1 provider).
Reuses the existing `InMemoryOAuthLinksRepo` +
`InMemoryOAuthPendingLinksRepo` helpers from the unit suite — zero
new in-memory scaffolding.

## Deploy-bridge hardening

Block 2 introduced `scripts/deploy-bridge.sh` for manual SSH-deploy
(bypasses the docker-compose `deploy.yml` mismatch). Block 3
hardens it on three axes:

1. **GIT_SHA upsert** (`712c892`) — the bridge sed-deletes any
   existing `GIT_SHA=` line in `/opt/driftstack/api/.env` and
   appends the freshly-computed short SHA. systemd's `EnvironmentFile`
   picks it up on restart; `/version`'s `git_sha` now tracks the
   deployed SHA (was permanently stale at `3f153e3`). Permissions
   preserved (`600 driftstack:driftstack`).
2. **post-deploy-verify** (`3fb5ebd`, `8df785b`) — new
   `scripts/post-deploy-verify.mjs` hits 8 invariants against the
   public origin (not the SSH-side localhost): /health, /version
   shape, /version SHA matches `--expected-sha`, /v1/status,
   /v1/status/incidents list, /v1/status/incidents/:id route
   registered (404 carries ProblemJson detail, not Astro/CDN HTML),
   /openapi.json has the expected paths, unknown path returns
   Fastify default 404 (not 5xx). deploy-bridge auto-runs it after
   the SSH-side /health-poll succeeds — non-zero exit propagates so
   operator sees red when an invariant breaks.
3. **/openapi.json tightening** (`b0a46d4`) — checkOpenapi now
   requires both `/v1/status/incidents` and
   `/v1/status/incidents/{id}`; future openapi/route drift fails
   post-deploy-verify red instead of silently passing.

## Test-coverage waves

- `aa0d65c` — V-667.C route-level integration tests (above).
- `a51ea63` — direct runtime unit tests for `lib/auth-tokens.ts`
  (15 cases). Existing W-numbered parity tests pin the file shape;
  this pins runtime behaviour: base64url + 32-byte entropy of
  generateAuthToken, deterministic sha256 hex of tokenHash,
  hashPassword + verifyPassword round-trip with random-salt
  invariant, AUTH_TOKEN_TTL_MS strictly-increasing-ordering
  (magicLink < signupVerification < passwordReset < webSession).

## Issues / observations

- `migrate.js` silent-skip root cause from block 2 (`docs/internal/
2026-05-15-deploy-pipeline-mismatch.md`) remains documented but
  un-investigated upstream. Workarounds in place: deploy-bridge
  runs migrations explicitly; migrate.ts falls back to the src
  tree when the compiled neighbour lacks `meta/_journal.json`.
- /openapi.json drift surfaced naturally during the V-545.A roll-out
  (route landed on prod before openapi entry made it to prod
  binary). post-deploy-verify tightening closes that loop.
- Deploy bridge's `npm ci --include=dev` shipping ~80 MB of dev
  deps to prod remains the accepted trade-off until the
  deploy.yml/server-deploy.yml docker-compose verdict (Option A
  install Docker vs Option B rewrite deploy.yml) is given by the
  founder.

## Operator action queue (unchanged from block 2)

1. **OAUTH_CLIENT activation** (~5 min). Wire the 6 env vars,
   `chmod 600`, `systemctl restart driftstack-api`. Verify with
   `node scripts/smoke-oauth-client.mjs --base-url
https://api.driftstack.dev` (expect 2× OK). Full runbook:
   `docs/runbooks/oauth-client-go-live.md`.
2. **Track F V-278.K Neon split** + V-278.L Upstash split — still
   operator-gated.
3. **deploy.yml-vs-server verdict** — Option A or B from
   `2026-05-15-deploy-pipeline-mismatch.md`.

## What's deployable today (block-3 closing state)

- Staging: `aa0d65c` (was `de0c310` mid-block; rolled forward at
  17:17 UTC).
- Prod: `aa0d65c` (rolled forward at 17:17 UTC; post-deploy-verify
  inline reported 8/8 OK).
- `main`: `a51ea63` — 2 commits ahead of prod (status-site page +
  auth-tokens unit tests, neither runtime-touching).

## Rule R + Rule M v2 audit

- Rule R: 10 commits in block 3, 0 uncommitted at close.
- Rule M v2: tracks interleaved across Track G (V-545.A), deploy
  ops, test coverage (V-667.C integration + auth-tokens unit). No
  drift-guard absorption episode. Pivoted each wave after at most
  2 consecutive same-track waves.
