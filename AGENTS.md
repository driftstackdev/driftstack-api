# Driftstack API — repository context

## ⚠️ Founder anonymity policy

Driftstack does not attribute work to a specific named person on customer-facing surfaces. All public-facing copy refers to "Driftstack" as the entity, never to a personal founder name.

- **DO NOT** include personal founder name on `/about`, `/security`, `/docs`, marketing site, customer dashboard, admin panel, FAQ, or any public-facing surface.
- **DO NOT** include personal founder bio paragraphs ("Driftstack is built by [name]" framing).
- **DO** use "Driftstack" / "the Driftstack team" / "we" framing for company voice.
- **DO** use generic role descriptions where founder context is needed (e.g. "founded in 2026 in the Netherlands").

Internal documentation, `docs/decisions.md`, V-log entries, and engineering scaffolding can reference founder context for engineering accuracy. Customer-facing surfaces stay anonymous.

## ⚠️ Git identity policy

All commits in this repo use the Driftstack-branded git identity, not a personal name + email.

```
git config --local user.name "Driftstack"
git config --local user.email "dev@driftstack.dev"
```

The local config above is set per-clone; verify with `git config --local user.name` after cloning.

## ⚠️ Attribution policy (every commit, every public-visible file)

Commits and repo content are attributed to the Driftstack identity, not to any external development tooling.

- **DO NOT** include any third-party tooling attribution trailer (any "co-authored-by"-style line naming external systems) on commits.
- **DO NOT** include any "Generated with …" footer or robot-emoji marker on commits.
- **DO NOT** reference development tooling by name in commit messages.
- Commit message body documents engineering work; tooling is not part of commit metadata.

The same rule applies to every public-visible file in the repo: source code, comments, file headers, READMEs, CHANGELOGs, issue/PR templates, internal docs that ship in the public source tree. Repo content describes what the code does and why; not what tooling produced it.

This is a presentation choice. Driftstack engineering uses whatever tools are most effective; commit history and repo content reflect the work, not the tooling.

Applies to every commit going forward without exception. If a tool's default appends an attribution trailer, override the default. When using `git commit -m "$(cat <<'EOF' ... EOF)"` heredoc, the message ends with a normal blank line.

## ⚠️ Customer-facing copy policy

Marketing site, customer dashboard, admin panel, FAQ, docs, and any public-facing surfaces:

- **DO NOT** reference development tooling on customer-facing copy.
- **DO NOT** use "powered by …" or "built with …" framing about tooling.
- **DO NOT** include personal founder name (per the Founder anonymity policy above).
- Driftstack is the product; the tooling that produced it is not customer-facing information.

The bundled-LLM agent feature has its own product surface (per the sub-processor list, customers see which LLM provider their data flows to when they enable the feature). That product disclosure is REQUIRED — it is not a tooling reference.

## ⚠️ Read this first

This repo is **driftstack-api** — the customer-facing API and control plane for Driftstack. The WebKit fork that supplies the real browser engine lives in a separate repository; the two repos do not share files. The mock WebKit driver in `apps/server/src/drivers/mock.ts` is the contract that decouples the two; the real WebKit driver swaps in once the fork's Phase 2 closes.

If tempted to reach into the WebKit fork to understand "what the driver should do": **stop**. The driver interface is the boundary. If the contract is unclear, surface it as a question rather than coupling to fork details.

## ⚠️ Repository scope

The codebase is **pure engineering**. Business and legal/compliance content lives outside any repo as separate tracks. The repo does not generate business framing, legal posture, marketing language, billing integration code, or compliance documentation by default.

**Exception (effective 2026-05-03):** legal/compliance baseline drafts are in-scope when explicitly directed. Drafts at `docs/legal/*.md` are starting points for counsel review, not final bound documents. Baseline legal text carries risk that counsel review may not catch; all generated legal content is treated as revisable. Acceptance machinery (version hash, timestamp, customer ID, re-accept on bump) follows standard engineering scope.

