import { z } from 'zod';
import { AccountIdSchema, AccountTierSchema, Iso8601Schema } from './common.js';

export const AccountStatusSchema = z.enum(['active', 'suspended', 'deleted']);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const AccountSchema = z.object({
  id: AccountIdSchema,
  email: z.string().email(),
  name: z.string().nullable(),
  tier: AccountTierSchema,
  status: AccountStatusSchema,
  created_at: Iso8601Schema,
  updated_at: Iso8601Schema,
});

export type Account = z.infer<typeof AccountSchema>;

// ───────────────────────────────────────────────────────────────────────────
// V-204 — email notification preferences
// ───────────────────────────────────────────────────────────────────────────

/**
 * Event types the customer can opt out of. Security + financial emails
 * (signup-verification, password-reset, billing-failure, subscription-
 * cancellation, support-ack) are never opt-outable; they're absent
 * from this enum on purpose so the API surface matches the policy.
 */
export const OptOutableEmailEventSchema = z.enum([
  'signup-welcome',
  'session-failed-first',
  'tier-changed',
  'trial-pack-purchased',
  'trial-pack-expired',
  'billing-receipt',
]);
export type OptOutableEmailEvent = z.infer<typeof OptOutableEmailEventSchema>;

export const EmailPreferenceSchema = z.object({
  event_type: OptOutableEmailEventSchema,
  opted_in: z.boolean(),
});
export type EmailPreference = z.infer<typeof EmailPreferenceSchema>;

export const ListEmailPreferencesResponseSchema = z.object({
  data: z.array(EmailPreferenceSchema),
});
export type ListEmailPreferencesResponse = z.infer<typeof ListEmailPreferencesResponseSchema>;

export const SetEmailPreferenceRequestSchema = z.object({
  event_type: OptOutableEmailEventSchema,
  opted_in: z.boolean(),
});
export type SetEmailPreferenceRequest = z.infer<typeof SetEmailPreferenceRequestSchema>;
