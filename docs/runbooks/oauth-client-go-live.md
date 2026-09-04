# OAuth-client go-live runbook (V-667.C)

How to activate sign-in-with-Google + sign-in-with-GitHub for
customer signup/login. Sister runbook to
`docs/runbooks/postmark-go-live.md` (Track A),
`docs/runbooks/livekit-go-live.md` (Track E).

**Status (2026-05-16):** V-667.C is **LIVE on staging + prod** under
Path A (per-provider redirect_uri matching Google + GitHub Console
registrations). Both servers boot with `oauthClient:true`;
`smoke-oauth-client.mjs` returns OK for both providers against both
origins. Real-IDP browser click-through from
https://app.driftstack.io/login is the remaining founder-side
validation step.

The sections below document the activation procedure for the next
operator who needs to re-run it (recovery scenario, new provider
addition, signing-secret rotation, etc.). The 2026-05-16 deploy
followed this exact sequence end-to-end (waves 16+ in the session
log).

## Founder verdicts (locked 2026-05-15)

1. **Existing-email collision:** merge-with-verification. The
   `oauth_pending_links` table holds a 60-min single-use token; the
   existing account receives an email; clicking the link merges the
   IDP identity onto the existing account.
2. **IDP revocation:** graceful fallback. The
   `account_oauth_links.last_revoked_at` column marks the link;
   subsequent login attempts surface a "re-link or sign in with
   password" prompt. Never auto-delete account, never auto-merge.
3. **Avatar / name sync:** first-link-only + user-overridable. The
   `accounts.avatar_source` enum (none/idp/user) drives behaviour;
   once 'user' is set (via user-edit), we never re-pull from the IDP.

## Pre-flight

- [ ] Google Cloud Console: create an OAuth 2.0 client (Web
      application). Authorized redirect URI:
      `https://api.driftstack.dev/v1/auth/oauth/google/callback`.
      Copy Client ID + Client Secret.
- [ ] GitHub Developer Settings → OAuth Apps → New OAuth App.
      Authorization callback URL:
      `https://api.driftstack.dev/v1/auth/oauth/github/callback`.
      Copy Client ID + Client Secret.
- [ ] Generate a fresh `OAUTH_CLIENT_SIGNING_SECRET` (≥32 chars):
      `    node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

## Step 1 — wire env on prod + staging

SSH-write to `/opt/driftstack/api/.env` on each server. Values come
from `1Password / Driftstack / OAuth client creds` — **not** from
this runbook, the repo, or any chat transcript.

```
OAUTH_CLIENT_SIGNING_SECRET=<32+ char random base64url>
OAUTH_CLIENT_CALLBACK_URL_BASE=https://api.driftstack.dev/v1/auth/oauth
GOOGLE_OAUTH_CLIENT_ID=<from Google Cloud Console>
GOOGLE_OAUTH_CLIENT_SECRET=<from Google Cloud Console>
GITHUB_OAUTH_CLIENT_ID=<from GitHub OAuth Apps>
GITHUB_OAUTH_CLIENT_SECRET=<from GitHub OAuth Apps>
```

**Path A note (2026-05-16):** `OAUTH_CLIENT_CALLBACK_URL_BASE` replaces
the previous `OAUTH_CLIENT_CALLBACK_URL` (which pointed at the SPA).
The per-provider URL is now derived as
`${OAUTH_CLIENT_CALLBACK_URL_BASE}/${provider}/callback`, which MUST
match each provider's Console-registered redirect URI:

- Google Cloud Console: `https://api.driftstack.dev/v1/auth/oauth/google/callback`
- GitHub OAuth App: `https://api.driftstack.dev/v1/auth/oauth/github/callback`

**No silent fallback** from the old env name. The OLD env value is
the wrong shape for the new field (would compose wrong per-provider
URLs and reproduce the redirect_uri_mismatch bug from a different
code path), so we'd rather flip `oauthClient:false` (route
un-registers, login buttons surface "OAuth start failed" banner)
than silently send broken URLs to the IDP.

**Safe rollout sequence:**

1. SSH both servers: **add** `OAUTH_CLIENT_CALLBACK_URL_BASE=...` to
   `/opt/driftstack/api/.env` alongside the existing
   `OAUTH_CLIENT_CALLBACK_URL`. No restart needed — live code reads
   the old name, doesn't know about the new one.
2. Deploy new code via `bash scripts/deploy-bridge.sh staging` then
   `bash scripts/deploy-bridge.sh prod`. The deploy-bridge restarts
   the service; new code reads the new env name.
3. After confirming `oauthClient:true` on both servers, optionally
   remove the now-unused `OAUTH_CLIENT_CALLBACK_URL` line.

