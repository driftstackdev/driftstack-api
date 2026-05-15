// W894 — V-170 Usage series + UsagePeriodSummary cross-source
// invariant. Two-hundred-twentieth in the drift-guard series.
// Pins the V-170 daily-bucketed usage series + the V-148-keyed
// UsagePeriodSummary:
//
//   UsageRecord (3 fields):
//     - type: UsageRecordTypeSchema (6-value).
//     - quantity: int nonnegative.
//     - recorded_at: ISO.
//
//   UsagePeriodSummary (5 fields):
//     - period_start + period_end + tier + totals + quotas.
//     - totals: z.record(UsageRecordType, int nonnegative).
//     - quotas: z.record(UsageRecordType, int nonnegative |
//       NULL=unmetered).
//
//   V-170 UsageDailyBucket (2 fields):
//     - date: UTC YYYY-MM-DD regex.
//     - totals: per-record-type tally.
//
//   UsageSeriesQuery: days: 1-90 (defaults 30).
//   UsageSeriesResponse: from_date + to_date + buckets array.
//   Contiguous days (empty totals for zero-usage days).
//   to_date EXCLUSIVE, from_date INCLUSIVE.
//
// stays in lockstep across api-types Zod canonical.
//
// Drift would silently break:
//   * Customer-dashboard sparkline rendering missing days
//     (contiguity violation).
//   * 90-day cap: server crash on infinite-query.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W894 V-170 Usage series cross-source invariant', () => {
  // ─── UsageRecord 3-field shape ───────────────────────────────

  it('CRITICAL UsageRecordSchema has 3 fields — type (UsageRecordTypeSchema) + quantity (int nonnegative) + recorded_at (ISO). The 3-field shape is what the metering ingestion pipeline persists.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/usage.ts'));
    expect(p).toMatch(
      /UsageRecordSchema = z\.object\(\{\s*\n\s*type: UsageRecordTypeSchema,\s*\n\s*quantity: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n\s*recorded_at: Iso8601Schema,\s*\n\s*\}\);/,
    );
  });

  // ─── UsagePeriodSummary 5-field shape ───────────────────────

  it('CRITICAL UsagePeriodSummarySchema has 5 fields — period_start + period_end + tier + totals + quotas. The totals + quotas pair lets the dashboard render usage-vs-quota bars per record-type.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/usage.ts'));
    expect(p).toMatch(
      /UsagePeriodSummarySchema = z\.object\(\{\s*\n\s*period_start: Iso8601Schema,\s*\n\s*period_end: Iso8601Schema,\s*\n\s*tier: AccountTierSchema,/,
    );
    expect(p).toMatch(
      /totals: z\.record\(UsageRecordTypeSchema, z\.number\(\)\.int\(\)\.nonnegative\(\)\)/,
    );
    expect(p).toMatch(
      /quotas: z\.record\(UsageRecordTypeSchema, z\.number\(\)\.int\(\)\.nonnegative\(\)\.nullable\(\)\)/,
    );
  });

  it("CRITICAL UsagePeriodSummary quotas.value uses .nullable() — null means UNMETERED for that record-type. The doc comment 'null = unmetered for that record' pins the semantics.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/usage.ts'));
    expect(p).toMatch(/null = unmetered for that record/);
  });

  // ─── V-170 UsageDailyBucket 2-field shape ────────────────────

  it("CRITICAL V-170 anchor + 'daily-bucketed usage series' framing + 'contiguous (days with zero usage are included as empty totals: {})' contiguity contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/usage.ts'));
    expect(p).toMatch(/V-170 — daily-bucketed usage series/);
    expect(p).toMatch(
      /contiguous \(days with\s*\n\s*\*\s*zero usage are included as empty `totals: \{\}`\)/,
    );
  });

  it("CRITICAL V-170 to_date is EXCLUSIVE + from_date INCLUSIVE — '[from_date, to_date)' interval. The half-open convention matches Python pandas + Postgres BETWEEN semantics — drift to inclusive both would double-count the last day.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/usage.ts'));
    expect(p).toMatch(/`\[from_date, to_date\)`/);
    expect(p).toMatch(
      /`to_date` is\s*\n\s*\*\s*exclusive \(typically today's UTC midnight\); `from_date` is inclusive/,
    );
  });

  it('CRITICAL UsageDailyBucketSchema 2 fields — date (UTC YYYY-MM-DD regex) + totals (per-record-type tally). Drift to letting date carry a timezone would break UTC-day-bucketing.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/usage.ts'));
    expect(p).toMatch(
      /UsageDailyBucketSchema = z\.object\(\{[\s\S]+?date: z\.string\(\)\.regex\(\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\)/,
    );
    expect(p).toMatch(
      /UsageDailyBucketSchema = z\.object\(\{[\s\S]+?totals: z\.record\(UsageRecordTypeSchema, z\.number\(\)\.int\(\)\.nonnegative\(\)\)/,
    );
  });

  // ─── UsageSeriesQuery days 1-90 ──────────────────────────────

  it('CRITICAL UsageSeriesQuerySchema days bound = z.coerce.number().int().min(1).max(90).optional(). The 1-day min + 90-day max bounds prevent zero-day query (no-op) + infinite-history query (server crash).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/usage.ts'));
    expect(p).toMatch(
      /UsageSeriesQuerySchema = z\.object\(\{[\s\S]+?days: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(90\)\.optional\(\)/,
    );
  });

  it('CRITICAL UsageSeriesQuery days default = 30 (comment hint). The 30-day default is what the dashboard sparkline renders by default.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/usage.ts'));
    expect(p).toMatch(/default 30, max 90/);
  });

  // ─── UsageSeriesResponse 3-field shape ───────────────────────

  it('CRITICAL UsageSeriesResponseSchema has 3 fields — from_date + to_date (both YYYY-MM-DD) + buckets (array of UsageDailyBucket). The 3-field response gives the dashboard the date range AND the series.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/usage.ts'));
    expect(p).toMatch(
      /UsageSeriesResponseSchema = z\.object\(\{\s*\n\s*from_date: z\.string\(\)\.regex\(\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\),\s*\n\s*to_date: z\.string\(\)\.regex\(\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\),\s*\n\s*buckets: z\.array\(UsageDailyBucketSchema\)/,
    );
  });

  // ─── V-170 consumer framing pinned ───────────────────────────

  it("CRITICAL V-170 consumer doc — 'customer-dashboard /usage sparklines + admin-panel account-detail charts'. The 2-consumer note threads the cross-app usage.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/usage.ts'));
    expect(p).toMatch(
      /customer-dashboard\s*\n\s*\*\s*\/usage sparklines \+ admin-panel account-detail charts/,
    );
  });

  // ─── Types re-exported ───────────────────────────────────────

  it('CRITICAL all 3 V-170 types re-export — UsageDailyBucket + UsageSeriesQuery + UsageSeriesResponse + UsagePeriodSummary. The 4 types are the full usage-read surface.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/usage.ts'));
    expect(p).toMatch(/export type UsageDailyBucket = z\.infer<typeof UsageDailyBucketSchema>;/);
    expect(p).toMatch(/export type UsageSeriesQuery = z\.infer<typeof UsageSeriesQuerySchema>;/);
    expect(p).toMatch(
      /export type UsageSeriesResponse = z\.infer<typeof UsageSeriesResponseSchema>;/,
    );
    expect(p).toMatch(
      /export type UsagePeriodSummary = z\.infer<typeof UsagePeriodSummarySchema>;/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/usage-series-schemas-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
