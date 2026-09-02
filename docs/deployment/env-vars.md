# Driftstack control plane — environment variables

> **Founder provisions each environment through an SSH-only, root-owned
> mode-600 pending file.** After validation it is atomically installed as
> `/opt/driftstack/api/.env` with owner `driftstack:driftstack`; immutable
> `deploy-bridge.sh` promotions preserve that runtime file. No actual secrets
> land in this repo, chat, commit text, or command-line arguments — examples
> below are placeholder shapes only.

**Effective:** 2026-07-15 · **Version:** 1.0.0 · **V-053**

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
- All runtime values are supplied via `/opt/driftstack/api/.env` on the
  Hetzner VM. Staging and production have independent mode-600 files. Local
  development uses `apps/server/.env` (gitignored).

## Variables

### Process / runtime

| Name                     | Required | Per-env? | Example      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | -------- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`               | yes      | per-env  | `production` | One of `development \| test \| production`. The production systemd service requires `production`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DRIFTSTACK_DEPLOY_ENV`  | optional | per-env  | `staging`    | Exact deployment-role marker. Set to `staging` only on the staging control plane; production should leave it unset or use `production`. This marker is an authority boundary for explicitly staging-only behavior, including the agent-decomposer deployment-key fallback below.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PORT`                   | optional | shared   | `7780`       | Default 3000 in development; the production systemd unit and reverse proxy use 7780.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `HOST`                   | optional | shared   | `0.0.0.0`    | Default `0.0.0.0`; production ingress remains restricted by the host firewall and reverse proxy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `LOG_LEVEL`              | optional | per-env  | `info`       | `fatal \| error \| warn \| info \| debug \| trace`. Production: `info`. Staging: `debug`. Default `info`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `DRIVER`                 | optional | per-env  | `mock`       | `mock \| webkit \| playwright` (config.ts enum). Pre-V1 staging + production both run `mock` until Agent 1's WebKit fork integrates; `playwright` is the V-333b local real-browser path (with `PLAYWRIGHT_BROWSER`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SESSION_PROXY_REQUIRED` | optional | per-env  | `false`      | Fail-closed tri-state for the direct `POST /v1/sessions` and `POST /v1/profiles/:id/launch` surfaces. **Unset** → inferred from egress-backend presence. `true` (or inferred true) disables both direct create verbs for every body because they have no typed, consumed proxy authority; a raw `proxy` key is always rejected and cannot bypass this boundary. `false` keeps proxy-free direct creation available (the **current prod + staging posture**, set 2026-06-11). Customer-controlled egress uses `POST /v1/agent-sessions` with an owner-validated saved `proxy_id`. Do not enable this flag as a proxy-presence check; keep the direct surface closed until a reviewed transport consumes typed egress authority. |

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

For session recording uploads and retrieval.

| Name                   | Required           | Per-env? | Example                                      | Notes                                                                                                                     |
| ---------------------- | ------------------ | -------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `R2_ACCOUNT_ID`        | required at deploy | shared   | `<32 hex chars>`                             | Cloudflare account ID. One per BV; same across environments.                                                              |
| `R2_ACCESS_KEY_ID`     | required at deploy | per-env  | `<20 chars>`                                 | Generated per environment; staging + production get separate access keys with separate scoped tokens.                     |
| `R2_SECRET_ACCESS_KEY` | required at deploy | per-env  | `<40 chars>`                                 | Pair to `R2_ACCESS_KEY_ID`.                                                                                               |
| `R2_BUCKET_RECORDINGS` | required at deploy | per-env  | `driftstack-recordings-staging`              | Bucket names: `driftstack-recordings-staging` and `driftstack-recordings-production`. Pre-create in Cloudflare dashboard. |
| `R2_ENDPOINT_URL`      | optional           | shared   | `https://<account>.r2.cloudflarestorage.com` | Default derives from `R2_ACCOUNT_ID`. Override only if Cloudflare's URL convention shifts.                                |

### Postmark (transactional email, EU sending region)

For signup verification, password reset, billing receipts and support
correspondence.

