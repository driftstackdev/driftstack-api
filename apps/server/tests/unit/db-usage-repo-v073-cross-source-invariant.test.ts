// W1010 — db/usage-repo V-073 cross-source invariant. Three-hundred-
// thirty-sixth in the drift-guard series. Pins the apps/server/src/
// db/usage-repo.ts Drizzle usage-records repo:
//
//   Header — 'Drizzle-backed implementation of UsageRepo'.
//
//   DrizzleUsageRepo 2-method surface — totalsForPeriod +
//     dailyBucketsForRange.
//
//   totalsForPeriod aggregation — 'coalesce(sum(quantity), 0)::int'
//     per recordType + groupBy(recordType). The coalesce + ::int
//     handles empty-period (NULL sum) + Postgres-bigint→JS-number
//     coercion.
//
//   Period window is [periodStart, periodEnd) — gte(periodStart) +
//     lt(periodEnd). The closed-open interval matches V-073 billing-
//     period semantics.
//
//   dailyBucketsForRange UTC-day framing — 'GROUP BY (date_trunc
//   ('day', recorded_at), record_type) with the existing (account_id,
//   recorded_at) index. UTC-day truncation matches the API contract'.
//
//   dailyBucketsForRange date format — to_char(date_trunc('day', ...
//     AT TIME ZONE 'UTC'), 'YYYY-MM-DD'). The AT TIME ZONE 'UTC' is
//     what enforces the UTC-day bucket boundary.
//
//   dailyBucketsForRange result sorting — Array.from(byDate.entries())
//     .sort(([a], [b]) => a.localeCompare(b)). The ISO-date string
//     localeCompare sorts chronologically because YYYY-MM-DD is
//     already lex-sortable.
//
// stays in lockstep across apps/server/src/db/usage-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1010 db/usage-repo V-073 cross-source invariant', () => {
  it("CRITICAL header — 'Drizzle-backed implementation of UsageRepo'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/usage-repo.ts'));
    expect(p).toMatch(/\/\/ Drizzle-backed implementation of UsageRepo\./);
    expect(p).toMatch(/export class DrizzleUsageRepo implements UsageRepo \{/);
  });

  it('CRITICAL 2-method surface — totalsForPeriod + dailyBucketsForRange.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/usage-repo.ts'));
    expect(p).toMatch(/async totalsForPeriod\(/);
    expect(p).toMatch(/async dailyBucketsForRange\(/);
  });

  it('CRITICAL totalsForPeriod aggregation — sql<number>`coalesce(sum(quantity), 0)::int` + groupBy(recordType). The coalesce+::int handles empty-period NULL sum and Postgres-bigint→JS-number.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/usage-repo.ts'));
    expect(p).toMatch(/recordType: usageRecords\.recordType,/);
    expect(p).toMatch(
      /total: sql<number>`coalesce\(sum\(\$\{usageRecords\.quantity\}\), 0\)::int`,/,
    );
    expect(p).toMatch(/\.groupBy\(usageRecords\.recordType\);/);
  });

  it('CRITICAL period window [periodStart, periodEnd) — gte(periodStart) + lt(periodEnd). The closed-open interval matches V-073 billing-period semantics.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/usage-repo.ts'));
    expect(p).toMatch(/gte\(usageRecords\.recordedAt, periodStart\),/);
    expect(p).toMatch(/lt\(usageRecords\.recordedAt, periodEnd\),/);
  });

  it("CRITICAL dailyBucketsForRange UTC-day framing — 'GROUP BY (date_trunc('day', recorded_at), record_type) with the existing (account_id, recorded_at) index. UTC-day truncation matches the API contract'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/usage-repo.ts'));
    expect(p).toMatch(/\/\/ GROUP BY \(date_trunc\('day', recorded_at\), record_type\) with the/);
    expect(p).toMatch(/\/\/ existing \(account_id, recorded_at\) index\. UTC-day truncation/);
    expect(p).toMatch(/\/\/ matches the API contract\./);
  });

  it("CRITICAL dailyBucketsForRange date format — to_char(date_trunc('day', recordedAt AT TIME ZONE 'UTC'), 'YYYY-MM-DD'). The AT TIME ZONE 'UTC' enforces UTC-day bucket boundary.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/usage-repo.ts'));
    expect(p).toMatch(
      /day: sql<string>`to_char\(date_trunc\('day', \$\{usageRecords\.recordedAt\} AT TIME ZONE 'UTC'\), 'YYYY-MM-DD'\)`,/,
    );
  });

  it('CRITICAL dailyBucketsForRange groupBy compound (date_trunc UTC + recordType).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/usage-repo.ts'));
    expect(p).toMatch(/\.groupBy\(/);
    expect(p).toMatch(
      /sql`date_trunc\('day', \$\{usageRecords\.recordedAt\} AT TIME ZONE 'UTC'\)`,/,
    );
    expect(p).toMatch(/usageRecords\.recordType,/);
  });

  it('CRITICAL dailyBucketsForRange result sorting — Array.from(byDate.entries()).sort(([a], [b]) => a.localeCompare(b)). The YYYY-MM-DD ISO date format is lex-sortable so localeCompare gives chronological order.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/usage-repo.ts'));
    expect(p).toMatch(/return Array\.from\(byDate\.entries\(\)\)/);
    expect(p).toMatch(/\.sort\(\(\[a\], \[b\]\) => a\.localeCompare\(b\)\)/);
    expect(p).toMatch(/\.map\(\(\[date, totals\]\) => \(\{ date, totals \}\)\);/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-usage-repo-v073-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
