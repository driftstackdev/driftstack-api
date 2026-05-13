// W560.B — drift guard for /docs/architecture/phase-8-e2e-design.md.
// Phase-8 e2e design pre-implementation. Drift here either weakens
// the schema-per-worker test-isolation discipline, drops the 5-goal
// rationale (HTTP-layer + Drizzle + Redis-Lua + customer-journey +
// OpenAPI-contract), or loosens the 100%-endpoint + 100%-error-
// coverage targets.
//
//   • Phase-8 design, NOT implementation. Pre-implementation per
//     founder request.
//   • 5 goals: HTTP layer + Drizzle real-Postgres + Redis-Lua +
//     customer-journey + OpenAPI contract validation.
//   • 4 non-goals (perf + real-WebKit + multi-tenant-load + DOM-UI).
//   • Playwright Test runner + request API; not browser context.
//   • Schema-per-worker isolation; per-test TRUNCATE-CASCADE.
//   • Real-driver-swap risk: mock-only URLs break when WebKit lands.
//   • Coverage: 100% endpoint + 100% documented-error + tier-each.
//   • CI: e2e as second job, depends on build-test.
//   • Phase-9-perf forward-ref: autocannon + 100/1000/30-RPS targets.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/architecture/phase-8-e2e-design.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W560.B /docs/architecture/phase-8-e2e-design.md content parity', () => {
  const body = read(LIB);

  it("Header + design-draft + 5-goal framing pinned: '# Phase 8 — End-to-End Test Design' + 'Status: design draft, ready for execution.' + 'Authored before implementation per founder request.' + 'The existing 123-test suite covers unit-level correctness and middleware-level integration via Fastify's `inject()`.' + 'Phase 8 adds **end-to-end** coverage' + '**HTTP layer behaviours that don't surface through `inject`** — keep-alive, content-length parsing, header case mangling' + '**Drizzle queries against real Postgres.**' + '**Redis Lua atomic rate-limit script.**' + '`RedisRateLimitStore` was built but never exercised' + '**Customer journey continuity.**' + '**Empirical correctness against the OpenAPI contract.**' + 'every endpoint × every documented happy path × every documented error path. No \"good enough.\"' — pinned so the design-draft-pre-implementation + 123-test-baseline + 5-goal (HTTP-layer + Drizzle-real-Postgres + Redis-Lua + customer-journey + OpenAPI-contract) + every-endpoint-every-error-no-good-enough commitment survives", () => {
    expect(body).toMatch(/^# Phase 8 — End-to-End Test Design$/m);
    expect(body).toMatch(/Status: design draft, ready for execution\./);
    expect(body).toMatch(/Authored before implementation per founder request\./);
    expect(body).toMatch(
      /The existing 123-test suite covers unit-level correctness and middleware-level integration via Fastify's `inject\(\)`\./,
    );
    expect(body).toMatch(/Phase 8 adds \*\*end-to-end\*\* coverage/);
    expect(body).toMatch(
      /\*\*HTTP layer behaviours that don't surface through `inject`\*\* — keep-alive, content-length parsing, header case mangling/,
    );
    expect(body).toMatch(/\*\*Drizzle queries against real Postgres\.\*\*/);
    expect(body).toMatch(/\*\*Redis Lua atomic rate-limit script\.\*\*/);
    expect(body).toMatch(/`RedisRateLimitStore` was built but never exercised/);
    expect(body).toMatch(/\*\*Customer journey continuity\.\*\*/);
    expect(body).toMatch(/\*\*Empirical correctness against the OpenAPI contract\.\*\*/);
    expect(body).toMatch(
      /every endpoint × every documented happy path × every documented error path\. No "good enough\."/,
    );
  });

  it("Non-goals + stack framing pinned: '## Non-goals (Phase 8)' + '**Performance** — that's Phase 9.' + '**Real WebKit driver** — still mocked via the `MockDriver`.' + '**Multi-tenant load testing** — also Phase 9.' + '**Browser-based UI tests** — Driftstack is API-only; no DOM, no clicks.' + 'Playwright is used purely as the HTTP client + test runner.' + '## Stack' + '**Test runner:** Playwright Test (`@playwright/test`, already in devDependencies).' + 'Use `request` (its built-in HTTP client) — not the browser context.' + '**Infra:** local docker-compose (Postgres 17 + Redis 7, ports 5432 / 6379)' + 'CI uses GH Actions service containers' + '**App:** the same Fastify `buildApp` from `apps/server/src/lib/app.ts`' + '_Drizzle_ repos (not the in-memory ones) and the _Redis_ rate-limit store.' + '**Listening:** server bound to `127.0.0.1:<dynamic port>` per test worker' — pinned so the 4-non-goal (perf + WebKit + multi-tenant-load + DOM-UI) + Playwright-request-not-browser + Postgres-17-Redis-7-5432/6379 + Drizzle-real-repos + 127.0.0.1-dynamic-port commitment survives", () => {
    expect(body).toMatch(/## Non-goals \(Phase 8\)/);
    expect(body).toMatch(/- \*\*Performance\*\* — that's Phase 9\./);
    expect(body).toMatch(/- \*\*Real WebKit driver\*\* — still mocked via the `MockDriver`\./);
    expect(body).toMatch(/- \*\*Multi-tenant load testing\*\* — also Phase 9\./);
    expect(body).toMatch(
      /- \*\*Browser-based UI tests\*\* — Driftstack is API-only; no DOM, no clicks\./,
    );
    expect(body).toMatch(/Playwright is used purely as the HTTP client \+ test runner\./);
    expect(body).toMatch(/## Stack/);
    expect(body).toMatch(
      /- \*\*Test runner:\*\* Playwright Test \(`@playwright\/test`, already in devDependencies\)\./,
    );
    expect(body).toMatch(/Use `request` \(its built-in HTTP client\) — not the browser context\./);
    expect(body).toMatch(
      /- \*\*Infra:\*\* local docker-compose \(Postgres 17 \+ Redis 7, ports 5432 \/ 6379\)/,
    );
    expect(body).toMatch(/CI uses GH Actions service containers/);
    expect(body).toMatch(
      /- \*\*App:\*\* the same Fastify `buildApp` from `apps\/server\/src\/lib\/app\.ts`/,
    );
    expect(body).toMatch(
      /_Drizzle_ repos \(not the in-memory ones\) and the _Redis_ rate-limit store\./,
    );
    expect(body).toMatch(
      /- \*\*Listening:\*\* server bound to `127\.0\.0\.1:<dynamic port>` per test worker/,
    );
  });

  it("Directory + 8-spec-file + 7-helper framing pinned: '## Directory layout' + 'apps/server/tests/e2e/' + 'playwright.config.ts' + 'helpers/' + 'server.ts                 # Boot a real Fastify server in-process for the test' + 'db.ts                     # Reset Postgres state between test files' + 'redis.ts                  # FLUSHDB between test files' + 'seed.ts                   # Programmatic test-data fixtures' + 'api.ts                    # Tiny typed wrapper around request, with auth helpers' + 'auth.spec.ts                  # Auth + key lifecycle, scope checks, last_used_at' + 'sessions.spec.ts              # All 8 session endpoints × happy + every error' + 'admin.spec.ts                 # POST/GET/DELETE /v1/api-keys, GET /v1/usage' + 'customer-journey.spec.ts      # Full create-key → session → ops → destroy flow' + 'rate-limit.spec.ts            # Real Redis Lua exercised; concurrent contention' + 'concurrency-limit.spec.ts     # Tier concurrent-session caps with real DB count' + 'openapi-contract.spec.ts      # Every response validates against /openapi.json' — pinned so the apps/server/tests/e2e/-layout + playwright.config + 5-helper + 7-spec-file commitment survives", () => {
    expect(body).toMatch(/## Directory layout/);
    expect(body).toMatch(/apps\/server\/tests\/e2e\//);
    expect(body).toMatch(/playwright\.config\.ts/);
    expect(body).toMatch(/helpers\//);
    expect(body).toMatch(/server\.ts\s+# Boot a real Fastify server in-process for the test/);
    expect(body).toMatch(/db\.ts\s+# Reset Postgres state between test files/);
    expect(body).toMatch(/redis\.ts\s+# FLUSHDB between test files/);
    expect(body).toMatch(/seed\.ts\s+# Programmatic test-data fixtures/);
    expect(body).toMatch(/api\.ts\s+# Tiny typed wrapper around request, with auth helpers/);
    expect(body).toMatch(/auth\.spec\.ts\s+# Auth \+ key lifecycle, scope checks, last_used_at/);
    expect(body).toMatch(/sessions\.spec\.ts\s+# All 8 session endpoints × happy \+ every error/);
    expect(body).toMatch(/admin\.spec\.ts\s+# POST\/GET\/DELETE \/v1\/api-keys, GET \/v1\/usage/);
    expect(body).toMatch(
      /customer-journey\.spec\.ts\s+# Full create-key → session → ops → destroy flow/,
    );
    expect(body).toMatch(
      /rate-limit\.spec\.ts\s+# Real Redis Lua exercised; concurrent contention/,
    );
    expect(body).toMatch(
      /concurrency-limit\.spec\.ts\s+# Tier concurrent-session caps with real DB count/,
    );
    expect(body).toMatch(
      /openapi-contract\.spec\.ts\s+# Every response validates against \/openapi\.json/,
    );
  });

  it("Schema-per-worker + mock-driver framing pinned: '## Test data lifecycle' + 'The single hardest e2e question.' + 'Three options considered:' + '**Decision: schema-per-worker.** Each Playwright worker creates its own schema' + 'Between tests, the worker truncates all tables (FK-aware ordering: session_events → sessions → api_keys → accounts; usage_records → accounts; rate_limit_buckets → accounts).' + 'Redis FLUSHDB between tests on the worker's dedicated DB index (Redis supports 16 logical DBs by default — workers get DB 1, 2, 3, etc.; DB 0 stays for dev).' + '**Why not per-test DB:** migration cost.' + '**Why not the shared-DB-with-prefix approach:** one accidental cross-test write' + '## Mock-driver determinism in e2e' + '**Tests must NEVER use real public URLs**' + '`https://error.driftstack-mock.test`, `https://timeout.driftstack-mock.test`, `https://http500.driftstack-mock.test`, selector `#nonexistent`, selector `#hangs`.' + 'The `customer-journey` spec is the one exception: it uses `https://example.com`' — pinned so the 3-options-table + schema-per-worker-decision + FK-truncate-ordering + Redis-16-DB-workers-1-2-3-DB-0-dev + 5-mock-trigger-URL + customer-journey-example.com-exception commitment survives", () => {
    expect(body).toMatch(/## Test data lifecycle/);
    expect(body).toMatch(/The single hardest e2e question\./);
    expect(body).toMatch(/Three options considered:/);
    expect(body).toMatch(
      /\*\*Decision: schema-per-worker\.\*\* Each Playwright worker creates its own schema/,
    );
    expect(body).toMatch(
      /Between tests, the worker truncates all tables \(FK-aware ordering: session_events → sessions → api_keys → accounts; usage_records → accounts; rate_limit_buckets → accounts\)\./,
    );
    expect(body).toMatch(
      /Redis FLUSHDB between tests on the worker's dedicated DB index \(Redis supports 16 logical DBs by default — workers get DB 1, 2, 3, etc\.; DB 0 stays for dev\)\./,
    );
    expect(body).toMatch(/\*\*Why not per-test DB:\*\* migration cost\./);
    expect(body).toMatch(
      /\*\*Why not the shared-DB-with-prefix approach:\*\* one accidental cross-test write/,
    );
    expect(body).toMatch(/## Mock-driver determinism in e2e/);
    expect(body).toMatch(/\*\*Tests must NEVER use real public URLs\*\*/);
    expect(body).toMatch(
      /`https:\/\/error\.driftstack-mock\.test`, `https:\/\/timeout\.driftstack-mock\.test`, `https:\/\/http500\.driftstack-mock\.test`, selector `#nonexistent`, selector `#hangs`\./,
    );
    expect(body).toMatch(
      /The `customer-journey` spec is the one exception: it uses `https:\/\/example\.com`/,
    );
  });

  it("Coverage targets + CI + Phase-9-perf framing pinned: '## Coverage targets' + '**Endpoint coverage:** 100% of OpenAPI-declared endpoints' + '**Documented-error coverage:** 100% of declared 4xx/5xx responses' + '**Line coverage target:** not a primary metric for e2e' + '`>= 75%` on the routes/services/middleware layers' + '**Mock driver trigger coverage:** all 5 trigger inputs' + '**Tier coverage:** every tier (free / starter / solo / builder / scale / enterprise)' + '## CI integration' + 'Update `.github/workflows/ci.yml` to run e2e as a second job that depends on the existing build-test job' + '## Phase 9 perf approach (forward reference)' + '**Load generator:** `autocannon`' + '**100 RPS sustained for 5 minutes**' + '**1000 RPS burst for 60 seconds**' + '**1-hour soak at 30 RPS**' + '100 RPS sustained: p99 < 250 ms, error rate (excluding 429) = 0' + '1000 RPS burst: server stays responsive (no 5xx), p99 may degrade to 1 s' + '1-hour soak: no metric > 1.5× its first-quarter average; no 5xx' — pinned so the 100%-endpoint + 100%-documented-error + 75%-line-aspirational + 5-mock-trigger + 6-tier-coverage + e2e-second-job-depends-build-test + autocannon + 100/1000/30-RPS-target commitment survives", () => {
    expect(body).toMatch(/## Coverage targets/);
    expect(body).toMatch(/- \*\*Endpoint coverage:\*\* 100% of OpenAPI-declared endpoints/);
    expect(body).toMatch(
      /- \*\*Documented-error coverage:\*\* 100% of declared 4xx\/5xx responses/,
    );
    expect(body).toMatch(/- \*\*Line coverage target:\*\* not a primary metric for e2e/);
    expect(body).toMatch(/`>= 75%` on the routes\/services\/middleware layers/);
    expect(body).toMatch(/- \*\*Mock driver trigger coverage:\*\* all 5 trigger inputs/);
    expect(body).toMatch(
      /- \*\*Tier coverage:\*\* every tier \(free \/ starter \/ solo \/ builder \/ scale \/ enterprise\)/,
    );
    expect(body).toMatch(/## CI integration/);
    expect(body).toMatch(
      /Update `\.github\/workflows\/ci\.yml` to run e2e as a second job that depends on the existing build-test job/,
    );
    expect(body).toMatch(/## Phase 9 perf approach \(forward reference\)/);
    expect(body).toMatch(/\*\*Load generator:\*\* `autocannon`/);
    expect(body).toMatch(/\*\*100 RPS sustained for 5 minutes\*\*/);
    expect(body).toMatch(/\*\*1000 RPS burst for 60 seconds\*\*/);
    expect(body).toMatch(/\*\*1-hour soak at 30 RPS\*\*/);
    expect(body).toMatch(/100 RPS sustained: p99 < 250 ms, error rate \(excluding 429\) = 0/);
    expect(body).toMatch(
      /1000 RPS burst: server stays responsive \(no 5xx\), p99 may degrade to 1 s/,
    );
    expect(body).toMatch(/1-hour soak: no metric > 1\.5× its first-quarter average; no 5xx/);
  });

  it("Memory-leak + Risk + Implementation-order framing pinned: '## Memory leak detection methodology' + 'The 1-hour soak is the primary detection vector.' + '**Per-test cleanup discipline.**' + '**Connection-pool ceiling test.**' + '**Driver session leak detector.**' + '**Heap growth check across the suite.**' + '## Risks / open questions' + '**Playwright `request` API + content-type negotiation.**' + '**Schema-per-worker ↔ migration concurrency.**' + '**Real-driver swap.** When the WebKit fork hands off the real driver' + '`https://error.driftstack-mock.test` is a mock-only URL.' + 'when the WebKit fork's Phase 2 closes' + '**Dynamic port + parallelism.**' + '## Implementation order (P5)' + 'Each step lands as a separate commit, all green, all pushed to main per the D-007 push-to-main pattern.' — pinned so the 4-soak-mitigation + 4-risk (Playwright-content-type + schema-migration-concurrency + real-driver-swap-WebKit-Phase-2 + dynamic-port-parallelism) + D-007-push-to-main commitment survives", () => {
    expect(body).toMatch(/## Memory leak detection methodology/);
    expect(body).toMatch(/The 1-hour soak is the primary detection vector\./);
    expect(body).toMatch(/1\. \*\*Per-test cleanup discipline\.\*\*/);
    expect(body).toMatch(/2\. \*\*Connection-pool ceiling test\.\*\*/);
    expect(body).toMatch(/3\. \*\*Driver session leak detector\.\*\*/);
    expect(body).toMatch(/4\. \*\*Heap growth check across the suite\.\*\*/);
    expect(body).toMatch(/## Risks \/ open questions/);
    expect(body).toMatch(/1\. \*\*Playwright `request` API \+ content-type negotiation\.\*\*/);
    expect(body).toMatch(/2\. \*\*Schema-per-worker ↔ migration concurrency\.\*\*/);
    expect(body).toMatch(
      /3\. \*\*Real-driver swap\.\*\* When the WebKit fork hands off the real driver/,
    );
    expect(body).toMatch(/`https:\/\/error\.driftstack-mock\.test` is a mock-only URL\./);
    expect(body).toMatch(/when the WebKit fork's Phase 2 closes/);
    expect(body).toMatch(/4\. \*\*Dynamic port \+ parallelism\.\*\*/);
    expect(body).toMatch(/## Implementation order \(P5\)/);
    expect(body).toMatch(
      /Each step lands as a separate commit, all green, all pushed to main per the D-007 push-to-main pattern\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
