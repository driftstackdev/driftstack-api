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
