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
import type { CryptoOrdersService } from '../services/crypto-orders.js';
import { registerWebhookRawBodyParser } from './_webhook-raw-body.js';
import { METRIC_NAMES, type MetricsRegistry } from '../services/metrics-registry.js';

export interface RegisterNowpaymentsWebhookRoutesDeps {
  /** IPN secret from the NowPayments merchant dashboard. */
  ipnSecret: string;
  logger: Logger;
  /**
   * V-666.B — when provided, the route forwards verified IPN updates
   * into the crypto-orders state machine. When omitted, the route
   * logs + acks only (W44 V-666 wire-ready posture).
   */
  ordersService?: CryptoOrdersService;
  /** Arc 7 obs.9 — optional metrics registry. When wired, the route
   *  increments `driftstack_nowpayments_webhook_total{outcome}` per
   *  request (one of: ok / signature_missing / signature_invalid /
   *  empty_body / malformed_event). */
  metrics?: MetricsRegistry;
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
  const metrics = deps.metrics;
  const bumpOutcome = (outcome: string): void => {
    try {
      metrics?.inc(METRIC_NAMES.nowpaymentsWebhookTotal, { outcome });
    } catch {
      // Swallow; metrics are best-effort.
    }
  };

  app.post('/v1/webhooks/nowpayments', async (req: FastifyRequest, reply) => {
    const sigHeader = req.headers['x-nowpayments-sig'];
    if (typeof sigHeader !== 'string' || sigHeader.length === 0) {
      bumpOutcome('signature_missing');
      throw new UnauthorizedError('x-nowpayments-sig header missing.');
    }

    const rawBody = req.rawBody;
    if (typeof rawBody !== 'string' || rawBody.length === 0) {
      bumpOutcome('empty_body');
      throw new BadRequestError('Empty request body.');
    }

    const verified = verifyNowpaymentsSignature({
      body: rawBody,
      secret: deps.ipnSecret,
      signature: sigHeader,
    });
    if (!verified) {
      bumpOutcome('signature_invalid');
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
      bumpOutcome('malformed_event');
      throw new BadRequestError('NowPayments IPN is missing required fields.');
    }

    // V-666.B — forward verified IPN into the order-status state
    // machine. When ordersService is omitted (W44 wire-ready posture)
    // the route still acks 200 + logs.
    let orderState: string | null = null;
    if (deps.ordersService !== undefined && typeof payload.order_id === 'string') {
      const updated = await deps.ordersService.applyIpnStatus({
        order_id: payload.order_id,
        payment_id: String(payload.payment_id),
        provider_status: payload.payment_status,
        // Billing-integrity (#1 crypto-denominated reconciliation) — forward the
        // IPN's amount fields so a paid transition requires
        // actually_paid >= pay_amount (BOTH in pay_currency); an under-payment
        // routes to 'partial', never 'paid'. `actually_paid` + `pay_amount` are
        // crypto-denominated; `price_amount` is FIAT (persisted on the audit
        // event only — comparing it to actually_paid is a unit error and left
        // every full crypto payment stuck 'partial').
        ...(typeof payload.actually_paid === 'number'
          ? { actually_paid: payload.actually_paid }
          : {}),
        ...(typeof payload.pay_amount === 'number' ? { pay_amount: payload.pay_amount } : {}),
        ...(typeof payload.price_amount === 'number' ? { price_amount: payload.price_amount } : {}),
        ...(typeof payload.pay_currency === 'string' ? { pay_currency: payload.pay_currency } : {}),
      });
      orderState = updated?.status ?? null;
    }

    deps.logger.info(
      {
        component: 'nowpayments-webhooks',
        payment_id: payload.payment_id,
        payment_status: payload.payment_status,
        order_id: payload.order_id,
        order_state: orderState,
      },
      'NowPayments IPN received (signature OK)',
    );

    bumpOutcome('ok');
    return reply.code(200).send({ received: true, order_state: orderState });
  });
}
