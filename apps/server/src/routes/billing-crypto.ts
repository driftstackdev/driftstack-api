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
import { mapNowpaymentsStatus } from '../services/crypto-orders.js';
import { BadRequestError, ValidationError } from '../lib/errors.js';
import { readIdempotencyKey } from '../lib/idempotency-key.js';
import { EFFECTIVE_ACCOUNT_HEADER } from '../lib/effective-account-header.js';
import type { NowPaymentsApiClient } from '../lib/nowpayments-api.js';
import type { PricingService } from '../services/pricing.js';

export interface CryptoCheckoutRoutesDeps {
  service: CryptoOrdersService;
  /**
   * Pricing-as-data Phase A — authoritative per-tier monthly price. The
   * handler charges `pricing.listEffective()` (the DB pricing table from
   * migration 0067, with the TIER_PRICE_CENTS constant as seed + fallback)
   * rather than the inline constant, so the owner pricing editor (a later
   * increment) moves the amount customers are actually charged.
   */
  pricing: PricingService;
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
// price_cents is now IGNORED.
//
// 2026-06-04 (pricing-as-data Phase A): this constant is no longer read
// verbatim for the charge — it is the SEED for the DB pricing table
// (migration 0067) AND the runtime FALLBACK. The handler charges
// `deps.pricing.listEffective()` (DB row ?? this constant), which lets
// the owner pricing editor move the charged amount while keeping
// checkout safe if the pricing table is ever unreadable. The constant
// must stay equal to the seed — cost-defaults-v541f + the DB-seed
// integration test pin that equality.
//
// Tier IDs match the canonical AccountTier enum at
// packages/api-types/src/common.ts. Only the 6 self-serve paid tiers
// are crypto-purchasable; the perpetual free tier is not purchasable
// (trial_pack was retired 2026-05-27 — its removal resolves the #10
// checkout-vs-quote product-list mismatch by deletion).
export const TIER_PRICE_CENTS: Record<string, number> = {
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
    // W496 — admin:billing (scopes.md): initiating a crypto checkout is a
    // subscription-change action. account_owner satisfies it (V-481), so the
    // dashboard's web-session works; a read/write-only API key is blocked.
    { preHandler: [app.requireAuth, app.requireScope('admin:billing'), app.rateLimit('global')] },
    async (req, reply) => {
      // Use the shared header constant rather than a raw literal so this
      // rejection can never drift from the name the resolver parses.
      const rawActAsAccount = req.headers[EFFECTIVE_ACCOUNT_HEADER];
      const hasActAsAccount = Array.isArray(rawActAsAccount)
        ? rawActAsAccount.some((value) => value.length > 0)
        : typeof rawActAsAccount === 'string' && rawActAsAccount.length > 0;
      if (hasActAsAccount) {
        // Crypto plan purchases are intentionally self-workspace only. Reject
        // the standard account-impersonation header before parsing the body or
        // touching pricing/order/provider state; silently ignoring it would let
        // a stale or bypassed dashboard buy for Self while claiming Team scope.
        throw new BadRequestError(
          'Crypto checkout is available only in the Self workspace. Remove X-Driftstack-Account and retry.',
        );
      }
      const ctx = requireCtx(req);
      const parsed = CreateCryptoCheckoutSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      // 2026-05-21 — V-666.SEC: server-side authoritative price lookup.
      // The customer-supplied price_cents in parsed.data is IGNORED.
      // 2026-06-04 (pricing-as-data Phase A): the authoritative charge
      // now flows through PricingService.listEffective() — the DB pricing
      // table (migration 0067) is the source of truth, with TIER_PRICE_CENTS
      // as the seed + fallback (listEffective returns the constant value
      // for any tier the DB read misses or if the read throws, so a pricing
      // -table outage never breaks checkout).
      //
      // V-746 — it CAN, however, charge a stale amount: once a price has been
      // edited via the owner route, DB != constants, so a read failure charges
      // the pre-edit price. listEffective raises an integrity alarm when it falls
      // back for exactly that reason. Charging the seeded price beats failing
      // checkout, but it is not the same as charging the right price.
      // Without an authoritative server price, a customer could POST
      // {product: 'api_scale', price_cents: 100} and unlock a $1,499/mo
      // tier for $1.
      const effectivePricing = await deps.pricing.listEffective();
      const serverPriceCents = effectivePricing.find(
        (row) => row.tier === parsed.data.product,
      )?.monthlyCents;
      if (typeof serverPriceCents !== 'number') {
        // SUPPORTED_PRODUCTS is derived from TIER_PRICE_CENTS and
        // listEffective() returns every priced tier, so this is
        // defensive — every Zod-accepted product slug MUST have an
        // effective price. Reaching here means the price sources
        // (crypto map, cost-defaults table, DB) went out of sync.
        throw new Error(
          `BUG: product '${parsed.data.product}' is supported but has no effective price`,
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
      // order_id in our DB. A successful create binds the provider id before
      // its address is exposed; the first IPN may backfill an unbound id and
      // remains the canonical source of payment status truth.
      let provider: 'stub' | 'nowpayments' = 'stub';
      let paymentAddress: string | null = null;
      let payCurrency: string | null = null;
      let payAmount: number | null = null;
      // Fresh writes always own a new pending/unbound order. A replay may mint
      // only when the original write never managed to bind its first payment.
      // Every other replay state is non-minting: confirming/partial already has
      // money in flight, and paid/failed/cancelled is terminal. Without this
      // explicit admission predicate, the broad `else if` below minted an
      // orphan provider payment for every non-pending replay and could then
      // re-expose the old bound address as payable.
      const mayMintPayment = !replayed || (order.status === 'pending' && order.payment_id === null);
      // V-666.SEC: skip the NowPayments call when the amount is below
      // their USD-equivalent floor. Avoids surfacing amount_too_low
      // errors to customers for any sub-floor product.
      if (
        deps.nowpayments !== undefined &&
        deps.nowpaymentsIpnCallbackUrl !== undefined &&
        serverPriceCents >= NOWPAYMENTS_MIN_USD_CENTS &&
        replayed &&
        order.status === 'pending' &&
        order.payment_id !== null
      ) {
        // IDEMPOTENT REPLAY of an order that is STILL pending and already
        // minted a payment: echo the ORIGINAL payment (never mint again — a
        // second mint returns a NEW payment_id whose IPN fails
        // applyIpnStatus's payment_id-match guard, so the customer would lose
        // real crypto). C7 — only re-surface the address when the bound
        // NowPayments payment is ITSELF still awaiting payment
        // (mapNowpaymentsStatus → 'pending'); a swept / expired / finished
        // payment must NOT be handed back as payable, or the customer pays a
        // dead address and loses the crypto. A non-pending order (failed /
        // cancelled / paid / confirming) skips this branch entirely and
        // returns the stub posture so the frontend shows its real state.
        // Best-effort: a lookup failure returns the stub posture.
        try {
          const existing = await deps.nowpayments.getPayment(order.payment_id);
          if (mapNowpaymentsStatus(existing.paymentStatus) === 'pending') {
            provider = 'nowpayments';
            paymentAddress = existing.payAddress;
            payCurrency = existing.payCurrency;
            payAmount = existing.payAmount;
          }
        } catch (err) {
          req.log.warn(
            {
              event: 'nowpayments_replay_get_payment_failed',
              order_id: order.order_id,
              err: err instanceof Error ? err.message : String(err),
            },
            'failed to re-fetch the original NowPayments payment on replay; returning stub posture',
          );
        }
      } else if (
        deps.nowpayments !== undefined &&
        deps.nowpaymentsIpnCallbackUrl !== undefined &&
        serverPriceCents >= NOWPAYMENTS_MIN_USD_CENTS &&
        mayMintPayment
      ) {
        // Fresh order, OR a replay whose original mint never bound a payment_id
        // (order.payment_id === null). A mint is not customer-payable until the
        // exact order has durably adopted that payment id. If binding fails, the
        // provider payment may be orphaned internally but its address is never
        // exposed; a later same-key retry can mint and bind a safe replacement.
        try {
          const payment = await deps.nowpayments.createPayment({
            priceAmount: order.price_cents / 100,
            priceCurrency: order.price_currency,
            orderId: order.order_id,
            orderDescription: `Driftstack ${order.product}`,
            ipnCallbackUrl: deps.nowpaymentsIpnCallbackUrl,
          });
          // Billing-integrity (#9 payment_id binding + #1 crypto-denominated
          // quote) — persist the minted NowPayments payment_id AND the
          // crypto-denominated quote (pay_amount + pay_currency) on the order so
          // applyIpnStatus can (a) reject an IPN whose payment_id doesn't match
          // and (b) reconcile the IPN's actually_paid against the SAME-unit
          // pay_amount (not the fiat price). Best-effort: a failure here leaves
          // these null (the first IPN backfills them), so it must not fail the
          // checkout response.
          //
          // CONCURRENCY (Fable audit 2026-07-02): the sequential idempotency
          // replay is guarded above, but two checkouts sharing one
          // Idempotency-Key that overlap in the createPayment window BOTH reach
          // this mint branch (each read order.payment_id === null before either
          // bound). recordPaymentId runs under the order row-lock and returns the
          // order with its EFFECTIVE bound payment_id: whoever binds first wins,
          // and the loser's freshly-minted payment is ORPHANED. We MUST surface
          // the bound payment's address, never the orphan — else the customer
          // pays an address whose IPN applyIpnStatus rejects on the payment_id
          // mismatch and their crypto is lost.
          let boundOrder = null as Awaited<ReturnType<typeof deps.service.recordPaymentId>>;
          try {
            boundOrder = await deps.service.recordPaymentId({
              order_id: order.order_id,
              payment_id: payment.paymentId,
              ...(payment.payAmount !== null && payment.payAmount !== undefined
                ? { pay_amount: payment.payAmount }
                : {}),
              ...(payment.payCurrency !== null && payment.payCurrency !== undefined
                ? { pay_currency: payment.payCurrency }
                : {}),
            });
            // recordPaymentId owns the row lock and may observe an IPN/cancel
            // transition that happened after createIdempotent returned. Keep
            // the response status on that newer authoritative snapshot rather
            // than pairing a hidden address with a stale `pending` status.
            if (boundOrder !== null) order = boundOrder;
          } catch (bindErr) {
            req.log.warn(
              {
                event: 'nowpayments_record_payment_id_failed',
                order_id: order.order_id,
                err: bindErr instanceof Error ? bindErr.message : String(bindErr),
              },
              'failed to bind NowPayments payment_id to order (will bind on first IPN)',
            );
          }
          if (
            boundOrder !== null &&
            boundOrder.payment_id !== null &&
            boundOrder.payment_id !== payment.paymentId
          ) {
            // A concurrent checkout bound this order to a DIFFERENT payment first;
            // our mint is orphaned. Echo the bound payment so the customer pays
            // the address whose IPN will actually reconcile.
            try {
              const bound = await deps.nowpayments.getPayment(boundOrder.payment_id);
              if (
                boundOrder.status === 'pending' &&
                mapNowpaymentsStatus(bound.paymentStatus) === 'pending'
              ) {
                provider = 'nowpayments';
                paymentAddress = bound.payAddress;
                payCurrency = bound.payCurrency;
                payAmount = bound.payAmount;
              }
            } catch (err) {
              req.log.warn(
                {
                  event: 'nowpayments_concurrent_bound_get_payment_failed',
                  order_id: order.order_id,
                  err: err instanceof Error ? err.message : String(err),
                },
                'failed to re-fetch the concurrently-bound NowPayments payment; returning stub posture',
              );
            }
          } else if (
            boundOrder !== null &&
            boundOrder.payment_id === payment.paymentId &&
            boundOrder.status === 'pending' &&
            mapNowpaymentsStatus(payment.paymentStatus) === 'pending'
          ) {
            // The order durably owns this exact, still-payable provider payment.
            provider = 'nowpayments';
            paymentAddress = payment.payAddress;
            payCurrency = payment.payCurrency;
            payAmount = payment.payAmount;
          } else {
            req.log.warn(
              {
                event: 'nowpayments_payment_not_safely_bound',
                order_id: order.order_id,
              },
              'minted NowPayments payment is not safely bound and will not be exposed',
            );
          }
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
