# Driftstack API — Architecture

> Living document. Reflects the state on the date noted below; updated alongside V-NNN entries that change system shape.

**Last refresh:** 2026-05-03 (V-087 full sync covering V-079..V-086; V-109 catch-up adding V-099 customer-dashboard workspace + V-100 admin force-actions). Prior baseline was Phase-1 minimal and significantly out of date.

## System shape

```
┌──────────────────────┐    HTTPS    ┌───────────────────────────────────┐    HTTPS / mTLS
│  Customer surfaces   │  ────────▶  │  Driftstack API + control plane   │  ──── (out, future)
│   - SDK (TS/Py/Go)   │             │  (Fastify, Node 22, this repo)    │           │
│   - GUI client       │             │                                   │           ▼
│   - Browser dashboard│             │  ┌─────────────────────────────┐  │   ┌──────────────────┐
│   - Marketing site   │             │  │ Middleware                  │  │   │  Mac mini fleet  │
│     (Astro, separate)│             │  │  · request-id               │  │   │  (WebKit fork,   │
└──────────────────────┘             │  │  · auth (API key)           │  │   │   separate repo) │
                                     │  │  · rate-limit (Redis)       │  │   │  via mock or     │
        Stripe webhook  ────────────▶│  │  · error → RFC 7807         │  │   │  webkit driver   │
        (signed POST)                │  └─────────────────────────────┘  │   └──────────────────┘
                                     │                                   │
                                     │  ┌─────────────────────────────┐  │
                                     │  │ Routes  (apps/server/src)   │  │
                                     │  │  /v1/sessions               │  │
                                     │  │  /v1/api-keys               │  │
                                     │  │  /v1/usage                  │  │
                                     │  │  /v1/profiles      (V-081)  │  │
                                     │  │  /v1/auth/*        (V-079)  │  │
                                     │  │  /v1/billing/*     (V-082)  │  │
                                     │  │  /v1/webhooks               │  │
                                     │  │  /v1/webhooks/stripe(V-080) │  │
                                     │  │  /v1/admin/*                │  │
                                     │  │  /v1/legal/*                │  │
                                     │  │  /health · /ready · /openapi│  │
                                     │  └─────────────────────────────┘  │
                                     │                                   │
                                     │  Services / Drivers / DB layer    │
                                     └───────────────┬───────────────────┘
                                                     │
                       ┌─────────────────────────────┼─────────────────────────────────┐
                       ▼                             ▼                                 ▼
              ┌─────────────────┐          ┌─────────────────┐                ┌─────────────────┐
              │ Postgres 17     │          │ Redis 7         │                │ Cloudflare R2   │
              │ (Neon, EU)      │          │ (Upstash, EU)   │                │ (recordings)    │
              │  · accounts     │          │  · auth cache   │                └─────────────────┘
              │  · api_keys     │          │  · rate-limit   │
              │  · sessions     │          │    buckets      │                ┌─────────────────┐
              │  · session_     │          │  · in-flight    │                │ Postmark        │
              │    events       │          │    auth         │                │ (transactional  │
              │  · usage_       │          │    coalescer    │                │  email, EU)     │
              │    records      │          └─────────────────┘                └─────────────────┘
              │  · rate_limit_  │
              │    overrides    │                                             ┌─────────────────┐
              │  · webhook_     │                                             │ Sentry          │
              │    endpoints    │                                             │ (errors, EU)    │
              │  · webhook_     │                                             └─────────────────┘
              │    deliveries   │
              │  · admin_audit_ │                                             ┌─────────────────┐
              │    log          │                                             │ Stripe          │
              │  · legal_       │                                             │ (subscriptions  │
              │    acceptances  │                                             │  + trial pack;  │
              │  · email_verify_│                                             │  inbound        │
              │    tokens       │                                             │  webhooks)      │
              │  · magic_link_  │                                             └─────────────────┘
              │    tokens       │
              │  · password_    │
              │    reset_tokens │
              │  · web_sessions │
              │  · profiles     │
              │  · subscriptions│
              │  · processed_   │
              │    stripe_events│
              └─────────────────┘
```

## Layers

