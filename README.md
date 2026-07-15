# Driftstack API

Customer-facing REST API and control plane for Driftstack — an iPhone Safari automation platform.

> **Status:** Active development. The control-plane API surface is built and
> tested end-to-end (auth flow, profiles, sessions, billing, webhooks, admin).
> The WebKit driver interface is the contract between this control plane and
> the browser engine; a mock driver ships in this repo and the real driver
> ships in the WebKit fork repo.

## Stack

- Node.js 22 LTS, TypeScript 5.x strict mode
- [Fastify](https://fastify.dev/) HTTP server
- [Drizzle ORM](https://orm.drizzle.team/) on Postgres 17
- Redis 7 for ephemeral state, rate limiting, session caching
- [Zod](https://zod.dev/) as single source of truth (OpenAPI 3.1 generated from Zod)
- Vitest (unit + integration) and Playwright (e2e)
- Pino structured JSON logging
- Docker Compose for dev infra
- GitHub Actions CI

## Repository layout

```
driftstack-api/
├── apps/
│   ├── server/             # Fastify API + control plane
│   │   ├── src/{routes,services,drivers,schemas,db,middleware,lib}
│   │   └── tests/{unit,integration,e2e}/
│   ├── marketing-site/     # Astro static-build (driftstack.dev)
│   ├── customer-dashboard/ # Astro customer portal (app.driftstack.dev)
│   ├── admin-panel/        # Astro admin UI (internal)
│   ├── docs/               # Astro docs site (docs.driftstack.dev)
│   ├── status-site/        # Status page (status.driftstack.dev)
│   └── gui-client/         # Tauri desktop client (macOS / Windows / Linux)
├── packages/
│   ├── api-types/             # Public Zod schemas + inferred TS types
│   ├── sdk-typescript/        # TypeScript SDK (Node 18+; browser-safe build)
│   ├── sdk-python/            # Python SDK (3.10+; sync + async clients)
│   ├── sdk-go/                # Go SDK (1.22+; context-aware client)
│   ├── behavioural-simulation/ # Synthetic touch / scroll / keyboard cadence
│   ├── recipe-library/         # Navigation flow library
│   ├── recapture-automation/   # Capture matrix orchestration
│   ├── webrtc-streaming/       # Server-side WebRTC encode pipeline
│   └── webhook-delivery/       # Outbound webhook delivery primitives
├── docs/
│   ├── architecture.md     # system shape
│   ├── decisions.md        # decision log
│   ├── adr/                # long-form architectural decision records
│   ├── deployment/         # env-vars schema + deploy notes
│   ├── legal/              # Terms / Privacy / DPA / AUP / definitions
│   └── architecture/       # subsystem-level design docs
├── docker-compose.yml      # Local Postgres 17 + Redis 7
└── drizzle.config.ts
```

## Setup

### Prerequisites

- Node.js 22 LTS (`.nvmrc` pins this — `nvm use` if you have nvm)
- Docker Desktop (for Postgres + Redis)
- npm 10+

### Install

```bash
git clone https://github.com/driftstackdev/driftstack-api.git
cd driftstack-api
npm install
cp .env.example .env
```

### Run infrastructure

```bash
docker compose up -d
```

This brings up Postgres 17 on `localhost:5432` and Redis 7 on `localhost:6379`. Credentials: `driftstack` / `driftstack` / db `driftstack`.

### Run server

```bash
npm run dev          # tsx watch, reloads on changes
```

### Typical workflow

```bash
npm run typecheck    # strict TS across all workspaces
npm run lint         # eslint with type-aware rules
npm run format:check # prettier (use `npm run format` to fix)
npm test             # vitest unit + integration
npm run test:e2e     # playwright (requires running server)
npm run build        # tsc --build all workspaces
```

### Database

```bash
npm run db:generate  # generate migration from schema diff
npm run db:migrate   # apply pending migrations
npm run db:seed      # seed dev data (test account + API key)
npm run db:studio    # drizzle studio web UI
```

## Configuration

All runtime config comes from environment variables. The Zod schema in `apps/server/src/lib/config.ts` validates at startup. The canonical reference is `docs/deployment/env-vars.md` — every env var the control plane reads is documented there.

Core groups (see env-vars.md for the full list):

- **Process**: `NODE_ENV`, `PORT`, `HOST`, `LOG_LEVEL`, `DRIVER`.
- **Postgres / Redis**: `DATABASE_URL`, `REDIS_URL` (dev defaults to docker-compose).
- **Cloudflare R2** (optional): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_RECORDINGS`.
- **Postmark** (optional): `POSTMARK_API_TOKEN`, `POSTMARK_FROM`, `POSTMARK_REPLY_TO`.
- **Sentry** (optional): `SENTRY_DSN` (EU region required), `SENTRY_ENVIRONMENT`.
- **Stripe** (optional): `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `DRIFTSTACK_TIER_PRICE_IDS` (six paid tiers, monthly + annual).
- **Auth-flow links**: `AUTH_VERIFY_EMAIL_URL`, `AUTH_MAGIC_LINK_URL`, `AUTH_PASSWORD_RESET_URL`.

Vendor integrations fail independently so the rest of the API stays up. `/v1/billing/*` returns a typed `503 FeatureUnavailable` until `STRIPE_SECRET_KEY` and `DRIFTSTACK_TIER_PRICE_IDS` are configured; `/v1/webhooks/stripe` is gated independently by `STRIPE_WEBHOOK_SECRET`; `/v1/auth/*` needs the auth-flow URLs.

## Authentication

Two surfaces:

- **API keys** (long-lived, scoped, revocable) — for SDK consumers. Pass as `Authorization: Bearer <key>`. Issuance via `POST /v1/api-keys`. scrypt-hashed at rest; sha256-keyed Redis cache with 30s TTL.
- **Web sessions** (opaque sha256 tokens, 30d TTL, revocable) — for browser dashboard / admin panel. Issued by `/v1/auth/{login,verify-email,magic-link/consume,password-reset/confirm}`; rotated by `/v1/auth/refresh`.

See `docs/architecture.md` for the full request lifecycle.

## Documentation

- `docs/architecture.md` — system shape, layers, persistence, request lifecycles
- `docs/decisions.md` — decision log
- `docs/adr/` — long-form architectural decision records
- `docs/deployment/env-vars.md` — canonical env-var schema
- `/openapi.json` — generated OpenAPI 3.1 spec (live, served at runtime)
- `/docs` — Swagger UI (live)

## Contributing

Pull requests welcome. Substantive changes should reference the relevant
ADR (or open a new one) and include test coverage. The customer SDKs are
maintained in separate public repositories — see the SDK READMEs for their
own contribution guides.

## License

MIT
