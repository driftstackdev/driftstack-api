# V-540.A — E2E coverage audit

**Date:** 2026-05-10
**Wave:** 19
**Status:** STAGED — audit only. Net-new E2E specs added in V-540.B
(subsequent wave).

## Purpose

Catalogue the gap between `apps/server/src/routes/` route inventory and
`apps/server/tests/e2e/` Playwright spec coverage, so the next coverage-
expansion wave can land net-new specs against the highest-leverage gaps.

## Route inventory

32 route modules in `apps/server/src/routes/`:

| Module                          | Surface                                       |
| ------------------------------- | --------------------------------------------- |
| `account-audit.ts`              | /v1/account/audit-log                         |
| `account-me.ts`                 | /v1/account/me                                |
| `account-mfa.ts`                | `/v1/account/mfa/*`                           |
| `account-rate-limits.ts`        | /v1/account/rate-limits                       |
| `account-web-sessions.ts`       | `/v1/account/web-sessions/*`                  |
| `admin-accounts.ts`             | /v1/admin/accounts                            |
| `admin-api-keys.ts`             | /v1/admin/api-keys                            |
| `admin-audit-log.ts`            | /v1/admin/audit-log                           |
| `admin-force-actions.ts`        | `/v1/admin/force-actions/*`                   |
| `admin-incidents.ts`            | `/v1/admin/incidents/*`                       |
| `admin-overview.ts`             | /v1/admin/overview                            |
| `admin-rate-limit-overrides.ts` | /v1/admin/rate-limit-overrides                |
| `admin-sessions.ts`             | /v1/admin/sessions                            |
| `admin-status-subscribers.ts`   | /v1/admin/status-subscribers                  |
| `admin-validation-harness.ts`   | /v1/admin/validation-harness                  |
| `admin-webhooks.ts`             | /v1/admin/webhooks                            |
| `admin.ts`                      | /v1/admin (root)                              |
| `auth-cli.ts`                   | `/v1/auth/cli-authorize/*`                    |
| `auth.ts`                       | `/v1/auth/*` (signup / login / magic / OAuth) |
| `billing.ts`                    | `/v1/billing/*`                               |
| `email-preferences.ts`          | /v1/email-preferences                         |
| `legal.ts`                      | /v1/legal/{documents,required,accept}         |
| `openapi.ts`                    | /openapi.json + /docs                         |
| `profile-snapshots.ts`          | `/v1/profile-snapshots/*`                     |
| `profiles.ts`                   | `/v1/profiles/*`                              |
| `sessions.ts`                   | `/v1/sessions/*`                              |
| `status-stream.ts`              | /v1/status/stream (SSE)                       |
| `status-subscribe.ts`           | /v1/status/subscribe                          |
| `status.ts`                     | /v1/status                                    |
| `team.ts`                       | `/v1/team/*`                                  |
| `webhooks.ts`                   | `/v1/webhooks/*` + customer-side ingestion    |
| (root health)                   | /health                                       |

## Existing E2E spec coverage

12 specs in `apps/server/tests/e2e/`:

| Spec                        | Route surface covered                                         |
| --------------------------- | ------------------------------------------------------------- |
| `smoke.spec.ts`             | /health + /openapi.json + auth-required 401 sanity            |
| `auth.spec.ts`              | `/v1/auth/*` signup + login + magic-link + verify-email       |
| `sessions.spec.ts`          | `/v1/sessions/*` create + interact + capture + delete         |
| `admin.spec.ts`             | `/v1/admin*` surface — generic admin auth + scope             |
| `admin-tier-change.spec.ts` | /v1/admin/accounts tier-change action                         |
| `admin-audit-note.spec.ts`  | /v1/admin/audit-log note add                                  |
| `rate-limit.spec.ts`        | /v1/account/rate-limits + token-bucket rate-limit enforcement |
| `concurrency-limit.spec.ts` | ADR-004 concurrent-session cap enforcement                    |
| `profile-limit.spec.ts`     | Tier-bound profile cap enforcement                            |
| `customer-journey.spec.ts`  | Multi-step: account → key → session → navigate → capture      |
| `webhooks.spec.ts`          | /v1/webhooks delivery + signature verification                |
| `openapi-contract.spec.ts`  | Every documented route returns Zod-validated body shape       |

## Gaps (sorted by leverage)

### HIGH leverage (customer-facing, no E2E coverage)

1. **`account-mfa.ts`** — TOTP enroll / verify / disable. MFA is a security-
   critical path; integration tests exist but no end-to-end happy-path +
   error-path coverage.
2. **`billing.ts`** — Stripe webhook ingestion + customer-portal redirect.
   Integration tests mock Stripe; an E2E that exercises the full
   subscription-state-machine transition (free → tier-1 → cancelled) would
   catch regressions the unit tests miss.
3. **`legal.ts`** — /v1/legal/required + /v1/legal/accept. Legal acceptance
   is a launch-blocker for paid signups; E2E should cover "never_accepted"
   → "accept" → "accept again under content-hash change" → re-accept flow.
4. **`profile-snapshots.ts`** — Snapshot create + restore. Foundation for
   the customer dashboard's "restore session profile" feature.

### MEDIUM leverage (admin / power-user, no E2E coverage)

5. **`admin-incidents.ts`** — Incident open / update / close + status-page
   subscriber notification.
6. **`admin-validation-harness.ts`** — Validation harness fixtures; covered
   by unit but not by an E2E that hits the real route.
7. **`admin-overview.ts`** — Overview totals aggregation. Integration tests
   cover the math; an E2E covering the auth-scope + response-shape would
   round out coverage.
8. **`auth-cli.ts`** — /v1/auth/cli-authorize/initiate + complete. CLI
   browser-OAuth-style flow; needs E2E covering the polling loop.
9. **`team.ts`** — Team membership + role changes + invitation flow.

### LOW leverage (already well-covered or low-traffic)

10. **`email-preferences.ts`** — Get + set opt-outable email categories;
    well-covered by integration.
11. **`account-audit.ts`** — Single GET endpoint with filter coverage in
    integration tests.
12. **`account-web-sessions.ts`** — Web-session list + revoke; covered by
    `auth.spec.ts` indirectly.
13. **`status-stream.ts`** + **`status-subscribe.ts`** — Status page primary
    flow covered; SSE harder to E2E test (Playwright doesn't natively model
    SSE consumption well).

## Recommended next-wave coverage (V-540.B)

Highest leverage with manageable scope per spec:

1. `account-mfa.spec.ts` — TOTP happy path + invalid-code path.
2. `legal-acceptance.spec.ts` — required → accept → re-accept-on-version-bump.
3. `profile-snapshots.spec.ts` — create + restore + diff between snapshots.

Each spec ~80-150 lines following the `customer-journey.spec.ts` pattern.
Total addition: ~3 specs + ~10-15 tests across them. Test suite would grow
from 1402 (post-V-530.C) to ~1415-1417 at V-540.B closure.

## Coverage methodology note

E2E specs exercise the routes through a real Fastify boot with real
Postgres and Redis (via Playwright's `request` fixture). They catch:

- Route registration / wiring bugs.
- Schema validation at the HTTP boundary.
- Cross-route flow bugs (auth → use-protected-route → revoke → expect 401).
- Real DB interaction (foreign-key constraints, cascades, etc.).

Integration tests (in `apps/server/tests/integration/`) exercise the
service layer with the route mounted but bypass real Postgres in many
cases via the in-memory repo. The two layers complement each other; this
audit only catalogues the E2E gap, not integration gaps.
