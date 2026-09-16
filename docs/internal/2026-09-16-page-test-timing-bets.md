# Open item: 118 timing bets in page tests, 29 files (2026-09-16)

## What happened

CI went red on `main` with `expected [] to have a length of 1` in
`apps/customer-dashboard/tests/unit/login-page.test.ts` — zero fetches, i.e. the
click handler had not run yet. Green 3/3 in isolation immediately after, and none
of the six commits in that push touched the customer dashboard.

The cause is a fixed wait. `flush()` yields exactly four macrotask turns, which is
a bet that the page reaches the state in four. Under a full parallel CI run it does
not — so machine load becomes the test verdict, and it fails in the direction that
costs most: it blocks every push, including the ones that had nothing to do with it.

## What was fixed

All nine unconverted arms in `login-page.test.ts` now wait on the actual predicate
via that file's own `until(predicate, what)` helper. Where the arm's claim is
"and nothing FURTHER happened" (the dedupe arms) the `flush` is KEPT after the
`until` — the two are not interchangeable, and swapping one for the other silently
weakens the test.

## ⛔ What is still open, and why it was NOT swept tonight

The same shape exists in **118 arms across 29 files**. Full enumeration:
`flake-enumeration.txt` beside this file, regenerable with the scan in the commit
that added this note.

arms helper? file
13 no apps/customer-dashboard/tests/unit/reset-password-page.test.ts
11 no apps/customer-dashboard/tests/unit/magic-link-page.test.ts
9 no apps/admin-panel/tests/unit/admin-accounts-page.test.ts
7 yes apps/customer-dashboard/tests/unit/signup-page.test.ts
7 no apps/status-site/tests/unit/status-site-subscribe-timeout.test.ts
7 no apps/customer-dashboard/tests/unit/webhooks-page.test.ts
7 no apps/admin-panel/tests/unit/admin-audit-log-page.test.ts
6 no apps/customer-dashboard/tests/unit/select-tier-page.test.ts
4 no apps/customer-dashboard/tests/unit/verify-email-page.test.ts
4 no apps/customer-dashboard/tests/unit/forgot-password-page.test.ts
4 no apps/customer-dashboard/tests/unit/api-keys-page.test.ts
4 no apps/admin-panel/tests/unit/admin-status-subscribers-page.test.ts
4 no apps/admin-panel/tests/unit/admin-sessions-page.test.ts
4 no apps/admin-panel/tests/unit/admin-overview-page.test.ts
3 no apps/customer-dashboard/tests/unit/auth-magic-link-request-page.test.ts
3 no apps/customer-dashboard/tests/unit/audit-log-page.test.ts
3 no apps/admin-panel/tests/unit/admin-webhook-dlq-page.test.ts
3 no apps/admin-panel/tests/unit/admin-incidents-list-page.test.ts
2 no apps/customer-dashboard/tests/unit/team-page.test.ts
2 no apps/customer-dashboard/tests/unit/team-accept-page.test.ts
2 no apps/customer-dashboard/tests/unit/security-mfa-page.test.ts
2 no apps/customer-dashboard/tests/unit/oauth-client-confirm-merge-page.test.ts
1 yes apps/customer-dashboard/tests/unit/oauth-client-callback-page.test.ts
1 no apps/gui-client/tests/unit/profile-activity-panel.test.tsx
1 no apps/gui-client/tests/unit/log-buffer-crash-trail.test.ts
1 no apps/customer-dashboard/tests/unit/security-page.test.ts
1 no apps/customer-dashboard/tests/unit/overview-page.test.ts
1 no apps/admin-panel/tests/unit/admin-rate-limit-overrides-page.test.ts
1 no apps/admin-panel/tests/unit/admin-api-keys-page.test.ts

files: 29 arms: 118 files that already have the helper: 2

⚠️ ONLY 2 OF THE 29 FILES HAVE THE `until` HELPER AT ALL. So this is not a known
fix left unapplied across the codebase — it is a fix written once, locally, in one
file, while the same hazard sat in 28 others that never had it. That changes the
remedy: the durable form is a SHARED helper (the dashboard tests already import
`./dashboard-test-runtime`, which is its natural home), not 29 copies.

⛔ It was deliberately NOT swept mechanically at the end of a long session. Each
conversion needs the RIGHT predicate, and a wrong one is worse than the flake it
replaces: a predicate that is already true when it is first evaluated returns
immediately and removes the wait without removing the bet, leaving a test that
passes for a reason nobody intended. 118 of those, written quickly, is how a suite
starts passing vacuously.

## How to do it properly

1. Put `until` in `dashboard-test-runtime` (and an equivalent for admin-panel /
   status-site) rather than copying it.
2. Convert per file, choosing the predicate from what the arm actually asserts —
   usually "the request this arm counts has been issued", not "any fetch happened".
3. Keep the trailing `flush` wherever the arm's point is that nothing further
   happened.
4. Prove each conversion is not vacuous: the predicate must be FALSE at the moment
   the `until` is first reached. An arm where it is already true has gained
   nothing and should be left alone rather than decorated.