| Name                 | Required           | Per-env? | Example                               | Notes                                                                                                               |
| -------------------- | ------------------ | -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `POSTMARK_API_TOKEN` | required at deploy | per-env  | `<UUID-shaped token>`                 | Postmark issues separate Server tokens per "Server" (their term). Staging + production = separate Postmark Servers. |
| `POSTMARK_FROM`      | required at deploy | shared   | `Driftstack <noreply@driftstack.dev>` | Verified sender address. DNS records (DKIM, Return-Path, Sender Signature) propagated per founder direction.        |
| `POSTMARK_REPLY_TO`  | optional           | shared   | `support@driftstack.dev`              | Customer replies route here.                                                                                        |

### Sentry (error tracking, EU region)

For diagnostics (V-058 SDK wiring + V-062 source-map upload).

**Runtime env vars** (live in `/opt/driftstack/api/.env`, read by the
systemd service):

| Name                        | Required           | Per-env? | Example                                                | Notes                                                                                                                                             |
| --------------------------- | ------------------ | -------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`                | required at deploy | per-env  | `https://<key>@<org>.ingest.de.sentry.io/<project-id>` | EU region (`*.ingest.de.sentry.io`, not `.us.`). Staging + production map to **the same Sentry project** but different `SENTRY_ENVIRONMENT` tags. |
| `SENTRY_ENVIRONMENT`        | optional           | per-env  | `production` / `staging`                               | Tagged on every event for filtering. Defaults to `NODE_ENV`.                                                                                      |
| `SENTRY_RELEASE`            | optional           | per-env  | full git SHA                                           | Release identifier used to match events to uploaded source maps. Keep it aligned with the exact immutable SHA being promoted.                     |
| `SENTRY_TRACES_SAMPLE_RATE` | optional           | per-env  | `0.1`                                                  | Default 0 (no APM traces). 0.1 in staging for tuning; production typically 0.01 to keep quota down.                                               |

**Build-time / GH Actions secrets** (live in repository-level GitHub
secrets and never in the runtime `.env`; used only by the source-map upload
step):

| Name                | Required for source-map upload | Example          | Notes                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_AUTH_TOKEN` | optional (skipped if unset)    | `sntrys_…`       | Sentry auth token with `project:write` + `project:releases` scopes. Generated at <https://sentry.io> → Settings → Auth Tokens. If unset, the upload step is a no-op (runtime still works; stack traces will be minified on Sentry until populated). |
| `SENTRY_ORG`        | required if upload runs        | `driftstack`     | Sentry organization slug.                                                                                                                                                                                                                           |
| `SENTRY_PROJECT`    | required if upload runs        | `driftstack-api` | Sentry project slug for this service.                                                                                                                                                                                                               |

### Stripe (payment processing — fiat only at launch)

Per V-052: Stripe is the sole payment rail. Coinbase Commerce dropped.

| Name                        | Required                         | Per-env? | Example                                                      | Notes                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | -------------------------------- | -------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_PUBLISHABLE_KEY`    | required when billing is enabled | per-env  | `pk_test_<...>` / `pk_live_<...>`                            | Test mode for staging + pre-launch production; live mode at commercial cutover. Stripe enforces the test-vs-live split server-side.                                                                                                                                                                                     |
| `STRIPE_SECRET_KEY`         | required when billing is enabled | per-env  | `sk_test_<...>` / `sk_live_<...>`                            | Wires the outbound Stripe billing provider together with `DRIFTSTACK_TIER_PRICE_IDS`. Live keys never enter chat / PR / shell arguments; install through the root-owned mode-600 pending-file procedure.                                                                                                                |
| `STRIPE_WEBHOOK_SECRET`     | required for Stripe webhooks     | per-env  | `whsec_<...>`                                                | Per-endpoint signing secret for `/v1/webhooks/stripe`, populated after that environment's full webhook URL is registered. It gates inbound signature verification independently of outbound billing.                                                                                                                    |
| `STRIPE_API_VERSION`        | optional                         | shared   | `2025-11-15.basil`                                           | Pinned Stripe API version sent on every outbound request as the `Stripe-Version` header. Omit to track Stripe's account-level default; pin when validating against a specific schema during integration testing.                                                                                                        |
| `STRIPE_SUCCESS_URL`        | optional                         | per-env  | `https://app.driftstack.dev/billing/success`                 | Customer-portal redirect after a successful Checkout Session. Server falls back to a hardcoded staging URL when omitted.                                                                                                                                                                                                |
| `STRIPE_CANCEL_URL`         | optional                         | per-env  | `https://app.driftstack.dev/billing/cancel`                  | Customer-portal redirect on Checkout cancellation. Same fallback behavior as `STRIPE_SUCCESS_URL`.                                                                                                                                                                                                                      |
| `STRIPE_PORTAL_RETURN_URL`  | optional                         | per-env  | `https://app.driftstack.dev/billing`                         | Stripe Billing Portal `return_url` — where the customer lands after closing the portal. Same fallback behavior.                                                                                                                                                                                                         |
| `DRIFTSTACK_TIER_PRICE_IDS` | required when billing is enabled | per-env  | `{"solo_manual":{"monthly":"price_…","annual":"price_…"},…}` | JSON map containing exactly the six self-serve paid tier ids (`solo_manual`, `team_manual`, `agency_manual`, `api_starter`, `api_builder`, `api_scale`), each with `monthly` and `annual` price IDs: six products / twelve recurring prices. The perpetual free tier has no Stripe price; Enterprise is sales-assisted. |