- **Routes** (`apps/server/src/routes/`) — Fastify handlers, one file per resource. Pure HTTP I/O: parse + validate via Zod from `@driftstack/api-types`, call service, format response. Public id format `<prefix>_<uuid>` (`acc_`, `key_`, `ses_`, `prof_`) is parsed/emitted at this boundary; service + DB use raw UUIDs.
- **Services** (`apps/server/src/services/`) — Business logic + orchestration. Repo-driven: each service depends on a `Repo` interface so tests substitute in-memory implementations and production wires Drizzle. No Fastify / no HTTP imports.
- **Drivers** (`apps/server/src/drivers/`) — Abstraction over the WebKit substrate. Two implementations: `mock` (in-memory, deterministic, fast-forwardable latency) and `webkit` (real fork, scaffolded but not yet integrated — throws `DriverNotIntegratedError` until the fork hands off).
- **DB layer** (`apps/server/src/db/`) — Drizzle ORM. `schema.ts` is the single TS source of truth; SQL migrations under `migrations/` apply via Drizzle's journal-driven migrator. In-memory test repos in `tests/integration/_helpers/` shadow the Drizzle implementations one-for-one.
- **Middleware** (`apps/server/src/middleware/`) — `request-id`, `auth` (API key extraction → AccountContext), `rate-limit` (Redis token bucket per account+bucket), `error-handler` (RFC 7807 problem+json formatter).
- **Lib** (`apps/server/src/lib/`) — Cross-cutting utilities: `config`, `logger` (Pino), `errors` (ApiError taxonomy), `api-keys` (scrypt + base32), `auth-tokens` (V-079 tokens + password hashing), `stripe-signing` (V-080 HMAC verification, no SDK dep), `stripe-api` (V-088 hand-rolled Stripe HTTP client), `webhook-signing` (outbound signature emission), `r2`, `sentry`, `redis-rate-limit-store` / `memory-rate-limit-store`.
- **Schemas** (`apps/server/src/schemas/`) — Server-internal Zod shapes that aren't part of the public contract. Public-contract schemas live in `packages/api-types/`.

### Workspaces beyond `apps/server/`

- `apps/marketing-site/` — Astro static-build for `driftstack.dev` (V-064+). SEO basics in `public/robots.txt` + `@astrojs/sitemap` integration (V-106).
- `apps/customer-dashboard/` — Astro static-build scaffolding for `app.driftstack.dev` (V-099). Sidebar + DashboardLayout + mock-data layer; sub-pages pending Tier 3 review per the customer-dashboard-stack proposal in `docs/architecture/customer-dashboard-stack.md` (PROPOSED).
- `apps/gui-client/` — Tauri desktop client. Separate workstream.
- `packages/sdk-typescript/` — `@driftstack/sdk` with 7 resource accessors as of V-101 (sessions / api-keys / usage / webhooks / profiles / billing / auth).
- `packages/sdk-python/` — Python SDK; same 7 resource accessors as of V-103.
- `packages/sdk-go/` — Go SDK (planned).
- `packages/api-types/` — Public Zod schemas + inferred TS types. Single source of truth for the API contract.

## Public API surfaces

| Surface            | Routes                                                                                                                                                                                                                         | Auth                                    | Lands in                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ----------------------- |
| Sessions           | `POST /v1/sessions`, navigate, interact, wait, capture, destroy, list                                                                                                                                                          | Bearer API key                          | Phase 1+                |
| API keys           | `POST /v1/api-keys`, `GET /v1/api-keys`, `DELETE /v1/api-keys/:id`                                                                                                                                                             | Admin scope                             | Phase 2                 |
| Usage              | `GET /v1/usage`                                                                                                                                                                                                                | Bearer                                  | Phase 2                 |
| Profiles           | `POST/GET /v1/profiles`, `GET/PATCH/DELETE /v1/profiles/:id`                                                                                                                                                                   | Bearer                                  | V-081                   |
| Auth flow          | `POST /v1/auth/{signup,verify-email,login,magic-link/{request,consume},password-reset/{request,confirm},refresh,logout}`                                                                                                       | **Public**                              | V-079                   |
| Billing            | `POST /v1/billing/{checkout-session,trial-pack,portal-session}`, `GET /v1/billing`                                                                                                                                             | Bearer                                  | V-082                   |
| Outbound webhooks  | `POST/GET /v1/webhooks`, `DELETE /v1/webhooks/:id`, `GET /v1/webhooks/:id/deliveries`                                                                                                                                          | Bearer (admin scope)                    | Phase 5                 |
| Inbound Stripe     | `POST /v1/webhooks/stripe`                                                                                                                                                                                                     | **Stripe-Signature header IS the auth** | V-080                   |
| Admin              | `GET/POST /v1/admin/accounts/{,:id,:id/{tier,suspend,unsuspend,usage,quota-override}}`, `/v1/admin/webhook-deliveries/...`, `/v1/admin/audit-log`, `POST /v1/admin/sessions/:id/destroy`, `POST /v1/admin/api-keys/:id/revoke` | Bearer (admin scope)                    | Phase 5 + V-083 + V-100 |
| Legal              | `GET /v1/legal/{documents,required}`, `POST /v1/legal/accept`                                                                                                                                                                  | Bearer                                  | V-046+                  |
| Health / readiness | `GET /health`, `GET /ready`, `GET /openapi.json`, `GET /docs`                                                                                                                                                                  | **Public**                              | Phase 1                 |

