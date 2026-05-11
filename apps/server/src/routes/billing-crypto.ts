// V-666.C — customer-facing crypto-checkout route.
//
//   POST /v1/billing/crypto-checkout
//
// Customers on the `/checkout/crypto` page hit this to mint a new
// CryptoOrder. The response carries an order_id + a stubbed payment
// context: until the founder lands a NowPayments merchant account +
// `NOWPAYMENTS_API_KEY`, we cannot call NowPayments's
// `POST /v1/payment` to mint a real `pay_address`. The route therefore
// returns `payment_address: null` and `provider: 'stub'` — the front
// end shows a "set up by support" notice in that posture.
//
// When the merchant account lands (V-666.D follow-up), a
// `NowpaymentsClient.createPayment(...)` call slots in between
// `service.create()` and the response, populating `payment_address`
// + `pay_currency`.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { CryptoOrdersService } from '../services/crypto-orders.js';
import { ValidationError } from '../lib/errors.js';

export interface CryptoCheckoutRoutesDeps {
  service: CryptoOrdersService;
}

const SUPPORTED_PRODUCTS = [
  'trial_pack',
  'solo_manual',
  'solo_automated',
  'team_growth',
  'team_scale',
  'api_starter',
  'api_pro',
] as const;

const CreateCryptoCheckoutSchema = z.object({
  product: z.enum(SUPPORTED_PRODUCTS),
  price_cents: z.number().int().positive().max(1_000_000),
  price_currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'price_currency must be a 3-letter uppercase ISO code'),
});

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

/**
 * Generate a public order id. 12 random hex chars is enough entropy
 * for the in-memory store + the customer-facing URL while staying
 * short enough to fit on a checkout page banner without wrapping.
 */
function newOrderId(): string {
  return `ord_${randomBytes(6).toString('hex')}`;
}

export function registerCryptoCheckoutRoutes(
  app: FastifyInstance,
  deps: CryptoCheckoutRoutesDeps,
): void {
  app.post(
    '/v1/billing/crypto-checkout',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const parsed = CreateCryptoCheckoutSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      const order = await deps.service.create({
        order_id: newOrderId(),
        account_id: ctx.account.id,
        product: parsed.data.product,
        price_cents: parsed.data.price_cents,
        price_currency: parsed.data.price_currency,
      });

      return reply.code(201).send({
        order_id: order.order_id,
        product: order.product,
        price_cents: order.price_cents,
        price_currency: order.price_currency,
        status: order.status,
        // V-666.D follow-up will populate these via the NowPayments
        // create-payment call. Stub posture: caller renders a
        // "contact support" message.
        provider: 'stub',
        payment_address: null,
        pay_currency: null,
        created_at: new Date(order.created_at).toISOString(),
      });
    },
  );
}
