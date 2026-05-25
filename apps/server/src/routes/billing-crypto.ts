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
import { readIdempotencyKey } from '../lib/idempotency-key.js';
import type { NowPaymentsApiClient } from '../lib/nowpayments-api.js';

export interface CryptoCheckoutRoutesDeps {
  service: CryptoOrdersService;
  /**
   * V-666.D — NowPayments HTTP client. When wired, the route mints a
   * real payment address (POST /v1/payment); when omitted, returns
   * `provider: 'stub'` + null fields (existing posture). Bootstrap
   * passes the client only when NOWPAYMENTS_API_KEY env var is set.
   */
  nowpayments?: NowPaymentsApiClient;
  /**
   * V-666.D — NowPayments IPN callback URL (e.g.
   * `https://api.driftstack.dev/v1/webhooks/nowpayments`). Passed as
   * `ipn_callback_url` on every createPayment call. Required when
   * `nowpayments` is set.
   */
  nowpaymentsIpnCallbackUrl?: string;
}

// 2026-05-21 — V-666.SEC: tier price-map is authoritative SERVER-SIDE.
// Prior version trusted customer-supplied `price_cents` directly,
// which allowed price tampering (POST {product: 'api_scale',
// price_cents: 100} → $1 charge for the $1,499/mo tier). The map
// below mirrors apps/customer-dashboard/src/pages/select-tier.astro's
// `priceCents` per tier; the SDK + customer-dashboard's request body
// price_cents is now IGNORED — server uses this table verbatim.
//
// Tier IDs match the canonical AccountTier enum at
// packages/api-types/src/common.ts. trial_pack is included for
// backwards-compat (SDK + integration tests POST it); the handler
// detects amounts below NOWPAYMENTS_MIN_USD_CENTS and returns the
// stub posture WITHOUT calling NowPayments — avoids the
// amount_too_low error customers would otherwise see. The
// customer-dashboard hides the crypto button on trial-pack copy as
// a UX guard.
export const TIER_PRICE_CENTS: Record<string, number> = {
  trial_pack: 299,
  solo_manual: 7900,
  team_manual: 24900,
  agency_manual: 69900,
  api_starter: 14900,
  api_builder: 49900,
  api_scale: 149900,
};
/** NowPayments USD-equivalent floor (verified empirically against
 *  api.nowpayments.io/v1/min-amount on 2026-05-21 — every supported
 *  cryptocurrency returned the same $19.16 figure). Amounts below
 *  this hit `amount_too_low` at their API; we short-circuit to the
 *  stub posture before calling. Bumped to 2000 cents ($20) to leave
 *  a small buffer against their floor drifting upward. */
const NOWPAYMENTS_MIN_USD_CENTS = 2000;
// SUPPORTED_PRODUCTS = keys of the authoritative price map. Adding
// a new tier requires bumping both this map AND the customer-
// dashboard's TIERS array.
const SUPPORTED_PRODUCTS = Object.keys(TIER_PRICE_CENTS) as [string, ...string[]];

