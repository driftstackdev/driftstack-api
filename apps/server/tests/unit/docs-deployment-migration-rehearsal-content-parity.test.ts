// W554.B — drift guard for /docs/deployment/migration-rehearsal.md.
// V-198 standing migration-rehearsal procedure. Drift here either
// weakens the post-commercial-activation effective-date (would
// re-permit unrehearsed Class B + C migrations against non-empty
// production), drops the 3-class taxonomy (would lose the
// rehearsal-required-vs-optional gating), or weakens the Neon-
// branching pattern (would re-introduce the prod-data-refresh
// burden we deliberately offload to Neon).
//
//   • V-198. Effective: every migration after first paying customer.
//   • Pre-launch: skip rehearsal (empty prod).
//   • 3-class taxonomy: A safe (rehearsal optional) + B locking
//     (rehearsal required) + C destructive (rehearsal + founder
//     approval).
//   • Neon branching: mig-<NNNN>-rehearsal-YYYYMMDD naming.
//   • Wall-time > 30s → maintenance-window deploy.
//   • Class C rollback = point-in-time restore from Neon.
//   • Hetzner-side pg_locks monitoring during deploy.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/deployment/migration-rehearsal.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W554.B /docs/deployment/migration-rehearsal.md content parity', () => {
  const body = read(LIB);

  it("Header + V-198 + effective-date framing pinned: '# Database migration rehearsal' + 'V-198 — standing procedure for rehearsing Drizzle migrations against production-shape data before they land in prod.' + 'Pre-launch most migrations have been free (empty tables, no users), but every migration that runs against a non-empty production table from commercial activation onwards must follow this checklist.' + '**Effective date**: every migration after the first paying customer.' + 'Before commercial activation, migrations land directly per the standard push-to-main pattern (no rehearsal — production is empty).' — pinned so the V-198 + standing-procedure + commercial-activation-onwards + first-paying-customer-effective + pre-launch-skip-rehearsal commitment survives", () => {
    expect(body).toMatch(/^# Database migration rehearsal$/m);
    expect(body).toMatch(/V-198 — standing procedure for rehearsing Drizzle migrations against/);
    expect(body).toMatch(/production-shape data before they land in prod\./);
    expect(body).toMatch(/Pre-launch most/);
    expect(body).toMatch(/migrations have been free \(empty tables, no users\), but every/);
    expect(body).toMatch(/migration that runs against a non-empty production table from/);
    expect(body).toMatch(/commercial activation onwards must follow this checklist\./);
    expect(body).toMatch(
      /> \*\*Effective date\*\*: every migration after the first paying customer\./,
    );
    expect(body).toMatch(/> Before commercial activation, migrations land directly per the/);
    expect(body).toMatch(
      /> standard push-to-main pattern \(no rehearsal — production is empty\)\./,
    );
  });

  it("Why-rehearsal + Neon-branching framing pinned: 'We use Neon as the Postgres host. Neon supports point-in-time branch creation, which gives us a \"production-shape data, isolated DB\" target for free — no separate staging-data-refresh procedure required.' + 'a `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT <expr>` that holds an exclusive lock for minutes on a 50M-row table is the class of incident this rehearsal is designed to catch.' + 'Name the branch `mig-<NNNN>-rehearsal-YYYYMMDD`' + '`mig-0017-rehearsal-20260601`' — pinned so the Neon-point-in-time-branch + free-no-staging-refresh + 50M-row-DDL-lock-incident + mig-NNNN-rehearsal-YYYYMMDD-naming commitment survives", () => {
    expect(body).toMatch(/We use Neon as the Postgres host\. Neon supports point-in-time branch/);
    expect(body).toMatch(/creation, which gives us a "production-shape data, isolated DB" target/);
    expect(body).toMatch(/for free — no separate staging-data-refresh procedure required\./);
    expect(body).toMatch(/a `ALTER TABLE \.\.\. ADD COLUMN \.\.\. NOT NULL DEFAULT <expr>`/);
    expect(body).toMatch(/that holds an exclusive lock for minutes on a 50M-row table is the/);
    expect(body).toMatch(/class of incident this rehearsal is designed to catch\./);
    expect(body).toMatch(/Name the branch `mig-<NNNN>-rehearsal-YYYYMMDD`/);
    expect(body).toMatch(/`mig-0017-rehearsal-20260601`/);
  });

  it("3-class taxonomy framing pinned: '**Class A — safe (additive, nullable columns; new tables; new indexes with `CREATE INDEX CONCURRENTLY`)**: minimal lock impact; rehearsal optional but a good habit.' + '**Class B — locking (NOT NULL columns with a default backfill; type changes; renames; FK additions to non-empty tables)**: rehearsal required.' + '**Class C — destructive (DROP COLUMN; DROP TABLE; data transformations that can't be reversed without restoring a backup)**: rehearsal required + explicit founder approval before running in production.' + 'When unsure, treat as one class higher.' — pinned so the Class-A-safe-additive-rehearsal-optional + Class-B-locking-rehearsal-required + Class-C-destructive-founder-approval + treat-one-class-higher-when-unsure commitment survives", () => {
    expect(body).toMatch(/- \*\*Class A — safe \(additive, nullable columns; new tables; new/);
    expect(body).toMatch(/indexes with `CREATE INDEX CONCURRENTLY`\)\*\*: minimal lock impact;/);
    expect(body).toMatch(/rehearsal optional but a good habit\./);
    expect(body).toMatch(/- \*\*Class B — locking \(NOT NULL columns with a default backfill;/);
    expect(body).toMatch(/type changes; renames; FK additions to non-empty tables\)\*\*:/);
    expect(body).toMatch(/rehearsal required\. Time the migration on a Neon branch first\./);
    expect(body).toMatch(/- \*\*Class C — destructive \(DROP COLUMN; DROP TABLE; data/);
    expect(body).toMatch(/transformations that can't be reversed without restoring a/);
    expect(body).toMatch(/backup\)\*\*: rehearsal required \+ explicit founder approval before/);
    expect(body).toMatch(/running in production\./);
    expect(body).toMatch(/When unsure, treat as one class higher\./);
  });

  it("7-step rehearsal-sequence framing pinned: '### 1. Snapshot production via Neon branching' + '### 2. Run the migration against the branch' + 'If the migration takes >30 seconds against the branch with production-shape data, treat it as a maintenance-window deploy' + '### 3. Verify post-migration invariants' + 'New NOT NULL column: every existing row got the backfill default. `SELECT count(*) FROM table WHERE col IS NULL` should be 0.' + '### 4. Run the test suite against the branch' + '### 5. Document the rehearsal' + '### 6. Land the migration in production' + '### 7. Drop the rehearsal branch' — pinned so the 7-step-sequence + 30s-threshold-maintenance-window + count(*)-IS-NULL-zero-invariant + V-log-append-rehearsal-note + 24h-keep-branch-alive commitment survives", () => {
    expect(body).toMatch(/### 1\. Snapshot production via Neon branching/);
    expect(body).toMatch(/### 2\. Run the migration against the branch/);
    expect(body).toMatch(/If the migration takes >30 seconds against the branch with/);
    expect(body).toMatch(/production-shape data, treat it as a maintenance-window deploy/);
    expect(body).toMatch(/### 3\. Verify post-migration invariants/);
    expect(body).toMatch(/- New NOT NULL column: every existing row got the backfill default\./);
    expect(body).toMatch(/`SELECT count\(\*\) FROM table WHERE col IS NULL` should be 0\./);
    expect(body).toMatch(/### 4\. Run the test suite against the branch/);
    expect(body).toMatch(/### 5\. Document the rehearsal/);
    expect(body).toMatch(/### 6\. Land the migration in production/);
    expect(body).toMatch(/### 7\. Drop the rehearsal branch/);
  });

  it("Rollback-strategy + Lock-contention monitoring framing pinned: '## Rollback strategy by class' + '**Class A**: rollback = run a reverse migration that drops the added column / table / index.' + '**Class B**: rollback is more painful. NOT NULL → nullable is always reversible' + '**Class C**: there is no in-place rollback. The recovery path is point-in-time restore from Neon to before the migration ran.' + '## Lock-contention monitoring during deploy' + 'SELECT pid, locktype, mode, granted, query_start, state, query' + 'FROM pg_locks' + 'JOIN pg_stat_activity USING (pid)' + 'WHERE NOT granted;' + 'Sustained `granted=false` rows for more than a few seconds indicate the migration is blocking foreground queries.' — pinned so the Class-A-reverse-migration + Class-B-NOT-NULL-reversible + Class-C-point-in-time-restore + pg_locks+pg_stat_activity-monitoring + granted=false-blocking commitment survives", () => {
    expect(body).toMatch(/## Rollback strategy by class/);
    expect(body).toMatch(/- \*\*Class A\*\*: rollback = run a reverse migration that drops the/);
    expect(body).toMatch(/added column \/ table \/ index\./);
    expect(body).toMatch(/- \*\*Class B\*\*: rollback is more painful\. NOT NULL → nullable is/);
    expect(body).toMatch(/always reversible via `ALTER TABLE \.\.\. ALTER COLUMN \.\.\. DROP NOT/);
    expect(body).toMatch(/- \*\*Class C\*\*: there is no in-place rollback\. The recovery path is/);
    expect(body).toMatch(/point-in-time restore from Neon to before the migration ran\./);
    expect(body).toMatch(/## Lock-contention monitoring during deploy/);
    expect(body).toMatch(/SELECT pid, locktype, mode, granted, query_start, state, query/);
    expect(body).toMatch(/FROM pg_locks/);
    expect(body).toMatch(/JOIN pg_stat_activity USING \(pid\)/);
    expect(body).toMatch(/WHERE NOT granted;/);
    expect(body).toMatch(/Sustained `granted=false` rows for more than a few seconds indicate/);
    expect(body).toMatch(/the migration is blocking foreground queries\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
