import { z } from 'zod';
import { AccountTierSchema, Iso8601Schema } from './common.js';

export const UsageRecordTypeSchema = z.enum([
  'session_minute',
  'navigate',
  'interact',
  'wait',
  'state_capture',
  'screenshot_capture',
]);

export const UsageRecordSchema = z.object({
  type: UsageRecordTypeSchema,
  quantity: z.number().int().nonnegative(),
  recorded_at: Iso8601Schema,
});

export const UsagePeriodSummarySchema = z.object({
  period_start: Iso8601Schema,
  period_end: Iso8601Schema,
  tier: AccountTierSchema,
  // Per-record-type tally for the current period.
  totals: z.record(UsageRecordTypeSchema, z.number().int().nonnegative()),
  // Tier quotas (max permitted in period); null = unmetered for that record.
  quotas: z.record(UsageRecordTypeSchema, z.number().int().nonnegative().nullable()),
});

export type UsagePeriodSummary = z.infer<typeof UsagePeriodSummarySchema>;

/**
 * V-170 — daily-bucketed usage series. Used by customer-dashboard
 * /usage sparklines + admin-panel account-detail charts. Returns one
 * bucket per UTC day in `[from_date, to_date)`, contiguous (days with
 * zero usage are included as empty `totals: {}`). `to_date` is
 * exclusive (typically today's UTC midnight); `from_date` is inclusive.
 */
export const UsageDailyBucketSchema = z.object({
  /** UTC date in `YYYY-MM-DD`. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totals: z.record(UsageRecordTypeSchema, z.number().int().nonnegative()),
});

export const UsageSeriesQuerySchema = z.object({
  /** Number of trailing days to return; default 30, max 90. */
  days: z.coerce.number().int().min(1).max(90).optional(),
});

export const UsageSeriesResponseSchema = z.object({
  from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  buckets: z.array(UsageDailyBucketSchema),
});

export type UsageDailyBucket = z.infer<typeof UsageDailyBucketSchema>;
export type UsageSeriesQuery = z.infer<typeof UsageSeriesQuerySchema>;
export type UsageSeriesResponse = z.infer<typeof UsageSeriesResponseSchema>;
