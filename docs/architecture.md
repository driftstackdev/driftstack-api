# Driftstack API — Architecture

> Living document. Filled in as components land. Phase 1 baseline only.

## System shape (target)

```
┌─────────────────┐         ┌──────────────────────────┐         ┌─────────────────┐
│  Customer       │  HTTPS  │  Driftstack API          │   ◀──   │  Mac mini fleet │
│  (AI agent /    │  ────▶  │  (Fastify, this repo)    │         │  (WebKit fork,  │
│   QA bot /      │         │                          │   ────▶ │   the WebKit fork)     │
│   scraper)      │         │  ┌────────────────────┐  │         │                 │
└─────────────────┘         │  │ Auth (API key)     │  │         └─────────────────┘
                            │  │ Rate limit (Redis) │  │
                            │  │ Routes / services  │  │         ┌─────────────────┐
                            │  │ Driver abstraction │  ──────▶  │ Postgres 17     │
                            │  └────────────────────┘  │         │ (accounts,      │
                            │                          │         │  api_keys,      │
                            └──────────────────────────┘         │  sessions,      │
                                                                 │  usage)         │
                                                                 └─────────────────┘
```

## Layers

- **Routes** (`src/routes/`) — Fastify handlers, one file per resource. Pure HTTP I/O: parse + validate via Zod, call service, format response. No business logic.
- **Services** (`src/services/`) — Business logic + orchestration. Composable, no HTTP awareness, takes typed inputs.
- **Drivers** (`src/drivers/`) — Abstraction over the WebKit substrate. Two implementations: `mock` (in-memory, deterministic) and `webkit` (real fork; not yet implemented).
- **DB layer** (`src/db/`) — Drizzle schema + queries. Services depend on this; routes never query directly.
- **Middleware** (`src/middleware/`) — Auth, rate limit, request-id, error formatter (RFC 7807), logging.
- **Schemas** (`src/schemas/`) — Zod schemas as the single source of truth. OpenAPI 3.1 spec is generated from these.

## Driver abstraction

The driver interface (sketch, finalised in Phase 4):

```ts
interface Driver {
  createSession(spec: SessionSpec): Promise<DriverSession>;
  navigate(sessionId: string, url: string, opts?: NavigateOpts): Promise<NavigateResult>;
  interact(sessionId: string, action: InteractionAction): Promise<InteractResult>;
  wait(sessionId: string, condition: WaitCondition): Promise<WaitResult>;
  getState(sessionId: string): Promise<SessionState>;
  capture(sessionId: string, kind: CaptureKind): Promise<CaptureResult>;
  destroy(sessionId: string): Promise<void>;
}
```

The factory (`src/drivers/index.ts`, Phase 4) returns `mock` when `DRIVER=mock` and `webkit` otherwise. The `webkit` implementation throws `NotYetIntegratedError` until the WebKit fork hands off the real driver.

## Persistence

- **Postgres** holds durable state: accounts, api_keys (hashed), sessions metadata, sessions_events (audit), usage_records, rate_limit_buckets (snapshots).
- **Redis** holds ephemeral state: rate-limit token buckets (sliding window), session-driver handles, transient idempotency keys.

## Request lifecycle (target, Phase 3+)

1. Request arrives → Fastify generates request id, Pino logs ingress.
2. Auth middleware extracts `Authorization: Bearer <key>`, hash-and-lookup against `api_keys`. Attaches `account` to request context.
3. Rate-limit middleware decrements account's bucket in Redis. 429 with `Retry-After` if exhausted.
4. Route handler validates body via Zod → calls service.
5. Service orchestrates: db reads, driver calls, db writes (transactional where applicable).
6. Response goes back through Fastify response serialiser (Zod-validated in dev).
7. Errors go through error middleware → RFC 7807 problem+json with stable `type` URI.
8. Pino logs egress with request id, latency, status.

## OpenAPI generation

Zod schemas are paired with `@asteasolutions/zod-to-openapi` (or equivalent) to produce the spec at build time. Spec served at `/openapi.json`; Swagger UI at `/docs`. Spec is committed when material to consumer SDKs.
