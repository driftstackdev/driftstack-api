# Self-hosted on macOS — full local stack runbook

V-333. Stand up the entire Driftstack control plane on a Mac so you
can exercise the API + GUI end-to-end without touching Hetzner or the
Cloudflare-fronted production stack. Useful for:

- Verifying the full sign-up → checkout → API key → session flow
  before each release.
- Reproducing customer-reported bugs locally.
- Founder-action validation (V-328 native bundle test, V-243
  updater key generation, etc.).
- Pre-empting "preparing to open real browsers" — once the
  PlaywrightDriver lands (V-333b), `DRIVER=playwright` will
  actually launch Safari/WebKit/Chromium on the Mac for sessions.

## Prerequisites

- macOS 12+ (Monterey or newer).
- Node.js 22+ (`brew install node@22` or via fnm/asdf).
- Docker Desktop (for Postgres 17 + Redis 7).
- Xcode Command Line Tools (`xcode-select --install`).
- Tauri prerequisites for the GUI client: Rust (`brew install rustup-init && rustup-init -y`).

## One-time setup

```sh
# Clone + install
git clone https://github.com/driftstackdev/driftstack-api.git
cd driftstack-api
npm install

# Spin up Postgres + Redis via the dev compose file.
docker compose up -d
# Compose file (docker-compose.yml) lives in the repo root and exposes:
#   postgres on 127.0.0.1:5432 (db driftstack / user driftstack)
#   redis on 127.0.0.1:6379

# Apply migrations (Drizzle generates + applies all V-NNN migrations).
npm run db:migrate --workspace @driftstack/server

# Build all workspace packages once (api-types Zod shapes + SDKs).
npm run build
```

## Run the control plane locally

V-336 — single command starts every surface concurrently:

```sh
npm run dev:all
```

`concurrently` prefixes each surface's stdout with its name + a
distinct color. Ctrl+C stops every surface cleanly.

If you'd rather run them in separate panes (e.g. for log isolation
when debugging one surface):

| Surface            | Command                 | URL                     |
| ------------------ | ----------------------- | ----------------------- |
| API server         | `npm run dev:server`    | <http://localhost:3000> |
| Customer dashboard | `npm run dev:dashboard` | <http://localhost:5173> |
| Admin panel        | `npm run dev:admin`     | <http://localhost:5174> |
| Marketing site     | `npm run dev:marketing` | <http://localhost:4321> |
| Docs site          | `npm run dev:docs`      | <http://localhost:4322> |
| Status site        | `npm run dev:status`    | <http://localhost:4323> |

`PUBLIC_API_BASE_URL` defaults to `http://localhost:3000` for all
Astro apps in dev — they pick up the local API automatically.

## Run the GUI client locally

```sh
cd apps/gui-client
npm run tauri dev
```

This launches a native Tauri window connected to the local API. On
first run, Tauri compiles the Rust side (~2-3 minutes); subsequent
runs are instant.

To target the local API, the GUI's First-Run Wizard accepts
`http://localhost:3000` as a base URL.

## Verify the full flow

1. Open the customer dashboard at <http://localhost:5173>.
2. Sign up: `signup@example.test` / any password ≥ 12 chars.
3. Verify email: dev mode logs the verify-email link to the API
   server's stdout. Click it to complete email verification.
4. Open the API keys page; mint a key. Copy the plaintext.
5. Open the GUI client; paste the API key + base URL
   (`http://localhost:3000`).
6. In the GUI: create a session. Status should reach `ready`. With
   `DRIVER=mock` (default), the session is in-memory only — actions
   like navigate succeed but no real browser opens.

## Switch to the real browser path (V-333b — pending)

Once the PlaywrightDriver lands (V-333b), set in `apps/server/.env`:

```
DRIVER=playwright
PLAYWRIGHT_BROWSER=webkit  # or 'chromium' / 'firefox'
```

Restart the API server. Sessions now spawn a real browser visible on
the Mac desktop. The GUI client + dashboard are unchanged.

Until V-333b ships, `DRIVER=webkit` returns
`DriverNotIntegratedError` per design — the WebKit fork (Agent 1
repo) lands the production driver separately.

## Resetting between runs

```sh
# Wipe the dev database (loses all signups + sessions; keeps schema).
docker compose exec postgres psql \
  -U driftstack -d driftstack -c '
    TRUNCATE TABLE
      sessions, profiles, api_keys, web_sessions, accounts, account_audit_log,
      admin_audit_log, webhook_endpoints, webhook_deliveries, stripe_events,
      subscriptions, usage_records, rate_limit_overrides, status_subscribers,
      incidents, incident_updates, scheduled_jobs, team_members, team_invites,
      legal_acceptances RESTART IDENTITY CASCADE;
  '

# Wipe Redis (auth-cache, rate-limit buckets, web-session locks).
docker compose exec redis redis-cli FLUSHALL
```

## Common pitfalls

- **GUI's First-Run Wizard fails**: usually a base-URL mismatch. The
  GUI's self-hosted default is `http://localhost:3000` (matches the dev
  API) per `apps/gui-client/src/lib/settings.ts` — set that in the
  wizard's base-URL field if it's pointed elsewhere (e.g. left at the
  cloud default `https://api.driftstack.dev`).
- **Migrations fail with "extension uuid-ossp not found"**: the dev
  compose enables it via `docker-entrypoint-initdb.d`. If you wiped
  the volume, rebuild via `docker compose down -v && docker compose
up -d`.
- **Stripe webhooks don't fire**: dev mode uses Stripe CLI's
  `stripe listen --forward-to localhost:3000/v1/webhooks/stripe`. See
  `docs/operations/stripe-cli-setup.md` for the test-mode key wiring.
- **Tauri dev hangs at "Compiling tauri"**: cold compile is slow on
  Apple Silicon (~3 min); warm rebuilds are <10s. Don't kill it
  prematurely.

## Related docs

- `docs/founder-actions/v243-tauri-updater-keys.md` — GUI signing key
  generation (one-time, Mac).
- `docs/founder-actions/v328-tauri-deep-link-test.md` — driftstack://
  URL scheme registration test on macOS.
- `docs/operations/launch-day-runbook.md` — production launch steps
  (different from this — production targets Hetzner).
- `docs/architecture/afp-harness-configuration.md` — Agent 1 cross-
  reference for the WebKit driver's harness branching when DRIVER=
  webkit eventually integrates.
