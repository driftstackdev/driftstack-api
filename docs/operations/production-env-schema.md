# Production environment schema (operations summary)

Provisioning-order summary of every env var the production / staging Hetzner VM needs in `/opt/driftstack/.env`. Sourced from `DEPLOY_DOTENV_BASE64` per `.github/workflows/deploy.yml` + `.github/workflows/server-deploy.yml`.

The longer per-variable spec (defaults, allowed values, behaviour-on-absent) lives in `docs/deployment/env-vars.md`. This doc is the operations cheat sheet — what to set up first, what comes next, what's optional.

## Variable groups, in provisioning order

### 1. Process / runtime — set these first

Required at startup; server fails fast if missing or malformed.

```
NODE_ENV=production
PORT=7780
HOST=0.0.0.0
LOG_LEVEL=info
```

### 2. Database (Neon, EU region)

Provisioned per `docs/founder-action-queue.md` Neon entry.

```
DATABASE_URL=postgres://<user>:<pwd>@<host>.neon.tech/driftstack-production?sslmode=require
```

Two databases: `driftstack-staging` + `driftstack-production`. Use Neon branches OR separate projects per ADR-001 preference.

### 3. Redis (Upstash, EU region)

```
REDIS_URL=rediss://default:<pwd>@<host>.upstash.io:<port>
```

### 4. Auth-flow URLs

The deep-links emailed to users land on the customer-dashboard origin. For production:

```
AUTH_VERIFY_EMAIL_URL=https://app.driftstack.dev/auth/verify-email
AUTH_MAGIC_LINK_URL=https://app.driftstack.dev/auth/magic-link
AUTH_PASSWORD_RESET_URL=https://app.driftstack.dev/auth/password-reset
DASHBOARD_ORIGIN=https://app.driftstack.dev
```

`DASHBOARD_ORIGIN` is the V-266 browser-OAuth flow's launch surface — the GUI client opens `${DASHBOARD_ORIGIN}/cli/authorize?code=…`.

For staging:

```
DASHBOARD_ORIGIN=https://staging.driftstack-customer-dashboard.pages.dev
```

Leave the three `AUTH_*_URL` overrides unset unless a route genuinely differs;
the server derives the staging verify-email, magic-link, and password-reset URLs
from `DASHBOARD_ORIGIN`. The former `app-staging.driftstack.dev` placeholder has
no DNS record and must not be used unless that custom domain is deliberately
provisioned and passes DNS, TLS, browser, and GUI capability acceptance first.

`AUTH_EXPOSE_DEBUG_TOKEN` MUST stay unset / false in production. Local dev only.

### 5. Email (Postmark)

```
POSTMARK_API_TOKEN=<server-token>
POSTMARK_FROM=Driftstack <noreply@driftstack.dev>
POSTMARK_REPLY_TO=support@driftstack.dev
```

When unset, email sends are no-ops (tests log a warning + skip). Production MUST have these set or signup / verify-email / magic-link / password-reset flows are silently broken from the customer's perspective.

### 6. R2 (Cloudflare object storage)

For session recordings + screenshots.

```
R2_ACCOUNT_ID=<32-hex-chars>
R2_ACCESS_KEY_ID=<rw-key-id>
R2_SECRET_ACCESS_KEY=<rw-secret>
R2_BUCKET_RECORDINGS=driftstack-recordings-prod
R2_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com
```

Two buckets: `driftstack-recordings-prod` + `driftstack-recordings-staging`. R2 supports per-bucket access keys; create one rw-key per environment + paste each into the matching environment's secrets.

### 7. Sentry (observability)

```
SENTRY_DSN=https://<key>@<org>.ingest.de.sentry.io/<project-id>
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=<gitsha>
```

EU ingest region. `SENTRY_RELEASE` is set by the deploy workflow at build time; not in the .env file directly.

### 8. Stripe (billing)

```
STRIPE_SECRET_KEY=sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…
DRIFTSTACK_TIER_PRICE_IDS=trial_pack:price_…|solo_manual:price_… …  # 19 IDs per ADR-004
STRIPE_TRIAL_PACK_PRICE_ID=price_…
STRIPE_SUCCESS_URL=https://app.driftstack.dev/billing/success
STRIPE_CANCEL_URL=https://app.driftstack.dev/billing/cancel
STRIPE_PORTAL_RETURN_URL=https://app.driftstack.dev/billing
```

