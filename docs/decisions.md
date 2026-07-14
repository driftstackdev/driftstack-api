# Driftstack API — Decision Log

Chronological record of decisions affecting the `driftstack-api` repo. Each entry is summary-level; full rationale lives in the V-log entry (when evidence-based) or in a planning doc (when strategic).

Format: `D-NNN — title (one line)`. Body links the V-log entry, lists the decision, the reasoning, and the decision-authority level per `AGENTS.md`:

- **Routine** — implementation detail inside the locked stack; landed and recorded
- **Architectural** — vendor / dependency / structural; surface for review before commit
- **Contractual** — affects API contract, CAPABILITIES.md, or WebKit-fork integration; explicit approval required

---

## D-001 — Locked stack baseline

- **Decision:** Node 22 LTS, TypeScript 5.x strict, Fastify, Drizzle on Postgres 17, ioredis on Redis 7, Zod (single source of truth, OpenAPI 3.1 generated), Vitest + Supertest + Playwright, Pino, Docker Compose, GitHub Actions.
- **Reasoning:** locked; chosen for tight TS ergonomics, codegen-friendly schemas, mature ecosystems, single-source validation/types.
- **Tier:** 3 (set in spec; agent does not change without surfacing).
- **V-log:** V-001 captures the verified install + green typecheck/lint/test on this stack.

## D-002 — Workspace layout: `apps/server` + `packages/api-types`

- **Decision:** monorepo with two TypeScript project references — `apps/server` (the Fastify app) and `packages/api-types` (shared types/schemas exported for SDK consumers).
- **Reasoning:** matches the spec issued. `api-types` carves out the externalisable surface so a future TypeScript SDK can depend on it without pulling in the server. TS project references give incremental builds and prevent leaks across boundaries.
- **Tier:** 2 (structural; spec already implied this).
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
- **Reasoning:** local dev machine runs v25, locked stack says v22 LTS. The runtime artifacts are produced and tested against 22 in CI (the source of truth for shippability), and the `>=22` floor lets v25 dev work without warnings. Tightening to `=22` would require nvm dance for every local command and provide no real benefit until v26 ships breaking changes.
- **Tier:** 1.
- **V-log:** V-001.

## D-007 — Push-to-main, no PR workflow (mirrors WebKit agent)

- **Decision:** every commit is pushed directly to main. No PRs, no branches, no review workflow. Verification log + decision log capture the why.
- **Reasoning:** mirrors the WebKit fork repo's `D-12` pattern. Small team, no other reviewers, two parallel agents — the per-feature PR ceremony has zero value and adds friction to autonomous work. The discipline is enforced by the V-log + decisions.md, not by gatekeeping.
- **Tier:** 2 (process; mirrors WebKit repo precedent).
- **V-log:** V-001.

## D-008 — License: MIT

- **Decision:** repo licensed MIT.
- **Reasoning:** matches WebKit fork repo policy stated in agent brief. Permissive enough that future SDK / customer integrations don't need a special license carve-out.
- **Tier:** 2 (confirmed in brief).
- **V-log:** V-001.

## D-009 — Phase 1 scope split: write everything; verify what we can; flag what we can't

- **Decision:** ship `docker-compose.yml` and the GitHub Actions CI workflow as part of Phase 1 even though Docker is not installed locally yet. End-to-end verification of the compose stack is deferred until installs Docker Desktop; CI verification of the same Postgres/Redis services happens automatically on first push (CI runs Postgres 17 and Redis 7 service containers in the same versions).
- **Reasoning:** the compose file is plain config, not code; mistakes in it surface the moment Docker is available. CI's service containers exercise the same image+config, so the first green CI run validates that the schema migrations and integration tests work against the real images. Holding the file back until local Docker is installed would block shipping the rest of Phase 1.
- **Tier:** 1.
- **V-log:** V-001 (verification deferred sub-section).

## D-010 — Password hashing: scrypt via `scrypt-kdf`

- **Decision:** API keys at rest are hashed with scrypt (`scrypt-kdf` package), not bcrypt.
- **Reasoning:** scrypt is memory-hard (resists GPU/ASIC attacks better than bcrypt for the same wall-clock cost), is in Node's built-in `crypto` module, and `scrypt-kdf` provides a clean encoded format. Spec says "bcrypt or scrypt" — picking scrypt and recording.
- **Tier:** 1.
- **V-log:** Phase 3 entry will record the empirical work-factor calibration.

## D-011 — UUID v4 PKs via Postgres `gen_random_uuid()`

- **Decision:** every table uses a `uuid` PK with `gen_random_uuid()` default. No prefix-encoded IDs in the database; the API layer formats them as `acc_…` / `key_…` / `ses_…` etc. for the public contract.
- **Reasoning:** raw UUIDs in Postgres index more efficiently than prefix-encoded text, and the prefix is a presentation concern, not a storage one. `gen_random_uuid()` (pgcrypto extension, available by default in Postgres 13+) avoids application-level dependence on `crypto.randomUUID()`. Splitting the concern this way means we can change the public prefix scheme without a DB migration.
- **Tier:** 1.
- **V-log:** V-002.

## D-012 — `api_keys.scopes` as Postgres enum array (not JSONB)

- **Decision:** `scopes` is `api_key_scope[]` (Postgres native array of enum values), not `jsonb`.
- **Reasoning:** lets us write `scope = ANY(scopes)` in queries and add a GIN index later if needed; enum constrains to known values at write time; smaller storage footprint than JSONB; trivially typed by Drizzle as `ApiKeyScope[]`. JSONB would be needed only if scopes evolved into objects (e.g., per-resource grants) — and at that point we'd add a separate `permissions` jsonb column rather than overloading `scopes`.
- **Tier:** 1.
- **V-log:** V-002.

## D-013 — Public ID format: `<3-char-prefix>_<UUID>`

- **Decision:** all public-API IDs use the format `<prefix>_<uuid>`. Prefixes: `acc` (account), `key` (api key), `ses` (session), `evt` (session event), `use` (usage record). The `PrefixedId(prefix)` helper in `packages/api-types/src/common.ts` returns a Zod string regex schema for each.
- **Reasoning:** matches the convention used by Stripe (`pi_…`, `cus_…`), OpenAI (`asst_…`, `thread_…`), Vercel (`prj_…`) etc. Lets clients route on prefix without parsing or guessing. Makes logs/grepping unambiguous. The base32 vs hex-UUID question went hex-UUID for now because the database stores UUIDs natively; format conversion can come later if customers ask for shorter IDs.
- **Tier:** 1.
- **V-log:** V-002.

## D-014 — Drizzle `db:generate` runs from repo root, not workspace

- **Decision:** `db:generate` and `db:studio` are root-package scripts (not workspace scripts). `db:migrate` and `db:seed` remain workspace scripts because they're tsx-run TS files that import workspace-relative modules.
- **Reasoning:** drizzle-kit resolves the `schema:` path from `drizzle.config.ts` against the **cwd**, not the config file's directory. Running from a workspace cwd breaks the path. Migration apply (`migrate.ts`) doesn't have this issue because it imports the schema as a TypeScript module, resolved by tsx.
- **Tier:** 1.
- **V-log:** V-002.

