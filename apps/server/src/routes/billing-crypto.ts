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
//
// V-666.AO — when the caller sends an `Idempotency-Key` header, the
// route hands the key to service.createIdempotent(); duplicate keys
// within the 24h window return the original order verbatim. The
// response carries an `Idempotent-Replayed: 1` header on replays so
// clients can distinguish a retry-success from a fresh create.
//
// V-666.AQ — replays fire a structured info log (`event:
// 'crypto_checkout_idempotency_replay'`). Aggregated, the log line
// answers "is my checkout button double-firing" without depending on
// the polling counters endpoint. Fresh writes don't log — they're
// already captured by the existing request-completed log.
//
// V-666.AR — replays whose body fingerprint differs from the stored
// one fire an additional warn log (`event:
// 'crypto_checkout_idempotency_body_mismatch'`). The contract still
// replays — the warn surfaces accidental key reuse for ops to see.

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

type IdempotencyHeader = { kind: 'absent' } | { kind: 'valid'; key: string } | { kind: 'invalid' };

/**
 * Reads `Idempotency-Key` off the request. Returns a discriminated
 * union: absent (no header / empty), valid (trimmed ASCII <=255),
 * or invalid (rule violation; the route turns that into a 400).
 */
function readIdempotencyKey(req: FastifyRequest): IdempotencyHeader {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return { kind: 'absent' };
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return { kind: 'absent' };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { kind: 'absent' };
  if (trimmed.length > 255) return { kind: 'invalid' };
  if (!/^[\x21-\x7e]+$/.test(trimmed)) return { kind: 'invalid' };
  return { kind: 'valid', key: trimmed };
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

      const idempotency = readIdempotencyKey(req);
      if (idempotency.kind === 'invalid') {
        throw new ValidationError({
          fieldErrors: {},
          formErrors: ['Idempotency-Key must be 1-255 ASCII chars (no whitespace).'],
        });
      }

      let order;
      let replayed = false;
      let bodyFingerprintMismatch = false;
      if (idempotency.kind === 'valid') {
        const result = await deps.service.createIdempotent({
          idempotency_key: idempotency.key,
          order_id: newOrderId(),
          account_id: ctx.account.id,
          product: parsed.data.product,
          price_cents: parsed.data.price_cents,
          price_currency: parsed.data.price_currency,
        });
        order = result.order;
        replayed = result.replayed;
        bodyFingerprintMismatch = result.bodyFingerprintMismatch;
      } else {
        order = await deps.service.create({
          order_id: newOrderId(),
          account_id: ctx.account.id,
          product: parsed.data.product,
          price_cents: parsed.data.price_cents,
          price_currency: parsed.data.price_currency,
        });
      }

      if (replayed) {
        void reply.header('Idempotent-Replayed', '1');
        req.log.info(
          {
            event: 'crypto_checkout_idempotency_replay',
            account_id: ctx.account.id,
            order_id: order.order_id,
            product: order.product,
          },
          'crypto checkout replayed via idempotency key',
        );
        if (bodyFingerprintMismatch) {
          req.log.warn(
            {
              event: 'crypto_checkout_idempotency_body_mismatch',
              account_id: ctx.account.id,
              order_id: order.order_id,
              attempted_product: parsed.data.product,
              attempted_price_cents: parsed.data.price_cents,
              attempted_price_currency: parsed.data.price_currency,
            },
            'idempotency-key replayed with a different request body',
          );
        }
      }

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
