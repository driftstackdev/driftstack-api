# Driftstack API — Agent context

## ⚠️ Read this first

This repo is **driftstack-api** — the customer-facing API and control plane for Driftstack. It is owned by **Agent #2**. Agent #1 owns the WebKit fork (`/Users/john/code/webkit-driftstack`); the two repos do not share files. The mock WebKit driver in `apps/server/src/drivers/mock.ts` is the contract that decouples the two; the real WebKit driver swaps in once the fork's Phase 2 closes.

If you're tempted to reach into the WebKit fork to understand "what the driver should do," **stop**. The interface is the boundary. If the contract is unclear, surface to the founder rather than coupling to fork details.

## ⚠️ Repository scope

The codebase is **pure engineering**. Business and legal/compliance content lives outside any repo (founder handles that as a separate private track). The agent does not generate business framing, legal posture, customer-facing copy, marketing language, billing integration code, or compliance documentation in this repo.

If a technical decision genuinely depends on something outside the agent's scope (e.g., "this stage is gated on KvK closure"), surface as an open dependency.

**Exception (effective 2026-05-03):** legal/compliance baseline drafts are in-scope when explicitly directed by founder. These drafts are starting points for counsel review, not final bound documents. Founder accepts that AI-generated legal text carries risk that counsel review may not catch and treats all generated legal content as revisable. Acceptance machinery (version hash, timestamp, customer ID, re-accept on bump) follows standard engineering scope.

The exception is opt-in per direction. Default behavior remains "surface against legal/compliance asks." Triggers for invoking the exception: explicit founder directive citing this clause. Documents land at `docs/legal/*.md` with a header marking them as AI-generated baseline drafts under this exception. Sub-processor lists, retention windows, jurisdiction, liability terms, and DPO necessity are factual claims that come from founder; agent does not extrapolate on them.

**Exception extension (effective 2026-05-03):** the legal/compliance exception is extended to cover three additional categories when explicitly directed by founder:

1. **Customer-facing copy** (marketing website at `driftstack.dev`, in-product onboarding flow text, transactional email templates, pricing-page positioning, docs-site landing).
2. **Billing integration code** (Stripe SDK + webhook handlers, Coinbase Commerce SDK + webhook handlers, Moneybird API integration, subscription state machine, customer portal redirects, BYOK metering).
3. **Onboarding flow with copy** (signup, email verification, legal acceptance UI, BYO-requirements explainer, payment-method selection, first-API-key issuance flow).

Same revision policy: founder-directed; founder accepts risk; all customer-facing copy revisable; all billing code passes through staging + manual approval before production. Default remains "surface against asks not covered by an active exception."

The "Out of scope" list is amended to reflect this:

- ~~Marketing website~~ — **moved to in-scope under the extended exception**.
- ~~Billing integration (Stripe/Mollie) — gated on commercial-activation gate~~ — **moved to in-scope under the extended exception for scaffolding work; live commercial activation (real charges, real signups) remains gated on KvK closure**.
- ~~Customer dashboard frontend (`app.driftstack.dev` for cloud-tier customers) — separate workstream~~ — **moved to in-scope under the extended exception** for the onboarding flow + minimum surface needed to issue keys + pay; full dashboard parity with the GUI client lands later.

Items still **out of scope** under the extension:

- Behavioural simulation library (file 64) — Phase 3.
- Recipe library — Phase 3.
- Mac mini fleet provisioning — gated on first customer + Agent 1 coordination.
- Behavioural data collection.
- Mollie integration (founder reversed dual-processor decision; Stripe-only fiat rail).

Sub-processor list lock under the extension: Hetzner, Neon, Upstash, Cloudflare (R2 + Pages + DNS), Postmark, Sentry, Stripe, Coinbase Commerce, Anthropic (BYO bundled LLM only, opt-in), Moneybird, MacStadium. Adding any sub-processor outside this list = directional question first, never silent.

**Out of scope (separate workstreams or future phases):**

- ~~GUI client (Electron/Tauri)~~ — **moved to active scope** (see file 128 / GUI workstream below). Self-hosted GUI is the higher-tier ($3k+) product surface and the founder's immediate dev tool for debugging WebKit-fork sessions + SOCKS5 proxy management.
- WebRTC streaming layer — may land inside the GUI workstream if scope allows; otherwise polling-based screenshots for the first iteration.
- Behavioural simulation library (file 64) — Phase 3
- Recipe library — Phase 3
- Mac mini fleet provisioning — gated on first customer
- ~~Marketing website~~ — **moved to in-scope under the legal-content exception extension below**.
- ~~Billing integration (Stripe/Mollie)~~ — **scaffolding moved to in-scope under the exception extension; live commercial activation remains gated on KvK closure. Mollie dropped per founder reversal.**
- ~~Customer dashboard frontend~~ — **onboarding-flow surface moved to in-scope under the exception extension; full dashboard parity later.**
- Behavioural data collection

If a request implies any of these, surface to founder rather than expanding scope.

## ⚠️ Publishing vs commercial activation

Three distinct gates — only the second and third are blocked on KvK / entity setup:

1. **Technical publish** (npm, PyPI, Go module registries, GitHub releases). **Not gated.** Public packages on registries are neutral artifacts, not commercial activity. Land them when the SDK is publish-ready.
2. **Commercial activation** (signups, billing, customer onboarding, paid tiers active). **Gated on KvK closure.**
3. **Advertise** (marketing site live, soliciting signups). **Gated on commercial activation.**

Initial publish uses the founder's personal account (`joeltheunissen89`). When the entity is registered, ownership transfers — V-log captures the transition. Pre-flight checks before each publish: package name available on the registry, version not already taken, LICENSE present, README publish-quality, no secrets / personal info beyond standard package metadata.

If a package name is taken on a registry, surface for an alternative-naming decision rather than picking one autonomously.

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

The founder triages both agents' work via a separate coordinating chat. Anything the founder needs to review or paste into that chat — milestone summaries, blocker write-ups, decision asks, end-of-session reports — must also be copied to the macOS clipboard via `pbcopy`, with the first line tagged:

```
[Agent 2 — Driftstack API + control plane]
```

This is non-optional — the chat agent triages outputs from both agents and tagging avoids attribution confusion. The clipboard content must be self-contained: the chat agent can't see prior turns from this session, so recap the relevant context rather than referring to earlier work. Print the same content to the chat too; `pbcopy` is additive, not a replacement.