### Marketing site (Cloudflare Pages — build-time only)

The marketing site (`apps/marketing-site/`) is a static Astro build
deployed to Cloudflare Pages. These secrets live at the **repository
level** (not per-environment) since the marketing-site deploy runs
once per main-merge push, not per-environment. Skipped if
`CLOUDFLARE_API_TOKEN` is unset (the workflow no-ops with a console
message; runtime is unaffected because the site is static).

| Name                            | Type     | Required for deploy | Example                                        | Notes                                                                                                                                                                                                                                                         |
| ------------------------------- | -------- | ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`          | secret   | optional            | `<api token>`                                  | Cloudflare API token with `Cloudflare Pages — Edit` permission. Generated at <https://dash.cloudflare.com> → My Profile → API Tokens. If unset, the deploy step is a no-op (build still runs, surfacing any Astro errors).                                    |
| `CLOUDFLARE_ACCOUNT_ID`         | secret   | required if deploy  | `<32 hex chars>`                               | Cloudflare account ID. Visible in any zone overview page in the CF dashboard.                                                                                                                                                                                 |
| `CLOUDFLARE_PAGES_PROJECT_NAME` | variable | required if deploy  | `driftstack-marketing`                         | Cloudflare Pages project slug. Pre-create the project in the CF dashboard before the first deploy. Set as a **repository variable** (Settings → Variables, not Secrets) since it's not sensitive.                                                             |
| `PUBLIC_SENTRY_DSN_MARKETING`   | secret   | optional            | `https://<key>@<org>.ingest.de.sentry.io/<id>` | V-469 — `@sentry/astro` DSN baked into the marketing-site bundle at build time. When unset, the integration is fully skipped (zero bundle inclusion). Use a DSN distinct from the API project so marketing front-end errors don't pollute the backend stream. |
| `SENTRY_AUTH_TOKEN`             | secret   | optional            | `sntrys_…`                                     | Shared with the API deploy + customer-dashboard deploy. `project:write` + `project:releases` scopes. When unset, source-map upload skips silently; runtime is unaffected.                                                                                     |
| `SENTRY_ORG`                    | secret   | required if upload  | `driftstack`                                   | Shared with the API deploy.                                                                                                                                                                                                                                   |

Custom domains + DNS are configured in the Cloudflare Pages dashboard,
not by env / secrets:

- `driftstack.dev` — apex of the Pages project
- `www.driftstack.dev` — CNAME alias to the Pages project
- DNS records live in Cloudflare DNS for the `driftstack.dev` zone

### Customer dashboard (Cloudflare Pages — build-time only)

The customer dashboard (`apps/customer-dashboard/`, V-099) is an Astro static-build deployed to Cloudflare Pages at `app.driftstack.dev`. Mirror of the marketing-site deploy pattern. Both share the same Cloudflare account; the dashboard uses a **separate Pages project** so DNS + cache + analytics scope to it independently.

