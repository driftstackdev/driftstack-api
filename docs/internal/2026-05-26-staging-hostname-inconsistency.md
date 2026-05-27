# 2026-05-26 — staging hostname inconsistency (partial fix shipped, rest needs verification)

The docs refer to the **staging API** by three different hostnames. The
nginx-served canonical is `api.staging.driftstack.dev` (dotted) per
`infra/nginx/staging.driftstack.dev.conf`: `server_name staging.driftstack.dev
api.staging.driftstack.dev` + the LE cert covers exactly those two. Anything
else either won't resolve or fails the cert/server_name match.

## Fixed (commit 3cf9e147)

`api-staging.driftstack.dev` (hyphenated) → `api.staging.driftstack.dev` in
the 3 SDK quickstarts' staging-override examples + `env-vars.md` + `stripe-
webhook-testing.md`. These were unambiguously wrong (nginx-contradicted).

## Still inconsistent — needs your verification (NOT auto-fixed)

1. **`staging-api.driftstack.dev`** (reversed form) appears in:
   - `apps/marketing-site/src/pages/docs/cli-quickstart.astro:109`
     (`--base-url https://staging-api.driftstack.dev`) — if the CLI hits the
     same nginx API, this should be `api.staging.driftstack.dev`. BUT the CLI
     (`@driftstack/cli`) is published externally; I can't confirm its staging
     ingress from this repo.
   - `docs/deployment/dr-runbook.md:541` + `docs/verification-log.md:23101`
     — DR-DNS-failover context; may be a deliberate separate DR alias.
     **Verify:** is `staging-api.driftstack.dev` a real DNS record / CLI
     ingress, or a third typo for `api.staging.driftstack.dev`? If the latter,
     fix cli-quickstart (the DR runbook is its own call; don't rewrite a DR
     procedure on a guess).

2. **`app-staging.driftstack.dev`** (staging _dashboard_) appears in
   `docs/operations/production-env-schema.md:52,54` (as the actual
   `DASHBOARD_ORIGIN` + `AUTH_VERIFY_EMAIL_URL` values) and the gui-client
   Tauri cli/authorize allowlist (`verification-log:15291`). The customer
   dashboard is **Cloudflare Pages** (not nginx), so its custom domain is
   set in CF, not this repo. Used consistently as `app-staging` — so this is
   **probably correct** (CF Pages staging custom domain), NOT a typo. Left
   as-is. **Verify** the CF Pages staging custom domain matches if touching.

**Why not auto-fixed:** the API host is repo-verifiable (nginx) and was
fixed; the dashboard (CF Pages) + DR-DNS hosts live in external config, and
guessing risks introducing a wrong canonical form (cf. the same-session
pagination/env-vars over-assertion lesson — don't assert a single value the
repo can't confirm). A quick "what are the real staging DNS names?" check
resolves all of this.
