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

## P1 — launch-recommended

### V-246-P1-001 — Open redirect in Stripe checkout return URLs

**File:** `apps/server/src/routes/billing.ts` lines 56–57, 76–77.

**Pattern:** `POST /v1/billing/checkout-session` and `POST /v1/billing/trial-pack` accept `success_url` + `cancel_url` from the request body and pass them straight to Stripe's Checkout API. A malicious customer (or someone with a stolen API key) could craft a checkout link with `success_url: https://attacker.com/phishing` and share it with a colleague who'd land on the phishing site after entering their card.

**Risk:** moderate. Stripe does some basic validation (HTTPS, well-formed URL) but doesn't enforce a customer-specific allowlist — that's the integrator's job.

**Fix shape:** validate `success_url` + `cancel_url` against a configured allowlist of origins (default: `https://app.driftstack.dev`). Customer needing custom URLs gets a clear error pointing at "contact support" for enterprise allowlisting.

**Targeted at V-248.**

### V-246-P1-002 — PII in operational logs (auth flows)

**Files:** `apps/server/src/services/auth-flows.ts` lines 406–407, 468–469.

**Pattern:** auth-flow operations (magic-link request, password-reset request) log the email address at `info` level when the request is for an unknown account or a suspended account. Intentional: response is shape-stable to prevent enumeration, but ops needs visibility into abuse patterns.

**Risk:** acceptable. Documented ops posture. IP-based rate limiting (planned post-launch) is the right long-term mitigation.

**Action:** document in `docs/deployment/runbook.md` that Pino logs may contain email addresses from failed auth-flow attempts; affects log-sharing posture (don't share raw logs with non-Driftstack-staff).

### V-246-P1-003 — `account_owner` scope reachability into `/v1/admin/*`

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

- V-247: implement V-246-P0-001 fix (key-version cache invalidation).
- V-248: implement V-246-P1-001 fix (Stripe URL allowlist).
- V-NNN post-launch: V-246-P1-002 (ops runbook docs), V-246-P1-003 (scope refactor), V-246-P1-004 (IP rate limiting), V-246-P2-\* (operational docs + ops procedures).

Audit is the load-bearing artifact; fixes are mechanical from here. Founder reviews this doc on wake to validate the prioritization (e.g. agree V-246-P1-003 is genuinely deferrable given Cloudflare Access mitigation).