| Name                                      | Type     | Required for deploy   | Example                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | -------- | --------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                    | secret   | shared with marketing | (same token as marketing)                      | Same secret as marketing; the token's `Cloudflare Pages — Edit` permission covers all Pages projects in the account.                                                                                                                                                                                                                                                                                                                                                                                        |
| `CLOUDFLARE_ACCOUNT_ID`                   | secret   | shared                | (same as marketing)                            | Same account.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `CLOUDFLARE_PAGES_DASHBOARD_PROJECT_NAME` | variable | required if deploy    | `driftstack-customer-dashboard`                | Pre-create the project in the CF dashboard before the first deploy. Set as a **repository variable**, not a secret.                                                                                                                                                                                                                                                                                                                                                                                         |
| `PUBLIC_API_BASE_URL`                     | variable | **required for prod** | `https://api.driftstack.dev`                   | Astro `import.meta.env.PUBLIC_API_BASE_URL` — the public origin of the Driftstack API. Resolved via the shared `resolveApiBaseUrl()` helper (W192/W193) in both the customer-dashboard and the admin-panel. Dev mode falls back to `http://localhost:3000`; **production builds throw at evaluation time when this env var is unset** — same fail-fast pattern as `DASHBOARD_ORIGIN` (V-079.B). Trailing slashes are stripped at the helper layer. Override for staging (`https://staging.driftstack.dev`). |
| `PUBLIC_SENTRY_DSN_DASHBOARD`             | secret   | optional              | `https://<key>@<org>.ingest.de.sentry.io/<id>` | V-469 — `@sentry/astro` DSN baked into the dashboard bundle at build time. When unset, the integration is fully skipped (zero bundle inclusion). Distinct from the marketing + API DSNs so per-surface filtering stays clean.                                                                                                                                                                                                                                                                               |

`.github/workflows/deploy-customer-dashboard.yml` builds and publishes the
dashboard to its dedicated Cloudflare Pages project.

Custom domains + DNS:

- `app.driftstack.dev` — apex of the Pages project
- DNS records live in Cloudflare DNS for the `driftstack.dev` zone

### User-facing auth flow (V-079)

| Name                      | Required                 | Per-env? | Example                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------ | -------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DASHBOARD_ORIGIN`        | required at deploy       | per-env  | `https://app.driftstack.dev`                 | Customer dashboard origin. V-079.B: if you only set this, the three `AUTH_*_URL` env vars below are derived automatically as `${DASHBOARD_ORIGIN}/verify-email`, `…/auth/magic-link`, `…/reset-password` (paths match the customer-dashboard's actual file-based routes). Production refuses to boot if any resolved URL still contains `localhost`. W190: trailing slashes are stripped at the schema layer, so `https://app.driftstack.dev/` and `https://app.driftstack.dev` are equivalent — every consumer (billing URL templating, team invite URLs, Stripe defaults) receives the canonical no-trailing-slash form. |
| `AUTH_VERIFY_EMAIL_URL`   | optional                 | per-env  | `https://app.driftstack.dev/verify-email`    | Override for the signup-verification link. Set only if the dashboard route differs from the conventional `/verify-email` path. Link generation canonicalizes the page path to one trailing slash before appending the URL-encoded plaintext token as `?token=<...>`, avoiding a query-preserving static-host redirect. Dev default: `http://localhost:5173/verify-email`.                                                                                                                                                                                                                                                  |
| `AUTH_MAGIC_LINK_URL`     | optional                 | per-env  | `https://app.driftstack.dev/auth/magic-link` | Override for the magic-link URL. Same canonicalization and token-encoding behavior as `AUTH_VERIFY_EMAIL_URL`. Dev default: `http://localhost:5173/auth/magic-link`. The customer-dashboard serves the consume page at `/auth/magic-link.astro`; override only if you move the dashboard route.                                                                                                                                                                                                                                                                                                                            |
| `AUTH_PASSWORD_RESET_URL` | optional                 | per-env  | `https://app.driftstack.dev/reset-password`  | Override for the password-reset URL. Same canonicalization and token-encoding behavior as `AUTH_VERIFY_EMAIL_URL`. Dev default: `http://localhost:5173/reset-password`.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `AUTH_EXPOSE_DEBUG_TOKEN` | optional (dev/test only) | per-env  | `true`                                       | When `true`, signup / magic-link / password-reset responses include the plaintext token as `debug_token`. Production MUST leave this `false` (default) — leaks the token via the response body, making integration tests cheap but auth dangerous.                                                                                                                                                                                                                                                                                                                                                                         |

### Staff access (2026-05-19)

