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
import { knownRequestKeys, reportUnknownRequestFields } from '../lib/unknown-request-fields.js';
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

/** Settlement currency for crypto orders. Mirrors `serverPriceCurrency` in
 *  routes/billing-crypto.ts, which is where the charge is actually priced. */
const CRYPTO_SETTLEMENT_CURRENCY = 'USD';

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
      // V-946 — report the keys zod stripped. This route is behind
      // `app.requireAuth` + a scope, verified at its registration, so the caller
      // is known and echoing back its own unrecognised keys discloses nothing.
      reportUnknownRequestFields({
        body: req.body,
        knownKeys: knownRequestKeys(QuoteSchema),
        reply,
        logger: req.log,
        route: 'POST /v1/billing/crypto-checkout/quote',
      });
      const product = parsed.data.product;
      // listEffective() = DB pricing row ?? TIER_PRICE_CENTS seed, per tier —
      // the same read billing-crypto.ts charges from, so an owner price edit
      // moves BOTH. V-746 — "quote == charge" means same SOURCE, not same
      // instant: this is a separate request from the checkout, each doing its own
      // read, so an owner edit (or a pricing-table read failure, which falls back
      // to the seeded constant and alarms) in between can still change the amount
      // charged relative to the amount quoted. There is no quote-binding token.
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
      // The quote MUST state the currency the charge actually settles in.
      // billing-crypto.ts locks `serverPriceCurrency = 'USD'` ("we never settle
      // in EUR / GBP / etc.") and ignores any client-supplied currency, but this
      // route defaulted to 'EUR' and echoed whatever the caller sent — so a
      // dashboard or SDK quoting api_scale rendered "€1,499.00" for an order
      // that then charged $1,499 USD. The request field is still accepted for
      // compatibility and still ignored, exactly as the checkout route ignores
      // it; the response now reports the settlement currency rather than a
      // caller-chosen label.
      return reply.send({
        product,
        price_cents: priceCents,
        price_currency: CRYPTO_SETTLEMENT_CURRENCY,
      });
    },
  );
}
