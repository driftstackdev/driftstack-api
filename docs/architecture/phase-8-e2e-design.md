# Phase 8 — End-to-End Test Design

> Status: design draft, ready for execution. Authored before implementation per founder request. Will be revised in-flight if implementation surfaces issues that the design didn't anticipate; revisions captured as V-log entries.

## Goals

The existing 123-test suite covers unit-level correctness and middleware-level integration via Fastify's `inject()`. Phase 8 adds **end-to-end** coverage: the same Fastify application running on a real port (HTTP), connected to real Postgres 17 and real Redis 7, exercised by an external HTTP client (Playwright's `request` API). What this catches that `inject()` doesn't:

1. **HTTP layer behaviours that don't surface through `inject`** — keep-alive, content-length parsing, header case mangling, body-stream handling, connection backpressure. `inject` simulates the request object directly; e2e exercises the actual TCP path.
2. **Drizzle queries against real Postgres.** The in-memory `SessionRepo` / `ApiKeysRepo` / `UsageRepo` mirror the Drizzle implementations _intentionally_, but the Drizzle code path itself has only been smoke-tested via `npm run db:migrate` + seed (V-008). E2E tests run every endpoint through the Drizzle stack and hit real foreign keys, real index behaviour, and real transactional semantics.
3. **Redis Lua atomic rate-limit script.** `RedisRateLimitStore` was built but never exercised — only the in-memory equivalent. E2E confirms the Lua script's atomicity claims under concurrent calls.
4. **Customer journey continuity.** A single test that walks `create account → create API key → create session → navigate → interact → capture → destroy` proves all the pieces interlock. `inject`-tests cover each piece in isolation.
5. **Empirical correctness against the OpenAPI contract.** A spec-validation step verifies every response shape matches its declared schema in `/openapi.json`. If the routes drifted from the spec they would catch nothing in `inject` mode.

The standard for Phase 8 is the same as every prior phase: every endpoint × every documented happy path × every documented error path. No "good enough."

## Non-goals (Phase 8)

- **Performance** — that's Phase 9.
- **Real WebKit driver** — still mocked via the `MockDriver`. The e2e tests use the same trigger-input set (error/timeout/http500 hosts; `#nonexistent` / `#hangs` selectors) that the integration suite uses.
- **Multi-tenant load testing** — also Phase 9.
- **Browser-based UI tests** — Driftstack is API-only; no DOM, no clicks. Playwright is used purely as the HTTP client + test runner.

## Stack

- **Test runner:** Playwright Test (`@playwright/test`, already in devDependencies). Use `request` (its built-in HTTP client) — not the browser context.
- **Infra:** local docker-compose (Postgres 17 + Redis 7, ports 5432 / 6379) for fast iteration. CI uses GH Actions service containers (same images, same versions).
- **App:** the same Fastify `buildApp` from `apps/server/src/lib/app.ts`, but constructed with the _Drizzle_ repos (not the in-memory ones) and the _Redis_ rate-limit store.
- **Listening:** server bound to `127.0.0.1:<dynamic port>` per test worker so Playwright can run files in parallel without port collisions.

## Directory layout

```
apps/server/tests/e2e/
├── playwright.config.ts          # Playwright config (CI vs local, parallelism, retries)
├── helpers/
│   ├── server.ts                 # Boot a real Fastify server in-process for the test
│   ├── db.ts                     # Reset Postgres state between test files
│   ├── redis.ts                  # FLUSHDB between test files
│   ├── seed.ts                   # Programmatic test-data fixtures
│   └── api.ts                    # Tiny typed wrapper around request, with auth helpers
├── auth.spec.ts                  # Auth + key lifecycle, scope checks, last_used_at
├── sessions.spec.ts              # All 8 session endpoints × happy + every error
├── admin.spec.ts                 # POST/GET/DELETE /v1/api-keys, GET /v1/usage
├── customer-journey.spec.ts      # Full create-key → session → ops → destroy flow
├── rate-limit.spec.ts            # Real Redis Lua exercised; concurrent contention
├── concurrency-limit.spec.ts     # Tier concurrent-session caps with real DB count
└── openapi-contract.spec.ts      # Every response validates against /openapi.json
```

