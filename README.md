# Driftstack API

Customer-facing REST + WebSocket API and control plane for [Driftstack](https://github.com/driftstackdev) — a stealth iPhone Safari automation platform.

> **Status:** Phase 1 (repo + infrastructure). Pre-launch, not production-ready. The mock WebKit driver is a contract; the real driver lands when the Driftstack WebKit fork closes Phase 2.

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
├── apps/server/          # Fastify API
│   ├── src/
│   │   ├── routes/       # HTTP handlers grouped by resource
│   │   ├── services/     # Business logic, orchestration
│   │   ├── drivers/      # Mock + (future) WebKit driver
│   │   ├── schemas/      # Zod schemas (request/response)
│   │   ├── db/           # Drizzle schema + migrations
│   │   ├── middleware/   # Auth, rate limit, error handler, logging
│   │   ├── lib/          # Cross-cutting utilities (config, etc.)
│   │   └── index.ts      # Server entry
│   └── tests/{unit,integration,e2e}/
├── packages/api-types/   # Shared types/schemas published to clients
├── docs/                 # architecture, decisions, verification log
├── docker-compose.yml    # Local Postgres + Redis
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

All runtime config comes from environment variables. See `.env.example` for the full list. The schema lives in `apps/server/src/lib/config.ts` (Zod-validated at startup).

| Var                        | Required | Default                                                      |
| -------------------------- | -------- | ------------------------------------------------------------ |
| `NODE_ENV`                 | no       | `development`                                                |
| `PORT`                     | no       | `3000`                                                       |
| `LOG_LEVEL`                | no       | `info`                                                       |
| `DATABASE_URL`             | no\*     | `postgres://driftstack:driftstack@localhost:5432/driftstack` |
| `REDIS_URL`                | no\*     | `redis://localhost:6379`                                     |
| `DRIVER`                   | no       | `mock`                                                       |
| `MOCK_NAVIGATE_LATENCY_MS` | no       | `120`                                                        |
| `MOCK_INTERACT_LATENCY_MS` | no       | `40`                                                         |

\* Falls back to dev defaults that match `docker-compose.yml`. In production you must set both explicitly.

## Authentication

API keys are long-lived, scoped, revocable. Pass as `Authorization: Bearer <key>`. See `docs/architecture.md` (Phase 3 onward).

## Documentation

- `docs/architecture.md` — system shape and component boundaries
- `docs/decisions.md` — D-NNN decision log
- `docs/verification-log.md` — V-NNN empirical verification log
- `/openapi.json` — generated OpenAPI 3.1 spec (served at runtime, Phase 7)
- `/docs` — Swagger UI (Phase 7)

## Contributing

This is a single-founder project. Agent #2 (this codebase) and Agent #1 (WebKit fork) push directly to main; verification log + decisions log capture the why. See `CLAUDE.md` for the operational discipline.

## License

MIT