Both providers can be activated independently — the route gate at
`lib/app.ts` registers when ≥1 provider has both clientId +
clientSecret AND the signing secret + callback URL base are set.

Restart the api service:

```sh
systemctl restart driftstack-api
```

Confirm the boot logs show `oauthClient:true`:

```sh
journalctl -u driftstack-api -n 30 --no-pager \
  | grep '"bootstrap complete"' \
  | grep -o '"oauthClient":[a-z]*'
```

Expected: `"oauthClient":true`. If `false`, one of the env vars is
missing or malformed — re-check the schema in
`apps/server/src/lib/config.ts` (`oauthClient` zod block).

Quick smoke (no Google/GitHub round-trip):

```sh
node scripts/smoke-oauth-client.mjs --base-url https://api.driftstack.dev
```

The script POSTs `/v1/auth/oauth-client/start` for each enabled
provider, follows the 302 to the IDP, and reports `OK` when the
authorize URL has all expected query params (`client_id`,
`redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`,
`scope`, `response_type=code`).

The broader `scripts/post-deploy-verify.mjs` covers the same surface
plus 7 other invariants (/health, /version, /v1/status,
/v1/status/incidents, /v1/status/incidents/:id, /openapi.json,
unknown-path 404). `deploy-bridge.sh` auto-runs it after every
`bash scripts/deploy-bridge.sh {staging,prod}` so a post-OAUTH-wire
redeploy will catch a misconfigured env automatically.

## Step 2 — smoke test

From a workstation:

1. Visit `https://app.driftstack.io/login`. Confirm the
   "Sign in with Google" + "Sign in with GitHub" buttons appear.
2. Click "Sign in with Google". Browser should redirect to
   `https://accounts.google.com/o/oauth2/v2/auth?...`. The
   `redirect_uri` query param MUST be
   `https://api.driftstack.dev/v1/auth/oauth/google/callback`
   (matches Google Cloud Console registration).
3. Complete consent. Browser briefly hits
   `https://api.driftstack.dev/v1/auth/oauth/google/callback?...`
   (302 from IDP), which 302s to
   `https://app.driftstack.io/auth/oauth-client/callback?...`
   (final landing).
4. The callback page POSTs to the server. Three possible outcomes:
   - **New account** (your email isn't in our DB): page redirects to
     `/`. Confirm the dashboard recognises you as signed in.
   - **Existing-link** (same Google account, same email): page
     redirects to `/`. `account_oauth_links.last_login_at` is
     bumped.
   - **Collision** (email already has a password account): page
     shows "Check your inbox". Open the verify-merge email and
     click the link → lands at
     `/auth/oauth-client/confirm-merge?token=...` → completes the
     link.
5. Repeat the same dance for GitHub.

## Step 3 — verify Verdict 2 (revocation fallback)

1. After successfully linking, go to Google Account → Security →
   Third-party apps → Driftstack → Remove access.
2. Try signing in with Google again on the Driftstack dashboard.
3. Expected: dashboard shows the "Re-link Google or sign in with
   password" prompt. Server stamps
   `account_oauth_links.last_revoked_at` on the existing row.
4. Sign in with password → re-link Google → confirm
   `last_revoked_at` clears on next IDP login.

## Step 4 — Postmark template (V-667.B-10 follow-up)

The collision-flow email is currently log-only (bootstrap mailer is
a stub). Wire the actual Postmark template:

1. Create a `verify-merge` template in the Postmark dashboard with
   variables `provider_label`, `confirm_url`, `expires_at`.
2. Replace the stub `sendVerifyMergeEmail` closure in
   `apps/server/src/lib/bootstrap.ts` with a call to
   `email.sendTransactional(...)` using the new template id.
3. Smoke-test: trigger a collision, verify the email arrives.

## Rollback

If something is wrong, unset `OAUTH_CLIENT_SIGNING_SECRET` (or any of
the provider keys) on the affected server and restart. The
`/v1/auth/oauth-client/*` routes will un-register; the dashboard's
sign-in buttons will show "OAuth start failed" banner. Existing
password / magic-link sign-in continues unaffected.

## Related

- `docs/internal/2026-05-15-prod-wire-up-batch-report.md` — track-by-
  track status across the full Wave 1054+ ladder.
- `apps/server/src/services/oauth-client-service.ts` — service-impl
  with all 3 founder verdicts encoded.
- `apps/server/src/lib/oauth-client-providers.ts` — provider
  catalogue + buildAuthorizeUrl helper.
- `apps/server/src/db/migrations/0039_v667c_oauth_client_tables.sql`
  — schema.
