// Billing routes (V-082).
//
//   POST /v1/billing/checkout-session   — start a paid-tier subscription
//   POST /v1/billing/trial-pack         — start the $2.99 trial pack
//   POST /v1/billing/portal-session     — open Stripe Customer Portal
//   GET  /v1/billing                    — current subscription + trial state
//
// All auth-gated. Trial-pack endpoint is also self-serve from the
// onboarding flow (Workstream F) before tier selection.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CreateCheckoutSessionRequestSchema,
  StartTrialPackRequestSchema,
} from '@driftstack/api-types';
import type { BillingService, SubscriptionMirror } from '../services/billing.js';
import { ValidationError } from '../lib/errors.js';

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

function publicSubscription(s: SubscriptionMirror): Record<string, unknown> {
  return {
    tier: s.tier,
    status: s.status,
    stripe_subscription_id: s.stripeSubscriptionId,
    current_period_end: s.currentPeriodEnd ? s.currentPeriodEnd.toISOString() : null,
    cancel_at_period_end: s.cancelAtPeriodEnd,
    canceled_at: s.canceledAt ? s.canceledAt.toISOString() : null,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  };
}

export interface BillingRoutesDeps {
  service: BillingService;
}

export function registerBillingRoutes(app: FastifyInstance, deps: BillingRoutesDeps): void {
  const { service } = deps;

  app.post(
    '/v1/billing/checkout-session',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const parsed = CreateCheckoutSessionRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      const result = await service.createCheckoutSession({
        accountId: ctx.account.id,
        tier: parsed.data.tier,
        billingPeriod: parsed.data.billing_period,
        ...(parsed.data.success_url !== undefined ? { successUrl: parsed.data.success_url } : {}),
        ...(parsed.data.cancel_url !== undefined ? { cancelUrl: parsed.data.cancel_url } : {}),
      });
      return {
        checkout_url: result.url,
        checkout_session_id: result.sessionId,
      };
    },
  );

  app.post(
    '/v1/billing/trial-pack',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const parsed = StartTrialPackRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      const result = await service.startTrialPack({
        accountId: ctx.account.id,
        ...(parsed.data.success_url !== undefined ? { successUrl: parsed.data.success_url } : {}),
        ...(parsed.data.cancel_url !== undefined ? { cancelUrl: parsed.data.cancel_url } : {}),
      });
      return {
        checkout_url: result.url,
        checkout_session_id: result.sessionId,
      };
    },
  );

  app.post(
    '/v1/billing/portal-session',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const result = await service.createPortalSession(ctx.account.id);
      return { portal_url: result.url };
    },
  );

  app.get(
    '/v1/billing',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const state = await service.getBillingState(ctx.account.id);
      return {
        subscription: state.subscription !== null ? publicSubscription(state.subscription) : null,
        trial_pack: {
          active: state.trialPack.active,
          credit_cents_remaining: state.trialPack.creditCentsRemaining,
          expires_at: state.trialPack.expiresAt ? state.trialPack.expiresAt.toISOString() : null,
          redeemed: state.trialPack.redeemed,
        },
      };
    },
  );
}
