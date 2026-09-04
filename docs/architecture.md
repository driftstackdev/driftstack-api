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
- **Drivers** (`apps/server/src/drivers/`) — Abstraction over the WebKit substrate. Three implementations: `mock` (in-memory, deterministic, fast-forwardable latency), `playwright` (V-333b, dev and E2E only, imported lazily so production builds do not pull in the devDependency), and `webkit` (real fork, scaffolded but not yet integrated — throws `DriverNotIntegratedError` until the fork hands off).
- **DB layer** (`apps/server/src/db/`) — Drizzle ORM. `schema.ts` is the single TS source of truth; SQL migrations under `migrations/` apply via Drizzle's journal-driven migrator. In-memory test repos in `tests/integration/_helpers/` shadow the Drizzle implementations one-for-one.
- **Middleware** (`apps/server/src/middleware/`) — `request-id`, `auth` (API key extraction → AccountContext), `rate-limit` (Redis token bucket per account+bucket), `error-handler` (RFC 7807 problem+json formatter).
- **Lib** (`apps/server/src/lib/`) — Cross-cutting utilities: `config`, `logger` (Pino), `errors` (ApiError taxonomy), `api-keys` (scrypt + base32), `auth-tokens` (V-079 tokens + password hashing), `stripe-signing` (V-080 HMAC verification, no SDK dep), `stripe-api` (V-088 hand-rolled Stripe HTTP client), `webhook-signing` (outbound signature emission), `r2`, `sentry`, `redis-rate-limit-store` / `memory-rate-limit-store`.
- **Schemas** (`apps/server/src/schemas/`) — Server-internal Zod shapes that aren't part of the public contract. Public-contract schemas live in `packages/api-types/`.

### Workspaces beyond `apps/server/`

- `apps/marketing-site/` — Astro static-build for `driftstack.io` (V-064+). SEO basics in `public/robots.txt` + `@astrojs/sitemap` integration (V-106).
- `apps/customer-dashboard/` — Astro static-build scaffolding for `app.driftstack.io` (V-099). Sidebar + DashboardLayout + mock-data layer; sub-pages pending Tier 3 review per the customer-dashboard-stack proposal in `docs/architecture/customer-dashboard-stack.md` (PROPOSED).
- `apps/gui-client/` — Tauri desktop client. Separate workstream.
- `packages/sdk-typescript/` — `@driftstack/sdk`; 19 resource accessors (V-1130 count; this
  read "7 as of V-101" long after the surface had grown, and the dated qualifier made a
  stale number look deliberate).
- `packages/sdk-python/` — Python SDK; the same 19 accessors, sync + async.
- `packages/sdk-go/` — Go SDK; the same 19 accessors. This said "(planned)" until V-1130,
  which was not a dated claim but a wrong one: the Go SDK ships, carries its own CHANGELOG,
  and `docs/architecture/sdk-versioning.md` has governed it as one of three SDKs since V-177.
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
- **Metering**: `usage_records`, `rate_limit_overrides`, and `rate_limit_buckets` — which exists in the schema but is **never written**; the live counters are in Redis and the durability snapshot D-015 describes was never built (see the reality check on D-015).
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

Sub-processor list locked per V-052 / AGENTS.md. Adding a vendor outside this list = directional question first.

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

`POST /v1/webhooks/stripe` registers a route-scoped `application/json` content-type parser that stashes the raw body on `request.rawBody` (signature verification needs the bytes). Flow: missing `Stripe-Signature` header → 401, signature verification (HMAC-SHA256 over `<timestamp>.<raw body>` with replay tolerance 5 min) → 401 on any failure mode, malformed event body → 400, otherwise dispatch to `StripeWebhooksService.handle` which idempotency-checks `processed_stripe_events` then routes by `event.type` to per-kind handlers. Replies 200 to a verified, parseable event that was processed — including duplicates and ignored event types — so Stripe does not retry on every event kind we deliberately skip. The one exception is a transient infrastructure error (C5): `handle()` rethrows those, the route bumps `handler_transient_error` and lets the 500 surface, because no ledger row was written and Stripe's ~3-day retry window will cleanly re-process the event rather than leave a paying customer un-upgraded by a one-second blip. A permanent handler error is swallowed and recorded inside dispatch, so it still returns 200.

## OpenAPI generation

