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
├── os-observer/
│   └── observer.py                 passive raw-SYN OS fingerprinter (see below)
├── systemd/
│   ├── driftstack-api.service      systemd unit, runs as `driftstack` user
│   └── driftstack-os-observer.service  unit for the observer (CAP_NET_RAW only)
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

## os-observer

The passive OS fingerprinter behind the proxy **OS chip**. A SOCKS5 proxy opens
its own TCP connection to a destination, so the SYN arriving here was built by
the proxy host's kernel — and TTL, window, MSS, window scale and TCP option
ORDER exist only in that SYN. A connected socket has had them consumed, so the
control plane cannot read them and this sniffs them instead.

⛔ **It lived only on the production host until 2026-09-15.** Everything beside it
in this directory was version-controlled; this was not, so a rebuild would have
lost it and a change had no review trail. The copy here is the DEPLOYED artefact,
fetched from the host rather than reconstructed.

|            |                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------- |
| Host       | the API origin (`driftstack-production`, 128.140.37.74)                                  |
| Sniffs     | `OBS_PORTS` = {7791, 443}, raw `SOCK_RAW`/`IPPROTO_TCP`, SYNs only                       |
| Accepts    | binds 7791 itself; **443 is accepted by nginx**, which is why no new listener was needed |
| Lookup     | `127.0.0.1:7792`, loopback only, never the public interface                              |
| Records    | last SYN per **(address, port)**, bounded LRU, 15-minute TTL                             |
| Capability | `CAP_NET_RAW` only; `NoNewPrivileges=true`                                               |

### Why two ports

`7791` is reached directly. `443` on **`api.driftstack.dev` is Cloudflare-fronted**,
so a SYN arriving there is Cloudflare's edge and not the proxy's — a perfectly
stable reading of the wrong machine. **`fleet.driftstack.dev` is direct**
(documented above as grey-cloud, NOT CF), and nginx already serves 443 on it, so
that name is a valid second vantage with no new infrastructure.

This matters because a provider can route web traffic and odd ports differently:
measured 2026-09-14, one residential proxy read Mac/iOS on 443 (via
browserleaks.com/ip) and Linux on 7791. Records are keyed per (address, port) so
the two can be **compared** rather than overwrite each other.

### Contract

| Path               | Answer                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `/sig/<ip>`        | the **7791** record. UNCHANGED — the control plane calls exactly this                                          |
| `/sig/<ip>/<port>` | that vantage's record                                                                                          |
| unobserved port    | **400**, not 404 — "we do not watch that port" must stay distinguishable from "nothing came from that address" |
| unseen / expired   | 404 with a reason, **never** a default signature                                                               |

### Deploying a change

```sh
scp infra/os-observer/observer.py root@<host>:/opt/driftstack/os-observer/observer.py
ssh root@<host> 'systemctl restart driftstack-os-observer'
ssh root@<host> 'curl -s http://127.0.0.1:7792/healthz'     # {"ok":true,...,"ports":[443,7791]}
```

⚠️ Back the live file up first, and afterwards confirm the **legacy** path still
answers — connect to 7791 from off-host and check `/sig/<ip>` returns 200 with
`dst_port: 7791`. A healthy service that records nothing looks identical to a
working one from `systemctl` alone.
