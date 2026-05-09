# Driftstack API — infra/

V-278 Hetzner deployment artifacts.

## Layout

```
infra/
├── bootstrap/
│   └── bootstrap.sh                Run-once host bootstrap (Ubuntu 24.04)
├── env-templates/
│   ├── production.env.template     production .env shape (REDACTED secrets)
│   └── staging.env.template        staging .env shape
├── nginx/
│   ├── api.driftstack.dev.conf     production API vhost (port 80, behind CF proxy)
│   └── staging.driftstack.dev.conf staging API vhost
├── systemd/
│   └── driftstack-api.service      systemd unit, runs as `driftstack` user
└── hetzner/
    └── docker-compose.yml          legacy compose model (superseded by V-278 systemd)
```

## V-278 deployment cycle

| Slice   | What                                                                                 |
| ------- | ------------------------------------------------------------------------------------ |
| V-278.A | Bootstrap both servers via `bootstrap/bootstrap.sh production` (or `staging`).       |
| V-278.B | Deploy api.driftstack.dev → production (systemd-managed Node service + nginx vhost). |
| V-278.C | Deploy app.driftstack.dev → production (customer dashboard built with Astro).        |
| V-278.D | Deploy docs.driftstack.dev (production server OR Cloudflare Pages).                  |
| V-278.E | Deploy driftstack.dev root (production server OR Cloudflare Pages).                  |
| V-278.F | Deploy staging.driftstack.dev → staging server.                                      |
| V-278.G | Run migrations on Neon Postgres (`drizzle-kit migrate`).                             |
| V-278.H | DNS records via Cloudflare API.                                                      |
| V-278.I | Smoke-test all public URLs.                                                          |
| V-278.J | Sentry per-service DSN wiring + verification.                                        |
| V-278.K | Post-launch — split Neon + Upstash into separate prod/staging projects.              |
| V-278.L | Post-launch — create dedicated Sentry projects for dashboard + marketing.            |

## TLS strategy

Cloudflare proxied + Universal SSL (publicly-trusted, auto-issued,
auto-renewed). Origin nginx serves plaintext HTTP on port 80; the
Cloudflare zone is configured for "Full (strict)" SSL/TLS. No
certbot / Let's Encrypt at the origin layer for v1.0.

## Sub-processor map

The `.env` files reference only credentials for sub-processors enumerated
in [DPA Annex 3](../apps/marketing-site/src/pages/legal/dpa.astro):

- **Hetzner Cloud** (Nuremberg NBG1 / Falkenstein FSN1) — VM compute.
- **Neon** (Frankfurt eu-central-1) — managed Postgres 17.
- **Upstash** (eu-central) — managed Redis 7.
- **Cloudflare** (global, EU-jurisdiction R2) — DNS / CDN / R2 / WAF.
- **Postmark** (US) — transactional email; sender domain DKIM-verified.
- **Sentry** (DE / EU region) — error tracking + release tracking.
- **Stripe** (US, EU subsidiary for SCA) — payment processing.

`scripts/check-subprocessor-mirror.mjs` enforces public ↔ DPA Annex 3
sync; CI fails when env templates introduce a new sub-processor without
the matching DPA + sub-processors.json update.

## Credential handling

- **TEST-mode secrets** (Stripe `sk_test_`, Postmark dev tokens) may be
  committed via base64 in `DEPLOY_DOTENV_BASE64` GitHub secret.
- **LIVE-mode secrets** (Stripe `sk_live_`, post-KvK) are written via
  SSH directly to `/opt/driftstack/api/.env` on the host. They never
  pass through the agent's chat history or pull-request artifacts. See
  [memory: Stripe credential handling](../docs/internal/credential-handling.md).