Zod schemas in `@driftstack/api-types` are paired with `@asteasolutions/zod-to-openapi` to produce the OpenAPI 3.1 spec at runtime. Spec served at `/openapi.json`; Swagger UI at `/docs`. The spec is the contract for SDK consumers; a deliberately committed copy lives elsewhere when material to SDK regeneration.

## Lifecycle event dispatcher (V-202c / V-202b)

Customer-facing events that pair an audit-log entry with a transactional email go through `AccountLifecycleService` (`apps/server/src/services/account-lifecycle.ts`). One `emit(accountId, event)` call site fans out into:

1. Account row lookup (`AccountLifecycleRepo.findForLifecycle`) — resolves email + per-event dedup flags.
2. Audit-log emit (when applicable for the event kind) via `AccountAuditService.record`.
3. Email-preference opt-out check via `EmailPreferencesService.shouldSend`.
4. Atomic dedup mark (when applicable) — e.g. `accounts.first_failure_email_sent_at` for `session.failed.first`.
5. `EmailService` send.

Best-effort by contract: errors during dispatch are caught + logged warn, never propagate to the caller. The calling service's primary responsibility (handling a Stripe webhook, a session failure, a checkout completion) must never be blocked on lifecycle work.

Event kinds wired today (`LifecycleEvent` discriminated union):

- `session.failed.first` — V-202c. Emitted from `SessionsService.runWithFailureCapture`. One-shot per account (column-based dedup).
- `session.success.first` — V-304a. First successful session on the account. One-shot per account (column-based dedup).
- `subscription.tier_changed` — V-202b. Emitted from `StripeWebhooksService.handleSubscriptionUpsert` / `handleSubscriptionDeleted`. Audit + email; short-circuits on no-op transitions.
- `subscription.renewal_reminder` — V-327. Emitted from the Stripe `invoice.upcoming` webhook (~7 days before renewal). Email-only.
- `billing.payment_succeeded` — emitted from the Stripe webhook on a successful
  charge. Ledger-backed dedup on the event id, same discipline as
  `subscription.renewal_reminder`.
- `billing.payment_failed` — emitted on a failed charge. Deliberately absent from
  `OptOutableEmailEventSchema`, so no `shouldSend` opt-out gate runs for it: a
  customer cannot mute the notice that their payment did not go through. Same
  ledger-backed dedup.

V-805 — this list documented four kinds while six are wired; the two `billing.*`
kinds were missing, including the one that is deliberately not opt-outable, which
is the one a reader most needs to know about.

(The two `trial_pack` lifecycle kinds were removed with the dead trial_pack lifecycle — no production path ever emitted them.)

Adding a new lifecycle event = extend the discriminated union, add a handler in the service, optionally extend `AccountLifecycleServiceConfig` for any new templating URLs, and add an opt-out preference key in `OptOutableEmailEvent` if the email should be customer-suppressible.

## Scheduled jobs (V-202d)

`scheduled_jobs` table holds time-shifted background work. `ScheduledJobsService` (`apps/server/src/services/scheduled-jobs.ts`) owns the lifecycle:

- `enqueue(jobType, accountId?, payload, runAt, dedupOnAccountAndType?)` — append (with optional dedup against pending rows for the same account + job_type).
- `processTick(now)` — atomic claim (`SELECT … FOR UPDATE SKIP LOCKED` in a CTE → `UPDATE … RETURNING`), dispatch each claimed row to its registered handler, mark complete / retry-with-exponential-backoff / failed-permanently. Multi-replica safe: concurrent workers across processes never claim the same row.
- `register(jobType, handler)` — handler registry keyed by `job_type`. Unhandled `job_type` values mark the row failed with operator-visible error.

Registered handlers today: `auth_tokens.sweep` (expired auth-token GC), `sessions.duration_sweep` (free-tier session auto-destroy), `cost.recompute_nightly` (usage cost rollup) — each self-re-arms by enqueuing its next run from its own handler. Future cron-shaped jobs (end-of-month rollups, cleanup jobs) reuse the same table by adding a `job_type` discriminator + handler — no new table.

The `setInterval(processTick, ...)` poller is constructed but not yet auto-started in bootstrap (covers both `ScheduledJobsService` and `ValidationHarnessService`); founder approval pending on cadence. Tests + manual `processTick` calls work today.

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

