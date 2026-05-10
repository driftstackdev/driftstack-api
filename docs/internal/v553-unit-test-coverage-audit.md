# V-553 — unit-test coverage audit (services layer)

**Date:** 2026-05-11
**Wave:** 23
**Status:** AUDIT — gap catalogue only. Net-new unit specs land in
V-553.B implementation slices.

## Purpose

Companion to V-540.A (E2E coverage audit, Wave 19). Catalogues the gap
between `apps/server/src/services/` modules and
`apps/server/tests/unit/` spec files. Unit tests exercise the service
layer in isolation; integration tests cover route → service → DB; E2E
tests cover external HTTP. Each layer has its own coverage axis.

## Numbers

- **40 service modules** in `apps/server/src/services/`.
- **32 unit spec files** in `apps/server/tests/unit/`.
- **60 integration specs** in `apps/server/tests/integration/`.
- **12 E2E specs** in `apps/server/tests/e2e/` (per V-540.A audit).

Service-to-unit-spec coverage at the file level is **20/40 = 50%** by
direct name match. But integration coverage typically covers the
service path too — so the _effective_ coverage is higher. The audit
focuses on the file-name gap as a leading indicator of "no direct unit
test exists for this module".

## Service modules with no direct unit spec (20)

| Module                        | Has integration coverage? | Priority |
| ----------------------------- | ------------------------- | -------- |
| `account-audit.ts`            | Yes — admin-audit specs   | LOW      |
| `admin-accounts.ts`           | Yes — admin specs         | LOW      |
| `auth-flows.ts`               | Yes — auth specs          | MED      |
| `auth.ts`                     | Yes — auth integration    | MED      |
| `cli-authorize.ts`            | Partial                   | HIGH     |
| `durable-webhook-delivery.ts` | Yes — webhook specs       | LOW      |
| `email-preferences.ts`        | Yes — email-prefs specs   | LOW      |
| `email.ts`                    | Indirect via auth-flows   | HIGH     |
| `health-probe.ts`             | Yes — smoke spec          | LOW      |
| `incident-broadcast.ts`       | Partial                   | MED      |
| `incident-event-bus.ts`       | Partial                   | MED      |
| `incident-notifications.ts`   | Partial                   | MED      |
| `incidents.ts`                | Yes — incident specs      | LOW      |
| `legal.ts`                    | Yes — legal specs         | LOW      |
| `mfa-challenge-store.ts`      | Yes — mfa integration     | LOW      |
| `mfa.ts`                      | Yes — mfa integration     | LOW      |
| `profile-snapshots.ts`        | Partial                   | HIGH     |
| `profiles.ts`                 | Yes — profile specs       | LOW      |
| `rate-limit-overrides.ts`     | Yes — admin rate-limit    | LOW      |
| `rate-limit.ts`               | Yes — rate-limit specs    | LOW      |

## Priority criteria

- **HIGH:** module has minimal integration coverage AND/OR the service
  exposes a complex algorithm where unit testing in isolation is
  significantly cheaper than booting the full integration harness.
- **MED:** module has integration coverage but a unit spec would catch
  edge cases (auth-token expiry, retry-budget exhaustion) the integration
  spec doesn't exercise cleanly.
- **LOW:** module is thin glue; integration coverage is sufficient.
  Adding a unit spec is busywork.

## Recommended next slices

### V-553.B (next wave)

Two HIGH-priority unit specs:

1. **`email.test.ts`** — `email.ts` is a fan-out service over Postmark.
   Unit tests should cover template-not-found rejection, recipient
   suppression (opt-out list), provider-503 retry semantics. Integration
   tests don't exercise the retry path because Postmark mocks
   short-circuit it.
2. **`cli-authorize.test.ts`** — CLI authorize flow has a polling loop
   - token-expiry semantics + race conditions between two CLI clients.
     Unit-level coverage catches the race-condition cases integration
     misses.

### V-553.C (later)

Profile-snapshots service — partial integration coverage; the snapshot-
diff algorithm is unit-testable in isolation.

### Out of scope

Database repo layer (`apps/server/src/db/*-repo.ts`) — repos are thin
Drizzle wrappers; coverage comes from integration tests against a real
Postgres. Unit-mocking Drizzle is brittle. Skip.

## Coverage methodology

This audit looks at file-name matches only. A more rigorous next-pass
audit (V-553.B sub-task) would:

1. Run `vitest --coverage` to get line-level coverage per service module.
2. Map per-module integration-spec coverage by parsing test descriptors.
3. Identify branch-coverage gaps where the service has logic but neither
   unit nor integration exercises every branch.

Out of scope for the file-name audit; flagged here for completeness.

## Verification

- File counts cross-checked via `ls | wc -l`.
- Service-to-spec gap computed via `comm -23`.
- V-205 + V-211 sweep: zero hits.