| Name                               | Required | Per-env? | Example                                                                                                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DRIFTSTACK_STAFF_EMAILS`          | optional | per-env  | `joeltheunissen89@gmail.com`                                                                                                                                | Comma-separated allowlist of account emails that get `driftstack_internal_admin` scope appended to their web-session synthetic api-key. Lets staff hit `/admin` via the same dashboard auth flow customers use, without minting a separate staff-only API key. Parsed once at boot (rotation requires a server restart). Whitespace + case normalized. Empty/unset → no bump (default). NEVER logged at info level; only the count is logged. See `apps/server/src/services/auth.ts:411-425`.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DRIFTSTACK_TASK_REFUSAL_PATTERNS` | optional | per-env  | `[{"id":"cred-1","category":"credential_theft","pattern":"steal (?:someone'?s )?password","reason":"Tasks involving credential theft are not permitted."}]` | file-06 §Safety guardrail #3: the curated abuse-pattern list (founder/AUP-authored, Tier-3) for the agent task-refusal start-gate. JSON array of `{ id, category, pattern, flags?, reason }`; `pattern` is a regex SOURCE matched against the NORMALIZED task (lowercase / NFKC-folded / single-spaced — write multi-word intent phrases, not bare words). Parsed once at boot. Unset/blank leaves the gate a **no-op** (the shipped default). Once set in production, the value must be a nonempty JSON array and every rule must compile and pass the ReDoS guard; otherwise boot refuses rather than silently serving with an empty/partial safety policy. Development/test retain skip-and-warn behavior for rule authoring. A match refuses the run before any LLM call. Mechanism: `apps/server/src/services/task-refusal.ts`; contract: `driftstack/docs/internal/task-refusal-contract.md`. |

### Customer-secret encryption (2026-05-20)

| Name                 | Required            | Per-env? | Example                                                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ------------------- | -------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MFA_ENCRYPTION_KEY` | optional (per-feat) | per-env  | base64 of 32 random bytes — `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` | AES-256-GCM master key for ALL customer-stored secrets. Decodes to exactly 32 bytes (AES-256); boot-time validation throws on wrong size. Activates these features when set: MFA TOTP secret storage (V-353), CLI/GUI device authorization (the minted API key is encrypted during its short Redis handoff), purpose/account/session-bound v2 agent-session transcript envelopes (boot authenticates existing v1/v2 ciphertext, synchronously CAS-converts every plaintext/v1 row in bounded batches, and refuses to serve until zero legacy rows remain), outbound-webhook signing-secret envelopes (legacy rows convert in bounded bootstrap batches), BYOK Anthropic key envelope (Q.1.d), gui*control_key auto-mint (24h-TTL), LiveKit per-Mac secret envelope (LK.2), saved-proxies storage (EG-API-1.6+). When unset, secret-bearing features fail closed through their existing omitted-route, 503 activation gate, or repository write refusal; none stores plaintext as a fallback. Naming kept `MFA*\*` for backwards compatibility — it predates BYOK. |

### Operational / optional (2026-05-27)

Read by the server but previously undocumented here. All optional with
documented defaults — none cause a startup failure if unset.

| Name                                        | Required | Per-env? | Example                                                     | Notes                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------- | -------- | -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CORS_ALLOWED_ORIGINS`                      | optional | per-env  | `https://app.driftstack.dev,https://staging.driftstack.dev` | Comma-separated allowlist of browser origins permitted to call the API. Unset → empty list (no cross-origin browser access). Already present in `infra/env-templates/{staging.env,production.env.template}`; this row documents it in the canonical spec. Read in `bootstrap.ts` → `app.ts` CORS config.                                                            |
| `NOWPAYMENTS_IPN_CALLBACK_URL`              | optional | per-env  | `https://api.driftstack.dev/v1/webhooks/nowpayments`        | Overrides the IPN (instant-payment-notification) callback URL Driftstack registers with NOWPayments for crypto-billing. Default `https://api.driftstack.dev/v1/webhooks/nowpayments`. **Confirm this points at the live API origin before crypto-billing goes LIVE.**                                                                                               |
| `BROADCAST_SLACK_WEBHOOK_URL`               | optional | per-env  | `https://hooks.slack.com/services/…`                        | Slack incoming-webhook URL for operational broadcast notifications. Unset → Slack broadcasts disabled (default null).                                                                                                                                                                                                                                               |
| `BROADCAST_GENERIC_WEBHOOK_URL`             | optional | per-env  | `https://ops.example.com/hook`                              | Generic (non-Slack) webhook URL for operational broadcast notifications. Unset → disabled (default null).                                                                                                                                                                                                                                                           |
| `PUBLIC_STATUS_PAGE_URL`                    | optional | shared   | `https://status.driftstack.dev`                             | Base URL of the public status page, embedded in status-subscription + incident emails. Default `https://status.driftstack.dev`.                                                                                                                                                                                                                                     |
| `DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS` | optional | per-env  | `1`                                                         | Set to `1` to suppress the periodic API-key / webhook-secret / BYOK-key rotation-reminder emails (e.g. during a migration window). Any other value / unset → reminders enabled (default).                                                                                                                                                                           |
| `DRIFTSTACK_AGENT_DECOMPOSER_USE_FALLBACK`  | optional | staging  | `true`                                                      | Staging demo escape hatch: exact `true` lets an unconfigured customer use the deployment Anthropic key after the BYOK and consented bundled-LLM legs are absent. **Never enable in production.** When `NODE_ENV=production`, boot refuses this flag unless `DRIFTSTACK_DEPLOY_ENV=staging`. Unset or any value other than exact `true` keeps the fallback disabled. |

