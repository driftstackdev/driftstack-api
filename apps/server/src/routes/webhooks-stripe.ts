// Inbound Stripe webhook route (V-080).
//
//   POST /v1/webhooks/stripe
//
// Public, no auth — Stripe-Signature header IS the auth. The route
// captures the raw request body (Stripe verifies a sha256 HMAC over
// `<timestamp>.<raw body>`) and rejects everything that doesn't
// pass signature verification before reaching the dispatch layer.
//
// Body parsing: V-666 — the raw-body content-type parser is shared
// across all webhook routes (Stripe + NowPayments + future) via
// `registerWebhookRawBodyParser`. Fastify only allows ONE parser per
// content-type, so the shared module is the only sanctioned path.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyStripeSignature } from '../lib/stripe-signing.js';
import { type StripeEvent, type StripeWebhooksService } from '../services/stripe-webhooks.js';
import { BadRequestError, UnauthorizedError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { registerWebhookRawBodyParser } from './_webhook-raw-body.js';
import { METRIC_NAMES, type MetricsRegistry } from '../services/metrics-registry.js';

export interface RegisterStripeWebhookRoutesDeps {
  service: StripeWebhooksService;
  /** Webhook signing secret as configured in Stripe (`whsec_...`). */
  signingSecret: string;
  logger: Logger;
  /** Arc 7 obs.8 — optional metrics registry. When wired, the
   *  /v1/webhooks/stripe route increments
   *  `driftstack_stripe_webhook_total{outcome}` per request. */
  metrics?: MetricsRegistry;
}

/** Map the StripeWebhooksService dispatch outcome to a bounded
 *  metric label. The service returns `'handled' | 'ignored' |
 *  'duplicate' | \`error:${string}\``; the dynamic error tail
 *  collapses to 'error' to keep cardinality fixed. */
function classifyStripeDispatchOutcome(outcome: string): string {
  if (outcome === 'handled' || outcome === 'duplicate' || outcome === 'ignored') return outcome;
  return 'error';
}

export function registerStripeWebhookRoutes(
  app: FastifyInstance,
  deps: RegisterStripeWebhookRoutesDeps,
): void {
  registerWebhookRawBodyParser(app);
  const metrics = deps.metrics;
  const bumpOutcome = (outcome: string): void => {
    try {
      metrics?.inc(METRIC_NAMES.stripeWebhookTotal, { outcome });
    } catch {
      // Swallow; metrics are best-effort.
    }
  };

  app.post('/v1/webhooks/stripe', async (req: FastifyRequest, reply) => {
    const sigHeader = req.headers['stripe-signature'];
    if (typeof sigHeader !== 'string' || sigHeader.length === 0) {
      bumpOutcome('signature_missing');
      throw new UnauthorizedError('Stripe-Signature header missing.');
    }

    const rawBody = req.rawBody;
    if (typeof rawBody !== 'string' || rawBody.length === 0) {
      bumpOutcome('empty_body');
      throw new BadRequestError('Empty request body.');
    }

    const verified = verifyStripeSignature({
      rawBody,
      header: sigHeader,
      secret: deps.signingSecret,
    });
    if (!verified.ok) {
      bumpOutcome('signature_invalid');
      deps.logger.warn(
        { component: 'stripe-webhooks', reason: verified.reason },
        'Stripe webhook signature verification failed',
      );
      // Don't leak which check failed in the response — Stripe's docs
      // say "any 4xx" causes a retry, so 401 is fine. Log the reason.
      throw new UnauthorizedError('Invalid Stripe signature.');
    }

    const event = req.body as StripeEvent;
    if (
      typeof event.id !== 'string' ||
      typeof event.type !== 'string' ||
      typeof event.data !== 'object' ||
      event.data === null
    ) {
      bumpOutcome('malformed_event');
      throw new BadRequestError('Stripe event is missing required fields.');
    }

    const outcome = await deps.service.handle(event, rawBody);
    bumpOutcome(classifyStripeDispatchOutcome(outcome));

    // Always reply 200 to a verified, parseable event — even on
    // duplicate or ignored. Stripe interprets non-2xx as a delivery
    // failure and retries; we'd rather acknowledge and record than
    // force a re-delivery loop on every "ignored" event-type.
    return reply.code(200).send({
      received: true,
      outcome,
    });
  });
}
