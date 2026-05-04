# Driftstack control plane — environment variables

> **Founder fills the values + base64-encodes** the resulting `.env` file
> into the GitHub repo secret `DEPLOY_DOTENV_BASE64`. The deploy
> pipeline (`.github/workflows/deploy.yml`) decodes it onto the
> Hetzner VM at `/opt/driftstack/.env`. No actual secrets land in this
> repo — examples below are placeholder shapes only.

**Effective:** 2026-05-03 · **Version:** 0.1.0-draft · **V-053**

This is the canonical schema for every env var the control plane
reads. When code adds a new env var, it lands here in the same
commit. Undocumented env-var sprawl is how production breaks two
months in.

## Conventions

- **Required** vars: server fails at startup if unset (Zod parse error).
- **Optional** vars: server uses a documented default if unset.
- **Per-environment** column: the same var may differ between
  staging and production (different DB URL, different Sentry env
  tag, etc.). Where the value is environment-independent (e.g. a
  Stripe webhook secret pinned to one Stripe account), the column
  reads "shared" — but **never** share secrets across environments
  unless they're tied to a single external resource.
- All values supplied via `.env` file at `/opt/driftstack/.env` on
  the Hetzner VM. The deploy pipeline writes this from
  `DEPLOY_DOTENV_BASE64`. Local dev uses `apps/server/.env`
  (gitignored).

## Variables

### Process / runtime

| Name        | Required | Per-env? | Example      | Notes                                                                                                                                           |
| ----------- | -------- | -------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`  | yes      | per-env  | `production` | One of `development \| test \| production`. Production deploys hardcode `production` in the Dockerfile env block; the .env override is unusual. |
| `PORT`      | optional | shared   | `7780`       | Default 3000 in dev; production compose pins 7780 to match the GUI client's expected default.                                                   |
| `HOST`      | optional | shared   | `0.0.0.0`    | Default `0.0.0.0`. Inside the container; the host binds `127.0.0.1:7780` so the bind value is irrelevant externally.                            |
| `LOG_LEVEL` | optional | per-env  | `info`       | `fatal \| error \| warn \| info \| debug \| trace`. Production: `info`. Staging: `debug`. Default `info`.                                       |
| `DRIVER`    | optional | per-env  | `mock`       | `mock \| webkit`. Pre-V1 staging + production both run `mock` until Agent 1's WebKit fork integrates.                                           |

### Postgres (Neon, EU Frankfurt)

| Name           | Required | Per-env? | Example                                                        | Notes                                                                                                                                                                                 |
| -------------- | -------- | -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | yes      | per-env  | `postgres://user:pass@<branch>.neon.tech/<db>?sslmode=require` | Neon connection string from the Neon dashboard. Staging + production are **separate Neon projects** (or separate branches of the same project), with separate databases. Never share. |

### Redis (Upstash, EU Frankfurt)

| Name        | Required | Per-env? | Example                                  | Notes                                                                                                 |
| ----------- | -------- | -------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `REDIS_URL` | yes      | per-env  | `rediss://default:<token>@<host>:<port>` | Upstash TLS-enabled URL (`rediss://`, not `redis://`). Staging + production are separate Upstash DBs. |

### Mock-driver tuning (test / dev only)

| Name                       | Required | Per-env? | Example | Notes                                                                                                          |
| -------------------------- | -------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `MOCK_NAVIGATE_LATENCY_MS` | optional | shared   | `120`   | Used by `MockDriver` to simulate navigate latency. Defaults to 120ms. Tests set to 0 via `fastForwardLatency`. |
| `MOCK_INTERACT_LATENCY_MS` | optional | shared   | `40`    | Same shape, interact path. Default 40ms.                                                                       |

### Slow-query log (Postgres observability)