## Auth model

Two distinct auth surfaces, separated by audience:

1. **API keys** — for SDK consumers (programmatic). Long-lived `ds_<env>_<base32>` tokens, scrypt-hashed at rest (`api_keys.key_hash`), 16-char prefix indexed for O(1) lookup. Extracted by `auth` middleware from `Authorization: Bearer <key>`. Cached as `AccountContext` in Redis with sha256 cache key, 30-second TTL, account-version invalidation on tier-change / suspend / revoke (D-020 + D-025 cache invalidation pattern).

2. **Web sessions** — for browser dashboard / admin panel. Opaque 32-byte URL-safe random tokens, sha256-hashed at rest (`web_sessions.token_hash`), revocable by `revoked_at` set, 30-day default TTL. Issued by `/v1/auth/{verify-email,login,magic-link/consume,password-reset/confirm}`; rotated by `/v1/auth/refresh` (revoke old, issue new). Server-side validation only — no JWT secrets to rotate. Customer dashboard sends the plaintext as a session-cookie value. (V-079.)

Password hashing uses the same scrypt-kdf primitive as API keys (`accounts.password_hash`); `accounts.email_verified_at` gates the password-login path (must be non-null).

## Persistence

**Postgres 17** (Neon EU Frankfurt) holds durable state. Schema lives in `apps/server/src/db/schema.ts`; migrations are SQL files under `migrations/` applied by Drizzle's journal-driven migrator at boot (`migrate.ts`).

Tables grouped by domain:

- **Accounts + auth**: `accounts` (with `password_hash`, `email_verified_at`, `stripe_customer_id`, `trial_pack_*`, `tier`, `status`), `api_keys`, `email_verify_tokens`, `magic_link_tokens`, `password_reset_tokens`, `web_sessions`.
- **Sessions**: `sessions`, `session_events`, `profiles`.
- **Metering**: `usage_records`, `rate_limit_buckets` (snapshots), `rate_limit_overrides`.
- **Outbound webhooks**: `webhook_endpoints`, `webhook_deliveries`.
- **Inbound Stripe**: `processed_stripe_events` (idempotency ledger), `subscriptions` (mirror of Stripe subscription state).
- **Admin / audit**: `admin_audit_log` (append-only).
- **Legal**: `legal_acceptances` (V-046+).

**Redis 7** (Upstash EU Frankfurt) holds ephemeral state:

- **Auth cache**: sha256-keyed AccountContext entries (30s TTL), per-account version counter for invalidation.
- **Rate-limit token buckets**: per-(account, bucket-key) state, sliding window.
- **Auth coalescer**: per-key in-flight Promise sharing so concurrent auths against the same key don't all run scrypt.

**Cloudflare R2** (EU jurisdiction) holds session recordings. Optional — disabled when not configured at boot, readiness probe skips the R2 check.

## External services

Configured per `docs/deployment/env-vars.md`:

| Service       | Purpose                                                                            | Optional?                                                                 |
| ------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Neon Postgres | Durable state                                                                      | Required                                                                  |
| Upstash Redis | Auth cache + rate-limit                                                            | Required                                                                  |
| Cloudflare R2 | Session recordings                                                                 | Optional (auto-disable on missing config)                                 |
| Postmark      | Transactional email (signup verify, password reset, billing receipts, support ack) | Optional (no-op service when unconfigured)                                |
| Sentry        | Error tracking (EU region required)                                                | Optional                                                                  |
| Stripe        | Subscription billing + trial-pack purchases + Customer Portal + inbound webhooks   | Optional (route + service registered only when STRIPE_WEBHOOK_SECRET set) |
| Anthropic     | Bundled-LLM AI agent (BYOK opt-in only)                                            | Optional                                                                  |
| Moneybird     | Accounting / invoicing                                                             | Pending Workstream E                                                      |
| MacStadium    | Mac fleet hosting (gated on first paying customer)                                 | Future                                                                    |

Sub-processor list locked per V-052 / CLAUDE.md. Adding a vendor outside this list = directional question first.

