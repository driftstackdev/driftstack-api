// V-666 — NowPayments IPN webhook route (V-487 follow-through).
//
//   POST /v1/webhooks/nowpayments
//
// Public, no auth — `x-nowpayments-sig` header IS the auth. The route
// captures the raw request body via the shared webhook raw-body parser
// (see `_webhook-raw-body.ts`) and verifies the HMAC-SHA512 signature
// against the IPN secret from the NowPayments dashboard.
//
// Posture: wire-ready. Until the founder lands a merchant account +
// `NOWPAYMENTS_IPN_SECRET`, the route stays unregistered (the wiring in
// `lib/app.ts` is gated on `deps.nowpaymentsIpnSecret`). When enabled,
// the route verifies the signature and logs the event; the actual
// order-status-update flow (V-487) lands when the customer-side
// checkout pages at `/checkout/crypto` go live.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyNowpaymentsSignature } from '../lib/nowpayments-signing.js';
import { BadRequestError, UnauthorizedError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { registerWebhookRawBodyParser } from './_webhook-raw-body.js';

export interface RegisterNowpaymentsWebhookRoutesDeps {
  /** IPN secret from the NowPayments merchant dashboard. */
  ipnSecret: string;
  logger: Logger;
}

interface NowpaymentsIpnPayload {
  payment_id?: number | string;
  payment_status?: string;
  order_id?: string;
  pay_address?: string;
  price_amount?: number;
  price_currency?: string;
  pay_amount?: number;
  pay_currency?: string;
  actually_paid?: number;
}

export function registerNowpaymentsWebhookRoutes(
  app: FastifyInstance,
  deps: RegisterNowpaymentsWebhookRoutesDeps,
): void {
  registerWebhookRawBodyParser(app);

  app.post('/v1/webhooks/nowpayments', async (req: FastifyRequest, reply) => {
    const sigHeader = req.headers['x-nowpayments-sig'];
    if (typeof sigHeader !== 'string' || sigHeader.length === 0) {
      throw new UnauthorizedError('x-nowpayments-sig header missing.');
    }

    const rawBody = req.rawBody;
    if (typeof rawBody !== 'string' || rawBody.length === 0) {
      throw new BadRequestError('Empty request body.');
    }

    const verified = verifyNowpaymentsSignature({
      body: rawBody,
      secret: deps.ipnSecret,
      signature: sigHeader,
    });
    if (!verified) {
      deps.logger.warn(
        { component: 'nowpayments-webhooks' },
        'NowPayments IPN signature verification failed',
      );
      throw new UnauthorizedError('Invalid NowPayments signature.');
    }

    const payload = req.body as NowpaymentsIpnPayload;
    if (
      payload === null ||
      typeof payload !== 'object' ||
      (typeof payload.payment_id !== 'number' && typeof payload.payment_id !== 'string') ||
      typeof payload.payment_status !== 'string'
    ) {
      throw new BadRequestError('NowPayments IPN is missing required fields.');
    }

    // V-487 order-status-update flow lands when checkout pages go live.
    // Until then we log + ack so retries don't loop.
    deps.logger.info(
      {
        component: 'nowpayments-webhooks',
        payment_id: payload.payment_id,
        payment_status: payload.payment_status,
        order_id: payload.order_id,
      },
      'NowPayments IPN received (signature OK)',
    );

    return reply.code(200).send({ received: true });
  });
}
