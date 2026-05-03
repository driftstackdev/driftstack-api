// Inbound Stripe webhook route (V-080).
//
//   POST /v1/webhooks/stripe
//
// Public, no auth — Stripe-Signature header IS the auth. The route
// captures the raw request body (Stripe verifies a sha256 HMAC over
// `<timestamp>.<raw body>`) and rejects everything that doesn't
// pass signature verification before reaching the dispatch layer.
//
// Body parsing: a route-scoped `application/json` content-type parser
// stashes the unparsed string on `request.rawBody`. We DON'T globally
// override Fastify's JSON parsing — only this one route needs it. The
// stash lives on a typed augmentation of FastifyRequest below.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyStripeSignature } from '../lib/stripe-signing.js';
import { type StripeEvent, type StripeWebhooksService } from '../services/stripe-webhooks.js';
import { BadRequestError, UnauthorizedError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Raw, unparsed JSON body — set by the Stripe webhook route's content-type parser. */
    rawBody?: string;
  }
}

export interface RegisterStripeWebhookRoutesDeps {
  service: StripeWebhooksService;
  /** Webhook signing secret as configured in Stripe (`whsec_...`). */
  signingSecret: string;
  logger: Logger;
}

const MAX_BODY_BYTES = 1_048_576; // 1 MiB — Stripe events are usually <16 KiB; 1 MiB is generous.

export function registerStripeWebhookRoutes(
  app: FastifyInstance,
  deps: RegisterStripeWebhookRoutesDeps,
): void {
  // Route-scoped raw-body content-type parser. By default Fastify auto
  // parses JSON; we register a custom parser keyed on the route URL
  // (constraint via the `config.rawBody` option below). The parser
  // returns the raw string AND the parsed JSON together so the handler
  // has both — signature verification needs the bytes; dispatch needs
  // the object.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: MAX_BODY_BYTES },
    (req, body, done) => {
      // Only stash + return raw body for the Stripe webhook route. For
      // every other JSON route, do the standard parse + return parsed.
      if (req.routeOptions.url === '/v1/webhooks/stripe') {
        // Cast: Fastify types the parsed-as-string body as unknown; we
        // know it's a string because of the parseAs option above.
        const text = typeof body === 'string' ? body : '';
        req.rawBody = text;
        try {
          const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
          done(null, parsed);
        } catch (err) {
          done(err instanceof Error ? err : new Error(String(err)), undefined);
        }
        return;
      }
      // Non-Stripe routes: standard parse, no stash.
      try {
        const parsed: unknown = typeof body === 'string' && body.length > 0 ? JSON.parse(body) : {};
        done(null, parsed);
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)), undefined);
      }
    },
  );

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
