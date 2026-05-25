// V-666.H — POST /v1/billing/crypto-checkout/quote.
//
// Price preview for the crypto-checkout page. Customers hit this
// before committing to actually opening an order (which would mint
// an order_id + reserve a payment address). The response carries
// the tier price in fiat-cents + a placeholder crypto pay range
// (until the NowPayments client lands and we can call its
// `/v1/estimate` endpoint, the response is a stub `pay_currency: null`
// + computed fiat-cents from the tier table).
//
// Quote responses are stateless — no DB write — so re-fetching is
// cheap and the route is not rate-limited beyond the global bucket.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AccountTier } from '@driftstack/api-types';
import { z } from 'zod';
import { ValidationError } from '../lib/errors.js';
// Source the quote price from the SAME authoritative table the
// crypto-checkout charges from (billing-crypto.ts TIER_PRICE_CENTS), so
// the quoted amount always equals what the order will be created for.
// NOT cost-defaults' TIER_MONTHLY_PRICE_CENTS — that table feeds
// cost-monitoring threshold derivation and carries different (lower)
// figures, which previously made the quote under-quote vs the charge.
import { TIER_PRICE_CENTS } from './billing-crypto.js';

const SUPPORTED_PRODUCTS: AccountTier[] = [
  'solo_manual',
  'team_manual',
  'agency_manual',
  'api_starter',
  'api_builder',
  'api_scale',
];

const QuoteSchema = z.object({
  product: z.enum(SUPPORTED_PRODUCTS as [AccountTier, ...AccountTier[]]),
  price_currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'price_currency must be a 3-letter uppercase ISO code')
    .optional(),
});

export function registerCryptoQuoteRoutes(app: FastifyInstance): void {
  app.post(
    '/v1/billing/crypto-checkout/quote',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req: FastifyRequest, reply) => {
      const parsed = QuoteSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const product = parsed.data.product;
      const priceCents = TIER_PRICE_CENTS[product];
      if (priceCents === undefined) {
        // Defensive: schema gated on a fixed list that lines up with
        // the price table. A new tier added to one but not the other
        // is a 400 here rather than a 500.
        throw new ValidationError({
          fieldErrors: { product: [`No quote available for tier "${product}".`] },
          formErrors: [],
        });
      }
      return reply.send({
        product,
        price_cents: priceCents,
        price_currency: parsed.data.price_currency ?? 'EUR',
        // V-666.D follow-up: the NowPayments client will populate this
        // by calling `POST /v1/estimate`. Until then the front end
        // shows "amount TBD on order creation".
        provider: 'stub',
        pay_currency: null,
        pay_min_amount: null,
        pay_max_amount: null,
      });
    },
  );
}
