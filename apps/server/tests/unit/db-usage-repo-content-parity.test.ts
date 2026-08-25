// W442.B — drift guard for apps/server/src/db/usage-repo.ts.
// UsageRepo with period totals + V-170 daily-bucket aggregation. Session
// minutes come from durable lifecycle intervals rather than the optional
// usage_records ledger, so customer/admin usage is truthful without a writer.
// Drift here either drops the AT TIME ZONE 'UTC' clause on
// date_trunc (server-local time-zone leaks into the response and
// fights the API "UTC YYYY-MM-DD" contract) or replaces gte/lt with
// gte/lte (period-end double-counting at the boundary).
//
//   • Action rows: SUM grouped by record_type; half-open window
//     [periodStart, periodEnd) via gte/lt; lifecycle + decomposer rows excluded.
//   • Session minutes: real non-reserving direct sessions plus assigned,
//     unlinked agent sessions. Intervals clip to one injected clock/window;
//     terminal rows fall back to updated_at when their terminal stamp is null.
//   • Floor applies after seconds are summed, never once per session.
//   • dailyBucketsForRange: date_trunc('day', recordedAt AT TIME
//     ZONE 'UTC') matches API "UTC YYYY-MM-DD" contract; GROUP BY
//     truncated-day + recordType; sorted byDate ascending.
//   • Same half-open [from, to) window via gte/lt.
//   • SQL and JS both reject legacy session-minute ledger rows and the
//     server-internal agent_decomposer / agent_decomposer_bundled telemetry.
//
// 2026-05-20 — REWRITTEN to use DISCRETE small pins instead of one
// 20-`\s*`-chain regex. The prior style was hitting catastrophic
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

  it('record-source constants separate lifecycle session minutes from both internal decomposer ledgers', () => {
    expect(body).toMatch(
      /const INTERNAL_RECORD_TYPES = \['agent_decomposer', 'agent_decomposer_bundled'\] as const;/,
    );
    expect(body).toMatch(/const LIFECYCLE_DERIVED_RECORD_TYPE = 'session_minute' as const;/);
  });

  it('constructor injects a deterministic clock while production defaults to a fresh Date', () => {
    expect(body).toMatch(/private readonly database: Database,/);
    expect(body).toMatch(/private readonly clock: \(\) => Date = \(\) => new Date\(\),/);
    expect(body.match(/const asOf = this\.clock\(\);/g)).toHaveLength(2);
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

  it('totalsForPeriod action WHERE is half-open and excludes lifecycle minutes plus both decomposer types', () => {
    expect(body).toMatch(/eq\(usageRecords\.accountId, accountId\),/);
    expect(body).toMatch(/gte\(usageRecords\.recordedAt, periodStart\),/);
    expect(body).toMatch(/lt\(usageRecords\.recordedAt, periodEnd\),/);
    expect(body).toMatch(/ne\(usageRecords\.recordType, LIFECYCLE_DERIVED_RECORD_TYPE\),/);
    expect(body).toMatch(/ne\(usageRecords\.recordType, INTERNAL_RECORD_TYPES\[0\]\),/);
    expect(body).toMatch(/ne\(usageRecords\.recordType, INTERNAL_RECORD_TYPES\[1\]\),/);
    expect(body).toMatch(/\.groupBy\(usageRecords\.recordType\);/);
  });

  it('totalsForPeriod result merges the lifecycle-derived minute count into action totals', () => {
    expect(body).toMatch(/const totals: Partial<Record<UsageRecordType, number>> = \{\};/);
    expect(body).toMatch(
      /row\.recordType === LIFECYCLE_DERIVED_RECORD_TYPE \|\|\s*\(INTERNAL_RECORD_TYPES as readonly string\[\]\)\.includes\(row\.recordType\)/,
    );
    expect(body).toMatch(/totals\[row\.recordType as UsageRecordType\] = row\.total;/);
    expect(body).toMatch(/totals\.session_minute = lifecycleRows\[0\]\?\.total_minutes \?\? 0;/);
    expect(body).toMatch(/return \{ totals \};/);
  });

  it('period lifecycle source includes only real direct and assigned standalone agent sessions', () => {
    expect(body).toMatch(/FROM sessions/);
    expect(body).toMatch(/driver_session_id NOT LIKE 'reserving:%'/);
    expect(body).toMatch(/FROM agent_sessions/);
    expect(body).toMatch(/node_id IS NOT NULL/);
    expect(body).toMatch(/driftstack_session_id IS NULL/);
  });

  it('terminal fallback and half-open clipping are explicit for direct and agent lifecycles', () => {
    expect(body).toMatch(/WHEN status IN \('destroyed', 'errored'\) THEN updated_at/);
    expect(body).toMatch(/WHEN status = 'closed' THEN updated_at/);
    expect(body).toMatch(
      /WHERE greatest\(started_at, \$\{periodStartIso\}::timestamptz\)\s*< least\(ended_at, \$\{periodEndIso\}::timestamptz, \$\{asOfIso\}::timestamptz\)/,
    );
  });

  it('period minutes floor only after all clipped lifecycle seconds are summed', () => {
    expect(body).toMatch(/SELECT floor\(\s*coalesce\(\s*sum\(\s*extract\(/);
    expect(body).toMatch(/\) \/ 60\s*\)\s*::int AS total_minutes/);
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

  it('dailyBucketsForRange action WHERE uses the same half-open window and three-source exclusion', () => {
    expect(body).toMatch(/gte\(usageRecords\.recordedAt, fromDate\),/);
    expect(body).toMatch(/lt\(usageRecords\.recordedAt, toDate\),/);
    expect(
      body.match(/ne\(usageRecords\.recordType, LIFECYCLE_DERIVED_RECORD_TYPE\),/g),
    ).toHaveLength(2);
    expect(body.match(/ne\(usageRecords\.recordType, INTERNAL_RECORD_TYPES\[1\]\),/g)).toHaveLength(
      2,
    );
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
    expect(body).toMatch(/if \(row\.total_minutes <= 0\) continue;/);
    expect(body).toMatch(/bucket\.session_minute = row\.total_minutes;/);
    expect(body).toMatch(/\.sort\(\(\[a\], \[b\]\) => a\.localeCompare\(b\)\)/);
    expect(body).toMatch(/\.map\(\(\[date, totals\]\) => \(\{ date, totals \}\)\);/);
  });

  it('daily lifecycle aggregation generates fixed 24-hour UTC days and floors after each day sum', () => {
    expect(body).toMatch(/day_start_utc AT TIME ZONE 'UTC' AS day_start/);
    expect(body).toMatch(/interval '24 hours'/);
    expect(body).toMatch(/GROUP BY days\.day_start/);
    expect(body).toMatch(/ORDER BY days\.day_start ASC/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
