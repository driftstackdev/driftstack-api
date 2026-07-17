// W1010 — db/usage-repo V-073 cross-source invariant. Three-hundred-
// thirty-sixth in the drift-guard series. Pins the apps/server/src/
// db/usage-repo.ts Drizzle usage-records repo:
//
//   Header — 'Drizzle-backed implementation of UsageRepo'.
//
//   DrizzleUsageRepo 2-method surface — totalsForPeriod +
//     dailyBucketsForRange.
//
//   totalsForPeriod action aggregation — usage_records session_minute and both
//     decomposer types are excluded. Session minutes are instead derived from
//     durable browser lifecycle intervals.
//
//   Period window is [periodStart, periodEnd) — gte(periodStart) +
//     lt(periodEnd). The closed-open interval matches V-073 billing-
//     period semantics.
//
//   Lifecycle truth — direct rows must have a non-reservation driver id;
//     agent rows must be node-assigned and unlinked from a direct session.
//     One injected clock clips active intervals. Terminal timestamps fall
//     back to updated_at. Seconds are summed before one floor-to-minutes.
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

  it('CRITICAL injected clock — both methods capture one deterministic asOf value.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/usage-repo.ts'));
    expect(p).toMatch(/private readonly clock: \(\) => Date = \(\) => new Date\(\),/);
    expect(p.match(/const asOf = this\.clock\(\);/g)).toHaveLength(2);
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

  it('CRITICAL usage_records exclusions — session_minute and both decomposer record types cannot override lifecycle truth.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/usage-repo.ts'));
    expect(p).toMatch(/const LIFECYCLE_DERIVED_RECORD_TYPE = 'session_minute' as const;/);
    expect(p).toMatch(
      /const INTERNAL_RECORD_TYPES = \['agent_decomposer', 'agent_decomposer_bundled'\] as const;/,
    );
    expect(p.match(/ne\(usageRecords\.recordType, LIFECYCLE_DERIVED_RECORD_TYPE\),/g)).toHaveLength(
      2,
    );
    expect(p.match(/ne\(usageRecords\.recordType, INTERNAL_RECORD_TYPES\[0\]\),/g)).toHaveLength(2);
    expect(p.match(/ne\(usageRecords\.recordType, INTERNAL_RECORD_TYPES\[1\]\),/g)).toHaveLength(2);
  });

  it('CRITICAL lifecycle authority — real direct sessions + node-assigned unlinked agent sessions only.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/usage-repo.ts'));
    expect(p).toMatch(/driver_session_id NOT LIKE 'reserving:%'/);
    expect(p).toMatch(/node_id IS NOT NULL/);
    expect(p).toMatch(/driftstack_session_id IS NULL/);
  });

  it('CRITICAL terminal fallback + half-open clip — stamps win, terminal updated_at repairs legacy null stamps, and asOf caps every interval.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/usage-repo.ts'));
    expect(p).toMatch(/WHEN destroyed_at IS NOT NULL THEN destroyed_at/);
    expect(p).toMatch(/WHEN status IN \('destroyed', 'errored'\) THEN updated_at/);
    expect(p).toMatch(/WHEN closed_at IS NOT NULL THEN closed_at/);
    expect(p).toMatch(/WHEN status = 'closed' THEN updated_at/);
    expect(p).toMatch(
      /WHERE greatest\(started_at, \$\{periodStartIso\}::timestamptz\)\s*< least\(ended_at, \$\{periodEndIso\}::timestamptz, \$\{asOfIso\}::timestamptz\)/,
    );
  });

  it('CRITICAL precision — aggregate clipped epoch seconds first, then floor once to complete minutes.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/usage-repo.ts'));
    expect(p).toMatch(/SELECT floor\(\s*coalesce\(\s*sum\(\s*extract\(/);
    expect(p).toMatch(/\) \/ 60\s*\)\s*::int AS total_minutes/);
    expect(p).toMatch(/totals\.session_minute = lifecycleRows\[0\]\?\.total_minutes \?\? 0;/);
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

  it('CRITICAL complete-day lifecycle split — generated boundaries are fixed UTC 24-hour steps and each day floors only after sum.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/usage-repo.ts'));
    expect(p).toMatch(/day_start_utc AT TIME ZONE 'UTC' AS day_start/);
    expect(p).toMatch(/interval '24 hours'/);
    expect(p).toMatch(/GROUP BY days\.day_start/);
    expect(p).toMatch(/bucket\.session_minute = row\.total_minutes;/);
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