**Exception extension (effective 2026-05-03):** the legal/compliance exception is extended to cover three additional categories when explicitly directed:

1. **Customer-facing copy** (marketing website at `driftstack.io`, in-product onboarding flow text, transactional email templates, pricing-page positioning, docs-site landing).
2. **Billing integration code** (Stripe SDK + webhook handlers, Moneybird API integration, subscription state machine, customer portal redirects, BYOK metering).
3. **Onboarding flow with copy** (signup, email verification, legal acceptance UI, BYO-requirements explainer, payment-method selection, first-API-key issuance flow).

Same revision policy: explicitly directed; risk-accepted; all customer-facing copy revisable; all billing code passes through staging + manual approval before production.

Sub-processor list (revised 2026-05-03 — V-052): Hetzner, Neon, Upstash, Cloudflare (R2 + Pages + DNS), Postmark, Sentry, Stripe, Anthropic (BYO bundled LLM only, opt-in), Moneybird, MacStadium. Adding any sub-processor outside this list = directional question first, never silent.

**Crypto rail dropped from launch (2026-05-03):** Coinbase Commerce closed for non-US/Singapore merchants 2026-03-31. Stripe is the sole payment rail at launch (fiat-only). Stripe's native USDC/USDB support (Dec 2025) is the candidate for crypto re-entry pending EU merchant eligibility verification at company onboarding. Alternative EU-friendly crypto processors (CoinGate, NOWPayments, BVNK, Triple-A) deferred to post-launch evaluation against actual transaction volume.

**Out of scope (separate workstreams or future phases):**

- WebRTC streaming layer — may land inside the GUI workstream if scope allows; otherwise polling-based screenshots for the first iteration.
- Behavioural simulation library — Phase 3.
- Recipe library — Phase 3.
- Mac mini fleet provisioning — gated on first paying customer.
- Behavioural data collection.

If a request implies any of these, surface it rather than expanding scope.

## ⚠️ Publishing vs commercial activation

Three distinct gates — only the second and third are blocked on company / entity setup:

1. **Technical publish** (npm, PyPI, Go module registries, GitHub releases). **Not gated.** Public packages on registries are neutral artifacts, not commercial activity. Land them when the SDK is publish-ready.
2. **Commercial activation** (signups, billing, customer onboarding, paid tiers active). **Gated on company entity registration.**
3. **Advertise** (marketing site live, soliciting signups). **Gated on commercial activation.**

Pre-flight checks before each publish: package name available on the registry, version not already taken, LICENSE present, README publish-quality, no secrets / personal info beyond standard package metadata.

If a package name is taken on a registry, surface for an alternative-naming decision rather than picking one autonomously.

## ⚠️ The standard

The standard is not "good enough to ship." The standard is **every API response correct against the OpenAPI spec, every error case has a handler and a test, every endpoint has integration tests covering happy path + every documented error path, mock driver behaviour deterministic and faithful to what the real WebKit driver will do**.

Specifically:

- Every endpoint has Zod schemas for request and response. OpenAPI spec is generated from Zod — there is no second source of truth.
- Every error case maps to an RFC 7807 `application/problem+json` response with a stable `type` URI.
- Every authenticated endpoint has tests for: happy path, missing key, invalid key, revoked key, rate limit hit, ownership violation (where applicable).
- Mock driver is **deterministic**: same inputs → same outputs, with simulated latency that's controlled by config. Never fake a success the real driver would fail; never randomise behaviour the real driver wouldn't randomise.
- Integration tests run against a real Postgres + Redis (the docker-compose services or CI service containers). No mocking the database.

## ⚠️ CAPABILITIES.md as truth source

`docs/CAPABILITIES.md` (when it exists) defines what the API claims to do — every documented capability must work end-to-end. Read it before claiming any capability; do **not** edit it without explicit direction. If implementation deviates from CAPABILITIES.md, surface the gap rather than silently changing scope.