const CreateCryptoCheckoutSchema = z.object({
  product: z.enum(SUPPORTED_PRODUCTS),
  // 2026-05-21 — kept for backwards-compat with the SDK shape but
  // IGNORED by the route handler. Server-side price is the only
  // source of truth (see TIER_PRICE_CENTS above). Schema still
  // validates the shape so a malformed number returns 400 instead of
  // a TypeError later.
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

// Idempotency-Key parser extracted to apps/server/src/lib/idempotency-key.ts
// so V-666.AO billing-crypto + v2-#19 agent-sessions share one
// validation path (no-whitespace + max-255 + ASCII-only per the
// customer-facing docs at /docs/idempotency-keys).

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

      // 2026-05-21 — V-666.SEC: server-side authoritative price lookup.
      // The customer-supplied price_cents in parsed.data is IGNORED;
      // we use the TIER_PRICE_CENTS map keyed by product slug. Without
      // this, a customer could POST {product: 'api_scale',
      // price_cents: 100} and unlock a $1,499/mo tier for $1.
      const serverPriceCents = TIER_PRICE_CENTS[parsed.data.product];
      if (typeof serverPriceCents !== 'number') {
        // SUPPORTED_PRODUCTS is derived from TIER_PRICE_CENTS, so this
        // is defensive — every Zod-accepted product slug MUST have a
        // price entry. Reaching here means the two went out of sync.
        throw new Error(
          `BUG: product '${parsed.data.product}' is supported but has no TIER_PRICE_CENTS entry`,
        );
      }
      // Currency is also locked server-side to USD for now. NowPayments
      // converts to crypto using their own rate engine; we never
      // settle in EUR / GBP / etc.
      const serverPriceCurrency = 'USD';
      // Log + audit-trail any customer attempt to override the price.
      // Doesn't reject (we already ignore the value) but surfaces
      // adversarial inputs to the operator.
      if (
        parsed.data.price_cents !== serverPriceCents ||
        parsed.data.price_currency !== serverPriceCurrency
      ) {
        req.log.warn(
          {
            event: 'crypto_checkout_price_override_attempt',
            account_id: ctx.account.id,
            product: parsed.data.product,
            client_price_cents: parsed.data.price_cents,
            client_price_currency: parsed.data.price_currency,
            server_price_cents: serverPriceCents,
            server_price_currency: serverPriceCurrency,
          },
          'client-supplied price_cents/currency does not match server table; ignoring client values',
        );
      }

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
          price_cents: serverPriceCents,
          price_currency: serverPriceCurrency,
        });
        order = result.order;
        replayed = result.replayed;
        bodyFingerprintMismatch = result.bodyFingerprintMismatch;
      } else {
        order = await deps.service.create({
          order_id: newOrderId(),
          account_id: ctx.account.id,
          product: parsed.data.product,
          price_cents: serverPriceCents,
          price_currency: serverPriceCurrency,
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

      // V-666.D — if NowPayments is wired, mint a real payment
      // address. We do this AFTER the local order is created so a
      // failed NowPayments call still leaves a customer-trackable
      // order_id in our DB. Order.payment_id stays null until the
      // first IPN callback (which carries authoritative status).
      // payment_id from the create call is informational only — the
      // IPN flow is the canonical source of truth.
      let provider: 'stub' | 'nowpayments' = 'stub';
      let paymentAddress: string | null = null;
      let payCurrency: string | null = null;
      let payAmount: number | null = null;
      // V-666.SEC: skip the NowPayments call when the amount is below
      // their USD-equivalent floor. Avoids surfacing amount_too_low
      // errors to customers + keeps the trial-pack flow on Stripe
      // even if a future regression re-enables a trial-pack crypto
      // button without UI gating.
      if (
        deps.nowpayments !== undefined &&
        deps.nowpaymentsIpnCallbackUrl !== undefined &&
        serverPriceCents >= NOWPAYMENTS_MIN_USD_CENTS
      ) {
        try {
          const payment = await deps.nowpayments.createPayment({
            priceAmount: order.price_cents / 100,
            priceCurrency: order.price_currency,
            orderId: order.order_id,
            orderDescription: `Driftstack ${order.product}`,
            ipnCallbackUrl: deps.nowpaymentsIpnCallbackUrl,
          });
          provider = 'nowpayments';
          paymentAddress = payment.payAddress;
          payCurrency = payment.payCurrency;
          payAmount = payment.payAmount;
        } catch (err) {
          // Soft-fail: the local order persists, the customer sees
          // the stub posture, support can mint the payment manually.
          // Log so ops sees the upstream failure.
          req.log.error(
            {
              event: 'nowpayments_create_payment_failed',
              order_id: order.order_id,
              err: err instanceof Error ? err.message : String(err),
            },
            'NowPayments create-payment call failed; returning stub posture',
          );
        }
      }

      return reply.code(201).send({
        order_id: order.order_id,
        product: order.product,
        price_cents: order.price_cents,
        price_currency: order.price_currency,
        status: order.status,
        provider,
        payment_address: paymentAddress,
        pay_currency: payCurrency,
        pay_amount: payAmount,
        created_at: new Date(order.created_at).toISOString(),
      });
    },
  );
}
