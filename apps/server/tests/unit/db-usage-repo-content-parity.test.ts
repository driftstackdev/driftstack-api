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
//   • Existing (account_id, recorded_at) index rationale.

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

  it('imports: and/eq/gte/lt/sql from drizzle-orm; UsageDailyBucket/RecordType/Repo/Totals from services/usage; Database type; usageRecords schema', () => {
    expect(body).toMatch(/import \{ and, eq, gte, lt, sql \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{\s*\n?\s*UsageDailyBucket,\s*\n?\s*UsageRecordType,\s*\n?\s*UsageRepo,\s*\n?\s*UsageTotals,\s*\n?\s*\} from '\.\.\/services\/usage\.js';/,
    );
    expect(body).toMatch(/import \{ usageRecords \} from '\.\/schema\.js';/);
  });

  it('totalsForPeriod: 2-field select (recordType + total via coalesce(sum,0)::int); WHERE accountId + half-open [periodStart, periodEnd) via gte/lt; GROUP BY recordType; populate totals Partial<Record<UsageRecordType, number>>', () => {
    expect(body).toMatch(
      /async totalsForPeriod\(\s*\n?\s*accountId: string,\s*\n?\s*periodStart: Date,\s*\n?\s*periodEnd: Date,\s*\n?\s*\): Promise<UsageTotals> \{\s*\n?\s*const rows = await this\.database\.db\s*\n?\s*\.select\(\{\s*\n?\s*recordType: usageRecords\.recordType,\s*\n?\s*total: sql<number>`coalesce\(sum\(\$\{usageRecords\.quantity\}\), 0\)::int`,\s*\n?\s*\}\)\s*\n?\s*\.from\(usageRecords\)\s*\n?\s*\.where\(\s*\n?\s*and\(\s*\n?\s*eq\(usageRecords\.accountId, accountId\),\s*\n?\s*gte\(usageRecords\.recordedAt, periodStart\),\s*\n?\s*lt\(usageRecords\.recordedAt, periodEnd\),\s*\n?\s*\),\s*\n?\s*\)\s*\n?\s*\.groupBy\(usageRecords\.recordType\);/,
    );
    expect(body).toMatch(
      /const totals: Partial<Record<UsageRecordType, number>> = \{\};\s*\n?\s*for \(const row of rows\) \{\s*\n?\s*totals\[row\.recordType\] = row\.total;\s*\n?\s*\}\s*\n?\s*return \{ totals \};/,
    );
  });

  it("dailyBucketsForRange framing pinned: GROUP BY (date_trunc('day', recorded_at), record_type) with existing (account_id, recorded_at) index; UTC-day truncation matches API contract", () => {
    expect(body).toMatch(
      /\/\/ GROUP BY \(date_trunc\('day', recorded_at\), record_type\) with the\s*\n?\s*\/\/ existing \(account_id, recorded_at\) index\. UTC-day truncation\s*\n?\s*\/\/ matches the API contract\./,
    );
  });

  it("dailyBucketsForRange: 3-field select (day via to_char + date_trunc 'day' AT TIME ZONE 'UTC' formatted 'YYYY-MM-DD' + recordType + total via coalesce(sum,0)::int); same WHERE half-open [fromDate, toDate); GROUP BY same date_trunc expr + recordType", () => {
    expect(body).toMatch(
      /day: sql<string>`to_char\(date_trunc\('day', \$\{usageRecords\.recordedAt\} AT TIME ZONE 'UTC'\), 'YYYY-MM-DD'\)`,\s*\n?\s*recordType: usageRecords\.recordType,\s*\n?\s*total: sql<number>`coalesce\(sum\(\$\{usageRecords\.quantity\}\), 0\)::int`,/,
    );
    expect(body).toMatch(
      /\.groupBy\(\s*\n?\s*sql`date_trunc\('day', \$\{usageRecords\.recordedAt\} AT TIME ZONE 'UTC'\)`,\s*\n?\s*usageRecords\.recordType,\s*\n?\s*\);/,
    );
  });

  it('Result aggregation: Map<string, Partial<Record<UsageRecordType, number>>> keyed by day; entries sorted ASC by date.localeCompare; output {date, totals} array', () => {
    expect(body).toMatch(
      /const byDate = new Map<string, Partial<Record<UsageRecordType, number>>>\(\);\s*\n?\s*for \(const row of rows\) \{\s*\n?\s*const bucket = byDate\.get\(row\.day\) \?\? \{\};\s*\n?\s*bucket\[row\.recordType\] = row\.total;\s*\n?\s*byDate\.set\(row\.day, bucket\);\s*\n?\s*\}\s*\n?\s*return Array\.from\(byDate\.entries\(\)\)\s*\n?\s*\.sort\(\(\[a\], \[b\]\) => a\.localeCompare\(b\)\)\s*\n?\s*\.map\(\(\[date, totals\]\) => \(\{ date, totals \}\)\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
