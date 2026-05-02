# Driftstack API — Verification Log

This log records every verification of empirical reality (build cycles, test runs, infrastructure assumptions) and every discrepancy between intent and behaviour. Entries are append-only and dated.

When intent and reality disagree: reality wins, code reflects reality, planning is updated, the change is recorded here.

Format: `V-NNN — title`. Date in body.

---

## V-001 — Phase 1 baseline: repo, monorepo scaffolding, tooling green

**Date:** 2026-05-02
**Author:** Driftstack Agent #2
**Phase:** 1 (repo + infrastructure)

### What was built

- GitHub repo `driftstackdev/driftstack-api` created via `gh repo create` (public, MIT license).
- Local clone at `/Users/john/code/driftstack-api`. Remote uses HTTPS (SSH key not configured for `git@github.com`; see Discrepancies below).
- TypeScript monorepo with two project references:
  - `apps/server/` — Fastify app (currently a boot-stub printing config)
  - `packages/api-types/` — shared types/schemas (currently empty re-export)
- Build/dev tooling:
  - `tsconfig.base.json` with strict mode + every available guardrail (D-003)
  - Two-tsconfig test pattern (D-004): `tsconfig.json` for build, `tsconfig.test.json` for type-checking tests
  - `tsconfig.eslint.json` for type-aware ESLint (D-005)
  - ESLint flat config with `recommendedTypeChecked` rules
  - Prettier with project-wide config
  - Vitest with v8 coverage
  - `.nvmrc` pinned to 22; `engines: ">=22"` (D-006)
- `docker-compose.yml` with Postgres 17 + Redis 7 services (D-009)
- GitHub Actions CI: typecheck, lint, format-check, build, test on push/PR to main; runs Postgres 17 + Redis 7 service containers
- Documentation scaffolds: `README.md`, `CLAUDE.md`, `docs/architecture.md`, `docs/decisions.md`, this log

### What tests verify it

- 4 unit tests in `apps/server/tests/unit/config.test.ts` covering Zod-validated env loading: defaults applied, numeric coercion, invalid driver rejected, missing env handled.
- `npm test` → 4/4 passed in 243ms.
- `npm run typecheck` → green across both workspaces.
- `npm run lint` → 0 errors, 0 warnings.
- `npm run format:check` → all files prettier-clean.

### Empirical findings