### Runtime ceilings + sweeper tuning (2026-08-14)

Read by the server and previously undocumented. Every one is optional with a
documented default; none causes a startup failure if unset. They are grouped
here because they share a purpose: each bounds how much one account can consume,
or how long the server waits before reclaiming something. Those are the dials an
operator reaches for during an incident, and an operator cannot tune a dial they
cannot find.

| Name                                                  | Required | Per-env? | Example                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | -------- | -------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB_STATEMENT_TIMEOUT_MS`                             | optional | per-env  | `30000`                                     | Cancels any single query on the app-path pool that exceeds this, so a runaway query (bad plan, lock wait, missing index) cannot hold one of the pool's 10 slots indefinitely and starve the rest. **OFF by default** — no behaviour change until set, mirroring `SLOW_QUERY_LOG_THRESHOLD_MS`. Migrations are exempt: `migrate.ts` uses its own `max: 1` client, so long DDL is never cancelled. Set it well above normal query time so it only ever catches true runaways. |
| `AGENT_RELAY_MAX_ACCOUNT_INFLIGHT`                    | optional | shared   | `16`                                        | Per-account ceiling on CONCURRENT in-flight control-relay requests (cookies/set, history, downloads list + content). Those routes carry only the `global` rate limiter and no concurrency limiter, so this is the bound. Default 16.                                                                                                                                                                                                                                        |
| `AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES`             | optional | shared   | `536870912`                                 | Per-account cap on concurrent in-flight upload VOLUME for `POST /v1/agent-sessions/:id/files`, independent of the 64 MiB per-file cap. Stops one account flooding the box's upload jail with many large simultaneous uploads. Default 512 MiB.                                                                                                                                                                                                                              |
| `AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_COUNT`             | optional | shared   | `4`                                         | Per-account cap on the COUNT of concurrent uploads, alongside the byte cap above. Default 4.                                                                                                                                                                                                                                                                                                                                                                                |
| `AGENT_TURN_MAX_ACCOUNT_INFLIGHT`                     | optional | shared   | `3`                                         | Maximum concurrent AI turns for one owner account across distinct agent sessions, whatever the key path (BYOK, bundled, deterministic). Manual transcript-only turns bypass it. Default 3.                                                                                                                                                                                                                                                                                  |
| `BUNDLED_TURN_MAX_CONCURRENCY`                        | optional | shared   | `3`                                         | Per-account ceiling on concurrent bundled-LLM turns. This is a **billing-integrity** control, not just load: the soft-cap gate is read-then-act (the cost row lands after the turn), so N concurrent turns can all read the same pre-increment spend and overshoot the cap. Bounding N caps the overshoot at (N-1) turns. Only consulted when the bundled-LLM leg is wired. Default 3.                                                                                      |
| `DRIFTSTACK_AGENT_SESSION_MAX_LIFETIME_HOURS`         | optional | per-env  | `12`                                        | Absolute lifetime cap the orphan sweeper applies to agent sessions, measured from `created_at` (deliberately NOT `updated_at`, so a chatty session that keeps appending transcript is still capped). Default 12.                                                                                                                                                                                                                                                            |
| `DRIFTSTACK_AGENT_SESSION_PAGE_STATE_MAX_AGE_SECONDS` | optional | per-env  | `120`                                       | How long a cached page-state snapshot stays fresh before it is re-read. Default 120. A non-finite or non-positive value falls back to the default.                                                                                                                                                                                                                                                                                                                          |
| `DRIFTSTACK_WORKER_DISCONNECT_GRACE_SECONDS`          | optional | per-env  | `120`                                       | How long a disconnected worker's sessions survive before the reaper closes them; a reconnect inside the window cancels the timer. Default 120. A non-finite or non-positive override falls back to the default **by design**, so a fat-fingered value can never disable the grace (a blip would close live sessions) nor set it to 0.                                                                                                                                       |
| `DRIFTSTACK_PROXY_PRELAUNCH_PROBE`                    | optional | per-env  | `0`                                         | Set to `0` or `false` to disable the pre-launch proxy reachability probe if it ever false-negatives a working proxy. Any other value, or unset, leaves the probe enabled.                                                                                                                                                                                                                                                                                                   |
| `DRIFTSTACK_PROXY_PROBE_TIMEOUT_MS`                   | optional | per-env  | `8000`                                      | Overall probe deadline covering dial, handshake and egress round-trip. Tunable so the budget can be widened for slow residential or mobile proxies without a code change. Unset → the built-in budget.                                                                                                                                                                                                                                                                      |
| `DRIFTSTACK_PROXY_PROBE_TARGET_URL`                   | optional | per-env  | `https://api.driftstack.dev/v1/egress/echo` | Overrides the neutral egress target the proxy probe dials. Default `https://api.driftstack.dev/v1/egress/echo` (`DEFAULT_PROBE_TARGET_URL` in `apps/server/src/services/proxy-connectivity-probe.ts`).                                                                                                                                                                                                                                                                      |
| `DRIFTSTACK_OWNER_EMAIL`                              | optional | per-env  | `ops@example.com`                           | Designates the account admitted by the `requireOwner` gate — the owner-only admin surface (`/v1/admin/owner/*`). Defaults to the founder account seeded at bootstrap, so a NEW deployment that does not set this has its owner routes bound to that seeded identity rather than to the operator standing up the environment. Set it deliberately per environment.                                                                                                           |
| `APP_VERSION`                                         | optional | per-env  | `1.4.0`                                     | Build version reported by `/version` and used as the Sentry release tag when `SENTRY_RELEASE` is unset. Falls back to `npm_package_version`, then the literal `unknown`.                                                                                                                                                                                                                                                                                                    |

