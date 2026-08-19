# Pre-launch security audit — 2026-05-06

V-246. Walks `apps/server/` auth + payment + data-handling code paths
against the "would I be embarrassed if this hit production with the
first paying customer?" bar. Conducted via Explore agent reading 14
service/lib/route files; findings cross-checked by line citations.

## Summary

| Severity                 | Count |
| ------------------------ | ----- |
| **P0 (launch-blocking)** | 1     |
| **P1 (recommended)**     | 4     |
| **P2 (post-launch)**     | 5     |
| **Verified clean**       | 10    |

**P0 + P1 fixes targeted for V-247 + V-248** (this V-246 entry is the audit doc; fixes land in subsequent commits).

## P0 — launch-blocking

### V-246-P0-001 — API key revocation race window

**File:** `apps/server/src/services/auth.ts` lines 150–159.

**Pattern:** when an API key is revoked, the DB write happens first (`revokedAt = now`), then the auth-cache entry for that key is invalidated. Between those two steps (microseconds), a concurrent request that read the cache before the invalidation can have a `AccountContext` with `revokedAt = null` cached. A second request hitting the same cache entry would still authenticate the revoked key.

**Window:** small (sub-millisecond in practice) but present and theoretically exploitable.

**Fix shape (selected):** Option B (key-version counter), mirroring the existing account-version pattern (V-016 / D-025). Add a `key:version:<id>` Redis counter; bump on revocation; bake the version into the cache key so a stale entry is never read. Zero added latency on cache hits (the version check is part of the key lookup).

Alternative considered but rejected: Option A (re-verify `revokedAt` from DB on every cache hit) — adds a DB query per cache hit, defeats the cache.

**Targeted at V-247.**

**Status (V-883, 2026-08-18): resolved in application code.** The selected
Option B shipped. `services/auth-cache.ts` defines a per-key version counter
(`auth:keyid:<id>:v`), bumped by `invalidateKey()` and checked by `get()`, so an
in-flight slow-path `set()` that captured the pre-revoke version produces an
entry the next `get()` detects as stale. The source comment carries this
finding's own id, and `services-auth-cache-content-parity` pins it. This entry
sat under "P0 — launch-blocking" after the fix landed; the finding text above is
left intact because an audit records what was found, not what is true today.

## P1 — launch-recommended

### V-246-P1-001 — Open redirect in Stripe checkout return URLs

**File:** `apps/server/src/routes/billing.ts` lines 56–57, 76–77.

**Pattern:** `POST /v1/billing/checkout-session` and `POST /v1/billing/trial-pack` accept `success_url` + `cancel_url` from the request body and pass them straight to Stripe's Checkout API. A malicious customer (or someone with a stolen API key) could craft a checkout link with `success_url: https://attacker.com/phishing` and share it with a colleague who'd land on the phishing site after entering their card.

**Risk:** moderate. Stripe does some basic validation (HTTPS, well-formed URL) but doesn't enforce a customer-specific allowlist — that's the integrator's job.

**Fix shape:** validate `success_url` + `cancel_url` against a configured allowlist of origins (default: `https://app.driftstack.dev`). Customer needing custom URLs gets a clear error pointing at "contact support" for enterprise allowlisting.

**Targeted at V-248.**

**Status (V-884, 2026-08-18): resolved in application code.** `billing.ts`
defines `validateReturnUrl()`, which parses each URL and rejects any origin not
on `ALLOWED_RETURN_ORIGINS` with a `BadRequestError`. It is applied to both
`success_url` and `cancel_url` — the two parameters this finding names.

### V-246-P1-002 — PII in operational logs (auth flows)

**Files:** `apps/server/src/services/auth-flows.ts` lines 406–407, 468–469.

**Pattern:** auth-flow operations (magic-link request, password-reset request) log the email address at `info` level when the request is for an unknown account or a suspended account. Intentional: response is shape-stable to prevent enumeration, but ops needs visibility into abuse patterns.

**Risk:** acceptable. Documented ops posture. IP-based rate limiting (planned post-launch) is the right long-term mitigation.