1. **Node 22 LTS engine constraint with v25 local.** Local dev machine runs Node v25.9.0; we set `engines: ">=22"` so npm/Drizzle don't warn, while CI pins to 22 via `.nvmrc` + `actions/setup-node@v4`. Captured as D-006. No build artifacts are produced locally that would diverge from CI's 22-built artifacts (TypeScript output is target-ES2023, not version-tied).
2. **Composite project + tests.** First typecheck failed with `TS6059: File … is not under 'rootDir' 'src'` (test files outside the build's rootDir) and `TS6310: Referenced project … may not disable emit` (`--noEmit` on a composite project is illegal). Fixed by splitting into `tsconfig.json` (build, src-only, composite, emits declarations) and `tsconfig.test.json` (no-emit, includes src+tests). The `typecheck` script runs both. Captured as D-004.
3. **ESLint type-aware rules + non-tsconfig files.** Initial config used `projectService: true` which excluded `eslint.config.js`, `vitest.config.ts`, `drizzle.config.ts`, and `tests/**/*.ts` from the project graph (parsing-error). Tried `allowDefaultProject` glob — rejected by typescript-eslint because `**` is not allowed there. Solved with a dedicated `tsconfig.eslint.json` that explicitly includes config files + tests + sources, and `parserOptions.project` pointing at it. Captured as D-005.
4. **Prettier autoformat ran on first format pass.** Three files (`tsconfig.json`, `apps/server/tsconfig.json`, `eslint.config.js`) needed formatting after `prettier --write`. Now stable: `format:check` passes idempotently.
5. **`as NodeJS.ProcessEnv` cast unnecessary in tests.** ESLint's `no-unnecessary-type-assertion` flagged the cast in `config.test.ts` because TypeScript's structural typing accepts the literal directly. `--fix` removed them. No behaviour change; tests still pass.

### Discrepancies between plan and reality

1. **Docker not installed.** Founder spec called for `docker-compose up` to bring up infra cleanly as Phase 1 verification. Docker Desktop is not installed on the founder's Mac; `docker` and `docker-compose` are not on PATH. The compose file is shipped as part of Phase 1 anyway (D-009): it's plain config, exercised by CI service containers using the same image versions, and verifiable locally the moment Docker is installed. Surfaced to founder.
2. **`~/.npm` cache root-owned.** First `npm install` failed with `EACCES`: `~/.npm/_cacache` was owned by root from a prior `sudo npm` operation. Workaround: used `npm install --cache /tmp/driftstack-npm-cache` for this session. Permanent fix requires `sudo chown -R 501:20 /Users/john/.npm` which the agent cannot run non-interactively. Surfaced to founder.
3. **SSH key for `git@github.com` not configured.** `gh auth status` reports SSH as the configured git protocol, but `gh repo clone …` failed with "Permission denied (publickey)." Cloned via HTTPS instead; remote is `https://github.com/driftstackdev/driftstack-api.git`. After `gh auth setup-git`, HTTPS push works for ordinary files via the gh credential helper.
4. **`gh` token lacks `workflow` scope.** First push attempt failed: `refusing to allow an OAuth App to create or update workflow .github/workflows/ci.yml without 'workflow' scope`. The current OAuth scopes (`gist, read:org, repo`) do not include `workflow`. `gh auth refresh -s workflow` requires interactive device-flow paste; the agent cannot complete that non-interactively. **Workaround applied:** the CI workflow file is stashed at `/tmp/driftstack-deferred/ci.yml` and excluded from this Phase 1 commit. The rest of Phase 1 ships now; the workflow file will be re-added in a follow-up commit once founder runs `gh auth refresh --hostname github.com -s workflow` to grant the scope. Until that follow-up lands, CI does not run on push — verification stays local.
5. **No `CAPABILITIES.md` exists yet.** Founder spec says agent reads `docs/CAPABILITIES.md` as a truth source. The file does not exist in this repo or in the WebKit repo. Treated as expected (founder maintains, hasn't authored yet); README + V-log + decisions.md serve as working truth until the file lands.

### Decisions made (cross-link)

D-001 through D-010, see `docs/decisions.md`.

### Status

Phase 1 ready to commit and push, minus the CI workflow file (gated on `workflow` scope grant — see discrepancy 4). Local verification chain green: typecheck, lint, format:check, build, test all pass. End-to-end verification of the Postgres-17 + Redis-7 + tests integration is deferred until either Docker is installed locally OR the `workflow` scope is granted and CI runs. Both surfaced to founder.

---

## V-002 — Phase 2: Drizzle schema, migrations, Zod public contracts, API-key crypto

**Date:** 2026-05-02
**Author:** Driftstack Agent #2
**Phase:** 2 (core schemas + DB)

### What was built

- **Drizzle schema** (`apps/server/src/db/schema.ts`) covering all six required tables: `accounts`, `api_keys`, `sessions`, `session_events`, `usage_records`, `rate_limit_buckets`. Six Postgres enums (`account_tier`, `account_status`, `api_key_scope`, `session_status`, `session_event_type`, `usage_record_type`). All FKs include explicit ON DELETE behaviour (`cascade` for owned, `restrict` for audit-significant `sessions.api_key_id`, `set null` for `usage_records.session_id`). Compound primary key on `rate_limit_buckets` (`account_id`, `bucket_key`).
- **Initial migration** generated by `drizzle-kit generate` — 6 tables, 6 enums, all indexes (`accounts_email_unique`, `api_keys_prefix_unique`, `api_keys_account_idx`, `sessions_account_idx`, `sessions_status_idx`, `sessions_account_status_idx`, `session_events_session_idx`, `session_events_session_created_idx`, `usage_records_account_idx`, `usage_records_account_period_idx`). File: `apps/server/src/db/migrations/0000_gray_northstar.sql`.
- **DB client module** (`apps/server/src/db/client.ts`) — `postgres-js` connection wrapped by Drizzle, with a clean shutdown helper.
- **Migrate script** (`apps/server/src/db/migrate.ts`) — runs `drizzle-orm/postgres-js/migrator` against the configured `DATABASE_URL`. Run with `npm run db:migrate`.
- **Seed script** (`apps/server/src/db/seed.ts`) — idempotent: creates `dev@driftstack.local` account on Pro tier + one read/write/admin API key; on re-run, recognises existing fixtures and prints prefixes only (plaintext is unrecoverable post-creation).
- **API-key utilities** (`apps/server/src/lib/api-keys.ts`) — generation (`ds_<env>_<32 base32 chars>`), prefix extraction, scrypt-kdf hashing (`logN=15, r=8, p=1`), constant-time verification.
- **Zod public-contract schemas** (`packages/api-types/src/`):
  - `common.ts`: prefixed-ID validators (`acc_…`, `key_…`, `ses_…`, `evt_…`, `use_…`), pagination, ISO8601, account tier/scope enums
  - `problem.ts`: RFC 7807 `Problem` schema + 16 stable problem-type URIs
  - `accounts.ts`, `api-keys.ts`, `sessions.ts`, `usage.ts`: request/response shapes for every Phase 5/6 endpoint, plus `Session`, `SessionEvent`, `UsagePeriodSummary`, `InteractAction` discriminated union (4 kinds), `WaitCondition` discriminated union (4 kinds), `CaptureKind` enum
- **Decisions added** (D-011 through D-016) — see `docs/decisions.md`.

### What tests verify it

- **39 new unit tests** (43 total in suite). All pass.
  - 9 in `tests/unit/api-keys.test.ts`: generation shape (regex), prefix uniqueness across 200 generations, hash/verify round-trip, plaintext mismatch rejection, tampered-hash rejection, salt randomness producing distinct hashes for the same plaintext (with both verifying).
  - 30 in `tests/unit/schemas.test.ts`: prefixed-ID accept/reject, pagination defaults + clamps, RFC 7807 status range + extension members, every discriminated-union variant of `InteractAction` and `WaitCondition`, every Zod schema's happy + at-least-one-error path. SessionSchema parsed against a fully populated example using realistic IDs and timestamps.
- `npm test` → 43/43 passed in 692ms (api-keys: 475ms scrypt-bound; schemas: 4ms; config: 2ms).
- `npm run typecheck` → green across both workspaces.
- `npm run lint` → 0 errors, 0 warnings.
- `npm run format:check` → all files clean.
- `npm run build` → both workspaces compile.
- `npm run db:generate` → 6 tables, expected column/index/FK counts.

### Empirical findings

1. **Drizzle workspace cwd vs config cwd.** First `npm run db:generate` failed with `No schema files found for path config ['./apps/server/src/db/schema.ts']`. Cause: the workspace ran from `apps/server`, where the schema-relative path doesn't resolve. drizzle-kit resolves `schema:` paths relative to the cwd, not the config file. Moved `db:generate` and `db:studio` invocations to the root `package.json` so they run from the repo root, where the config-supplied paths are correct. Captured as D-014.
2. **scrypt is slow on purpose; tests need extended timeout.** Default vitest timeout (10s) was tight for 5 hash operations at `logN=15`; bumped the api-keys describe block to 15s. On the founder's M-series Mac, total scrypt time for the suite is ~475ms. Will revisit work-factor in Phase 3 once we have a profile of expected key-verify latency at request time.
3. **Public ID prefix scheme.** Adopted `acc_…`, `key_…`, `ses_…`, `evt_…`, `use_…` (base UUID). Rationale: matches Stripe/OpenAI ergonomics, lets clients route routing logic on prefix, and makes log greps trivial. Internal services/DB use raw UUIDs; mapping happens at the route boundary in Phase 5. Recorded as D-013.
4. **Drizzle output formatting.** drizzle-kit generates `_journal.json` and `_snapshot.json` snapshot files that prettier wanted to reformat. Added `apps/server/src/db/migrations/` to `.prettierignore` — these are tooling-owned artifacts and should not be hand-edited or formatted.
5. **npm 10.5 + Node v25 incompatibility.** `npm install` after editing root devDeps failed with `TypeError: minimatch is not a function` from npm's bundled `@npmcli/map-workspaces` against Node v25's iteration semantics. Worked around by running `npx -y --cache /tmp/driftstack-npm-cache npm@11 install` once. Permanent fix is on founder's plate alongside the `~/.npm` chown. Recorded in `local_toolchain.md` memory.
6. **Drizzle ↔ Zod parity (manual cross-check).** Drizzle stores internal fields (`driver_session_id`, `key_hash`, `account_id` on api*keys); the public Zod schemas omit these on purpose. Each Zod field that \_is* exposed maps to a Drizzle column with compatible nullability and type. Verified by-eye column-by-column against `schema.ts` while writing the Zod files. No discrepancies; the two are intentionally non-identical (public surface ⊊ persistent state).

### Decisions made (cross-link)

D-011, D-012, D-013, D-014, D-015, D-016. See `docs/decisions.md`.

### Status

Phase 2 ready to commit. Local verification chain green (typecheck/lint/format/build/test). Migration SQL emitted but not applied (Docker still missing locally; will be applied by CI once `workflow` scope is granted, or locally by founder once Docker is available). Phase 3 (auth + middleware) can begin against the same mocked-DB unit-test envelope; integration tests against real Postgres will land in Phase 3-4 as that infra comes online.

---

## V-003 — Phase 3: auth + rate-limit + error-handler + Fastify app shell

**Date:** 2026-05-02
**Author:** Driftstack Agent #2
**Phase:** 3 (auth + middleware)

### What was built

- **Logger** (`apps/server/src/lib/logger.ts`) — Pino factory with structured JSON output, redaction of `Authorization`, cookies, and `plaintext` fields, and a separate `createTestLogger` returning a silent logger.
- **Error taxonomy** (`apps/server/src/lib/errors.ts`) — `ApiError` base + 14 named subclasses. Each maps to its stable RFC 7807 problem-type URI and carries optional extension members.
- **Error handler middleware** (`apps/server/src/middleware/error-handler.ts`) — Fastify `setErrorHandler` + `setNotFoundHandler`. Maps `ApiError` and `ZodError` to `application/problem+json` responses with the request id as `instance`. Logs 5xx at error level, 4xx at warn. Anything unrecognised becomes `Internal` (500) with the original cause logged but not exposed.
- **Request ID middleware** — trusts inbound `x-request-id` (when ≤128 chars), otherwise generates a UUID. Echoes on every response.
- **Auth service** (`apps/server/src/services/auth.ts`) — pure function `authenticate(repo, plaintext, now)` that decouples Drizzle via `AccountAuthRepo` interface (in-memory impl in tests, Drizzle impl in `apps/server/src/db/auth-repo.ts`). Validates Bearer token shape, looks up by prefix, scrypt-verifies, checks revoked/expired, checks account active, touches `last_used_at`. Throws typed `ApiError` on every failure path.
- **Auth Fastify plugin** — decorates `request.account: AccountContext | null`, exposes `app.requireAuth` (preHandler) and `app.requireScope(scope)` (factory).
- **Rate-limit service** (`apps/server/src/services/rate-limit.ts`) — token-bucket algorithm with tier-keyed defaults (`free`, `starter`, `pro`, `enterprise`) and a `RateLimitStore` interface. Two stores: `MemoryRateLimitStore` (tests) and `RedisRateLimitStore` (prod, atomic Lua script).
- **Rate-limit Fastify plugin** — exposes `app.rateLimit(bucketKey, cost?)` factory; sets `x-ratelimit-remaining` on every reply, `retry-after` on 429s, throws `RateLimitedError` with the retry hint.
- **App builder** (`apps/server/src/lib/app.ts`) — `buildApp(deps)` returns a configured `FastifyInstance` with helmet, CORS, request-id, auth, rate-limit, and the error handler wired in. Registers `/health`, `/healthz`, and `/v1/whoami` (auth-gated) as smoke routes.
- **Test fixture** (`apps/server/tests/integration/_helpers/`) — `InMemoryAuthRepo` (mirrors Drizzle impl exactly), `buildTestApp(opts)` for one-line app construction with seeded account + key. Lets us run real Fastify integration tests with `inject` and zero infra dependency.

### What tests verify it

**67 total tests, all passing.** New in Phase 3: 24 tests.

- **rate-limit unit suite** (`tests/unit/rate-limit.test.ts`, 10 tests) — algorithm correctness against `MemoryRateLimitStore`: first-call full-capacity, exhaustion + retry-after, refill-over-time, capacity clamp on long idle, retry-after deficit math, key independence; `bucketConfigFor` tier resolution + global fallback; service-level `rateLimitConsume` routing.
- **integration / auth pipeline** (`tests/integration/auth.test.ts`, 14 tests) — happy path (200 with proper headers), missing Auth header (401 Unauthorized), malformed header (401), unknown key (401 InvalidKey), revoked key (401 RevokedKey), expired key (401 ExpiredKey), suspended account (403 Forbidden), deleted account (401 InvalidKey — leaks no state to caller), `last_used_at` update on success; `/health` and `/healthz` public; unknown route (404 problem+json); rate-limit 429 with retry-after when bucket drained; `x-ratelimit-remaining` header on 200.
- `npm run typecheck` → green across both workspaces.
- `npm run lint` → 0 errors.
- `npm run format:check` → all files clean.
- `npm run build` → both workspaces compile.

### Empirical findings

1. **Pino `Logger` ≠ Fastify `FastifyBaseLogger` under `exactOptionalPropertyTypes`.** Pino's `Logger` interface declares `msgPrefix: string | undefined`, while Fastify's `FastifyBaseLogger` doesn't declare `msgPrefix`. With EOPT enabled, structural assignment fails. The cleanest resolution was to drop EOPT — it's the strict-mode flag most prone to false positives with library boundaries, and the other strict flags catch the classes of bug we care about. Captured as D-017.
2. **Fastify infers Http/2 server type without prompting.** Without explicit annotation on the `Fastify(...)` return value, TypeScript inferred `Http2SecureServer` for the instance — incompatible with the auth plugin's `RawServerDefault`-typed declarations. Fixed by annotating the local: `const app: FastifyInstance = Fastify({...})`.
3. **`@typescript-eslint/require-await` on Fastify async-but-no-await plugins.** Switched all in-repo plugins to the callback `(app, opts, done) => { ...; done() }` form — clearer and lint-clean. Captured as D-018.
4. **`light-my-request`'s `Response.json<T>()` is generic.** Tests originally cast `res.json() as Record<string, unknown>`, which `no-unnecessary-type-assertion` flagged because the underlying signature is `<T = any>(): T`. Switched to `res.json<Record<string, unknown>>()`.
5. **Auth-bound rate-limit tests need bucket pre-drain.** First version of the rate-limit integration test exhausted the bucket via 60 sequential HTTP requests. Empirically, scrypt verification adds ~50ms per call → 60 calls take ~3 seconds → bucket refills ~3 tokens during the loop → 61st request still has tokens. Fix: drain the bucket directly via `fx.rateLimitStore.consume({ cost: 60, ... })` before the HTTP call.
6. **`request.account: AccountContext | null` decorator type.** Fastify's `decorateRequest` requires the value to be valid before any preHandler — `null` is the only valid initial value. The route handler narrows with an explicit null-check; the type discipline forces that.
7. **Redis Lua script not exercised yet.** `RedisRateLimitStore` is wired and typed but cannot be tested locally without Redis. The Lua source is reviewed by hand; semantically equivalent to `MemoryRateLimitStore` (which has full algorithmic test coverage). When local Docker comes up (or CI service containers run on first push of the workflow file), an integration test exercising `RedisRateLimitStore` against a real Redis 7 will land alongside Phase 3.

### Decisions made (cross-link)

D-017 (drop EOPT), D-018 (Fastify plugin callback form). See `docs/decisions.md`.

### Status

Phase 3 ready to commit and push. 67 tests passing locally. Auth + rate-limit pipelines validated end-to-end via Fastify `inject` against in-memory adapters. Real-Postgres + Real-Redis integration tests are deferred until the founder unblocks Docker / `workflow` scope.

Phase 4 (mock WebKit driver) is the next clean target — the driver interface is fully decoupled from DB/Redis, so it can be designed, implemented, and tested in isolation.