| Name                          | Required | Per-env | Example | Notes                                                                                                                                                                                   |
| ----------------------------- | -------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLOW_QUERY_LOG_THRESHOLD_MS` | optional | per-env | `100`   | When set, postgres-js queries at or above this duration emit a warn-level structured `slow_query` log via `apps/server/src/lib/slow-query-log.ts`. Unset = disabled (default dev/test). |

### Cloudflare R2 (object storage, EU jurisdiction)

For session Recording uploads (V-040 in-memory ring → R2 mirror, lands
in Workstream A iteration 2).

| Name                   | Required           | Per-env? | Example                                      | Notes                                                                                                                     |
| ---------------------- | ------------------ | -------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `R2_ACCOUNT_ID`        | required at deploy | shared   | `<32 hex chars>`                             | Cloudflare account ID. One per BV; same across environments.                                                              |
| `R2_ACCESS_KEY_ID`     | required at deploy | per-env  | `<20 chars>`                                 | Generated per environment; staging + production get separate access keys with separate scoped tokens.                     |
| `R2_SECRET_ACCESS_KEY` | required at deploy | per-env  | `<40 chars>`                                 | Pair to `R2_ACCESS_KEY_ID`.                                                                                               |
| `R2_BUCKET_RECORDINGS` | required at deploy | per-env  | `driftstack-recordings-staging`              | Bucket names: `driftstack-recordings-staging` and `driftstack-recordings-production`. Pre-create in Cloudflare dashboard. |
| `R2_ENDPOINT_URL`      | optional           | shared   | `https://<account>.r2.cloudflarestorage.com` | Default derives from `R2_ACCOUNT_ID`. Override only if Cloudflare's URL convention shifts.                                |

### Postmark (transactional email, EU sending region)

For signup verification, password reset, billing receipts, support
correspondence (transactional email service, lands in Workstream A
iteration 2 + Workstream F).

| Name                 | Required           | Per-env? | Example                               | Notes                                                                                                               |
| -------------------- | ------------------ | -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `POSTMARK_API_TOKEN` | required at deploy | per-env  | `<UUID-shaped token>`                 | Postmark issues separate Server tokens per "Server" (their term). Staging + production = separate Postmark Servers. |
| `POSTMARK_FROM`      | required at deploy | shared   | `Driftstack <noreply@driftstack.dev>` | Verified sender address. DNS records (DKIM, Return-Path, Sender Signature) propagated per founder direction.        |
| `POSTMARK_REPLY_TO`  | optional           | shared   | `support@driftstack.dev`              | Customer replies route here.                                                                                        |

### Sentry (error tracking, EU region)

For diagnostics (V-058 SDK wiring + V-062 source-map upload).

**Runtime env vars** (live in `DEPLOY_DOTENV_BASE64`, read by the
running container):

| Name                        | Required           | Per-env? | Example                                                | Notes                                                                                                                                                                                          |
| --------------------------- | ------------------ | -------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`                | required at deploy | per-env  | `https://<key>@<org>.ingest.de.sentry.io/<project-id>` | EU region (`*.ingest.de.sentry.io`, not `.us.`). Staging + production map to **the same Sentry project** but different `SENTRY_ENVIRONMENT` tags.                                              |
| `SENTRY_ENVIRONMENT`        | optional           | per-env  | `production` / `staging`                               | Tagged on every event for filtering. Defaults to `NODE_ENV`.                                                                                                                                   |
| `SENTRY_RELEASE`            | optional           | per-env  | full git SHA                                           | **Baked into the Docker image** at build time via `--build-arg SENTRY_RELEASE=${{ github.sha }}` (per V-062); not in `DEPLOY_DOTENV_BASE64`. Matches the Sentry source-map release identifier. |
| `SENTRY_TRACES_SAMPLE_RATE` | optional           | per-env  | `0.1`                                                  | Default 0 (no APM traces). 0.1 in staging for tuning; production typically 0.01 to keep quota down.                                                                                            |

