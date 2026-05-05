# Driftstack API

Customer-facing REST API and control plane for Driftstack — an iPhone Safari automation platform.

> **Status:** Pre-launch. Control-plane API surface is built and tested (auth flow, profiles, sessions, billing, webhooks, admin). Mock WebKit driver is the contract; the real driver swaps in when the Driftstack WebKit fork closes Phase 2.

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
│   └── gui-client/         # Tauri desktop client (separate workstream)
├── packages/
│   ├── api-types/          # Public Zod schemas + inferred TS types (SDK consumers)
│   ├── sdk-typescript/     # @driftstack/sdk
│   ├── sdk-python/         # python SDK (generated + hand-polished)
│   └── sdk-go/             # go SDK (planned)
├── docs/
│   ├── architecture.md     # system shape (synced 2026-05-03 V-087)
│   ├── decisions.md        # D-NNN decision log
│   ├── verification-log.md # V-NNN empirical log (append-only)
│   ├── adr/                # ADR-001..ADR-006
│   ├── deployment/         # env-vars schema + deploy notes
│   ├── legal/              # ToS / Privacy / DPA / AUP / SLA / SOC2 drafts
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
- **Stripe** (optional): `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `DRIFTSTACK_TIER_PRICE_IDS`, `STRIPE_TRIAL_PACK_PRICE_ID`.
- **Auth-flow links**: `AUTH_VERIFY_EMAIL_URL`, `AUTH_MAGIC_LINK_URL`, `AUTH_PASSWORD_RESET_URL`.

Routes register conditionally — when a vendor isn't configured, its routes don't register and the rest of the API stays up. /v1/billing/\* needs Stripe configured; /v1/webhooks/stripe needs `STRIPE_WEBHOOK_SECRET`; /v1/auth/\* needs the auth-flow URLs.

## Authentication

Two surfaces:

- **API keys** (long-lived, scoped, revocable) — for SDK consumers. Pass as `Authorization: Bearer <key>`. Issuance via `POST /v1/api-keys`. scrypt-hashed at rest; sha256-keyed Redis cache with 30s TTL.
- **Web sessions** (opaque sha256 tokens, 30d TTL, revocable) — for browser dashboard / admin panel. Issued by `/v1/auth/{login,verify-email,magic-link/consume,password-reset/confirm}`; rotated by `/v1/auth/refresh`.

See `docs/architecture.md` for the full request lifecycle (V-087 sync).

## Documentation

- `docs/architecture.md` — system shape, layers, persistence, request lifecycles
- `docs/decisions.md` — D-NNN decision log (D-001..D-034 as of 2026-05-03)
- `docs/verification-log.md` — V-NNN append-only empirical log
- `docs/adr/` — long-form ADRs for architectural deviations
- `docs/deployment/env-vars.md` — canonical env-var schema
- `/openapi.json` — generated OpenAPI 3.1 spec (live, served at runtime)
- `/docs` — Swagger UI (live)

## Contributing

This is a small project with direct push-to-main on internal commits; the verification log (`docs/verification-log.md`) and decisions log (`docs/decisions.md`) capture the rationale behind every substantive change. External contributions go through standard pull-request flow on GitHub.

## License

MIT