`apps/server/src/drivers/index.ts` factory returns `mock` when `DRIVER=mock` (default in dev / staging / pre-fork-integration production), `playwright` when `DRIVER=playwright`, and `webkit` otherwise. V-806 — this said there were two implementations and that the factory chose between mock and webkit; the Playwright driver has been the third branch since V-333b. The `webkit` implementation throws `DriverNotIntegratedError` until the WebKit fork's Phase 2 closes. Driver-interface changes are coordinated explicitly with the WebKit fork (separate repo, see AGENTS.md WebKit driver boundary section).

## Tier model (ADR-004)

Two ladders (Manual + API), concurrent-only metering on paid tiers, concurrent-only metering throughout. V-806 — this used to add that hours were metered on the trial pack by decrementing an `accounts` credit column; that column was dropped by `migrations/0065_retire_trial_pack_free_tier.sql` and is absent from `schema.ts`, so the sentence described a meter that no longer exists. See `packages/api-types/src/common.ts` for the locked tier list + per-tier limits and `apps/server/src/services/sessions.ts` for the enforcement constants (`TIER_CONCURRENT_SESSION_LIMITS`, `PROFILES_PER_TIER`).

## Decisions (cross-reference)

Pricing + commercial:

- **D-019 / ADR-004** — Two-ladder pricing + concurrent-only metering. Supersedes file-127 single-ladder hours-with-overage.
- **D-027 / ADR-002** — Stripe-only payment rail at launch.
  **Contradicted by the shipped system since 2026-08-10** — a customer-facing crypto
  rail ships alongside Stripe. See ADR-002's reality check; a superseding ADR is owed.
- **ADR-003** — Paid trial pack ($2.99 / 14 days / $0.18-per-hour decrement) replaces a free tier.
  **Reversed by the shipped system since 2026-08-10** — the trial pack was retired
  2026-05-27 and `free` is a live tier. See ADR-003's reality check; a superseding ADR
  is owed.

Auth + security:

- **D-020 / D-025** — Auth cache invalidation pattern (sha256-keyed Redis cache, 30s TTL, account-version increment on tier-change / suspend / revoke).
- **D-024** — Process-local single-flight coalescer for the auth slow path.
- **D-028** — Web sessions are opaque sha256-hashed tokens (not JWT).
- **D-035** — Admin scope enforcement at Fastify preHandler (not service layer).
- **D-036** — Team roles taxonomy (4-role model; gates dashboard UI only, not `/v1/*`).

Webhooks:

- **D-023** — Outbound-webhook signing secrets use versioned AES-GCM envelopes; plaintext exists only at the delivery-worker boundary.
- **D-029** — Hand-rolled Stripe HTTP client (no `stripe` npm SDK dep).
- **D-030** — Inbound Stripe webhook idempotency via `processed_stripe_events` PK.
- **D-031** — `session.failed` first-failure-only emission semantic.

Lifecycle + scheduled jobs:

- **V-202c / V-202b / V-202d** — `AccountLifecycleService` is the single dispatcher for paired audit + email customer lifecycle events. `ScheduledJobsService` is the generic table-backed cron worker (V-173-pattern extension); first consumer is trial-pack expiry. Per-event-kind tests in `tests/unit/account-lifecycle.test.ts` + `tests/unit/scheduled-jobs.test.ts`. Per-flow integration tests in `tests/integration/trial-pack-expiry.test.ts`.
- **V-216 / V-224 / V-225 / V-226** — All 13 `AccountAuditAction` enum values now have emit sites: 4 in `auth-flows.ts` (V-224), 2 in `api-keys.ts` (V-216), 2 in `sessions.ts` (V-216), 2 in `profiles.ts` (V-225), 2 in `webhooks.ts` (V-225), 1 in `account-lifecycle.ts` (V-226 → relocated by V-202b). No deferred wires remain.

Infrastructure + observability:

- **ADR-001** — Hetzner for control-plane hosting.
- **D-033 / ADR-006** — Audit-log retention pattern (90d hot Postgres / R2 archive / 7y total).
- **D-034 / ADR-005** — Sentry-first observability destination.

Schema + naming:

- **D-032** — Profile name uniqueness scoped to `(account_id, name)`.
- See `docs/architecture/archetype-naming-convention.md` (V-136) for archetype identifier shape.

Long-form ADRs live under `docs/adr/`. Short D-NNN entries with autonomy levels live in `docs/decisions.md`.
