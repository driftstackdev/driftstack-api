// V-666.H — POST /v1/billing/crypto-checkout/quote.
//
// Price preview for the crypto-checkout page. Customers hit this
// before committing to actually opening an order (which would mint
// an order_id + reserve a payment address). The response carries
// only the authoritative tier price in fiat cents. The exact crypto
// currency, amount and deposit address are payment-specific values
// returned by checkout creation, never invented by this stateless preview.
//
// Quote responses are stateless — no DB write — so re-fetching is
// cheap and the route is not rate-limited beyond the global bucket.
// The authoritative price table is billing data, so callers need
// read:billing (also satisfied by broad read/account_owner).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AccountTier } from '@driftstack/api-types';
import { z } from 'zod';
import { ValidationError } from '../lib/errors.js';
// Source the quote price from PricingService.listEffective() — the SAME
// authoritative read the crypto-checkout CHARGE uses (billing-crypto.ts).
// listEffective() returns the per-tier DB pricing row (migration 0067) or
// the TIER_PRICE_CENTS seed/fallback, so the quote tracks owner price edits
// and the quoted amount always equals what the order will be created for.
// Reading the TIER_PRICE_CENTS constant directly here (as this route did
// pre-pricing-as-data) diverged the quote from the charge the instant the
// owner edited a tier price in the DB — the charge moved, the quote didn't.
import type { PricingService } from '../services/pricing.js';

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

export interface CryptoQuoteRoutesDeps {
  /**
   * Pricing-as-data Phase A — the authoritative per-tier price source the
   * crypto-checkout CHARGE also reads (billing-crypto.ts charges
   * `pricing.listEffective()`). The quote MUST read the same source so the
   * preview always equals the amount the order is created for.
   */
  pricing: PricingService;
}

export function registerCryptoQuoteRoutes(app: FastifyInstance, deps: CryptoQuoteRoutesDeps): void {
  app.post(
    '/v1/billing/crypto-checkout/quote',
    { preHandler: [app.requireAuth, app.requireScope('read:billing'), app.rateLimit('global')] },
    async (req: FastifyRequest, reply) => {
      const parsed = QuoteSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const product = parsed.data.product;
      // listEffective() = DB pricing row ?? TIER_PRICE_CENTS seed, per tier —
      // the same read billing-crypto.ts charges from, so quote == charge.
      const effectivePricing = await deps.pricing.listEffective();
      const priceCents = effectivePricing.find((row) => row.tier === product)?.monthlyCents;
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
      });
    },
  );
}
