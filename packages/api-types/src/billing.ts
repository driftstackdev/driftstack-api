// Billing flow schemas (V-082).
//
// Endpoints exposed under /v1/billing/*:
//   - POST /v1/billing/checkout-session   (start a paid-tier subscription)
//   - POST /v1/billing/portal-session     (open Stripe Customer Portal)
//   - GET  /v1/billing/subscription       (current subscription state)
//
// The one-time $2.99 trial_pack was retired 2026-05-27 in favour of a
// perpetual free tier (see AccountTierSchema 'free'); its checkout flow
// and credit state were removed entirely.
//
// At scaffolding time, the actual Stripe API calls are gated behind
// a `BillingProvider` interface so tests run against an in-memory
// provider that returns deterministic checkout URLs / customer IDs.

import { z } from 'zod';
import { AccountTierSchema, Iso8601Schema, PURCHASABLE_TIERS } from './common.js';

// ───────────────────────────────────────────────────────────────────────────
// Checkout session
// ───────────────────────────────────────────────────────────────────────────

export const BillingPeriodSchema = z.enum(['monthly', 'annual']);
export type BillingPeriod = z.infer<typeof BillingPeriodSchema>;

export const CreateCheckoutSessionRequestSchema = z.object({
  /**
   * Target tier. Must be a self-serve paid tier (not 'free' or 'enterprise').
   *
   * V-924 — an enum of the accepted values, not `AccountTierSchema.refine(...)`.
   * A refine is a runtime predicate JSON Schema cannot express, so the generated
   * OpenAPI document emitted all eight tiers and advertised `free` and
   * `enterprise` as valid on a live billing endpoint that returns 400 for both.
   * Same accepted set, same rejection message, accurate published contract.
   */
  tier: z.enum(PURCHASABLE_TIERS, {
    message: 'tier must be a self-serve paid tier (free and enterprise excluded)',
  }),
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

export const GetBillingStateResponseSchema = z.object({
  subscription: SubscriptionSchema.nullable(),
});
export type GetBillingStateResponse = z.infer<typeof GetBillingStateResponseSchema>;