## Request lifecycle (Bearer-API-key path)

1. Fastify generates request id (or honors inbound `x-request-id`), Pino logs ingress.
2. `auth` middleware: extracts `Authorization: Bearer <key>` → sha256 of plaintext → check Redis auth cache → cache hit returns AccountContext directly; miss runs the auth coalescer to share in-flight scrypt verification across concurrent same-key requests, falls through to `findApiKeyByPrefix` + scrypt verify + load AccountContext + cache + return. Failures return RFC 7807 problem (`InvalidKey` / `RevokedKey` / `ExpiredKey`).
3. `rate-limit` middleware (when applied): consumes from the named bucket in Redis using account-tier defaults (or per-account override). `x-ratelimit-remaining` header set on every response; 429 with `Retry-After` on exhaustion.
4. Route handler validates body / params / query through Zod schema in `@driftstack/api-types`. Validation failure → `ValidationFailed` problem (400).
5. Route calls service. Service orchestrates: DB reads/writes via repo, driver calls (sessions only), webhook event enqueue (outbound), email sends (auth-flow / billing). Atomicity within the service boundary; route stays thin.
6. Response goes through Fastify response serializer.
7. Errors thrown anywhere are caught by the error-handler middleware → RFC 7807 problem+json with stable `type` URI from `PROBLEM_TYPES`.
8. Pino logs egress: request id, latency, status, account id (if authenticated).

## Request lifecycle (public auth-flow path)

`/v1/auth/*` routes do NOT pass through the `auth` middleware (they ARE the auth gate). Rate limiting is intentionally not wired at scaffolding time — the existing rate-limit middleware is account-keyed; IP-based rate limiting for public flows lands as a follow-on (see V-079 V-log entry). Otherwise the lifecycle is: Zod validation → AuthFlowsService → AuthFlowError mapped to RFC 7807 problem.

## Request lifecycle (Stripe inbound webhook)

`POST /v1/webhooks/stripe` registers a route-scoped `application/json` content-type parser that stashes the raw body on `request.rawBody` (signature verification needs the bytes). Flow: missing `Stripe-Signature` header → 401, signature verification (HMAC-SHA256 over `<timestamp>.<raw body>` with replay tolerance 5 min) → 401 on any failure mode, malformed event body → 400, otherwise dispatch to `StripeWebhooksService.handle` which idempotency-checks `processed_stripe_events` then routes by `event.type` to per-kind handlers. Always replies 200 to a verified, parseable event (even on duplicate or ignored event types) to prevent Stripe re-delivery loops.

## OpenAPI generation

Zod schemas in `@driftstack/api-types` are paired with `@asteasolutions/zod-to-openapi` to produce the OpenAPI 3.1 spec at runtime. Spec served at `/openapi.json`; Swagger UI at `/docs`. The spec is the contract for SDK consumers; a deliberately committed copy lives elsewhere when material to SDK regeneration.

## Driver abstraction

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

`apps/server/src/drivers/index.ts` factory returns `mock` when `DRIVER=mock` (default in dev / staging / pre-fork-integration production) and `webkit` otherwise. The `webkit` implementation throws `DriverNotIntegratedError` until the WebKit fork's Phase 2 closes. Driver-interface changes are coordinated explicitly with the WebKit fork (separate repo, see CLAUDE.md WebKit driver boundary section).

## Tier model (ADR-004)

Two ladders (Manual + API), concurrent-only metering on paid tiers, hours metering only on the trial pack via `accounts.trial_pack_credit_cents` decrement. See `packages/api-types/src/common.ts` for the locked tier list + per-tier limits and `apps/server/src/services/sessions.ts` for the enforcement constants (`TIER_CONCURRENT_SESSION_LIMITS`, `PROFILES_PER_TIER`).

## Decisions (cross-reference)

- **D-019 / ADR-004** — Two-ladder pricing + concurrent-only metering. Supersedes file-127 single-ladder hours-with-overage.
- **D-020 / D-025** — Auth cache invalidation pattern (sha256-keyed Redis cache, 30s TTL, account-version increment on tier-change / suspend / revoke).
- **D-023** — Outbound-webhook signing secrets stored plaintext at rest.
- **D-027 / ADR-002** — Stripe-only payment rail at launch.
- **ADR-001** — Hetzner for control-plane hosting.
- **ADR-003** — Paid trial pack ($2.99 / 14 days / $0.18-per-hour decrement) replaces a free tier.

Long-form ADRs live under `docs/adr/`. Short D-NNN entries with autonomy levels live in `docs/decisions.md`.