## Server boot in tests

A test starts the same Fastify app as production wires, but with overridable infra connections:

```ts
// apps/server/tests/e2e/helpers/server.ts
export async function startTestServer(): Promise<TestServer> {
  const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
  const database = createDb(config.databaseUrl, { max: 5 });
  const redis = new Redis(config.redisUrl);

  const authRepo = new DrizzleAccountAuthRepo(database);
  const sessionsRepo = new DrizzleSessionRepo(database);
  const apiKeysRepo = new DrizzleApiKeysRepo(database);
  const usageRepo = new DrizzleUsageRepo(database);
  const rateLimitStore = new RedisRateLimitStore(redis);
  const driver = new MockDriver({
    fastForwardLatency: false, // real timing, not test-fast
    navigateLatencyMs: config.mockNavigateLatencyMs,
    interactLatencyMs: config.mockInteractLatencyMs,
  });

  const app = await buildApp({
    logger: createTestLogger(),
    authRepo,
    sessionsService: new SessionsService({ repo: sessionsRepo, driver }),
    apiKeysService: new ApiKeysService(apiKeysRepo),
    usageService: new UsageService(usageRepo),
    rateLimitStore,
    permissiveCors: true,
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    cleanup: async () => {
      await app.close();
      await redis.quit();
      await database.close();
    },
  };
}
```

`fastForwardLatency: false` is deliberate — Phase 8 wants to see real wall-clock timing. The mock-driver's standard 120 ms / 40 ms per call is small enough not to matter for test speed but large enough that timing-dependent regressions surface.

## Test data lifecycle

The single hardest e2e question. Three options considered:

|                                  approach | isolation           | speed                           | failure recoverability             |
| ----------------------------------------: | ------------------- | ------------------------------- | ---------------------------------- |
|                           One DB per test | total               | slow (~1s per test for migrate) | best                               |
| Schema-per-worker, truncate between tests | total within worker | medium                          | good                               |
|        Shared DB, per-test prefix on data | partial             | fast                            | poor (one bad test poisons others) |

**Decision: schema-per-worker.** Each Playwright worker creates its own schema (e.g. `test_w0`, `test_w1`) and runs migrations into it once at worker startup. Between tests, the worker truncates all tables (FK-aware ordering: session_events → sessions → api_keys → accounts; usage_records → accounts; rate_limit_buckets → accounts). Redis FLUSHDB between tests on the worker's dedicated DB index (Redis supports 16 logical DBs by default — workers get DB 1, 2, 3, etc.; DB 0 stays for dev).

**Why not per-test DB:** migration cost. Postgres CREATE DATABASE plus 6-table migration takes ~700 ms locally and longer in CI. With ~60 tests planned, that's a 40-second tax on every run. Schema-per-worker amortises it across the worker's tests.

**Why not the shared-DB-with-prefix approach:** one accidental cross-test write (a deferred service log? a missed cleanup?) and the rest of the file's tests cascade-fail with mysterious "row already exists" errors. Truncate-between-tests is the discipline that's easy to enforce and easy to debug.

**Implementation sketch:**

```ts
// apps/server/tests/e2e/helpers/db.ts
export async function resetDatabaseState(database: Database): Promise<void> {
  await database.client`
    TRUNCATE TABLE
      session_events,
      sessions,
      api_keys,
      usage_records,
      rate_limit_buckets,
      accounts
    RESTART IDENTITY CASCADE
  `;
}

export async function resetRedisState(redis: Redis): Promise<void> {
  await redis.flushdb();
}
```

Run as `beforeEach` on every spec file. Worker-init creates the schema and runs migrations once.

## Mock-driver determinism in e2e

The mock-driver trigger inputs from Phase 4 are reused. E2E tests use the same `https://error.driftstack-mock.test`, `https://timeout.driftstack-mock.test`, `https://http500.driftstack-mock.test`, selector `#nonexistent`, selector `#hangs`. **Tests must NEVER use real public URLs** (no `https://example.com`, no `https://google.com`) — the test contract is "mock driver routes by trigger input"; using a real URL pollutes the assumption.

