# Driftstack API — Agent context

## ⚠️ Read this first

This repo is **driftstack-api** — the customer-facing API and control plane for Driftstack. It is owned by **Agent #2**. Agent #1 owns the WebKit fork (`/Users/john/code/webkit-driftstack`); the two repos do not share files. The mock WebKit driver in `apps/server/src/drivers/mock.ts` is the contract that decouples the two; the real WebKit driver swaps in once the fork's Phase 2 closes.

If you're tempted to reach into the WebKit fork to understand "what the driver should do," **stop**. The interface is the boundary. If the contract is unclear, surface to the founder rather than coupling to fork details.

## ⚠️ Repository scope

The codebase is **pure engineering**. Business and legal/compliance content lives outside any repo (founder handles that as a separate private track). The agent does not generate business framing, legal posture, customer-facing copy, marketing language, billing integration code, or compliance documentation in this repo.

If a technical decision genuinely depends on something outside the agent's scope (e.g., "this stage is gated on KvK closure"), surface as an open dependency.

**Out of scope (separate workstreams or future phases):**

- GUI client (Electron/Tauri)
- WebRTC streaming layer
- Behavioural simulation library (file 64) — Phase 3
- Recipe library — Phase 3
- Mac mini fleet provisioning — gated on first customer
- Marketing website
- Billing integration (Stripe/Mollie) — gated on KvK closure
- Customer dashboard frontend
- Behavioural data collection

If a request implies any of these, surface to founder rather than expanding scope.

## ⚠️ The standard

The standard is not "good enough to ship." The standard is **every API response correct against the OpenAPI spec, every error case has a handler and a test, every endpoint has integration tests covering happy path + every documented error path, mock driver behaviour is deterministic and faithful to what the real WebKit driver will do**.

Specifically:

- Every endpoint has Zod schemas for request and response. OpenAPI spec is generated from Zod — there is no second source of truth.
- Every error case maps to an RFC 7807 `application/problem+json` response with a stable `type` URI.
- Every authenticated endpoint has tests for: happy path, missing key, invalid key, revoked key, rate limit hit, ownership violation (where applicable).
- Mock driver is **deterministic**: same inputs → same outputs, with simulated latency that's controlled by config. Never fake a success the real driver would fail; never randomise behaviour the real driver wouldn't randomise.
- Integration tests run against a real Postgres + Redis (the docker-compose services or CI service containers). No mocking the database.

## ⚠️ CAPABILITIES.md as truth source

The founder maintains `docs/CAPABILITIES.md` (when it exists). It defines what the API claims to do — every documented capability must work end-to-end. The agent reads it before claiming any capability; the agent does **not** edit it autonomously. If the implementation deviates from CAPABILITIES.md, surface the gap to the founder rather than silently changing scope.

If `docs/CAPABILITIES.md` does not yet exist, that's fine — Phase 1 predates it. Treat the README + verification log as the working truth until the founder lands the file.

## Locked tech stack

Don't change without surfacing to founder:

- Node.js 22 LTS · TypeScript 5.x strict
- Fastify · Drizzle (Postgres 17) · ioredis (Redis 7)
- Zod (single source of truth, OpenAPI 3.1 generated from it)
- Custom API keys (long-lived, scoped, revocable; scrypt-hashed at rest)
- Vitest unit + Supertest integration + Playwright e2e
- Pino structured JSON logging
- Docker Compose dev infra · GitHub Actions CI

## Operational discipline

### Verification log (`/docs/verification-log.md`)

Append-only V-NNN entries. Each substantive change lands with one entry covering: what was built, what tests verify it, empirical findings, decisions made. When something doesn't work as expected, the entry records the discrepancy — reality wins, code reflects reality, planning gets updated.

### Decision log (`/docs/decisions.md`)

D-NNN entries: stack decisions, architecture decisions, naming decisions. Body links the V-log entry that carries the full reasoning, and notes the autonomy tier:

- **Tier 1** — implementation details inside the locked stack. Agent decides; recorded.
- **Tier 2** — vendor / dependency / structural choices. Agent proposes, founder confirms.
- **Tier 3** — anything affecting CAPABILITIES.md, the API contract, or the WebKit-fork integration approach. Founder decides; agent surfaces.

### Push-to-main pattern

Every commit is pushed directly to main. No PR-per-feature workflow. Founder may check progress remotely. Don't batch a session's work into one commit; land logical units, verify each (typecheck + lint + tests), push, continue.

### Empirical framing

Findings format: empirical results with attribution. No "good enough" framing on broken endpoints, missing error handling, or missing tests. Spot-check empirical: predict before testing; verify before committing.

## Decision authority

Autonomous (Tier 1):

- Implementation details within the locked stack
- Test coverage decisions
- Database schema details inside Phase 2 boundaries
- Error code design within RFC 7807
- Logging structure
- Internal module organisation

Surface to founder (Tier 3):

- Stack changes
- API contract changes (new endpoints, breaking existing)
- Decisions affecting CAPABILITIES.md
- Changes to the WebKit-fork integration approach (driver interface)
- Database schema growth beyond reasonable bounds

## Build cycle (workspace-level)

A clean iteration:

```bash
npm run typecheck   # strict TS across all workspaces
npm run lint        # eslint with type-aware rules
npm run format:check
npm test            # vitest
```

Then build: `npm run build`. Then commit, push.

If any step fails, fix root cause — don't paper over with `// eslint-disable`, `as any`, or skipped tests.

## What's where

- `apps/server/src/routes/` — HTTP handlers, one file per resource
- `apps/server/src/services/` — Business logic, orchestration
- `apps/server/src/drivers/` — Mock and WebKit drivers
- `apps/server/src/schemas/` — Zod schemas (single source of truth)
- `apps/server/src/db/` — Drizzle schema + migrations + seed
- `apps/server/src/middleware/` — Auth, rate limit, error handler, logging, request-id
- `apps/server/src/lib/` — Cross-cutting utilities (config, logger factory, etc.)
- `packages/api-types/` — Shared types/schemas (re-exported for SDK consumers)
- `docs/architecture.md` — System shape
- `docs/decisions.md` — D-NNN decision log
- `docs/verification-log.md` — V-NNN empirical log

## Cross-agent coordination

WebKit Agent #1 and you are independent. Different repos, different stacks, no shared files. The mock WebKit driver abstracts the eventual integration. When the WebKit fork closes Phase 2, the founder will coordinate the swap of mock driver for real driver.

If you're tempted to look at WebKit fork details: don't. Mock driver is the contract.
