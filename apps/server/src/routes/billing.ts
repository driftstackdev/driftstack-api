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
import { BadRequestError, FeatureUnavailableError, ValidationError } from '../lib/errors.js';

// V-248 / V-246-P1-001 — Stripe checkout return URL allowlist.
// Customer-supplied success_url + cancel_url are passed through to
// Stripe Checkout; without validation, a customer could craft a URL
// pointing at attacker.com and share the checkout link with a colleague
// who'd land on the phishing site after entering their card.
//
// Allowlist: by default the Driftstack cloud dashboard origin and
// `app.driftstack.local` (e2e). Per-customer enterprise allowlists are
// out of scope for the launch posture; customers needing a custom URL
// get a clear "contact support" error.
//
// The allowlist is hardcoded rather than env-driven because it
// anchors the security guarantee — a typo in env config would silently
// re-introduce the open-redirect. Founder edits this list when a
// legitimate origin needs to be added (paired with PR review).
const ALLOWED_RETURN_ORIGINS: readonly string[] = [
  'https://app.driftstack.dev',
  'http://localhost:5173', // dashboard dev server
  'http://app.driftstack.local', // e2e fixture
];

/**
 * Verify a customer-supplied URL is on the allowlist by origin match.
 * Returns the URL string when valid; throws BadRequestError otherwise.
 * Defensive parsing: malformed URLs reject (not silently accepted).
 */
function validateReturnUrl(url: string, label: 'success_url' | 'cancel_url'): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestError(`${label} is not a valid URL.`);
  }
  if (!ALLOWED_RETURN_ORIGINS.includes(parsed.origin)) {
    throw new BadRequestError(
      `${label} origin "${parsed.origin}" is not on the allowlist. Contact support if you need a custom origin allowlisted.`,
    );
  }
  return url;
}

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

      // V-248 — gate customer-supplied return URLs against the allowlist.
      const successUrl =
        parsed.data.success_url !== undefined
          ? validateReturnUrl(parsed.data.success_url, 'success_url')
          : undefined;
      const cancelUrl =
        parsed.data.cancel_url !== undefined
          ? validateReturnUrl(parsed.data.cancel_url, 'cancel_url')
          : undefined;
      const result = await service.createCheckoutSession({
        accountId: ctx.account.id,
        tier: parsed.data.tier,
        billingPeriod: parsed.data.billing_period,
        ...(successUrl !== undefined ? { successUrl } : {}),
        ...(cancelUrl !== undefined ? { cancelUrl } : {}),
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

      // V-248 — same allowlist gate as checkout-session.
      const successUrl =
        parsed.data.success_url !== undefined
          ? validateReturnUrl(parsed.data.success_url, 'success_url')
          : undefined;
      const cancelUrl =
        parsed.data.cancel_url !== undefined
          ? validateReturnUrl(parsed.data.cancel_url, 'cancel_url')
          : undefined;
      const result = await service.startTrialPack({
        accountId: ctx.account.id,
        ...(successUrl !== undefined ? { successUrl } : {}),
        ...(cancelUrl !== undefined ? { cancelUrl } : {}),
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

// Wave 1119 / Slice 1119.2 B1 server-side leg — when Stripe env is not
// configured (no STRIPE_SECRET_KEY / DRIFTSTACK_TIER_PRICE_IDS /
// STRIPE_TRIAL_PACK_PRICE_ID), `registerBillingRoutes` doesn't run and
// the four `/v1/billing/*` paths fall through to the global 404 handler.
// That's the wrong signal for an *intentionally unconfigured* feature:
// 404 reads as "this endpoint doesn't exist" (typo? wrong version?) when
// the right read is "this server isn't wired for billing yet."
//
// `registerBillingDisabledRoutes` wires the same four paths to 503 +
// `FeatureUnavailable` problem-type bodies so the dashboard's existing
// 503-detection leg (apps/customer-dashboard/src/pages/select-tier.astro
// since 121cd266) gets a machine-readable signal + a clear human message.
// The Retry-After header is emitted automatically by the error-handler
// middleware when extensions.retry_after_seconds is set (B5 / 020fbeaf);
// we don't set one here because there's no ETA — the fix is a deploy.
//
// Stays unauthed-but-stubbed: returning 503 from `/v1/billing/checkout-
// session` etc. before requireAuth means even a typo-token customer hits
// the right error instead of a 401 (which would suggest they need to fix
// their token, not contact support about a server-side billing gap).
export function registerBillingDisabledRoutes(app: FastifyInstance): void {
  const detail =
    'Billing is not configured on this server. Reach out to support@driftstack.dev if you expected to use this endpoint.';

  const stub = (): never => {
    throw new FeatureUnavailableError(detail);
  };

  app.post('/v1/billing/checkout-session', stub);
  app.post('/v1/billing/trial-pack', stub);
  app.post('/v1/billing/portal-session', stub);
  app.get('/v1/billing', stub);
}
