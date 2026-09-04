# Driftstack API — infra/

V-278 Hetzner deployment artifacts.

## Layout

```
infra/
├── bootstrap/
│   ├── bootstrap.sh                Run-once host bootstrap (Ubuntu 24.04)
│   └── deploy-api.sh               Deploy the Fastify API to a host (V-278.B)
├── env-templates/
│   ├── production.env.template     production .env shape (REDACTED secrets)
│   └── staging.env.template        staging .env shape
├── nginx/
│   ├── api.driftstack.dev.conf     production API vhost (port 80, behind CF proxy)
│   ├── staging.driftstack.dev.conf staging API vhost
│   ├── fleet.driftstack.dev.conf   DIRECT (grey-cloud, NOT CF) fleet-node control WS vhost
│   └── ws_upgrade_map.conf         $connection_upgrade map (→ /etc/nginx/conf.d/), used by fleet
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
| V-278.C | Deploy app.driftstack.io → production (customer dashboard built with Astro).         |
| V-278.D | Deploy docs.driftstack.io (production server OR Cloudflare Pages).                   |
| V-278.E | Deploy driftstack.io root (production server OR Cloudflare Pages).                   |
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

### `fleet.driftstack.dev` exception (grey-cloud, direct origin TLS)

`api.driftstack.dev` is Cloudflare-proxied, and CF mangles the long-lived
fleet-node **control WebSocket** (`/v1/fleet/events`) — it drops it (Code=57) and
botches the reconnect handshake (-1011), which flaps the Mac-worker control link
and breaks session dispatch (cookies/upload/End-session, ~1-min page loads; bus
W2863, fixed 2026-06-24). So the workers connect to a **DNS-only / grey-cloud**
subdomain `fleet.driftstack.dev` whose origin terminates TLS directly (the one
certbot/LE exception at the origin). To (re)provision on a box:

1. **DNS:** `fleet.driftstack.dev` A → origin IP, **DNS-only / grey-cloud** (NOT orange-proxied).
2. **Cert:** `certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cf-dns-creds.ini -d fleet.driftstack.dev` (auto-renews).
3. **Map:** `nginx/ws_upgrade_map.conf` → `/etc/nginx/conf.d/` (provides `$connection_upgrade`).
4. **Vhost:** `nginx/fleet.driftstack.dev.conf` → `sites-available/` + symlink into `sites-enabled/`; `nginx -t`; `systemctl reload nginx`.
5. **Daemon:** `DRIFTSTACK_CONTROL_ENDPOINT=wss://fleet.driftstack.dev/v1/fleet/events` (the `configure.sh` default).

`deploy-api.sh production` now **auto-installs the fleet vhost + map** (steps 3–4): it
scp's both, then symlinks + reloads the vhost **only when the LE cert (step 2) is
present**, else it skips with a loud warning + the certbot command (an unconditional
symlink would `nginx -t`-fail on the missing cert and 502 the box). So steps **1 (DNS),
2 (cert), 5 (daemon endpoint)** remain the one-time manual prerequisites; the map+vhost
ride the normal deploy. If the cert is absent the workers fall back to the CF-proxied
`api.` and the -1011 flap returns until you provision it + re-deploy.

## Sub-processor map

The `.env` files reference only credentials for sub-processors enumerated
in [DPA Annex 3](../apps/marketing-site/src/pages/legal/dpa.md):

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
  pass through the agent's chat history or pull-request artifacts.
