// Billing flow schemas (V-082).
//
// Endpoints exposed under /v1/billing/*:
//   - POST /v1/billing/checkout-session   (start a paid-tier subscription)
//   - POST /v1/billing/trial-pack         (start the $2.99 trial pack)
//   - POST /v1/billing/portal-session     (open Stripe Customer Portal)
//   - GET  /v1/billing/subscription       (current subscription state)
//
// At scaffolding time, the actual Stripe API calls are gated behind
// a `BillingProvider` interface so tests run against an in-memory
// provider that returns deterministic checkout URLs / customer IDs.

import { z } from 'zod';
import { AccountTierSchema, Iso8601Schema } from './common.js';

// ───────────────────────────────────────────────────────────────────────────
// Checkout session
// ───────────────────────────────────────────────────────────────────────────

export const BillingPeriodSchema = z.enum(['monthly', 'annual']);
export type BillingPeriod = z.infer<typeof BillingPeriodSchema>;

export const CreateCheckoutSessionRequestSchema = z.object({
  /** Target tier. Must be a paid tier (not 'trial_pack' or 'enterprise'). */
  tier: AccountTierSchema.refine(
    (t) => t !== 'trial_pack' && t !== 'enterprise',
    'tier must be a self-serve paid tier (trial_pack and enterprise excluded)',
  ),
  billing_period: BillingPeriodSchema,
  /**
   * Where Stripe redirects on success. The `{CHECKOUT_SESSION_ID}` token
   * is replaced server-side. Defaults to the configured success URL when
   * omitted.
   */
  success_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
});
export type CreateCheckoutSessionRequest = z.infer<typeof CreateCheckoutSessionRequestSchema>;

export const CreateCheckoutSessionResponseSchema = z.object({
  checkout_url: z.string().url(),
  /** Stripe checkout session id. Echoed for client-side correlation. */
  checkout_session_id: z.string(),
});
export type CreateCheckoutSessionResponse = z.infer<typeof CreateCheckoutSessionResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Trial-pack
// ───────────────────────────────────────────────────────────────────────────

// The trial-pack is a one-time $2.99 pre-paid credit per ADR-003. Same
// Stripe Checkout flow, different price id (a one-time payment, not a
// subscription). On success the webhook router records the purchase
// and provisions trial_pack_credit_cents = 299, expires_at = +14 days.
export const StartTrialPackRequestSchema = z.object({
  success_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
});
export type StartTrialPackRequest = z.infer<typeof StartTrialPackRequestSchema>;

export const StartTrialPackResponseSchema = z.object({
  checkout_url: z.string().url(),
  checkout_session_id: z.string(),
});
export type StartTrialPackResponse = z.infer<typeof StartTrialPackResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Customer portal
// ───────────────────────────────────────────────────────────────────────────

export const CreatePortalSessionResponseSchema = z.object({
  portal_url: z.string().url(),
});
export type CreatePortalSessionResponse = z.infer<typeof CreatePortalSessionResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Subscription read
// ───────────────────────────────────────────────────────────────────────────

export const SubscriptionStatusSchema = z.enum([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const SubscriptionSchema = z.object({
  tier: AccountTierSchema,
  status: SubscriptionStatusSchema,
  stripe_subscription_id: z.string(),
  current_period_end: Iso8601Schema.nullable(),
  cancel_at_period_end: z.boolean(),
  canceled_at: Iso8601Schema.nullable(),
  created_at: Iso8601Schema,
  updated_at: Iso8601Schema,
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const TrialPackStateSchema = z.object({
  /** True when the account holds an unredeemed trial-pack credit. */
  active: z.boolean(),
  credit_cents_remaining: z.number().int().nullable(),
  expires_at: Iso8601Schema.nullable(),
  redeemed: z.boolean(),
});
export type TrialPackState = z.infer<typeof TrialPackStateSchema>;

export const GetBillingStateResponseSchema = z.object({
  subscription: SubscriptionSchema.nullable(),
  trial_pack: TrialPackStateSchema,
});
export type GetBillingStateResponse = z.infer<typeof GetBillingStateResponseSchema>;
