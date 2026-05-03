# Driftstack API — Decision Log

Chronological record of decisions affecting the `driftstack-api` repo. Each entry is summary-level; full rationale lives in the V-log entry (when evidence-based) or in a planning doc (when strategic).

Format: `D-NNN — title (one line)`. Body links the V-log entry, lists the decision, the reasoning, and the decision-authority level per `CLAUDE.md`:

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

## D-023 — Webhook signing secret stored plaintext at rest (Stripe posture)

- **Decision:** the `webhook_endpoints.secret` column holds the plaintext signing secret (`whsec_<32 base32>`). The `secret_prefix` column stores the first 12 chars for display/debug. There is no separate scrypt-hashed field; the signing worker reads the plaintext directly to compute `HMAC-SHA256(<unix>.<body>, secret)` per delivery.
- **Reasoning:** the worker MUST sign every outbound delivery, so the plaintext has to be available at sign-time. Hashing-at-rest while still being able to sign requires either (a) re-deriving signing material from a hash on every delivery (operationally awful, breaks customer rotation flow) or (b) a KMS-style envelope (per-account encryption key — adds operational complexity without solving the root leak problem, since the per-account key has to live somewhere). The threat model for a leaked webhook secret is "attacker can forge webhook deliveries to the customer's endpoint" — phishing-grade, not takeover-grade. API key plaintext leaks remain takeover-grade because they let the attacker call our API as the customer; webhook secret leaks let the attacker impersonate us to the customer's endpoint, which the customer can mitigate by rotating the secret. Stripe takes the same posture (plaintext signing secret at rest, customers rotate on suspicion of leak). Documented as a customer-facing rotation flow, not as a security gap to solve in a future iteration.
- **Tier:** Contractual (security model; reviewed via the WH1 design doc that captured this as the proposed decision).
- **V-log:** V-014.

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