The `customer-journey` spec is the one exception: it uses `https://example.com` to demonstrate the happy path with a recognisable URL. Documented in-spec.

Determinism guarantees the e2e suite makes:

1. Same input → same status code, same body shape (modulo timestamps and uuids).
2. Operations on the same session in the same order → same final session state.
3. Every error from the driver → the same `application/problem+json` response with the same `type` URI.

The mock-driver counter-based session ids (`mock_ses_00000001`, …) are predictable, but **tests must not assert on them** — they leak driver internals. Tests assert on the public `ses_<uuid>` ids, and rely on the Drizzle session row's autogenerated UUID.

## Route coverage map

| Endpoint                         | Happy                                                                                   | Error cases tested                                                                                                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/sessions`              | 201 with full shape, both `archetype` defaulted and supplied                            | 400 ValidationFailed (bad archetype slug, bad metadata shape) · 401 missing/invalid/revoked/expired key · 403 admin scope (n/a — create is read scope) · 429 ConcurrencyLimit (tier=free, second create) · 429 RateLimited (sessions:create bucket exhausted) |
| `GET /v1/sessions`               | empty list, populated list, pagination cursor round-trip                                | 401                                                                                                                                                                                                                                                           |
| `POST /v1/sessions/:id/navigate` | 200 status=200, 200 status=500 (http500 trigger), wait_until variants                   | 502 DriverError (network trigger), 504-equivalent timeout (timeout trigger), 404 NotFound (other-account session, missing id), 410 SessionDestroyed, 400 BadRequest (bad URL, wrong-prefix id), 401, 429                                                      |
| `POST /v1/sessions/:id/interact` | tap, type, scroll, press                                                                | 502 DriverError (#nonexistent), 410, 404, 401, 429                                                                                                                                                                                                            |
| `POST /v1/sessions/:id/wait`     | time-based, selector match, url match, selector_hidden                                  | 502 (selector never appears within timeout), 410, 404, 401, 429                                                                                                                                                                                               |
| `GET /v1/sessions/:id/state`     | initial null url/title, post-navigate populated                                         | 410, 404, 401, 429                                                                                                                                                                                                                                            |
| `POST /v1/sessions/:id/capture`  | screenshot, dom_snapshot, pdf, full_page=true                                           | 410, 404, 401, 429                                                                                                                                                                                                                                            |
| `DELETE /v1/sessions/:id`        | 204 first call, 204 second call (idempotent at HTTP) — but subsequent ops 410           | 404 unknown id, 401                                                                                                                                                                                                                                           |
| `POST /v1/api-keys`              | 201 with plaintext, scopes round-trip, ds*test* for free tier, ds*live* for paid        | 403 missing admin scope, 400 empty scopes, 400 too-long name, 401                                                                                                                                                                                             |
| `GET /v1/api-keys`               | empty list, multiple keys, plaintext never present                                      | 401                                                                                                                                                                                                                                                           |
| `DELETE /v1/api-keys/:id`        | 204 + idempotent re-delete                                                              | 404 unknown id, 403 missing admin scope, 401                                                                                                                                                                                                                  |
| `GET /v1/usage`                  | zero totals on fresh account, aggregated totals after recording, enterprise null quotas | 401                                                                                                                                                                                                                                                           |
| `GET /health`                    | 200 ok                                                                                  | none — public                                                                                                                                                                                                                                                 |
| `GET /openapi.json`              | 200 with `openapi: 3.1.0`                                                               | none — public                                                                                                                                                                                                                                                 |
| `GET /docs/`                     | 200 HTML                                                                                | none — public                                                                                                                                                                                                                                                 |

Total ~ 65–70 individual `test()` blocks across 7 spec files.

### Cross-cutting tests not tied to one endpoint

- **Customer journey (1 test):** create-account-with-admin-key → create another scoped key → use scoped key for session ops → revoke key → confirm subsequent ops 401 → check usage shows the recorded operations.
- **Concurrency limit by tier (1 per tier × 6 tiers = 6 tests):** seed account at tier T → create T's max sessions → 7th creation returns 429 ConcurrencyLimit with `current_sessions` and `limit` fields. Skip free tier's "1" case if it's already covered in sessions.spec.ts.
- **Rate-limit Lua atomicity (1 test):** seed `free`-tier account → fire 100 concurrent `Promise.all` requests with the same key against `/v1/whoami`-equivalent endpoint → assert exactly `60` succeed (the bucket capacity) and the rest are 429. Catches Lua script atomicity bugs the in-memory implementation can't surface.
- **Cross-account isolation (1 test):** account A creates session → account B's GET/POST against that session's id → 404 (not 403; matches the requireOwned policy).
- **OpenAPI contract validation (every endpoint):** for every endpoint, after a happy-path call, parse the response body against the corresponding response schema from `/openapi.json` (resolved via `$ref`). Fail the test if any field is missing or has the wrong type. This catches drift between the spec and the routes.

## OpenAPI contract validation strategy

Use `ajv` with `addSchema(spec.components.schemas)` and a `$ref` resolver, then validate response bodies in a custom Playwright matcher. Sketch:

```ts
const ajv = new Ajv({ strict: false }).addSchema(openapiSpec);
expect.extend({
  toMatchOpenApiResponse(received, opName: string) {
    const schema =
      openapiSpec.paths[opName].responses[received.statusCode].content['application/json'].schema;
    const validate = ajv.compile(schema);
    const ok = validate(received.body);
    return ok
      ? { pass: true, message: () => '' }
      : {
          pass: false,
          message: () => `OpenAPI validation failed: ${ajv.errorsText(validate.errors)}`,
        };
  },
});
```

If the spec generation in `lib/openapi.ts` ever drifts from what the route actually returns, this test fails immediately on the first happy-path call.

## Coverage targets

- **Endpoint coverage:** 100% of OpenAPI-declared endpoints have at least one e2e test of their happy path.
- **Documented-error coverage:** 100% of declared 4xx/5xx responses for each endpoint have an e2e test producing them. (The spec declares 400/401/403/404/410/429/502 across the surface.)
- **Line coverage target:** not a primary metric for e2e (already strong from unit + integration suites); aspirationally `>= 75%` on the routes/services/middleware layers when e2e is layered on top of the existing suites.
- **Mock driver trigger coverage:** all 5 trigger inputs (error host, timeout host, http500 host, #nonexistent selector, #hangs selector) exercised in at least one e2e test.
- **Tier coverage:** every tier (free / starter / solo / builder / scale / enterprise) seeded and exercised by at least one e2e test (concurrency-limit suite).

## CI integration

Update `.github/workflows/ci.yml` to run e2e as a second job that depends on the existing build-test job:

```yaml
e2e:
  name: End-to-end
  needs: build-test
  runs-on: ubuntu-latest
  services:
    postgres: ... # same image + creds as build-test
    redis: ...
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: '22', cache: 'npm' }
    - run: npm ci
    - run: npx playwright install --with-deps chromium # not strictly needed; we don't launch browsers, but Playwright still wants its deps for `request`
    - run: npm run build
    - run: npm run db:migrate
      env: { DATABASE_URL: postgres://driftstack:driftstack@localhost:5432/driftstack }
    - run: npm run test:e2e
      env: { DATABASE_URL: ..., REDIS_URL: redis://localhost:6379, NODE_ENV: test }
```

Local dev runs the same suite via `npm run test:e2e`, expecting `docker compose up -d` already running.

## Phase 9 perf approach (forward reference)

Phase 9 is gated on Phase 8 landing first; design here for continuity:

- **Load generator:** `autocannon` (Node-native, supports keep-alive + concurrency profiles). Alternative considered: k6 — better metrics, harder CI integration. Going with autocannon for tighter Node integration.
- **Targets:**
  - **100 RPS sustained for 5 minutes**, mixed read/write workload approximating customer journey: 70% navigate/interact (write-side), 20% getState (read-side), 10% session create/destroy.
  - **1000 RPS burst for 60 seconds**, GET-heavy (`/v1/sessions/:id/state`, `/v1/sessions`) — the cheapest endpoints, to stress the Fastify ↔ Postgres connection pool and the Redis Lua hot path.
  - **1-hour soak at 30 RPS**, mixed workload, capture RSS / heap / fd count every minute. Memory-leak detector compares first-quarter average to last-quarter average; failure threshold = 1.5× growth on any metric.
- **Metrics captured:**
  - Latency: p50 / p95 / p99 / p99.9, per endpoint
  - Throughput: actual RPS achieved vs target
  - Error rate: 5xx count, 4xx count (rate-limit-induced 429s expected and counted separately)
  - DB stats: query count per request, slowest query, connection-pool wait time (postgres-js exposes hooks)
  - Redis stats: ops/sec, memory used, slow log count
  - Process stats: RSS, heap, event-loop lag (every 5 s)
- **Pass criteria** (initial; revisable when first numbers come in):
  - 100 RPS sustained: p99 < 250 ms, error rate (excluding 429) = 0
  - 1000 RPS burst: server stays responsive (no 5xx), p99 may degrade to 1 s
  - 1-hour soak: no metric > 1.5× its first-quarter average; no 5xx

## Memory leak detection methodology

The 1-hour soak is the primary detection vector. Secondary mitigations baked into Phase 8 to prevent leaks reaching the soak:

1. **Per-test cleanup discipline.** Every `beforeEach` calls `resetDatabaseState` + `resetRedisState`. Every `afterEach` closes any per-test connections. The `test.afterAll` in each spec calls `cleanup()` which closes the server, Redis, and DB pool.
2. **Connection-pool ceiling test.** A dedicated test runs `1000` sequential requests against the same server instance and asserts the Postgres connection-pool size never exceeds the configured `max`. Catches the "open a new connection per request" anti-pattern.
3. **Driver session leak detector.** A test creates `100` sessions, destroys them all, calls a debug endpoint (added in Phase 9 if needed) that returns `MockDriver.sessions.size` — expects `0`. Already verifiable via the existing `destroy` semantics, but worth asserting end-to-end.
4. **Heap growth check across the suite.** Snapshot `process.memoryUsage().heapUsed` at suite start and end; total growth across ~70 e2e tests should stay under a flat allowance (e.g. 30 MB). Flags accidentally retained references in the Fastify request lifecycle.

## Risks / open questions

1. **Playwright `request` API + content-type negotiation.** Fastify defaults to `application/json` for object bodies; Playwright sends bodies as JSON via `data:` option, but the encoding of binary capture responses (base64 in `data` field, but the field is itself JSON) needs spot-checking. Plan: write the screenshot capture test first to surface any issues.
2. **Schema-per-worker ↔ migration concurrency.** If two workers race to apply migrations to their schemas, drizzle's migrate function may step on a global advisory lock. Tested locally during Phase 8 setup before scaling parallelism.
3. **Real-driver swap.** When Agent #1 hands off the WebKit driver, the e2e suite's mock-driver-trigger-input dependency becomes a problem — `https://error.driftstack-mock.test` is a mock-only URL. **Phase 8 doesn't solve this.** When the swap happens, the e2e suite should split: most tests stay against the mock; a smaller "smoke" suite runs against the real driver against a known stable site (TBD by founder + Agent #1).
4. **Dynamic port + parallelism.** `app.listen({ port: 0 })` lets Fastify pick a free port. Worker-level isolation already covers parallelism. But if Playwright workers run >1 spec each, intra-worker tests must reuse the worker's server — solved by `test.beforeAll` per file.

## Implementation order (P5)

1. Add `playwright.config.ts`, `apps/server/tests/e2e/helpers/{server,db,redis,seed,api}.ts`. Verify a smoke `/health` test passes locally against docker-compose.
2. `auth.spec.ts` — port the inject-suite to e2e first as the easiest mechanical translation.
3. `sessions.spec.ts` — full route map.
4. `admin.spec.ts`.
5. `customer-journey.spec.ts`.
6. `rate-limit.spec.ts` (concurrent Promise.all stresses Redis Lua).
7. `concurrency-limit.spec.ts` (one per tier).
8. `openapi-contract.spec.ts` (cross-cutting).
9. CI workflow update — second job, depends on build-test.
10. V-009 entry summarising results, including any newly-found empirical issues.

Each step lands as a separate commit, all green, all pushed to main per the D-007 push-to-main pattern.