**Action:** document in `docs/deployment/runbook.md` that Pino logs may contain email addresses from failed auth-flow attempts; affects log-sharing posture (don't share raw logs with non-Driftstack-staff).

**Status (V-884, 2026-08-18): action complete.** This finding's action was to
document the posture, not to change code. `docs/deployment/runbook.md` carries a
"Log-handling — PII posture" section naming the intentional cases, the
`auth-flows.ts` line, and the instruction not to share raw Pino output. The
residual risk is further reduced because P1-004 below — the mitigation this
finding points at — has since shipped.

### V-246-P1-003 — `account_owner` scope reachability into `/v1/admin/*`

**Status (V616, 2026-07-13): resolved in application code.** Both authorization
predicates now require exact `driftstack_internal_admin` authority for
`/v1/admin/*`; neither `account_owner` nor the stored legacy `admin` customer
alias satisfies that scope. Cloudflare Access remains defense in depth.

**File:** `apps/server/src/services/auth.ts` lines 255–267 (pre-existing `KNOWN GAP` comment).

**Pattern:** the V-174 scope split intentionally allowed `account_owner` (customer dashboard) to reach `/v1/admin/*` routes alongside `driftstack_internal_admin` (Driftstack staff). Operationally mitigated by Cloudflare Access on `admin.driftstack.dev` (V-135 separate origin).

**Risk:** if a customer ever gets a key with `account_owner` scope AND knows the admin route shape AND can reach the origin (Cloudflare Access bypass), they could act on other customers' data.

**Action:** post-launch refactor to fully separate the two scopes at the route layer, removing the operational dependency on Cloudflare Access. Tracked here as V-246-P1-003; not blocking V-247/V-248.

### V-246-P1-004 — IP-based rate limiting on auth endpoints

**Pattern:** Auth-flow routes (`/v1/auth/signup`, `/v1/auth/login`, `/v1/auth/magic-link`, `/v1/auth/password-reset`) have account-keyed rate limiting (when authenticated) but no IP-based gate for unauthenticated requests. Documented in `auth-flows.ts` lines 15–21 as planned.

**Risk:** unauthenticated requests can be hammered (signup spam, magic-link request flood for known emails) until the IP-based gate lands.

**Action:** post-launch addition. Track as V-NNN follow-up; not blocking launch since current scale doesn't make this attractive yet.

## P2 — post-launch document & revisit

| ID           | Item                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------- |
| V-246-P2-001 | Cache invalidation doesn't track key version (relies on unique keyPrefix randomness)        |
| V-246-P2-002 | 30s revocation lag documented internally but no customer-facing public note                 |
| V-246-P2-003 | Stripe webhook signing secret rotation requires server redeploy (no live-rotate)            |
| V-246-P2-004 | Stripe API error logs include type+code only (could include more context for debugging)     |
| V-246-P2-005 | No documented audit log retention/pruning policy (V-163 archive is the path; needs cadence) |

**Status (V-885, 2026-08-18): P2-001 is closed; the rest stand.** The V-247 fix
that closed P0-001 is exactly this item's subject — `auth-cache.ts` now keeps a
per-key version counter (`auth:keyid:<id>:v`) checked on every `get()`, so cache
invalidation no longer relies on `keyPrefix` randomness. P2-002 (no
customer-facing note on revocation lag), P2-003, P2-004 and P2-005 were checked
and remain open; P2-005's policy is written in ADR-006, but the monthly sweep it
specifies has never run (V-865), so the cadence it asks for still does not exist.

All P2s are operational/documentation rather than architectural. None blocking launch.

## Verified clean (explicitly checked)

- **Scope-check enforcement** — all customer-facing routes use either `requireAuth` preHandler + service-layer scope checks, OR `requireScope('driftstack_internal_admin')` for admin routes. No silent bypasses.
- **Plaintext credential leakage** — API keys never logged; password hashes never logged; web session tokens sha256-hashed at rest; Stripe error responses sanitized to type+code only.
- **Stripe webhook idempotency** — `processed_stripe_events` PK constraint resolves the check-then-insert race; replay protection via 5-minute timestamp tolerance + HMAC-SHA256 constant-time compare.
- **Audit log injection** — all customer-controlled payloads pass through Zod validation in route layer before reaching the audit emit boundary; no eval/dynamic-code constructs.
- **Account-scope leakage** — every resource lookup uses `(resourceId, accountId)` tuple in the repo layer; cross-account access returns null (treated as 404).
- **Web session token security** — opaque sha256-hashed tokens (D-028); Bearer auth via header (not cookies → CSRF-immune); proper TTL + revocation.
- **CSRF protection** — all state-mutating endpoints require Bearer auth; no cookie-only mutations.
- **User enumeration prevention** — auth-flow responses are shape-stable for unknown emails (always returns `{sent: true, ...}`).
- **Cache version invalidation correctness** — account-version counter pattern is atomic in Redis; correctly resolves the cache-staleness race for tier/status changes.
- **Multi-customer Stripe webhook events** — single account per Stripe customer; `findAccountIdFromCustomerOrRef` returns one account; no bulk leakage.

## Resume points

**Status (V-885, 2026-08-18): every item on this list has shipped.** Kept as the
record of what was planned; do not read it as outstanding work.

- V-247: implement V-246-P0-001 fix (key-version cache invalidation). — **done**, per-key version counter in `auth-cache.ts` (V-883).
- V-248: implement V-246-P1-001 fix (Stripe URL allowlist). — **done**, `validateReturnUrl()` in `billing.ts` (V-884).
- V-NNN post-launch: V-246-P1-002 (ops runbook docs), V-246-P1-003 (scope refactor), V-246-P1-004 (IP rate limiting), `V-246-P2-*` (operational docs and ops procedures). — P1-002 **done** (runbook PII section), P1-003 **done** (audit's own V616 note), P1-004 **done** (`AUTH_IP_LIMITS` across nine route modules). The `P2-*` group is the only part still open, and P2-001 of it has since closed.

Audit is the load-bearing artifact; fixes are mechanical from here. Founder reviews this doc on wake to validate the prioritization (e.g. agree V-246-P1-003 is genuinely deferrable given Cloudflare Access mitigation).

---

## V-498 — closure status (2026-05-10)

Pre-launch security audit revisit four days after V-246. Closure status per finding:

| ID           | Severity | Status                      | Notes                                                                                       |
| ------------ | -------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| V-246-P0-001 | P0       | **CLOSED (V-247)**          | Key-version counter shipped; cache key bakes the version, stale entries unreachable.        |
| V-246-P1-001 | P1       | **CLOSED (V-248)**          | Stripe URL allowlist enforced at `/v1/billing/checkout-session` + `/v1/billing/trial-pack`. |
| V-246-P1-002 | P1       | **DOCUMENTED**              | Runbook §"Log-handling — PII posture" published; ops know to gate raw-log sharing.          |
| V-246-P1-003 | P1       | **DEFERRED (V-NNN)**        | Operational mitigation via V-135 Cloudflare Access on `admin.driftstack.dev`. Post-launch.  |
| V-246-P1-004 | P1       | **DEFERRED (V-NNN)**        | IP-based rate limiting on auth endpoints. Post-launch; current scale doesn't draw attacks.  |
| V-246-P2-001 | P2       | DEFERRED                    | Cache invalidation key-version coverage extension — nice-to-have.                           |
| V-246-P2-002 | P2       | DEFERRED                    | 30s revocation lag — internal doc only; no customer-facing copy yet.                        |
| V-246-P2-003 | P2       | **PARTIAL CLOSURE (V-497)** | DR runbook Scenario 10 documents the panic-rotate procedure with overlap window.            |
| V-246-P2-004 | P2       | DEFERRED                    | Stripe API error log enrichment.                                                            |
| V-246-P2-005 | P2       | DEFERRED                    | Audit-log retention/pruning cadence — V-163 archive shape exists; cadence not yet locked.   |

**Net status**: P0 closed; P1 closed where actionable pre-launch (2 of 4); 2 P1 deferred with explicit operational mitigations; 4 of 5 P2s deferred unchanged; 1 P2 (P2-003 Stripe rotation) gained a DR runbook entry under V-497.

## V-498 delta audit — what changed since 2026-05-06

Re-checked the four pre-launch slices that landed since V-246 for new findings. Each was reviewed against the same six checks the original audit applied (scope-reach, plaintext-leakage, idempotency, audit-log injection, account-scope leakage, web-session-token security).

### V-481 — granular API key scopes (Track A wave 2)

- `requireScope` mirrored at two call sites (`lib/errors-helpers.ts` + `services/auth.ts`); the unit test matrix at `tests/unit/scope-check.test.ts` (41 cases) asserts both sites evaluate the same predicate. **CLEAN.**
- Broad-satisfies-granular invariant: `read` satisfies `read:sessions` etc., but granular keys do NOT satisfy broad checks — narrow keys stay narrow. Asserted in tests. **CLEAN.**
- No new scope can reach `/v1/admin/*` — `driftstack_internal_admin` is the gate, and granular scopes are explicitly enumerated as customer-only verbs (`read`/`write`/`admin` on customer resources). **CLEAN.**

### V-484 — audit-log filter extensions (Track A wave 3)

- New query params (`from` / `to` / `actor_type` / `target_resource_id`) all parse through Zod; malformed values return 400 (`from=not-a-date` test pinned). **CLEAN.**
- All filters apply against `accountId = ctx.account.id` — no cross-account leakage path exists; route still calls `accountAudit.list(ctx, opts)` which scopes at the service layer. **CLEAN.**
- `target_resource_id` is bounded to 200 chars; SQL parameterised via Drizzle's `eq`. No injection vector. **CLEAN.**

### V-485 — per-tier feature gating (Track A wave 4)

- `requireTierFeature(tier, feature)` is a pure boolean lookup against `TIER_FEATURES[tier][feature]`. No side effect, no DB hit, no IO. **CLEAN.**
- Registry is read-only at module load; no runtime mutation paths exist. **CLEAN.**
- The guard throws `ForbiddenError` (existing, RFC 9457 typed) rather than a custom error — error handling is consistent with the rest of the API. **CLEAN.**

### V-494 — log + Sentry redaction (Track C wave 4)

- pino redact list now covers `password` / `new_password` / `current_password` / `code` (TOTP) / `recovery_code(s)` / `secret` / `signing_secret` / `webhook_secret` / `client_secret` / `totp_secret` / `mfaSecret` / `stripe-signature` header. **CLEAN.**
- Sentry beforeSend mirrors the pino list with case-insensitive key matching at every nesting depth. Unit test pins the matrix (12 cases) including cycle safety. **CLEAN.**
- Defense-in-depth posture: pino is best-effort (developers may forget to nest fields under `body.*`); Sentry's recursive walker catches leakage that bypasses pino. Both layers must fail open for a secret to leak. **CLEAN.**

### V-486 — Postmark templates (Track A wave 5)

- Two new templates (`quota-warning`, `session-event-digest`) — DRAFT copy only; no firing logic; no PII enters the renderer pre-activation. When wired (V-486-followup), the dedupe column writes are atomic per the existing `firstSuccessEmailSentAt` pattern. **PRE-CLEAN.**

### V-487 — NowPayments scaffold (Track A wave 6)

- `verifyNowpaymentsSignature` uses `timingSafeEqual` for the constant-time HMAC compare. **CLEAN.**
- Canonicalises JSON body (sorts keys at every level) before HMAC — protects against the `{"a":1,"b":2}` vs `{"b":2,"a":1}` variant attack. Unit test pins (10 cases) including non-JSON raw-body fallback. **CLEAN.**
- Falsy returns on empty body / secret / signature, non-hex signature, length mismatch — caller can return 401 uniformly without a special-case path. **CLEAN.**
- Route consumer not yet wired; verifier is library code only. No new attack surface introduced by V-487 itself.

### Net delta-audit verdict

**No new P0 or P1 findings introduced by V-481 → V-487.** The four review touchpoints (V-481, V-484, V-485, V-494) all align with the existing audit posture. V-486 + V-487 add scaffolding without new ingress.

The original audit's deferred items (P1-003, P1-004, P2-001/002/004/005) remain deferred — none of the post-V-246 work changed the priority calculus.

Next scheduled audit: pre-first-paying-customer (commercial activation), per the V-246 cadence note. That review re-walks the full set + any new code merged since V-498.