### Local development + test only (2026-08-14)

Read by the server or its seed scripts, but never part of a deployed
environment file. Listed so the roster is complete rather than because
production should set them.

| Name                                | Required | Per-env? | Example         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | -------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PLAYWRIGHT_HEADED`                 | optional | local    | `1`             | Runs the `playwright` driver headed instead of headless. Local real-browser debugging only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `DRIFTSTACK_AGENT_DECOMPOSER_FORCE` | optional | local    | `deterministic` | Forces the deterministic agent decomposer regardless of key configuration. Exact value `deterministic`; anything else is ignored. Test/dev seam — see `DRIFTSTACK_AGENT_DECOMPOSER_USE_FALLBACK` above for the staging escape hatch, which is a different control.                                                                                                                                                                                                                                                                                                                   |
| `FLEET_NODE_DISPLAY_NAME`           | optional | local    | `local-mac-dev` | Read only by `apps/server/src/scripts/seed-local-fleet-node.ts` when seeding a fleet node for local development. Default `local-mac-dev`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `FLEET_NODE_HARDWARE_CLASS`         | optional | local    | `mac-dev`       | Same seed script. Default `mac-dev`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `FLEET_NODE_REGION`                 | optional | local    | `local`         | Same seed script. Default `local`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DEFAULT_EGRESS_HOST`               | optional | per-env  | `203.0.113.10`  | Operator-default egress host for a session created with no `proxy_id`. **Unset is valid and deliberate:** with no default the assign carries no proxy and a `REQUIRE_PROXY=1` fleet node refuses it by name (`no_proxy_configured`) rather than routing into a dead address. Lives in env because the previous SOURCE constant (`127.0.0.1:1080`, a local fleet-demo value) became the live production default and pointed every default session at a loopback nothing listens on — presenting to customers as an unexplained freeze. Requires `DEFAULT_EGRESS_PORT` to take effect. |
| `DEFAULT_EGRESS_PORT`               | optional | per-env  | `1080`          | Port for `DEFAULT_EGRESS_HOST`. Both must be set; a host without a port is treated as no default rather than having a port invented for it.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `DEFAULT_EGRESS_USERNAME`           | optional | per-env  | `user`          | SOCKS5 username, only if the default egress authenticates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `DEFAULT_EGRESS_PASSWORD`           | optional | per-env  | `REDACTED`      | SOCKS5 password, only if the default egress authenticates. Secret — never commit a real value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Per-environment baseline

