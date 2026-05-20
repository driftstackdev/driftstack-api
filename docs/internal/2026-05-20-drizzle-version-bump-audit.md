# drizzle-orm 0.38.4 version-bump audit (2026-05-20)

**Verdict:** STAY on 0.38.4 for now. No upstream fix for the
journal silent-skip bug landed between 0.39.0 → 0.45.2 (the
latest stable in the 0.x line). Our local prevention via
`scripts/migration-immutability-check.mjs` + the deploy-bridge
pre-gate is the active mitigation; a version bump does not
remove the need for that check.

## Context — the bug we wanted upstream to fix

Drizzle 0.38.4 silently skips journal entries whose `when`
timestamp is `<=` the maximum `created_at` already in the
`drizzle.__drizzle_migrations` table. This was the root cause
of the 2026-05-19 migration audit incident: a journal entry
with an out-of-order `when` was added during a fast-follow
commit, deployed to staging, then completely ignored by drizzle
on the next migrate-up — the schema diverged silently.

Our mitigation:

- `scripts/migration-immutability-check.mjs` — pre-deploy gate
  that catches: applied-row-hash drift, pending journal entries
  with `when <= max(DB.created_at)`, journal/DB count mismatch.
- Wired into `scripts/deploy-bridge.sh` at line ~146-161 BEFORE
  the atomic swap, so a misconfigured journal aborts deploy at
  the gate.

## What upstream actually shipped 0.39.0 → 0.45.2

Spot-checked changelogs for `migrat|journal|pending|breaking`:

| Version | Migration-related notes                                                                       |
| ------- | --------------------------------------------------------------------------------------------- |
| 0.39.0  | Bun SQL driver; WITH supports INSERT/UPDATE/DELETE. No migration-runner changes.              |
| 0.39.1  | SQLite `onConflict` stacking fix; aliasedTable view support. No migration-runner changes.     |
| 0.40.0  | Gel integration (only `pull`, not `generate/migrate/push`). No migration-runner fixes for us. |
| 0.41.0  | Nothing migration-relevant.                                                                   |
| 0.42.0  | Nothing migration-relevant.                                                                   |
| 0.43.0  | Nothing migration-relevant.                                                                   |
| 0.44.0  | Nothing migration-relevant.                                                                   |
| 0.45.0  | Nothing migration-relevant.                                                                   |

Conclusion: **the journal silent-skip behavior is not in their
fix queue**. Either it's the documented semantic or they don't
consider it a bug — either way, our local guard remains the
active defense.

## Risk of bumping anyway

- 7 minor versions across 6 months of upstream changes.
- We use raw-sql template literals heavily (recapture matrix
  joins, atlas-priority queries, drift-guard structural tests).
  Each minor version could subtly change sql-template
  behavior; no test surface to catch regressions before they
  hit prod.
- The `tx.execute(sql\`\`)` Date-param footgun (the 2026-05-19
  prod TypeError) was a 0.38.4-specific manifestation; we have
  no signal whether 0.45 fixed, changed, or worsened the same
  surface.
- Migration tooling on drizzle-kit side may have parallel
  changes; we'd need to bump both packages in lockstep.

## Recommended cadence

- Re-audit in 90 days (2026-08-20).
- Trigger an immediate audit if: (a) a CVE lands against
  0.38.x, (b) Bun SQL becomes interesting for the v1.0+ stack,
  or (c) we hit a second silent-skip incident the local gate
  doesn't catch (which would prove the gate's coverage is
  incomplete and we need upstream behavior to change).

## What stays in place

- `scripts/migration-immutability-check.mjs` is the active
  prevention.
- The structural drift guard at
  `apps/server/tests/unit/drizzle-date-param-no-regress-structural-guard.test.ts`
  (commit `d9417a91`) prevents the Date-param footgun from
  regressing at CI time, independent of upstream behavior.
- Per the 2026-05-19 audit doc (`drizzle-date-param-audit-wave-29-N.md`),
  the codebase has zero additional latent Date-param bug sites;
  fully clean.

No code changes accompany this doc — bump is deferred.