**Live-mode keys**: per the `stripe_credential_handling` rule, live `sk_live_…` keys go via SSH-write to Hetzner only — never via `gh secret set` from a chat-readable terminal, never in a PR description. Test-mode keys (`sk_test_…`) for staging are fine in `DEPLOY_DOTENV_BASE64`.

When `STRIPE_SECRET_KEY` + `DRIFTSTACK_TIER_PRICE_IDS` + `STRIPE_TRIAL_PACK_PRICE_ID` are all set, the BillingService wires; `/v1/billing/*` routes register; webhook endpoint validates signatures. When any is unset, the routes don't register (pre-launch state) and the bootstrap log emits a `BillingService NOT wired` warning.

### 9. Driver (production WebKit fork integration)

```
DRIVER=webkit
```

Pre-launch / dev: `DRIVER=mock`. Production: `DRIVER=webkit` once the WebKit-fork driver is wired (cross-repo dep on Agent 1's bridge).

## What's NOT in production .env

- **`AUTH_EXPOSE_DEBUG_TOKEN`** — dev/test only. Production servers rely on real email delivery for the verification token.
- **Local-dev convenience vars** — `MOCK_NAVIGATE_LATENCY_MS`, etc. Mock driver only.
- **Internal admin secrets** — admin routes are gated by Cloudflare Access SSO at the origin level (V-135), not by env-var.

## Sub-processor → env-var crosswalk

For audit + DPA-Annex-3-correctness:

| Sub-processor (DPA Annex 3 / data/sub-processors.ts) | Env vars                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Hetzner Online GmbH                                  | (host-level, not env-var)                                              |
| Neon, Inc.                                           | `DATABASE_URL`                                                         |
| Upstash, Inc.                                        | `REDIS_URL`                                                            |
| Cloudflare, Inc. (R2 + Pages)                        | `R2_*` (R2); CF Pages handled separately by deploy workflows           |
| Postmark (ActiveCampaign LLC)                        | `POSTMARK_*`                                                           |
| Sentry (Functional Software, Inc.)                   | `SENTRY_*`                                                             |
| Stripe Payments Europe Ltd / Stripe, Inc.            | `STRIPE_*` + `DRIFTSTACK_TIER_PRICE_IDS`                               |
| Anthropic, PBC (conditional, opt-in only)            | (set by per-account BYOK config; not in process .env)                  |
| Moneybird B.V.                                       | (out-of-process; founder-side accounting integration, not server-side) |
| MacStadium, Inc.                                     | (host-level for the Mac fleet, not the control-plane VM)               |

## Sequence summary

When provisioning a fresh production environment from zero, the order:

1. Hetzner VMs (V-278 founder runbook).
2. Neon DB → `DATABASE_URL`.
3. Upstash Redis → `REDIS_URL`.
4. Cloudflare DNS for `api.driftstack.dev` + `staging.driftstack.dev` → the production and staging API ingress.
5. Cloudflare R2 buckets → `R2_*`.
6. Postmark → `POSTMARK_*`.
7. Sentry → `SENTRY_*`.
8. Stripe live-mode + price IDs → `STRIPE_*` + `DRIFTSTACK_TIER_PRICE_IDS` (post-BV-KvK closure).
9. WebKit-fork driver → `DRIVER=webkit` (post-Agent-1 bridge integration).

Each step independently — partial completion lets the server bootstrap with reduced functionality. Bootstrap log clearly states which integrations are wired vs which are NOT-wired.

## Related docs

- `docs/deployment/env-vars.md` — full per-variable spec.
- `docs/founder-actions/v278-hetzner-deploy-keys.md` — Hetzner provisioning + secrets runbook.
- `docs/adr/ADR-001-control-plane-hosting-hetzner.md` — hosting decision.
- `docs/deployment/runbook.md` — day-to-day operations.
- `docs/deployment/dr-runbook.md` — disaster recovery.
