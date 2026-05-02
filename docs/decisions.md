# Driftstack API — Decision Log

Chronological record of decisions affecting the `driftstack-api` repo. Each entry is summary-level; full rationale lives in the V-log entry (when evidence-based) or in a planning doc (when strategic).

Format: `D-NNN — title (one line)`. Body links the V-log entry, lists the decision, the reasoning, and the autonomy tier per `CLAUDE.md`:

- **Tier 1** — implementation detail inside locked stack; agent decides
- **Tier 2** — vendor / dependency / structural; agent proposes, founder confirms
- **Tier 3** — affects API contract, CAPABILITIES.md, or WebKit-fork integration; founder decides

---

## D-001 — Locked stack baseline

- **Decision:** Node 22 LTS, TypeScript 5.x strict, Fastify, Drizzle on Postgres 17, ioredis on Redis 7, Zod (single source of truth, OpenAPI 3.1 generated), Vitest + Supertest + Playwright, Pino, Docker Compose, GitHub Actions.
- **Reasoning:** founder-set; chosen for tight TS ergonomics, codegen-friendly schemas, mature ecosystems, single-source validation/types.
- **Tier:** 3 (founder set; agent does not change without surfacing).
- **V-log:** V-001 captures the verified install + green typecheck/lint/test on this stack.

## D-002 — Workspace layout: `apps/server` + `packages/api-types`

- **Decision:** monorepo with two TypeScript project references — `apps/server` (the Fastify app) and `packages/api-types` (shared types/schemas exported for SDK consumers).
- **Reasoning:** matches the spec founder issued. `api-types` carves out the externalisable surface so a future TypeScript SDK can depend on it without pulling in the server. TS project references give incremental builds and prevent leaks across boundaries.
- **Tier:** 2 (structural; founder spec already implied this).
- **V-log:** V-001.

## D-003 — Strict TS configuration

- **Decision:** `tsconfig.base.json` enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`. ES2023 target. `NodeNext` module resolution.
- **Reasoning:** every guardrail we can enable now is paid for once and saves bugs later. `noUncheckedIndexedAccess` in particular catches the most common kind of "but it might be undefined" bug at the DB-query and route-params boundary.
- **Tier:** 1.
- **V-log:** V-001.

## D-004 — Tests live outside `rootDir`; separate `tsconfig.test.json`

- **Decision:** the build `tsconfig.json` includes only `src/**/*` (composite, emits declarations). A second `tsconfig.test.json` includes both `src/**/*` and `tests/**/*` for type-checking, with `noEmit`. The `typecheck` script runs both.
- **Reasoning:** TypeScript composite projects forbid sources outside `rootDir`. Mixing tests into the build leaks test types into emitted declarations and breaks downstream consumers. The two-tsconfig pattern keeps emit clean while still type-checking tests.
- **Tier:** 1.
- **V-log:** V-001.

## D-005 — ESLint with type-aware rules via `tsconfig.eslint.json`

- **Decision:** a third tsconfig (`tsconfig.eslint.json`) includes config files (`eslint.config.js`, `vitest.config.ts`, `drizzle.config.ts`), all source, and all tests. ESLint's `parserOptions.project` points at it.
- **Reasoning:** type-aware rules (`no-floating-promises`, `no-misused-promises`) catch real bugs but require every linted file to be in a TS project. The dedicated tsconfig is the documented pattern; `projectService` with glob allow-listing was tried first and rejected by typescript-eslint as too-wide.
- **Tier:** 1.
- **V-log:** V-001.

## D-006 — `engines: ">=22"` instead of pinning exactly to 22

- **Decision:** `package.json` requires Node `>=22`. Local dev machine has Node v25; CI pins to 22 LTS via `.nvmrc` and `actions/setup-node@v4`.
- **Reasoning:** founder's local Mac runs v25, locked stack says v22 LTS. The runtime artifacts are produced and tested against 22 in CI (the source of truth for shippability), and the `>=22` floor lets v25 dev work without warnings. Tightening to `=22` would require nvm dance for every local command and provide no real benefit until v26 ships breaking changes.
- **Tier:** 1.
- **V-log:** V-001.

## D-007 — Push-to-main, no PR workflow (mirrors WebKit agent)

- **Decision:** every commit is pushed directly to main. No PRs, no branches, no review workflow. Verification log + decision log capture the why.
- **Reasoning:** mirrors WebKit Agent #1's `D-12` pattern. Single founder, no other reviewers, two parallel agents — the per-feature PR ceremony has zero value and adds friction to autonomous work. The discipline is enforced by the V-log + decisions.md, not by gatekeeping.
- **Tier:** 2 (process; mirrors WebKit repo precedent).
- **V-log:** V-001.

## D-008 — License: MIT

- **Decision:** repo licensed MIT.
- **Reasoning:** matches WebKit fork repo policy stated in agent brief. Permissive enough that future SDK / customer integrations don't need a special license carve-out.
- **Tier:** 2 (founder confirmed in brief).
- **V-log:** V-001.

## D-009 — Phase 1 scope split: write everything; verify what we can; flag what we can't

- **Decision:** ship `docker-compose.yml` and the GitHub Actions CI workflow as part of Phase 1 even though Docker is not installed locally yet. End-to-end verification of the compose stack is deferred until founder installs Docker Desktop; CI verification of the same Postgres/Redis services happens automatically on first push (CI runs Postgres 17 and Redis 7 service containers in the same versions).
- **Reasoning:** the compose file is plain config, not code; mistakes in it surface the moment Docker is available. CI's service containers exercise the same image+config, so the first green CI run validates that the schema migrations and integration tests work against the real images. Holding the file back until local Docker is installed would block shipping the rest of Phase 1.
- **Tier:** 1.
- **V-log:** V-001 (verification deferred sub-section).

## D-010 — Password hashing: scrypt via `scrypt-kdf`

- **Decision:** API keys at rest are hashed with scrypt (`scrypt-kdf` package), not bcrypt.
- **Reasoning:** scrypt is memory-hard (resists GPU/ASIC attacks better than bcrypt for the same wall-clock cost), is in Node's built-in `crypto` module, and `scrypt-kdf` provides a clean encoded format. Spec says "bcrypt or scrypt" — picking scrypt and recording.
- **Tier:** 1.
- **V-log:** Phase 3 entry will record the empirical work-factor calibration.