**Build-time / GH Actions secrets** (live in repository-level GitHub
secrets, NOT in `DEPLOY_DOTENV_BASE64` — used only by the deploy
workflow's source-map upload step):

| Name                | Required for source-map upload | Example          | Notes                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_AUTH_TOKEN` | optional (skipped if unset)    | `sntrys_…`       | Sentry auth token with `project:write` + `project:releases` scopes. Generated at <https://sentry.io> → Settings → Auth Tokens. If unset, the upload step is a no-op (runtime still works; stack traces will be minified on Sentry until populated). |
| `SENTRY_ORG`        | required if upload runs        | `driftstack`     | Sentry organization slug.                                                                                                                                                                                                                           |
| `SENTRY_PROJECT`    | required if upload runs        | `driftstack-api` | Sentry project slug for this service.                                                                                                                                                                                                               |

### Stripe (payment processing — fiat only at launch)

Per V-052: Stripe is the sole payment rail. Coinbase Commerce dropped.

| Name                           | Required           | Per-env? | Example                                          | Notes                                                                                                                                                                                                                                        |
| ------------------------------ | ------------------ | -------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_PUBLISHABLE_KEY`       | required at deploy | per-env  | `pk_test_<...>` / `pk_live_<...>`                | Test mode for staging + pre-KvK; live mode for production post-KvK. Stripe enforces the test-vs-live split server-side.                                                                                                                      |
| `STRIPE_SECRET_KEY`            | required at deploy | per-env  | `sk_test_<...>` / `sk_live_<...>`                | Same split. Live keys never enter chat / PR — written directly into Hetzner `.env` via SSH at production cutover.                                                                                                                            |
| `STRIPE_WEBHOOK_SECRET`        | required at deploy | per-env  | `whsec_<...>`                                    | Per-endpoint signing secret, populated after the webhook URL is registered with Stripe. Different per environment because webhook URLs differ (`/staging/webhooks/stripe` vs `/v1/webhooks/stripe`).                                         |
| `STRIPE_API_VERSION`           | optional           | shared   | `2025-11-15.basil`                               | Pinned Stripe API version sent on every outbound request as the `Stripe-Version` header. Omit to track Stripe's account-level default; pin when validating against a specific schema during integration testing.                             |
| `STRIPE_SUCCESS_URL`           | optional           | per-env  | `https://app.driftstack.dev/billing/success`     | Customer-portal redirect after a successful Checkout Session. Server falls back to a hardcoded staging URL when omitted.                                                                                                                     |
| `STRIPE_CANCEL_URL`            | optional           | per-env  | `https://app.driftstack.dev/billing/cancel`      | Customer-portal redirect on Checkout cancellation. Same fallback behavior as `STRIPE_SUCCESS_URL`.                                                                                                                                           |
| `STRIPE_PORTAL_RETURN_URL`     | optional           | per-env  | `https://app.driftstack.dev/billing`             | Stripe Billing Portal `return_url` — where the customer lands after closing the portal. Same fallback behavior.                                                                                                                              |
| `STRIPE_TRIAL_PACK_PRICE_ID`   | required at deploy | per-env  | `price_xxx`                                      | One-time price ID for the $2.99 trial pack (ADR-003). Distinct from `DRIFTSTACK_TIER_PRICE_IDS` because trial pack is one-time, not subscription. Founder creates in Stripe test mode (staging) + later live mode (production).              |
| `DRIFTSTACK_TIER_PRICE_IDS`    | required at deploy | per-env  | `{"starter":"price_xxx","solo":"price_xxx",...}` | JSON map of tier slug → Stripe price ID. SKU naming convention: `driftstack_<tier>_<period>` (e.g. `driftstack_starter_monthly`). Annual SKUs `_annual` later. Founder creates in Stripe test mode (staging) + later live mode (production). |
| `DRIFTSTACK_BYOK_METER_NAME`   | optional           | shared   | `driftstack_llm_tokens`                          | Meter event name for BYOK LLM token billing. Defaults to `driftstack_llm_tokens`. Stripe meter aggregates monthly.                                                                                                                           |
| `DRIFTSTACK_BYOK_MARKUP_RATIO` | optional           | shared   | `1.3`                                            | Multiplier on Anthropic published rates for bundled-LLM customers. Placeholder `1.3` until founder confirms. BYOK customers (own Anthropic key) skip metering entirely; detected via account flag.                                           |

### Anthropic (bundled-LLM AI agent — opt-in only)

Per V-046 / V-048: Anthropic is a conditional Sub-processor; engaged
only for customers who opt into bundled-LLM billing. BYOK customers
supply their own Anthropic key directly to the SDK and don't trigger
this path.

| Name                | Required           | Per-env? | Example        | Notes                                                                                                                                                                                                                                  |
| ------------------- | ------------------ | -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | required at deploy | per-env  | `sk-ant-<...>` | Driftstack's Anthropic key for the bundled-LLM path. Production-only at launch (bundled LLM is disabled in staging). Server fails to boot the bundled-LLM service if this is required at runtime + missing — gate with a feature flag. |

### Moneybird (accounting / invoicing)

Workstream E scoping doc + Workstream D implementation. Founder
holds the access token + administration ID.

| Name                          | Required           | Per-env? | Example          | Notes                                                                                                                          |
| ----------------------------- | ------------------ | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `MONEYBIRD_API_TOKEN`         | required at deploy | per-env  | `<bearer token>` | Moneybird personal access token (or OAuth2 token; OAuth2 recommended in scoping doc). Founder delivers at implementation time. |
| `MONEYBIRD_ADMINISTRATION_ID` | required at deploy | per-env  | `<numeric id>`   | One administration per BV. Staging may use a separate test administration; production uses the BV's production administration. |

### Legal / entity placeholders (post-KvK)

These are read into the legal documents at startup (V-047
LegalDocumentCatalog reads `docs/legal/*.md`) and the Privacy /
ToS / DPA placeholder substitution (founder's task post-KvK).

| Name                    | Required          | Per-env? | Example                         | Notes                                                                                                                    |
| ----------------------- | ----------------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `BV_LEGAL_NAME`         | required post-KvK | shared   | `Driftstack B.V.`               | Find-replaces `[BV LEGAL NAME]` in the legal documents at server startup. Pre-KvK: leave unset; placeholder text serves. |
| `BV_KVK_NUMBER`         | required post-KvK | shared   | `<8 digits>`                    | Find-replaces `[KvK NUMBER]`.                                                                                            |
| `BV_BTW_NUMBER`         | required post-KvK | shared   | `NL<9 digits>B<2 digits>`       | Find-replaces `[BTW NUMBER]`. Format: `NL` + 9 digits + `B` + 2 digits per Dutch BTW format.                             |
| `BV_REGISTERED_ADDRESS` | required post-KvK | shared   | `<street>, <postal> <city>, NL` | Find-replaces `[REGISTERED ADDRESS]`. Single-line format.                                                                |

The find-replace lands in V-046 follow-up work; founder direction is
to keep brackets in `docs/legal/*.md` and substitute at runtime, not
to commit values.

### Marketing site (Cloudflare Pages — build-time only)

The marketing site (`apps/marketing-site/`) is a static Astro build
deployed to Cloudflare Pages. These secrets live at the **repository
level** (not per-environment) since the marketing-site deploy runs
once per main-merge push, not per-environment. Skipped if
`CLOUDFLARE_API_TOKEN` is unset (the workflow no-ops with a console
message; runtime is unaffected because the site is static).

| Name                            | Type     | Required for deploy | Example                | Notes                                                                                                                                                                                                                      |
| ------------------------------- | -------- | ------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`          | secret   | optional            | `<api token>`          | Cloudflare API token with `Cloudflare Pages — Edit` permission. Generated at <https://dash.cloudflare.com> → My Profile → API Tokens. If unset, the deploy step is a no-op (build still runs, surfacing any Astro errors). |
| `CLOUDFLARE_ACCOUNT_ID`         | secret   | required if deploy  | `<32 hex chars>`       | Cloudflare account ID. Visible in any zone overview page in the CF dashboard.                                                                                                                                              |
| `CLOUDFLARE_PAGES_PROJECT_NAME` | variable | required if deploy  | `driftstack-marketing` | Cloudflare Pages project slug. Pre-create the project in the CF dashboard before the first deploy. Set as a **repository variable** (Settings → Variables, not Secrets) since it's not sensitive.                          |

Custom domains + DNS are configured in the Cloudflare Pages dashboard,
not by env / secrets:

- `driftstack.dev` — apex of the Pages project
- `www.driftstack.dev` — CNAME alias to the Pages project
- DNS records live in Cloudflare DNS for the `driftstack.dev` zone

### Customer dashboard (Cloudflare Pages — build-time only)

The customer dashboard (`apps/customer-dashboard/`, V-099) is an Astro static-build deployed to Cloudflare Pages at `app.driftstack.dev`. Mirror of the marketing-site deploy pattern. Both share the same Cloudflare account; the dashboard uses a **separate Pages project** so DNS + cache + analytics scope to it independently.

| Name                                      | Type     | Required for deploy   | Example                         | Notes                                                                                                                                                                                                             |
| ----------------------------------------- | -------- | --------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                    | secret   | shared with marketing | (same token as marketing)       | Same secret as marketing; the token's `Cloudflare Pages — Edit` permission covers all Pages projects in the account.                                                                                              |
| `CLOUDFLARE_ACCOUNT_ID`                   | secret   | shared                | (same as marketing)             | Same account.                                                                                                                                                                                                     |
| `CLOUDFLARE_PAGES_DASHBOARD_PROJECT_NAME` | variable | required if deploy    | `driftstack-customer-dashboard` | Pre-create the project in the CF dashboard before the first deploy. Set as a **repository variable**, not a secret.                                                                                               |
| `PUBLIC_API_BASE_URL`                     | variable | optional              | `https://api.driftstack.dev`    | Astro `import.meta.env.PUBLIC_API_BASE_URL` — the URL the dashboard's auth + data-fetch code points at. Defaults to `https://api.driftstack.dev` when unset. Override for staging (`api-staging.driftstack.dev`). |

The deploy workflow at `.github/workflows/deploy-customer-dashboard.yml` lands when the founder confirms the dashboard-stack proposal. Until then, the dashboard builds via `npm run build --workspace apps/customer-dashboard` but does not auto-deploy.

Custom domains + DNS:

- `app.driftstack.dev` — apex of the Pages project
- DNS records live in Cloudflare DNS for the `driftstack.dev` zone

### User-facing auth flow (V-079)

| Name                      | Required                 | Per-env? | Example                                          | Notes                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------ | -------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_VERIFY_EMAIL_URL`   | required at deploy       | per-env  | `https://app.driftstack.dev/auth/verify-email`   | Customer dashboard URL the signup-verification email links to. Plaintext token appended as `?token=<...>`. Default in dev: `http://localhost:5173/auth/verify-email`.                                                                              |
| `AUTH_MAGIC_LINK_URL`     | required at deploy       | per-env  | `https://app.driftstack.dev/auth/magic-link`     | Customer dashboard URL the magic-link email points at. Plaintext token appended as `?token=<...>`. Default in dev: `http://localhost:5173/auth/magic-link`.                                                                                        |
| `AUTH_PASSWORD_RESET_URL` | required at deploy       | per-env  | `https://app.driftstack.dev/auth/password-reset` | Customer dashboard URL the password-reset email points at. Plaintext token appended as `?token=<...>`. Default in dev: `http://localhost:5173/auth/password-reset`.                                                                                |
| `AUTH_EXPOSE_DEBUG_TOKEN` | optional (dev/test only) | per-env  | `true`                                           | When `true`, signup / magic-link / password-reset responses include the plaintext token as `debug_token`. Production MUST leave this `false` (default) — leaks the token via the response body, making integration tests cheap but auth dangerous. |

### Future Workstream slots (placeholder — not yet wired)

| Name                                      | Notes                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SIGNING_KEY_KID`                     | Per V-052 §4: control-plane signing key id (current). Rotation event format documented in `docs/network-architecture.md` §4.     |
| `FLEET_NODE_PUBLIC_KEY_CACHE_TTL_SECONDS` | Default 15. JWT validation cache TTL for `(node_id, public_key, revoked_at)` triples. See network-architecture.md §4 revocation. |

## Per-environment baseline

A minimum staging `.env` looks roughly like this (no actual values,
shapes only):

```
NODE_ENV=production
PORT=7780
LOG_LEVEL=info
DRIVER=mock

DATABASE_URL=postgres://...neon.tech/...
REDIS_URL=rediss://...upstash.io:...

R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_RECORDINGS=driftstack-recordings-staging

POSTMARK_API_TOKEN=...
POSTMARK_FROM=Driftstack <noreply@driftstack.dev>
POSTMARK_REPLY_TO=support@driftstack.dev

SENTRY_DSN=https://...ingest.de.sentry.io/...
SENTRY_ENVIRONMENT=staging
# SENTRY_RELEASE is baked into the image at build time; do not set
# here.

STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
DRIFTSTACK_TIER_PRICE_IDS={"starter":"price_xxx","solo":"price_xxx","builder":"price_xxx","scale":"price_xxx"}

# bundled LLM disabled in staging by default
# ANTHROPIC_API_KEY=

MONEYBIRD_API_TOKEN=...
MONEYBIRD_ADMINISTRATION_ID=...

AUTH_VERIFY_EMAIL_URL=https://app.driftstack.dev/auth/verify-email
AUTH_MAGIC_LINK_URL=https://app.driftstack.dev/auth/magic-link
AUTH_PASSWORD_RESET_URL=https://app.driftstack.dev/auth/password-reset
# AUTH_EXPOSE_DEBUG_TOKEN must remain unset in staging + production —
# only ever set to `true` in local dev / CI.
```

Production `.env` is structurally identical with environment-tagged
values (`SENTRY_ENVIRONMENT=production`, `R2_BUCKET_RECORDINGS=
driftstack-recordings-production`, etc.) and live-mode Stripe keys
post-KvK.

## How DEPLOY_DOTENV_BASE64 gets populated

Per founder direction (V-052 decision 2): values reviewed via the
GitHub UI (not `gh secret set`), one at a time. Founder workflow:

1. Compose the `.env` file locally per the schema above.
2. `base64 -i .env > .env.b64` (single-line base64 on macOS:
   `base64 -i .env | tr -d '\n' > .env.b64`).
3. Open repo settings → Environments → staging → Add secret →
   `DEPLOY_DOTENV_BASE64` → paste contents of `.env.b64`.
4. Repeat for production environment.

The deploy pipeline (`deploy.yml`) decodes it onto the Hetzner VM
at deploy time. Full round-trip stays on the founder's machine +
GitHub + Hetzner; no third-party secret store at this stage. When
secret count or rotation cadence justifies, migrate to HashiCorp
Vault / 1Password Connect / equivalent.

## Validation checklist

Before flipping `DEPLOY_DOTENV_BASE64` for the first time:

- [ ] `NODE_ENV=production` set explicitly (Dockerfile already
      hardcodes; .env override would be unusual).
- [ ] `DATABASE_URL` ends with `?sslmode=require` (Neon enforces TLS).
- [ ] `REDIS_URL` uses `rediss://` not `redis://` (Upstash TLS).
- [ ] `SENTRY_DSN` contains `.de.` for EU region.
- [ ] `STRIPE_PUBLISHABLE_KEY` matches the mode of `STRIPE_SECRET_KEY`
      (both `pk_test_` + `sk_test_` for staging; both `pk_live_` +
      `sk_live_` for production).
- [ ] `DRIFTSTACK_TIER_PRICE_IDS` JSON parses (server fails fast if
      not).
- [ ] `BV_*` placeholders left empty pre-KvK; the legal-doc
      placeholder substitution skips when unset.
- [ ] `SENTRY_AUTH_TOKEN` populated as a **repository-wide** GH
      secret (not an environment secret) so the deploy workflow's
      source-map upload step runs. If left unset, the upload step
      no-ops with a console message; runtime is unaffected.

## Updating this doc

Every PR that adds or removes a `process.env.X` read in
`apps/server/src/lib/config.ts` (or any other server-side env
read) lands here in the same commit. The CI build step verifies
that the `ConfigSchema` Zod object's required keys are documented
above — when it isn't (e.g. doc drift), CI fails.

CI verification not yet wired; lands in Workstream A iteration 2
when the Zod-config-vs-doc parity check is added as a unit test.
