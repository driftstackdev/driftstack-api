// W433.A — drift guard for packages/api-types/src/usage.ts.
// Usage metering shapes. Drift here either drops a billable
// record-type from UsageRecordTypeSchema (server emits records the
// SDK can't represent — type mismatch on every aggregation) or
// breaks the V-170 daily-bucket shape (dashboard sparklines fall
// over).
//
//   • UsageRecordTypeSchema enum: 6 record types pinned
//     (session_minute / navigate / interact / wait /
//     state_capture / screenshot_capture).
//   • UsageRecordSchema: type + non-negative int quantity +
//     recorded_at Iso8601.
//   • UsagePeriodSummary: period_start/end + tier + totals
//     record + quotas record (null = unmetered).
//   • V-170 UsageDailyBucket: date YYYY-MM-DD regex + totals
//     record.
//   • UsageSeriesQuery: days int 1..90 default 30 via coerce.
//   • UsageSeriesResponse: from_date inclusive / to_date
//     exclusive + buckets array.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/usage.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W433.A packages/api-types/src/usage.ts content parity', () => {
  const body = read(LIB);

  it("imports: z from 'zod' + AccountTierSchema + Iso8601Schema from './common.js'", () => {
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(/import \{ AccountTierSchema, Iso8601Schema \} from '\.\/common\.js';/);
  });

  it('UsageRecordTypeSchema enum: 6 billable record types pinned (session_minute / navigate / interact / wait / state_capture / screenshot_capture) in exact order', () => {
    expect(body).toMatch(
      /export const UsageRecordTypeSchema = z\.enum\(\[\s*'session_minute',\s*'navigate',\s*'interact',\s*'wait',\s*'state_capture',\s*'screenshot_capture',\s*\]\);/,
    );
  });

  it('UsageRecordSchema: type + non-negative int quantity + recorded_at Iso8601', () => {
    expect(body).toMatch(
      /export const UsageRecordSchema = z\.object\(\{\s*type: UsageRecordTypeSchema,\s*quantity: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*recorded_at: Iso8601Schema,\s*\}\);/,
    );
  });

  it('UsagePeriodSummary: period_start/end + tier + per-type totals + quotas (null=unmetered) records', () => {
    expect(body).toMatch(
      /export const UsagePeriodSummarySchema = z\.object\(\{\s*period_start: Iso8601Schema,\s*period_end: Iso8601Schema,\s*tier: AccountTierSchema,\s*\/\/ Per-record-type tally for the current period\.\s*totals: z\.record\(UsageRecordTypeSchema, z\.number\(\)\.int\(\)\.nonnegative\(\)\),\s*\/\/ Tier quotas \(max permitted in period\); null = unmetered for that record\.\s*quotas: z\.record\(UsageRecordTypeSchema, z\.number\(\)\.int\(\)\.nonnegative\(\)\.nullable\(\)\),\s*\}\);/,
    );
    expect(body).toMatch(
      /export type UsagePeriodSummary = z\.infer<typeof UsagePeriodSummarySchema>;/,
    );
  });

  it('V-170 daily-bucketed usage series framing: customer-dashboard sparklines + admin-panel account-detail charts; contiguous days incl. zero-usage; to_date exclusive / from_date inclusive', () => {
    expect(body).toMatch(
      /\*\s*V-170 — daily-bucketed usage series\. Used by customer-dashboard\s*\*\s*\/usage sparklines \+ admin-panel account-detail charts\. Returns one\s*\*\s*bucket per UTC day in `\[from_date, to_date\)`, contiguous \(days with\s*\*\s*zero usage are included as empty `totals: \{\}`\)\. `to_date` is\s*\*\s*exclusive \(typically today's UTC midnight\); `from_date` is inclusive\./,
    );
  });

  it('UsageDailyBucket: date YYYY-MM-DD regex + totals record', () => {
    expect(body).toMatch(
      /export const UsageDailyBucketSchema = z\.object\(\{\s*\/\*\* UTC date in `YYYY-MM-DD`\. \*\/\s*date: z\.string\(\)\.regex\(\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\),\s*totals: z\.record\(UsageRecordTypeSchema, z\.number\(\)\.int\(\)\.nonnegative\(\)\),\s*\}\);/,
    );
  });

  it('UsageSeriesQuery: days coerced int 1..90 optional; comment "default 30, max 90"', () => {
    expect(body).toMatch(
      /export const UsageSeriesQuerySchema = z\.object\(\{\s*\/\*\* Number of trailing days to return; default 30, max 90\. \*\/\s*days: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(90\)\.optional\(\),\s*\}\);/,
    );
  });

  it('UsageSeriesResponse: from_date YYYY-MM-DD regex + to_date YYYY-MM-DD regex + buckets array of UsageDailyBucket', () => {
    expect(body).toMatch(
      /export const UsageSeriesResponseSchema = z\.object\(\{\s*from_date: z\.string\(\)\.regex\(\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\),\s*to_date: z\.string\(\)\.regex\(\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\),\s*buckets: z\.array\(UsageDailyBucketSchema\),\s*\}\);/,
    );
    expect(body).toMatch(/export type UsageDailyBucket = z\.infer<typeof UsageDailyBucketSchema>;/);
    expect(body).toMatch(/export type UsageSeriesQuery = z\.infer<typeof UsageSeriesQuerySchema>;/);
    expect(body).toMatch(
      /export type UsageSeriesResponse = z\.infer<typeof UsageSeriesResponseSchema>;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