## D-015 — Live rate-limit counters in Redis; Postgres `rate_limit_buckets` is durability snapshot

- **Decision:** the hot path for rate limiting writes to Redis (token bucket, per-account-per-bucket-key). Postgres `rate_limit_buckets` is a durability snapshot synced periodically (Phase 3 will define the period); it's not read on the hot path.
- **Reasoning:** Redis gives sub-millisecond INCR/DECR with TTL semantics natural to a token bucket. Postgres gives durability so a Redis flush or eviction doesn't reset all customer rate limits, and gives an SQL-queryable surface for analytics/admin tools. Two-tier storage at this seam is a known-good pattern.
- **Tier:** 2.
- **V-log:** V-002.

## D-017 — Disable `exactOptionalPropertyTypes` due to Fastify/Pino type-boundary friction

- **Decision:** removed `exactOptionalPropertyTypes: true` from `tsconfig.base.json` while keeping every other strict-mode flag (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, etc.).
- **Reasoning:** EOPT exposes mismatches between Fastify's `FastifyBaseLogger` and Pino's `Logger` that aren't real bugs — Fastify accepts a wider logger type than Pino's, and EOPT refuses the structural subtyping. Forcing EOPT compatibility would require either casting at every plugin boundary or wrapping the logger. The other strict flags catch the classes of bug we actually care about (undefined index access, missing return paths, implicit any, override mismatch). Re-enabling EOPT is a future task once the core Fastify deps mature their typings.
- **Tier:** 1.
- **V-log:** V-003.

## D-021 — TypeScript SDK package (`@driftstack/sdk`)

- **Decision:** ship a hand-written TypeScript SDK as `packages/sdk-typescript/`. Imports types directly from `@driftstack/api-types` (the single source of truth for the API contract), NOT from a code-generated artifact. Builds dual ESM + CJS via `tsup`. Public surface: `Driftstack` class with `sessions` / `apiKeys` / `usage` resource accessors, 17 typed error classes mirroring the server's RFC 7807 problem-types, `withRetry` policy with exponential backoff + jitter + Retry-After honouring, and a `verifyWebhookSignature` helper for forthcoming webhooks.
- **Reasoning:** code-gen tools (`openapi-typescript-codegen`, `@hey-api/openapi-ts`) produce opinionated SDK shapes that don't match the resource/action ergonomics customers expect (Stripe-style `client.sessions.create()` rather than `SessionsApi.createSession(input)`). Hand-writing the client is ~500 lines and gives exact control over retry, error mapping, and header injection. Since `@driftstack/api-types` already exports every Zod-derived TS type the SDK needs, no codegen step is required for TypeScript — the schemas flow through directly. (Python and Go SDKs in future will likely consume the OpenAPI spec since they can't import `@driftstack/api-types`.)
- **Tier:** 2 (vendor / structural choice; matches spec direction in coordination response).
- **V-log:** V-013.

## D-027 — Stripe-only payment processing at launch (Architectural deviation from Mollie-primary plan)

- **Decision:** use Stripe as the sole payment processor at launch. Drop Mollie from the active rail list. The earlier "dual-processor with Mollie primary" design (parent driftstack repo file 116) is deferred to the revisit triggers, not abandoned.
- **Reasoning:** Stripe's EU payment-method coverage (iDEAL, Bancontact, SEPA Direct Debit, SOFORT, region-cards) closes the historical gap that justified Mollie-primary; Stripe Tax handles BTW reverse-charge natively (Mollie does not); Stripe Meters is required for BYOK LLM line-item billing (no Mollie equivalent); operational doubling cost (dual webhooks + dual reconciliation + dual sub-processor amendment surface) is meaningful for a small engineering team. Approved architectural deviation. If Stripe declines underwriting at company-onboarding, Mollie reactivates per the deferred dual-processor spec with proper Art 28(2) amendment notice.
- **Tier:** 2 (vendor / structural; approved deviation from the planned dual-processor design).
- **ADR:** [ADR-002](adr/ADR-002-stripe-only-payment-processing.md) — full context + alternatives + revisit triggers.
- **V-log:** V-052 (Coinbase Commerce dropped — single-rail posture follow-on), V-060 (this entry + ADR-002 landing).

## D-026 — Control-plane hosting on Hetzner Cloud (Architectural deviation from PaaS plan)

- **Decision:** host the control plane on Hetzner Cloud (two CCX13 VMs, Falkenstein region, ~€50/mo total) rather than a PaaS (Railway / Fly.io were the planned candidates).
- **Reasoning:** EU-jurisdiction posture for the privacy-policy sub-processor list is materially simpler with a German hyperscaler-adjacent provider; cost predictability at low scale; VM-level control for future co-tenant infrastructure (CI runner, WireGuard concentrator per V-054 v2); direct mTLS termination on the VM (V-054 decision 1A) without depending on a paid Cloudflare API Shield plan. Datastore decoupling (Neon Postgres + Upstash Redis + Cloudflare R2) neutralises the "managed-add-ons" PaaS advantage. Tradeoff accepted: more ops surface (SSH key hygiene, OS patching, monitoring) than a PaaS would impose. Mitigated by the bare-bones host posture (only Cloudflare Tunnel + unattended-upgrades alongside the application container).
- **Tier:** 2 (vendor / structural; approved deviation from the originally-planned PaaS).
- **ADR:** [ADR-001](adr/ADR-001-control-plane-hosting-hetzner.md) — full context + alternatives + revisit triggers.
- **V-log:** V-051 (network architecture doc + deploy pipeline targeting Hetzner), V-055 (ADR pattern + this entry).

## D-025 — Admin tooling: scope model, audit logging, cache invalidation, rate-limit override

