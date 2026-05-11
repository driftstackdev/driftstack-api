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

export interface RegisterStripeWebhookRoutesDeps {
  service: StripeWebhooksService;
  /** Webhook signing secret as configured in Stripe (`whsec_...`). */
  signingSecret: string;
  logger: Logger;
}

export function registerStripeWebhookRoutes(
  app: FastifyInstance,
  deps: RegisterStripeWebhookRoutesDeps,
): void {
  registerWebhookRawBodyParser(app);

  app.post('/v1/webhooks/stripe', async (req: FastifyRequest, reply) => {
    const sigHeader = req.headers['stripe-signature'];
    if (typeof sigHeader !== 'string' || sigHeader.length === 0) {
      throw new UnauthorizedError('Stripe-Signature header missing.');
    }

    const rawBody = req.rawBody;
    if (typeof rawBody !== 'string' || rawBody.length === 0) {
      throw new BadRequestError('Empty request body.');
    }

    const verified = verifyStripeSignature({
      rawBody,
      header: sigHeader,
      secret: deps.signingSecret,
    });
    if (!verified.ok) {
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
      throw new BadRequestError('Stripe event is missing required fields.');
    }

    const outcome = await deps.service.handle(event, rawBody);

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