If `docs/CAPABILITIES.md` does not yet exist, that's fine — Phase 1 predates it. Treat the README + verification log as the working truth until the file lands.

## Locked tech stack

Don't change without surfacing first:

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

D-NNN entries: stack decisions, architecture decisions, naming decisions. Body links the V-log entry that carries the full reasoning, and notes the autonomy level (see Decision authority below).

### Push-to-main pattern

Every commit is pushed directly to main. No PR-per-feature workflow. Land logical units, verify each (typecheck + lint + tests), push, continue. Don't batch a session's work into one commit.

### Marketing-copy + brand-surface cadence (standing convention)

Engineering work follows the push-to-main pattern above. Customer-facing marketing copy and brand-surface decisions go through an explicit review gate:

1. Draft copy / design in working tree but do NOT commit.
2. Surface full draft in next status update message — entire copy block as it would appear on the page (line breaks and all), or descriptions/screenshots of dev-server output for visual changes.
3. Reviewer applies redlines + replies with corrections or approval.
4. Commit approved version (with redlines applied).
5. V-NNN entry notes "draft surfaced + approved before commit."

Applies to: customer-facing pages under `apps/marketing-site/`, brand surface treatments (typography, layout, motif), customer-facing copy in transactional emails, customer-facing onboarding flow text. Engineering scaffolding behind those surfaces (config, data modules, build pipelines, tests) follows the standard push-to-main pattern.

Exception: factual technical-state numbers (e.g. `apps/marketing-site/src/data/capabilities.ts` cumulative-rig snapshot) follow push-to-main without draft review when the underlying numbers update.

### Empirical framing

Findings format: empirical results with attribution. No "good enough" framing on broken endpoints, missing error handling, or missing tests. Spot-check empirical: predict before testing; verify before committing.

## Decision authority

**Autonomous (routine implementation):**

- Implementation details within the locked stack
- Test coverage decisions
- Database schema details inside Phase 2 boundaries
- Error code design within RFC 7807
- Logging structure
- Internal module organisation

**Surface for review (architectural / contractual):**

- Stack changes
- API contract changes (new endpoints, breaking existing)
- Decisions affecting CAPABILITIES.md
- Changes to the WebKit-fork integration approach (driver interface)
- Database schema growth beyond reasonable bounds
- New sub-processor additions to the locked list

**Surface for explicit approval (commercial / brand):**

- Per-tier limits, pricing values, BYOK markup
- Customer-facing marketing copy + brand-surface treatments
- Anything affecting commercial commitments to customers

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
- `apps/marketing-site/` — Astro static-build marketing site (Cloudflare Pages)
- `docs/architecture.md` — System shape
- `docs/decisions.md` — D-NNN decision log
- `docs/adr/` — Long-form ADRs for architectural deviations from planned approaches
- `docs/verification-log.md` — V-NNN empirical log
- `docs/deployment/env-vars.md` — Canonical env-var schema (every var the control plane reads)

## External services + credentials

External services in active use: Hetzner / Neon / Upstash / Cloudflare R2 + Pages + DNS / Postmark / Sentry / Stripe / Anthropic / Moneybird / MacStadium. Login + 2FA + billing + credential-location + use-case per service are tracked in a separate operational register, maintained outside this repo.

This repo references env vars per `docs/deployment/env-vars.md` — the canonical schema for what the control plane reads at runtime. If a request involves rotating a credential or onboarding a new sub-processor, consult the operational register rather than inventing the answer here.

## WebKit driver boundary

The WebKit fork lives in a separate repository on a separate stack. The two repos communicate via the driver interface in `apps/server/src/drivers/types.ts`; the mock driver in `mock.ts` is the standing implementation, and the real WebKit driver swaps in once the fork's Phase 2 closes.

Driver-interface changes are coordinated explicitly. Don't read fork internals to make implementation decisions in this repo — the interface is the only contract.
