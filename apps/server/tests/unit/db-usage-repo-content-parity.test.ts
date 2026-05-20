// W442.B — drift guard for apps/server/src/db/usage-repo.ts.
// UsageRepo with period totals + V-170 daily-bucket aggregation.
// Drift here either drops the AT TIME ZONE 'UTC' clause on
// date_trunc (server-local time-zone leaks into the response and
// fights the API "UTC YYYY-MM-DD" contract) or replaces gte/lt with
// gte/lte (period-end double-counting at the boundary).
//
//   • totalsForPeriod: SUM grouped by record_type; half-open window
//     [periodStart, periodEnd) via gte/lt; coalesce(sum,0)::int.
//   • dailyBucketsForRange: date_trunc('day', recordedAt AT TIME
//     ZONE 'UTC') matches API "UTC YYYY-MM-DD" contract; GROUP BY
//     truncated-day + recordType; sorted byDate ascending.
//   • Same half-open [from, to) window via gte/lt.
//   • v2-#4 Q.1.e — ne(recordType, INTERNAL_RECORD_TYPES[0]) filters
//     server-internal `agent_decomposer` (+ Arc 1 sub-slice 6.4
//     `agent_decomposer_bundled`) telemetry from customer-facing
//     aggregations.
//
// 2026-05-20 — REWRITTEN to use DISCRETE small pins instead of one
// 20-`\s*\n?\s*`-chain regex. The prior style was hitting catastrophic
// backtracking on fail-match (post-v2-#4 source changes broke the
// chain; the regex engine exhausted ~3 minutes of CPU per pre-push
// before vitest cycled the worker). Memory rule "Eliminated
// catastrophic backtracking parity-regex risk by pivoting to discrete
// kind-extraction regex instead of broad \\s*\\n?\\s* chains" applied.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/usage-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W442.B apps/server/src/db/usage-repo.ts content parity', () => {
  const body = read(LIB);

  it("header framing pinned: 'Drizzle-backed implementation of UsageRepo.'", () => {
    expect(body).toMatch(/\/\/ Drizzle-backed implementation of UsageRepo\./);
  });

  it('imports: and/eq/gte/lt/ne/sql from drizzle-orm; UsageDailyBucket/RecordType/Repo/Totals from services/usage; Database type; usageRecords schema', () => {
    expect(body).toMatch(/import \{ and, eq, gte, lt, ne, sql \} from 'drizzle-orm';/);
    expect(body).toMatch(/UsageDailyBucket,/);
    expect(body).toMatch(/UsageRecordType,/);
    expect(body).toMatch(/UsageRepo,/);
    expect(body).toMatch(/UsageTotals,/);
    expect(body).toMatch(/import \{ usageRecords \} from '\.\/schema\.js';/);
  });

  it('v2-#4 Q.1.e + Arc 1 sub-slice 6.4 — INTERNAL_RECORD_TYPES constant filters server-internal cost telemetry from customer-facing aggregations', () => {
    expect(body).toMatch(
      /const INTERNAL_RECORD_TYPES = \['agent_decomposer', 'agent_decomposer_bundled'\] as const;/,
    );
  });

  it('totalsForPeriod: 3-arg signature (accountId / periodStart / periodEnd) returning Promise<UsageTotals>', () => {
    expect(body).toMatch(/async totalsForPeriod\(/);
    expect(body).toMatch(/accountId: string,/);
    expect(body).toMatch(/periodStart: Date,/);
    expect(body).toMatch(/periodEnd: Date,/);
    expect(body).toMatch(/\): Promise<UsageTotals> \{/);
  });

  it('totalsForPeriod select shape: recordType + coalesce(sum,0)::int as total', () => {
    expect(body).toMatch(/recordType: usageRecords\.recordType,/);
    expect(body).toMatch(
      /total: sql<number>`coalesce\(sum\(\$\{usageRecords\.quantity\}\), 0\)::int`,/,
    );
  });

  it('totalsForPeriod WHERE clause: half-open [periodStart, periodEnd) via gte/lt + accountId eq + v2-#4 ne(recordType, INTERNAL_RECORD_TYPES[0])', () => {
    expect(body).toMatch(/eq\(usageRecords\.accountId, accountId\),/);
    expect(body).toMatch(/gte\(usageRecords\.recordedAt, periodStart\),/);
    expect(body).toMatch(/lt\(usageRecords\.recordedAt, periodEnd\),/);
    expect(body).toMatch(/ne\(usageRecords\.recordType, INTERNAL_RECORD_TYPES\[0\]\),/);
    expect(body).toMatch(/\.groupBy\(usageRecords\.recordType\);/);
  });

  it('totalsForPeriod result aggregation: Partial<Record<UsageRecordType,number>> + defensive INTERNAL_RECORD_TYPES.includes() drop', () => {
    expect(body).toMatch(/const totals: Partial<Record<UsageRecordType, number>> = \{\};/);
    expect(body).toMatch(
      /if \(\(INTERNAL_RECORD_TYPES as readonly string\[\]\)\.includes\(row\.recordType\)\) continue;/,
    );
    expect(body).toMatch(/totals\[row\.recordType as UsageRecordType\] = row\.total;/);
    expect(body).toMatch(/return \{ totals \};/);
  });

  it("dailyBucketsForRange framing pinned: GROUP BY (date_trunc('day', recorded_at), record_type) with existing (account_id, recorded_at) index; UTC-day truncation matches API contract", () => {
    expect(body).toMatch(/GROUP BY \(date_trunc\('day', recorded_at\), record_type\)/);
    expect(body).toMatch(/existing \(account_id, recorded_at\) index/);
    expect(body).toMatch(/UTC-day truncation/);
    expect(body).toMatch(/matches the API contract\./);
  });

  it("dailyBucketsForRange select shape: day via to_char + date_trunc 'day' AT TIME ZONE 'UTC' formatted 'YYYY-MM-DD' + recordType + total", () => {
    expect(body).toMatch(
      /day: sql<string>`to_char\(date_trunc\('day', \$\{usageRecords\.recordedAt\} AT TIME ZONE 'UTC'\), 'YYYY-MM-DD'\)`,/,
    );
  });

  it('dailyBucketsForRange WHERE: same half-open [fromDate, toDate) + accountId eq + ne(recordType, INTERNAL_RECORD_TYPES[0])', () => {
    expect(body).toMatch(/gte\(usageRecords\.recordedAt, fromDate\),/);
    expect(body).toMatch(/lt\(usageRecords\.recordedAt, toDate\),/);
  });

  it('dailyBucketsForRange GROUP BY: date_trunc expr + recordType', () => {
    expect(body).toMatch(
      /sql`date_trunc\('day', \$\{usageRecords\.recordedAt\} AT TIME ZONE 'UTC'\)`,/,
    );
  });

  it('Result aggregation: Map<string, Partial<Record<UsageRecordType, number>>> keyed by day; entries sorted ASC by date.localeCompare; output {date, totals} array', () => {
    expect(body).toMatch(
      /const byDate = new Map<string, Partial<Record<UsageRecordType, number>>>\(\);/,
    );
    expect(body).toMatch(/byDate\.get\(row\.day\)/);
    expect(body).toMatch(/byDate\.set\(row\.day, bucket\);/);
    expect(body).toMatch(/\.sort\(\(\[a\], \[b\]\) => a\.localeCompare\(b\)\)/);
    expect(body).toMatch(/\.map\(\(\[date, totals\]\) => \(\{ date, totals \}\)\);/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
