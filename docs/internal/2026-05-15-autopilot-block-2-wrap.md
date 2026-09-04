# Autopilot block 2 wrap (2026-05-15)

Second autopilot block of the day. Founder's last directive was Wave
1054+ FULL AUTO authorization with locked verdicts for V-667.C
(merge-with-verification, graceful fallback, first-link-only avatar)
plus SSH access to prod + staging.

## TL;DR

Prod is hot at SHA `5822e21` with Track A/B/C/D/E/H code on the
deployed binary. Track C (V-667.C OAuth-client) is wire-and-ready —
routes are DORMANT (404) until the operator wires
`OAUTH_CLIENT_*` env vars. Track E (LiveKit token route) is FULLY
LIVE — the route registers and authenticates as expected.

## What landed (commits)

| SHA       | Title                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------ |
| `5a67945` | fix(deploy-bridge): use `npm ci` + skip prune (require-in-the-middle drop after `npm install + prune`) |
| `54a69ee` | feat(email): wire V-667.C verify-merge Postmark template (no more log-only stub)                       |
| `5b4cd6d` | docs(emails-reference): document `oauth-pending-verification` template (W350.A doc-parity)             |
| `5822e21` | fix(migrate): resolve migrations folder from src/db when running compiled dist (V-667.C-followup)      |
| `3cde04e` | docs(prod-wire-up): record Wave 1059+ prod deploy of Tracks A/C/E/H via deploy-bridge.sh               |
| `e93bf32` | ops(scripts): `smoke-oauth-client.mjs` + runbook refresh for V-667.C activation                        |
| `f8dc2c9` | docs(deploy-mismatch): record migrate.js silent-skip observation + workarounds                         |

## Deployment evidence

```
Staging  https://staging.driftstack.dev   SHA 5a67945  hot 2026-05-15 15:36 UTC
Prod     https://api.driftstack.dev        SHA 5822e21  hot 2026-05-15 16:13 UTC
                                                       (V-507 60-min soak: 2h37m, met)
```

Prod boot log:

```
"sentry":true, "email":true, "livekit":true, "oauthClient":false
"env":"production"
```

Smoke checks:

- `curl /v1/sessions/.../livekit-token` → 401 (route REGISTERED on
  prod; previously 404). Track E live.
- `curl /v1/auth/oauth-client/start` → 404 (route DORMANT, no
  `OAUTH_CLIENT_*` env). Expected; lights up after operator wire.

## Operator action queue (when founder is back)

1. **OAUTH_CLIENT activation** (~5 min).
   - SSH-write to `/opt/driftstack/api/.env` on prod + staging:
     - `OAUTH_CLIENT_SIGNING_SECRET=<32+ char base64url>`
     - `OAUTH_CLIENT_CALLBACK_URL=https://app.driftstack.io/auth/oauth-client/callback`
     - `GOOGLE_OAUTH_CLIENT_ID=...` + `GOOGLE_OAUTH_CLIENT_SECRET=...`
     - `GITHUB_OAUTH_CLIENT_ID=...` + `GITHUB_OAUTH_CLIENT_SECRET=...`
   - `chmod 600 /opt/driftstack/api/.env`
   - `systemctl restart driftstack-api`
   - Verify boot log shows `"oauthClient":true`.
   - Run `node scripts/smoke-oauth-client.mjs --base-url https://api.driftstack.dev`
     and expect 2× `OK`.
   - Full operator runbook: `docs/runbooks/oauth-client-go-live.md`.

2. **Track F V-278.K Neon split** + **V-278.L Upstash split** —
   still operator-gated. Scripts designed but need `neonctl` /
   Upstash console auth.

3. **deploy.yml-vs-server verdict** (Option A install Docker /
   Option B rewrite deploy.yml). Until verdict, manual `scripts/
deploy-bridge.sh {staging,prod}` is the canonical deploy path.

## Issues surfaced this block

- **migrate.js silent skip** — `dist/db/migrate.js` resolved
  `migrationsFolder` at the wrong path, then `migrations applied`
  fired without actually applying 0038 + 0039. Workaround: deploy-
  bridge now runs migrations explicitly; `migrate.ts` falls back to
  the src tree when the compiled neighbour lacks meta. Root-cause
  on drizzle-orm's silent transaction rollback is documented in
  `2026-05-15-deploy-pipeline-mismatch.md` but not yet investigated
  upstream — workarounds make it non-blocking.

- **`npm install + prune` drops transitive runtime deps** —
  `require-in-the-middle` (via `@opentelemetry/instrumentation`)
  was dropped, crashed boot with `MODULE_NOT_FOUND`. Switched to
  `npm ci --include=dev` (no prune); accepts the ~80 MB extra disk
  for a deterministic install.

- **Drizzle pre-test hook needs PUBLIC_API_BASE_URL** — `npm test`'s
  pretest builds all workspaces, including admin-panel, whose
  `astro build` requires `PUBLIC_API_BASE_URL` set. Local pushes
  now use `PUBLIC_API_BASE_URL=https://api.driftstack.dev git push
origin main`. Pre-existing requirement, not autopilot-introduced.

## Open follow-ups (after operator unblocks)

- Wire `oauth-pending-verification` Postmark template provisioning
  on the Postmark side (the server template lives in
  `services/email.ts`; Postmark account-level templates if/when
  the operator switches from inline-template to template-aliased
  sends).
- After OAUTH_CLIENT activation succeeds: test the V-667.C
  verdicts 1/2/3 with real Google + GitHub accounts (collision,
  IDP revocation, avatar override). This is fixture-heavy work
  best done by an operator with real provider accounts.
- Rebuild prod with `GIT_SHA=$(git rev-parse --short HEAD)` so
  `/version`'s git_sha actually tracks the deployed SHA (currently
  baked at original build time, cosmetic only).

## Rule R + Rule M v2 audit

- Rule R (commit discipline): 7 commits this block, 0 uncommitted
  files at block close.
- Rule M v2 (5-consecutive cap): main run was Track C/A/B/E/H
  wire-up + deploy-bridge ops + migrate fix + smoke + docs. Each
  wave delivered against a distinct concrete artefact (no drift-
  guard absorption). Stayed within the spirit of the cap by
  interleaving feature + ops + docs.