A minimum staging `.env` looks roughly like this (no actual values,
shapes only):

```
NODE_ENV=production
PORT=7780
LOG_LEVEL=info
DRIVER=mock
# W632 — egress safeguard relaxed until SOCKS5 egress is GA (else every
# proxyless session-create, incl. onboarding, 400s). Remove when GA.
SESSION_PROXY_REQUIRED=false

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
# SENTRY_RELEASE may be set to the exact immutable Git SHA when source maps
# are uploaded for the deployment.

STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
DRIFTSTACK_TIER_PRICE_IDS={"solo_manual":{"monthly":"price_…","annual":"price_…"},"team_manual":{"monthly":"price_…","annual":"price_…"},"agency_manual":{"monthly":"price_…","annual":"price_…"},"api_starter":{"monthly":"price_…","annual":"price_…"},"api_builder":{"monthly":"price_…","annual":"price_…"},"api_scale":{"monthly":"price_…","annual":"price_…"}}

DASHBOARD_ORIGIN=https://app.driftstack.dev
# V-079.B/C: the three AUTH_*_URL vars below are derived from
# DASHBOARD_ORIGIN automatically using the customer-dashboard's
# real file-based routes. Override only if your dashboard routes
# differ.
# AUTH_VERIFY_EMAIL_URL=https://app.driftstack.dev/verify-email
# AUTH_MAGIC_LINK_URL=https://app.driftstack.dev/auth/magic-link
# AUTH_PASSWORD_RESET_URL=https://app.driftstack.dev/reset-password
# AUTH_EXPOSE_DEBUG_TOKEN must remain unset in staging + production —
# only ever set to `true` in local dev / CI. Production boot refuses it.
```

Production `.env` is structurally identical with environment-tagged
values (`SENTRY_ENVIRONMENT=production`, `R2_BUCKET_RECORDINGS=
driftstack-recordings-production`, etc.) and the explicitly selected Stripe
mode.

## How the production runtime file gets populated

Use the established no-output pending-file procedure independently for staging
and production:

1. Compose the complete file locally from this schema in a temporary file with
   mode `600`; never include values in chat, commits, or command-line arguments.
2. Transfer it over SSH/SFTP to a root-owned mode-600 pending path on the target
   host and validate every required value before changing the live file.
3. Preserve a root-only recovery copy, atomically install the reviewed file at
   `/opt/driftstack/api/.env`, then set owner `driftstack:driftstack` and mode
   `600`. Delete the pending file after the activation succeeds.
4. Promote one reviewed full Git SHA with
   `DEPLOY_VIA_BUNDLE=1 scripts/deploy-bridge.sh <staging|prod> <full-sha>`, run
   `post-deploy-verify.mjs`, and confirm `deploy-status.sh --check`.

The immutable deploy bridge updates only generated deployment markers in the
runtime file; it does not source secrets from GitHub or print them.

## Validation checklist

Before atomically installing or rotating a runtime file:

- [ ] `NODE_ENV=production` set explicitly for the systemd service.
- [ ] `DATABASE_URL` ends with `?sslmode=require` (Neon enforces TLS).
- [ ] `REDIS_URL` uses `rediss://` not `redis://` (Upstash TLS).
- [ ] `SENTRY_DSN` contains `.de.` for EU region.
- [ ] `STRIPE_PUBLISHABLE_KEY` matches the mode of `STRIPE_SECRET_KEY`
      (both `pk_test_` + `sk_test_` for staging; both `pk_live_` +
      `sk_live_` for production).
- [ ] `DRIFTSTACK_TIER_PRICE_IDS` JSON parses (server fails fast if
      not).
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

CI content guards verify that the documented runtime contract stays aligned with
the configuration and bootstrap wiring.