- **Decision:** the operational-tooling workstream introduces:
  - **Admin scope (existing).** All `/v1/admin/*` routes gate on the existing `admin` scope from D-012. No new scope token. Founder holds the initial admin key. The README will document admin-key issuance once the workstream lands.
  - **Closed-enum action vocabulary.** `admin_audit_log.action` is a Postgres enum (`account.tier_changed`, `account.suspended`, `account.unsuspended`, `webhook_delivery.replayed`, `webhook_delivery.requeued`, `rate_limit_override.set`, `rate_limit_override.cleared`). Adding a new admin endpoint is a migration-bearing change. Closed enum forces deliberate vocabulary choice and gives `WHERE action = ...` queries a free index hit.
  - **Append-only at the service layer, not the schema.** `AdminAuditLogRepo` exposes `insert(...)` + `list(...)` only; no `update` / `delete` methods exist. The "no mutate" invariant is enforced by the absence of code paths, not by DB-level revoking. (Postgres lacks practical row-level immutability without triggers; absent methods are the cleanest enforcement at this scale.)
  - **Audit-write before response.** Every admin endpoint writes the audit row inside the same handler that performs the action. Failure to audit fails the request — there is no "audit best-effort" path. Tests assert audit row presence as a regression catch (a future commit accidentally removing the audit call should make a test red, not green).
  - **Cache invalidation pattern (re-uses D-020):**
    - Tier change → `authCache.invalidateAccount(accountId)` (bumps account-version; cached entries miss next read).
    - Suspend / unsuspend → same `invalidateAccount` path, plus the consequence: a suspended account fails the `account.status === 'suspended'` check in `authenticate()`, so cached scope checks naturally re-evaluate after the version bump.
    - Rate-limit override set/clear → `authCache.invalidateAccount(accountId)`. Override data is loaded into the cached `AccountContext` (proposed in this workstream), so a version bump forces re-load.
    - Webhook delivery replay/requeue → no auth-cache impact (operates on DB rows directly).
  - **Rate-limit override storage.** `rate_limit_overrides` table holds `(account_id, bucket_key, capacity, refill_per_second_centi, reason, expires_at, set_by_key_id)`. Unique index on `(account_id, bucket_key)` enforces "one override per bucket"; re-setting upserts. `refill_per_second_centi` stores the rate as 100× the actual rate to avoid float drift (the existing tier defaults include `1/60` per second; centi-rate stores it as `2` rounded, accepting that off-by-one until/unless overrides need sub-centi precision). Override is read at `rateLimitConsume()` time alongside the tier default; if present and unexpired, supersedes the default.
  - **Closed admin /usage facets.** The directive's `GET /v1/admin/accounts/:id/usage` calls for "by record type" + "by period" + "by endpoint." First two work today via the existing `currentPeriodSummary`; "by endpoint" requires both a `usage_records.endpoint` column (doesn't exist) AND production code paths that write to `usage_records` (doesn't happen — see V-014/V-015 amendment). Decision for this workstream: implement period + record_type facets; defer "by endpoint" to the future quota workstream that builds usage recording. Documented in the response shape.
- **Reasoning:** admin tooling is security-critical. The discipline that pays for itself: forced enum so the action set is explicit; mandatory audit rows that aren't best-effort; closed override vocabulary; cache invalidation reuses the proven D-020 path. The "no UPDATE/DELETE" enforcement via missing methods (rather than DB triggers) is consistent with the rest of this codebase — services own correctness, the DB is a store. Override storage in a dedicated table (rather than overloading `accounts`) keeps the override path orthogonal to account state, simplifies the sweep query, and lets us delete an override without touching the account row.
- **Tier:** 2 (security-critical structural pattern; approved scope per coordination response).
- **V-log:** V-016.

## D-024 — Process-local single-flight coalescer for the auth slow path

- **Decision:** add an `AuthCoalescer` (`apps/server/src/services/auth-coalescer.ts`) that wraps the `authenticate()` slow path in a `Map<sha256(plaintext), Promise<AccountContext>>`. First miss for a sha runs the prefix lookup + scrypt verify + account fetch; concurrent misses for the same sha share the in-flight Promise. Map entry removed on settlement (both fulfil and reject) via `.finally()`. Process-local only — no distributed lock.
- **Reasoning:** V-012's residual cold-start blip was 16 concurrent autocannon connections all running scrypt simultaneously on the smoke's first wave. Three alternatives were considered:
  - **Pre-warm the cache at boot.** Architecturally impossible: the auth cache key is `sha256(plaintext)` (D-020) and plaintext is unrecoverable from the persisted `api_keys.key_hash`. No entry can be written without plaintext.
  - **Change the cache key to `api_key_id` or to a server-secret-HMAC fingerprint.** Would require an extra column + migration, change the security model (a per-server-secret HMAC index is reversible if the server secret leaks), and re-introduce a lookup-from-plaintext step on every miss. Founder rejected.
  - **Single-flight coalescing.** No security model change, no schema change, ~80 LOC, directly addresses the documented problem. Founder approved as B1.

  Cross-process coalescing was deliberately not implemented: a Redis-backed lock adds latency comparable to the scrypt run itself and reintroduces the bottleneck. When scaling to multi-process, each process gets its own coalescer; the shared Redis cache absorbs across-process duplication after the first per-process miss.

- **Tier:** 2 (perf-critical structural choice; approved).
- **V-log:** V-015.

## D-023 — Webhook signing secret encrypted at rest (supersedes original plaintext posture)

- **Decision:** `webhook_endpoints.secret` and live `secret_prev` hold versioned AES-256-GCM envelopes under the platform customer-secret key. The repository decrypts them only in process for HMAC signing; `secret_prefix` remains display-only. Legacy plaintext rows are drained by a bounded compare-and-set bootstrap upgrader, and encrypted rows/new writes fail closed when the key is absent or wrong.
- **Reasoning:** signing requires recoverable key material, but it does not require usable keys in a database snapshot. Reusing the already-operated platform envelope removes the former KMS-complexity objection while preserving one-time plaintext creation responses and atomic dual-sign rotation. A webhook-secret leak enables forged customer events and is therefore treated as a direct integrity breach, not an acceptable “phishing-grade” exception.
- **Tier:** Contractual (security model; reviewed via the WH1 design doc that captured this as the proposed decision).
- **V-log:** V-014; plaintext posture superseded 2026-07-12.

## D-022 — `*Input` type variants for request shapes with server-side defaults

- **Decision:** schemas in `@driftstack/api-types` that use Zod `.default(...)` (e.g. `NavigateRequestSchema.wait_until`, `CaptureRequestSchema.full_page`, `PaginationQuerySchema.limit`) export TWO type aliases: `NavigateRequest` (the inferred output type, fields with defaults are non-optional) and `NavigateRequestInput` (the `z.input` type, fields with defaults are optional). The server consumes `*Request`. SDKs and route handlers consume `*RequestInput`.
- **Reasoning:** without this split, a customer calling `client.sessions.navigate(id, { url })` got a TS error because `wait_until` was inferred as required even though the server applies `'load'` as a default. Forcing every customer to spell out fields the server defaults breaks the ergonomics the SDK exists to provide. The `z.input`/`z.output` distinction in Zod is exactly designed for this case.
- **Tier:** 1.
- **V-log:** V-013.

## D-020 — Auth cache (Redis-backed, 30 s TTL) — security model

- **Decision:** introduce a Redis-backed auth cache that maps `sha256(plaintext)` → `AccountContext`, TTL 30 s, with explicit invalidation on revocation and account-level changes. **At-rest hash strength is not weakened** — `scrypt-kdf` at `logN=15` stays in `lib/api-keys.ts` for the persisted `api_keys.key_hash`. The cache is a pure performance optimisation.
- **Reasoning:** V-010 found scrypt verification dominates p50/p99 on every authenticated request. Two ways out: (a) cache the verified-key→context mapping for some seconds, (b) lower the scrypt work factor. (a) preserves the at-rest security posture (a Redis dump alone yields no usable plaintext keys, only sha256 hashes that are non-reversible without rainbow-tabling 32-char base32 alphabets). (b) would make a stolen `api_keys` table trivially crackable. Founder accepted (a) per coordination response.

  Security properties:
  - **Cache key is `sha256(plaintext)`** — non-reversible. A Redis dump doesn't yield plaintext keys.
  - **TTL is 30 s.** Worst-case revocation propagation is documented as 30 s in the API docs (forthcoming customer-facing change).
  - **Explicit invalidation on revocation** via reverse-index `auth:keyid:<keyId>` → `<sha>`. DELETE /v1/api-keys/:id is immediate, not 30 s.
  - **Account-level invalidation** via per-account version counter `auth:account:<accountId>:v`. INCRing the version makes ALL cached entries for that account miss on next read; cleanup is via natural TTL expiry. Used for tier changes, account suspension, account deletion (admin tooling, not yet exposed via API but the path is in place).
  - **`expiresAt` re-checked on every cache read** so an expiry can never leak past its deadline (the cache could otherwise outlive a keys's expiry by up to TTL).
  - **TTL capped at expiresAt** at cache write time, so a key with 5 s left to live gets cached for 5 s (not 30 s).
  - **Graceful degradation:** any Redis failure (network, slow query, malformed entry) is caught at both the impl level (RedisAuthCache logs + returns null/no-op) and the call site (authenticate() wraps in try/catch as belt-and-suspenders). Auth still works; just slower.
  - **No plaintext in cache value.** The cached `AccountContext` contains the hashed key, account info, scopes, etc. — no plaintext. The plaintext lives only in the request, in transit, and in the customer's secret store.

- **Tier:** 3 (security model decision; approved per coordination response).
- **V-log:** V-012 (perf delta + behaviour verification).

## D-019 — Six-tier locked pricing model

- **Decision:** AccountTier moves from a 4-value enum (`free / starter / pro / enterprise`) to the 6-value locked-pricing model: `free / starter / solo / builder / scale / enterprise`. Concurrency limits, monthly quotas, and rate-limit defaults are scaled per tier:

  | tier       | $/mo  | concurrent   | global RL capacity / refill | navigate quota |
  | ---------- | ----- | ------------ | --------------------------- | -------------- |
  | free       | trial | 1            | 60 / 1 rps                  | 100            |
  | starter    | $39   | 2            | 120 / 2 rps                 | 500            |
  | solo       | $99   | 5            | 600 / 10 rps                | 5,000          |
  | builder    | $299  | 15           | 1,800 / 30 rps              | 25,000         |
  | scale      | $999  | 50           | 6,000 / 100 rps             | 100,000        |
  | enterprise | $3k+  | 100 (custom) | 60,000 / 1000 rps           | unmetered      |

  Other quota types (session_minute, interact, wait, state_capture, screenshot_capture) follow the same proportional scaling — see `apps/server/src/services/usage.ts`.

  Old `pro` rows are mapped to `builder` in the migration as the closest equivalent (15 concurrent vs old pro's 20). `scale` tier inherited the old `pro` quota numbers (navigate=100k, etc.) since those were already calibrated for an upper-tier load.

- **Reasoning:** locked locked pricing — the four-tier model in V-001 to V-007 was a placeholder; the actual pricing matrix has six tiers with specific concurrency caps. Without correct tier semantics every rate-limit and quota test was asserting against the wrong contract; without a migration any DB carrying old `pro` rows would break on first `tier::account_tier` cast.
- **Tier:** 3 (locked business model).
- **V-log:** V-008.

## D-018 — Driftstack-internal Fastify plugins use the callback `done` form, not async

- **Decision:** plugins authored in this repo (auth, rate-limit, request-id) accept `(app, opts, done)` and call `done()` once setup is complete; they are not declared `async`. External plugins (`@fastify/cors`, `@fastify/helmet`) keep their published signatures.
- **Reasoning:** Fastify accepts both forms, but `eslint`'s `@typescript-eslint/require-await` flags an async function with no `await`. The plugins do synchronous decoration only — no awaits. Switching to the callback form is the documented Fastify pattern for sync setup, and reads more clearly than `async (...) => {}` + an unused await.
- **Tier:** 1.
- **V-log:** V-003.

## D-016 — `packages/api-types` is the public contract; server-internal Zod stays in `apps/server`

- **Decision:** every Zod schema for a request/response shape that crosses the public API boundary lives in `packages/api-types/src/`. Schemas for purely-internal shapes (driver state, internal service inputs, queue messages, etc.) live in `apps/server/src/schemas/` and never get re-exported.
- **Reasoning:** when we ship a TypeScript SDK in Phase 8+, it depends on `@driftstack/api-types` only — not on the server. Putting public schemas in the api-types package makes the SDK's transitive surface tractable and forces conscious choices when something internal needs to become public.
- **Tier:** 2.
- **V-log:** V-002.

## D-028 — Web sessions are opaque sha256-hashed tokens (not JWT)

- **Decision:** browser-dashboard auth uses 32-byte URL-safe random tokens, sha256-hashed at rest in `web_sessions.token_hash`, with `revoked_at` for revocation. NOT JWT.
- **Reasoning:** opaque tokens are revocable by DB delete without JWT secret-rotation complexity. Lookup is O(1) (sha256 + indexed), authoritative, and survives the server restart. The B2B audience doesn't need federated SSO; a JWT would add infra without benefit. Same primitive used twice (API keys also use sha256-of-prefix + scrypt-of-key) keeps the auth-cache invariants consistent.
- **Tier:** 2 (architectural — auth model).
- **V-log:** V-079.

## D-029 — Hand-rolled Stripe HTTP client (no `stripe` npm SDK dep)

- **Decision:** `apps/server/src/lib/stripe-api.ts` and `apps/server/src/lib/stripe-signing.ts` implement Stripe API access + webhook signature verification by wrapping `fetch()` directly. The `stripe` npm package is NOT a dependency.
- **Reasoning:** we touch a small surface area (Customers, Checkout Sessions, Billing Portal, webhook signature verification). The official SDK is hundreds of types + dozens of resource methods we'll never call. Slim dependency graph reduces supply-chain attack surface + version-drift maintenance. The `BillingProvider` interface keeps the test-friendliness — production swaps in `StripeBillingProvider`, tests use `InMemoryBillingProvider`. If we ever need a Stripe API surface that's significantly more complex (e.g. issuing, treasury), revisit.
- **Tier:** 2 (architectural — vendor surface management).
- **V-log:** V-080 (signature verification), V-088 (full Stripe HTTP client).

## D-030 — Inbound Stripe webhook idempotency via `processed_stripe_events` PK

- **Decision:** every inbound Stripe webhook event records its `event.id` in `processed_stripe_events` (PK on `event_id`). Handler short-circuits via `hasEvent` before running; race-safe via `INSERT ... ON CONFLICT DO NOTHING` on the record path. Append-only ledger; no UPDATE / DELETE at the service layer.
- **Reasoning:** Stripe's `event.id` is unique per Stripe account for the lifetime of the account. This is the cheapest available idempotency key. Stripe re-delivers events within a 3-day window; the ledger is the durable record of "we've already handled this." `ON CONFLICT DO NOTHING` resolves concurrent-delivery races deterministically.
- **Tier:** 2 (architectural — idempotency model).
- **V-log:** V-080 (scaffold + verification), V-089 (mutation handlers).

## D-031 — `session.failed` first-failure-only emission semantic

- **Decision:** `session.failed` webhook fires once per session — when a driver call (`navigate` / `interact` / `wait` / `getState` / `capture` / `guiInput`) throws, the SessionsService marks the session `errored`, sets `destroyedAt`, fires `session.failed`, and re-throws. Subsequent ops on the same session 410 SessionDestroyed at the `requireOwned` gate, so duplicate emission is structurally impossible.
- **Reasoning:** founder-approved (V-090 surface). Customer's webhook receiver gets the failure once; subsequent calls give a clear 410 instead of a silent retry-loop opportunity. `errored` and `destroyed` behave identically for customer ops (only DELETE is allowed, idempotent).
- **Tier:** 2 (architectural — webhook contract semantic).
- **V-log:** V-090.

## D-032 — Profile name uniqueness scoped to (account_id, name)

- **Decision:** `profiles.name` is unique per account, NOT globally. Customers may use their own naming conventions ("aws-staging", "instagram-account-1") without collision risk.
- **Reasoning:** profile names are human-meaningful identifiers within an account. A global unique constraint would force customers to disambiguate against other tenants' names — privacy leak + UX friction. The `(account_id, name)` unique index is an O(1) lookup at create time + supports the public ID resolution path.
- **Tier:** 1 (routine — schema design).
- **V-log:** V-081.

## D-033 — Audit-log retention pattern: 90d hot Postgres / R2 archive / 7y total (proposed)

- **Decision (PROPOSED — pending founder review):** audit-shaped tables (`admin_audit_log`, `processed_stripe_events`, `legal_acceptances`, `webhook_deliveries`) retain 90 days hot in Postgres, monthly archive sweep to Cloudflare R2 in JSON Lines + gzip, 7-year total retention.
- **Reasoning:** 90 days covers admin queries / Stripe re-delivery / customer-support span; 7 years aligns with Dutch BV bewaarplicht + GDPR Art 17(3)(b) legal-obligation exception. JSONL chosen over Parquet for human-readability + no schema-evolution friction. R2 already on locked sub-processor list. NOT a separate audit-store vendor (cost + sub-processor amendment outweighs benefit at launch scale; we don't operate at the regulated-banking threshold that justifies QLDB-equivalent crypto-anchored ledgers).
- **Tier:** 2 (architectural — retention SLA + workflow). Status: proposed.
- **V-log:** V-095. ADR: `docs/adr/ADR-006-audit-log-retention-export.md`.

## D-034 — Sentry-first observability destination (proposed)

- **Decision (PROPOSED — pending founder review):** primary structured-log + metrics destination at launch is Sentry. Defer adding a second observability vendor (Better Stack / Axiom / Datadog) until Sentry's structured-log capacity, retention, or query depth becomes a documented bottleneck against actual production volume.
- **Reasoning:** Sentry already on locked sub-processor list (V-052) + EU region wired (V-058). Adding a vendor requires DPA Annex 3 amendment + 30-day customer notice — meaningful cost for marginal benefit at launch volume. Single pane of glass for errors / performance / structured logs / breadcrumbs. Cost predictable at launch scale.
- **Tier:** 2 (architectural — vendor surface). Status: proposed.
- **V-log:** V-094. ADR: `docs/adr/ADR-005-observability-sentry-first.md`.

## D-035 — Admin scope enforcement at Fastify preHandler, not service layer

- **Decision:** every `/v1/admin/*` route uses `[app.requireScope('admin'), app.rateLimit('global')]` as its preHandler chain. Service-layer `throwIfMissingScope(ctx, 'admin')` calls remain as defense-in-depth but are no longer the primary gate. Order matters: `requireScope` must precede `rateLimit` so a non-admin caller gets 403, not a 429 that masks the scope violation.
- **Reasoning:** centralizing the check at the route boundary makes "did I forget the admin gate?" a code-review question with a one-line answer (the preHandler array) instead of a service-method audit. It also closes a probing leak — the prior service-layer check ran inside `withAudit`, so a non-admin attempt produced an `error: forbidden` audit row containing `targetAccountId`, leaking that the caller's target was a known account. Post-V-134, the preHandler rejects before audit machinery runs; the audit-row leak is gone in exchange for losing visibility into "non-admin tried admin endpoint" attempts. Acceptable trade — the inverse leak (target enumeration via audit inflation) is more costly than the missing visibility, which can be reconstructed from access logs if ever needed. Note: `apps/server/src/routes/admin.ts` is misnamed — it serves customer routes (`/v1/api-keys`, `/v1/usage`) and is correctly NOT migrated.
- **Tier:** 2 (architectural — security pattern; security trade-off documented).
- **V-log:** V-134.

## D-036 — Team roles taxonomy: 4-role model (owner / admin / member / viewer), gates dashboard UI only

- **Decision:** account membership uses 4 roles — **owner** (single per account; billing + transfer + delete), **admin** (full operational; cannot delete account or transfer ownership), **member** (create/manage profiles + sessions; cannot manage billing or invite), **viewer** (read-only). Roles gate dashboard UI only. `/v1/*` API routes continue to gate on API-key scopes (`read` / `write` / `admin`); the team role determines who can mint a key and what scopes they can grant. Multi-seat schema (`account_users`, `account_invites`) is not yet implemented — the V-079 schema is still single-user-per-account.
- **Reasoning:** 4 roles cover the realistic shape of small-to-mid B2B accounts (1–20 humans). 3 roles loses the read-only auditor / stakeholder slot (compliance + observer use cases). 5+ roles introduces a billing-only carve-out that's better solved by per-feature flags than another role tier. Keeping API auth on scopes (not roles) preserves the K-of-N invariant — an automation key minted by an admin can be revoked without affecting the human admin's dashboard access. Documented forward-looking schema + endpoint sketch in `docs/architecture/team-roles-taxonomy.md` so the future "wire up multi-seat" V-NNN has a checklist instead of a blank page.
- **Tier:** 2 (architectural — auth model + future schema shape).
- **V-log:** V-142.

## D-2026-05-06-01 — GUI API key at-rest storage: keyring-rs (OS keychain per-platform)

- **Decision:** the GUI client (`apps/gui-client`) stores the customer's API key in the OS-native keychain via the `keyring` Rust crate (v3, with `apple-native` + `windows-native` + `sync-secret-service` features). macOS Keychain on Mac, Windows Credential Manager on Windows, Linux Secret Service / KWallet on Linux — chosen automatically per-platform by the crate. Service identifier `dev.driftstack.gui` matches the Tauri bundle id so OS-native UI surfaces secrets under the app's identity. Three Tauri commands expose the surface to the frontend: `secret_save(key, value)`, `secret_load(key) -> Option<String>`, `secret_delete(key)`. Other settings (baseUrl, future theme prefs) stay in `settings.json` via `@tauri-apps/plugin-store` because they're non-sensitive.
- **Reasoning:** alternatives considered:
  - **(a) Tauri Stronghold plugin** — encrypts at rest with an OS-derived key; cross-platform; requires a master password (UX friction) OR a derived-from-OS-keychain key (added complexity). keyring-rs gets the same security with simpler ergonomics.
  - **(b) Plaintext on disk** — current pre-V-241 state; documented + acknowledged. Customer-trust concern (disk forensics, shoulder-surfing). Acceptable as MVP but not for first paying customer.
  - **(c) Custom encrypted-blob** — reinvents keyring-rs poorly. Skip.

  keyring-rs is mature (used by 1Password, GitHub CLI, etc.); Tauri 2.x compat verified via crate features; no friction with the existing `tauri-plugin-store` (different concern; plain JSON for non-secrets stays where it is). The "service:user" namespace `dev.driftstack.gui:default:api_key` keeps room for future per-account-id secrets when multi-account lands without orphaning the current single-account customers.

  Migration path: `loadSettings()` detects pre-V-241 customers with `apiKey` in settings.json on first call, transparently copies to keychain, rewrites the JSON without the apiKey field. One-shot; no customer action. Failure mode (keychain write fails) leaves apiKey in settings.json so the customer isn't suddenly logged out.

- **Tier:** 3 (security architecture / customer-data handling — autonomously decided per founder direction 2026-05-06 explicit autopilot grant).
- **V-log:** V-241.
- **Revert path:** if keyring-rs proves to be a build-time blocker on a target platform, revert by removing the `keyring` dependency + restoring settings.ts to the plugin-store-only path. Migration in reverse direction (keychain → settings.json) would need a one-shot read-and-rewrite. Not anticipated.

## D-2026-05-06-02 — GUI telemetry: Sentry crash-only, opt-in, cloud-default-on / self-hosted-default-off

- **Decision:** the GUI client (`apps/gui-client`) wires `@sentry/browser` v8 for crash-only telemetry. Gate logic in `src/lib/telemetry.ts::telemetryEnabled()`:
  - DSN unset → never fires.
  - `optIn === true` → ON (overrides default).
  - `optIn === false` → OFF (overrides default).
  - `optIn === null` → ON for cloud baseUrl (`*.driftstack.dev`), OFF for everything else.

  Crash-only configuration: tracesSampleRate=0 (no perf), no Replay, no Browser-Profiling. Default integrations (GlobalHandlers, Breadcrumbs) cover the crash surface only. `beforeSend` scrubber strips Authorization headers, `api_key` / `password` / `secret` / `token` / `bearer` field names from `extra` + `contexts`. Release tagged as `driftstack-gui@<version>`.

  Customer toggle in `SettingsView` exposes three radios: "Use platform default", "Share crash reports with Driftstack", "Don't share crash reports". Default selection on first install is "Use platform default" (null) so cloud customers get telemetry without explicit action and self-hosted customers don't.

  No native (Rust-side) Sentry yet. The Tauri shell is thin per the V-236 audit; most customer-facing crashes originate in the React layer. Adding sentry-rust later is purely additive if Rust crashes become a real issue surface.

- **Reasoning:** alternatives considered:
  - **(a) No telemetry** — current pre-V-242 state. Operational signal "did anyone hit a crash?" is unknowable. Acceptable for true-self-hosted privacy posture, but cloud customers benefit from observability.
  - **(b) Always-on** — privacy concern for self-hosted; defeats the "your data stays on your premise" pitch.
  - **(c) Always-opt-in (default off everywhere)** — most cloud customers won't toggle on; we lose the signal that matters most.

  The cloud-on / self-hosted-off split aligns telemetry to the customer's underlying choice: cloud is a data-sharing tier already (their data hits Driftstack's servers); self-hosted explicitly opts out of that. Telemetry mirrors the same posture.

  Privacy contract is defense-in-depth: never intentionally send PII (no API keys, profile data, request bodies, customer email/name); the `beforeSend` scrubber catches the case where a stack trace accidentally captures a credential-shaped field. Sentry's `sendDefaultPii` is also off.

- **Tier:** 3 (security architecture / customer-data handling — autonomously decided per founder direction 2026-05-06 explicit autopilot grant).
- **V-log:** V-242.
- **Revert path:** if telemetry becomes a customer-trust concern (e.g. someone files a complaint), set `tracesSampleRate=0` and remove the cloud-default in one PR; default everywhere becomes "off unless opt-in". Customer-facing impact: minor loss of crash signal for cloud customers who didn't actively opt in. Reversible without schema or contract changes.

## D-2026-05-06-03 — GUI distribution: Tauri Updater + GitHub Releases (cross-platform)

- **Decision:** the GUI client (`apps/gui-client`) ships via GitHub Releases (binary delivery) + Tauri Updater (auto-update with public-key signature verification). CI workflow at `.github/workflows/gui-release.yml` triggers on `gui-v*` tags, builds three platform binaries in parallel (macOS universal `.dmg`, Windows `.exe` via NSIS, Linux `.AppImage` + `.deb`), signs each with the Tauri Updater private key, uploads to a GitHub Release, and exposes `latest.json` as the manifest.

  **OS-level binary code signing DEFERRED post-launch.** Customers see "unknown publisher" / Gatekeeper warnings on first install (normal for indie apps). Subsequent updates ARE signed via the Tauri Updater public-key embedded in the original install — that protects update integrity even without OS-level publisher trust. Per-platform signing certs become individual `D-*` entries when the founder enrolls in the relevant program:
  - **D-2026-05-06-03a (deferred):** Apple Developer cert (~$99/yr) for macOS Gatekeeper trust + notarization. Blocked on founder Apple Developer enrollment.
  - **D-2026-05-06-03b (deferred):** Windows code signing cert (~$200+/yr; EV cert preferred for SmartScreen reputation). Blocked on founder cert purchase.
  - **D-2026-05-06-03c (deferred):** Linux package signing (.AppImage / .deb / .rpm). Free per-distro; deferred post-launch — customers running on Linux are technical enough to handle unsigned `.AppImage` execution.

- **Reasoning:** alternatives considered:
  - **(a) Sparkle** — established macOS auto-updater, but macOS-only; would need a separate Windows/Linux updater. Tauri Updater is one-tool-fits-all.
  - **(b) Tauri Updater alone, no GitHub Releases** — would need to host binaries ourselves. GitHub Releases is free, has CDN, and provides per-asset URLs for the manifest to reference. No reason to self-host.
  - **(c) Custom updater protocol** — reinvents Tauri Updater poorly. Skip.

  Tauri Updater is built into the framework, supports public-key signature verification (prevents an attacker from substituting an unsigned update via DNS hijack or similar), and works identically across Windows / macOS / Linux. GitHub Releases provides binary hosting with a stable URL pattern (`releases/latest/download/<asset>`). The `latest.json` manifest is regenerated on every release; existing installs hit the manifest URL, see a new version is available, download + verify + apply.

  CI workflow uses `tauri-apps/tauri-action@v0` which encapsulates the build-bundle-sign sequence. Three GitHub Actions secrets needed: `TAURI_UPDATER_PUBKEY` (public key embedded in builds), `TAURI_UPDATER_PRIVKEY` (private key for signing), `TAURI_UPDATER_PRIVKEY_PASSWORD` (passphrase set during key generation). Founder runbook at `docs/founder-actions/v243-tauri-updater-keys.md` documents the one-time `npx tauri signer generate` step + GitHub secret upload.

- **Tier:** 3 (distribution architecture / customer trust + signing — autonomously decided per founder direction 2026-05-06 explicit autopilot grant).
- **V-log:** V-243.
- **Revert path:** if Tauri Updater proves problematic (Tauri 2.x bugs, signing key issues, etc.), customers can always download a fresh release manually from GitHub. Switch to Sparkle (macOS) + a separate Windows installer + Linux package mirror would be ~3-day rework; reversible at any pre-customer-volume point.

---

## D-2026-05-07-01 — Public DRAFT exposure for `/legal/*` pages (banner + noindex over counsel-review-blocker)

- **Decision:** Ship `apps/marketing-site/src/pages/legal/{privacy,terms,dpa,aup}.md` publicly with a prominent DRAFT banner + `noindex,nofollow`, instead of holding all four routes as 404 until counsel review.

- **Reasoning:**
  - The marketing-site footer has been linking `/legal/{terms,privacy,dpa,aup}` since V-091 era. 404s on those URLs is a worse customer-trust signal than visibly-DRAFT pages with explicit "not for customer reliance" framing.
  - The `docs/legal/README.md` pre-publication blocker has three gates: (1) first paying customer onboarded, (2) presented as representing BV's binding position, (3) hosted on public URL. Gate (1) is still respected (BV onboarding ~2026-05-21 + counsel review still required for first customer). Gate (2) is satisfied by the prominent banner ("Draft — counsel review pending; not for customer reliance") — this is the OPPOSITE of presenting as binding. Gate (3) is the one being relaxed.
  - The relaxation is defensible: the original gate (3) framing presumed pages would either be canonical or absent. A third state — "publicly visible but explicitly non-binding" — wasn't contemplated. The DRAFT banner + noindex approximates "not really hosted as binding content" and is the standard SaaS pattern (pre-launch products commonly publish DRAFT terms with this framing).
  - Founder direction 2026-05-07 ("I want all pages such as legal pages, and everything live, and I can review post-launch") is the explicit grant. The pre-publication blocker was set 2026-05-03; this decision supersedes the gate (3) line for the DRAFT-banner case.
  - `POST /v1/legal/accept` (V-048 acceptance machinery) is NOT wired to these draft versions — customer acceptance still requires counsel-reviewed content + content_hash. So no customer is bound by the DRAFT pages. The pages exist as transparency surface, not as a contract instrument.

- **Tier:** 3 (compliance + customer-trust posture — autonomously decided per founder direction 2026-05-07 extended Tier-3 content authority for legal pages).
- **V-log:** V-255.
- **Revert path:** if founder judges the DRAFT banner insufficient, one revert: `git revert <V-255-sha>` restores the four routes to 404s; the canonical drafts in `docs/legal/*.md` are unaffected. Counsel review proceeds on its own timeline; banner removal is a separate V-NNN that wires `POST /v1/legal/accept` to the counsel-reviewed content.

---

## D-2026-05-08-01 — Status-page arc (V-295) ships with in-process event bus, not Redis Pub/Sub

- **Decision:** The V-295e SSE on /v1/status/stream uses an in-process `IncidentEventBus` for fan-out to connected clients. Redis Pub/Sub bridging is NOT shipped at launch.

- **Reasoning:**
  - Driftstack ships a single API instance at launch. There is exactly one process for SSE clients to connect to; the bus has zero cross-instance routing concerns.
  - SSE clients hold open connections — any future multi-instance setup needs sticky-session routing (or a dedicated SSE relay tier) regardless of pub/sub mechanism. Adding Redis Pub/Sub now without sticky-session routing would NOT enable multi-instance.
  - In-process emit is sync + zero-latency. Putting the emit OUTSIDE the `Promise.all` of email + outbound-webhook fan-out keeps SSE notification latency at ~0ms even when other channels are slow.
  - The migration path is documented inline in `incident-event-bus.ts`: when scale demands it, the right answer is sticky-session routing OR a dedicated SSE relay process — not Redis Pub/Sub bridging that breaks deterministic at-most-once semantics.

- **Tier:** 1 (architecture decision within standard ecosystem; auto-decide per founder direction 2026-05-08 autonomous-decision-guidance).
- **V-log:** V-295e.
- **Revert path:** if a multi-instance deploy demands cross-process pub/sub, swap `IncidentEventBus` for a Redis-backed implementation. The interface (`subscribe(listener) → unsubscribe`) is stable. The lifecycle dispatch in bootstrap doesn't need to change.

---

## D-2026-05-08-02 — API key rotation uses `expires_at`-driven grace, not a separate revocation column

- **Decision:** V-296 rotation sets the OLD key's `expires_at = max(existing, now + 24h)` rather than introducing a new `rotated_to_id` column or "rotation state" enum. The auth path's existing `expires_at`-driven gate handles auto-revocation at the grace boundary.

- **Reasoning:**
  - The V-049 auth path already short-circuits keys past `expires_at`. Reusing this means rotation needs zero new auth-path code.
  - A `rotated_to_id` column would require a new join in the auth hot path (twice on every authenticated request) — unnecessary cost for a feature that fires rarely.
  - The `max(existing, now + 24h)` invariant prevents accidentally extending an already-expiring key's life. Customer intent ("this key expires next Tuesday") is preserved.
  - Simpler model: a key has an expires_at. When you rotate, that timestamp shifts forward by 24h (or stays at the prior shorter date). When the timestamp passes, the key stops working. No state machine, no enum, no separate revocation table.

- **Tier:** 1 (architecture decision within standard ecosystem; auto-decide per founder direction 2026-05-08 autonomous-decision-guidance).
- **V-log:** V-296.
- **Revert path:** if customers complain about the 24h grace being too long/short, the constant in `apps/server/src/services/api-keys.ts:rotate()` is one number to change. If they complain about not being able to revoke immediately during grace, V-049's existing DELETE /v1/api-keys/:id endpoint already handles that — rotation does NOT prevent immediate revoke.

---

## D-2026-05-08-03 — Customer audit-log export cap at 10,000 rows per request

- **Decision:** V-297 `GET /v1/account/audit-log/export?format=csv|json` walks paginated reads up to a 10,000-row server-side ceiling. Older entries remain accessible via `GET /v1/account/audit-log?cursor=...` (unbounded; cursor-paginated).

- **Reasoning:**
  - GDPR Article 20 requires "structured, commonly used, machine-readable format" — the cap doesn't affect compliance because customers can fetch beyond 10k via the read endpoint they already have.
  - 10k is generous: a year+ of typical activity for a small-team account fits comfortably. Pathological cases (millions of rows on an enterprise account) would otherwise OOM the export response.
  - The `X-Driftstack-Export-Truncated: true|false` header signals when the cap was hit so power users know to fetch more via cursor pagination.
  - Per-export ceiling is preferable to streaming because the JSON envelope shape (`{generated_at, account_id, row_count, truncated, data}`) requires `row_count` + `truncated` to be set before the body streams. Streaming would force a different envelope shape.

- **Tier:** 1 (architecture decision within standard ecosystem; auto-decide per founder direction 2026-05-08 autonomous-decision-guidance).
- **V-log:** V-297.
- **Revert path:** if customers exceed the cap regularly, change `EXPORT_MAX_ROWS` in `apps/server/src/routes/account-audit.ts` (one constant). Or implement true streaming JSON via a different envelope. Both reversible at any pre-customer-volume point.

---

## D-2026-05-10-01 — OAuth 2.0 third-party flow uses PKCE S256, confidential clients, opaque tokens (no JWT)

- **Decision:** V-488 selected Authorization Code with mandatory PKCE (RFC 7636), `code_challenge_method=S256` only, and opaque bearer access tokens rather than JWTs. V-667's implemented invite-only client model is confidential: every client receives a one-time `client_secret`, and `/token`, `/introspect`, and `/revoke` authenticate that secret. Access tokens expire after one hour and there are no refresh tokens. V-617 binds introspection and revocation to the authenticated client's own tokens.

- **Reasoning:**
  - **PKCE plus confidential-client authentication.** PKCE binds every authorization code to its verifier; the client secret separately authenticates the server-side integration at token exchange, introspection, and revocation. The provider does not expose implicit or client-credentials grants. Browser-only public clients are not supported by this invite-only v1 surface.
  - **S256 only, plain refused at registration.** Plain PKCE is in the RFC but exists only for legacy clients that can't compute SHA-256. We have no such clients; refusing plain at registration time means the verifier never branches on method at runtime. One fewer attacker-controllable degree of freedom.
  - **Opaque tokens, not JWTs.** JWTs require key-rotation infrastructure, audience-binding logic, and a JWT-validation lib on every reader path. OAuth tokens enter the same central `AccountContext` + scope/rate-limit/audit pipeline as API keys. Their one-way digest/client binding lives in `oauth_access_tokens`; a backing `api_keys` authority UUID preserves the existing session/audit foreign-key contract. Authentication intentionally rechecks the joined token, live client and backing authority in PostgreSQL on every `oat_` request rather than positive-caching it, so token/client revocation is effective on the next request. Migrating to JWTs later remains reversible.
  - **No refresh tokens v1.** Opaque tokens have a fixed one-hour TTL; customers re-authorize after expiry. Refresh-token rotation, revocation, and theft detection are deferred until customer demand justifies the added attack surface.
  - **Client-bound lifecycle endpoints.** `/v1/oauth/introspect` follows RFC 7662 and returns metadata only for a token owned by the authenticated live client. `/v1/oauth/revoke` follows RFC 7009 and revokes only that client's token. Authenticated unknown/foreign tokens collapse to minimal inactive/no-op responses, while bad client credentials fail before token lookup or mutation.
  - **Persistent one-way state with bounded retention.** Client-secret, pending-authorization, authorization-code and access-token plaintext never lands in PostgreSQL; only SHA-256 digests do. Pending consent and codes are persistent and single-use across restarts/replicas. Approval atomically replaces one pending authorization with one code; exchange atomically consumes that code, revalidates live client and account authority, and creates the backing API-key/OAuth-token rows, so a crash cannot strand accepted consent or burn a valid code without a token. Account-scoped clients can be approved only by their registered account; deleting that account cascades the client rather than widening it into a null-bound marketplace client. The exact published 13-scope third-party allowlist is enforced during both staging and approval; broad/deprecated/new API-key scopes fail closed rather than inheriting into OAuth. Revoking a client atomically revokes every access-token authority it issued; rotating only the client secret leaves existing bearer tokens valid until revoke/expiry. One restart-safe hourly scheduled chain deletes provider authorizations and codes older than their five-minute validity and OAuth-token rows at or past their one-hour expiry. Deduplicated scheduler enqueues serialize the canonical account/job tuple with a transaction-scoped PostgreSQL advisory lock before rechecking and inserting, so concurrent bootstrap replicas cannot seed parallel chains. The in-handler re-arm uses the same dedup while excluding exactly its still-in-flight current job ID: the first delivery inserts a successor, while a retry after a committed enqueue observes that successor and cannot fan out the chain. Cleanup intentionally retains the expired backing `api_keys` actor rows because historical sessions and audit records may still reference those IDs; their fixed expiry keeps them non-authenticating.
  - **Hosted human-consent boundary.** Integrators redirect the customer's browser to `https://app.driftstack.dev/oauth/authorize/`, never directly to the provider-internal staging API. The Dashboard captures one bounded canonical S256 request, preserves it across same-origin sign-in, displays only server-bound app/scope/callback fields, and requires an explicit Approve or Cancel action. The intermediate `authorization_id` remains provider-internal. Registered callbacks are bounded to 2,048 characters, reject userinfo and fragments, and require HTTPS except for loopback development; callback parameters are constructed through the URL API so an existing registered query is preserved safely.

- **Tier:** 1 (architecture decision within standard ecosystem; auto-decide per founder direction 2026-05-08 autonomous-decision-guidance).
- **V-log:** V-488, V-617, V-618, V-619, V-620.
- **Revert path:**
  - If customers demand JWTs for federated trust (rare for SaaS API consumers): introduce a JWT format alongside opaque, gate per OAuth-client. Migration is opt-in.
  - If refresh tokens become necessary: add `/v1/oauth/token` with `grant_type=refresh_token`; change is purely additive.
  - If S256 proves insufficient (post-quantum era, ~2030+): add a new `code_challenge_method` option, deprecate S256 with migration window. The route layer's method-allowlist is one constant.

---

## D-2026-07-12-01 — Withdraw the transferable profile Marketplace

- **Decision:** remove the profile Marketplace preview from every product surface and do not build its catalog, balance, purchase, or profile-transfer backend. The historical F4 plan remains as superseded context, not active product direction.
- **Reasoning:**
  - Safari blocks third-party cookies by default and limits script-writable first-party storage after extended non-interaction, weakening the idea that passive browser age is a durable cross-site asset.
  - Checkout history, CAPTCHA outcomes, and site trust generally belong to server-side accounts and their relationship with IP, location, payment identity, and behavior; they are not reliably transferred with a browser-state container.
  - Moving a genuinely authenticated profile would risk transferring session cookies or other credentials. That creates security, privacy, support, and provenance liabilities disproportionate to the speculative customer value.
  - The shipped surface was mock inventory with a disabled purchase button. Keeping an unavailable, weakly defensible future product in primary navigation distracted from Profiles, Proxies, and Automation.
  - Reusable profile templates, customer-owned import/export, and customer-run automation recipes remain valid directions because they do not claim to sell transferable trust.
- **Tier:** explicit product-direction approval (2026-07-12).
- **V-log:** V-554.
- **Revert path:** restore the removed GUI view/navigation only after a new product review defines a technically verifiable asset, safe transfer model, provenance controls, and customer value independent of cross-site tracking.
