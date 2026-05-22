---
layout: ../../layouts/DocLayout.astro
title: Crypto checkout
description: Pay for Driftstack tiers with BTC, ETH, USDT, USDC, or other supported cryptocurrencies via NowPayments.
---

# Crypto checkout

Driftstack supports cryptocurrency payments through
[NowPayments](https://nowpayments.io). The flow mints a one-time
payment address per order; the customer sends crypto; NowPayments
posts an IPN to Driftstack when the payment is confirmed on-chain;
Driftstack activates the subscription tier.

Crypto checkout is enabled for paid tiers ($79/mo and above). The
$2.99 trial pack is **card-only** — NowPayments enforces a USD-
equivalent floor (~$19.16) below which payments are rejected as
`amount_too_low`.

## Create a checkout order

`POST /v1/billing/crypto-checkout`

```ts
const order = await client.billing.createCryptoCheckout({
  product: 'solo_manual',
  // price_cents + price_currency are accepted for API compatibility
  // but IGNORED by the server. The price is derived server-side
  // from the product slug to prevent price tampering.
  price_cents: 7900,
  price_currency: 'USD',
});
```

Authenticated. Idempotent — pass an `Idempotency-Key` header to
make retries safe; the same key within 24h returns the original
order verbatim with an `Idempotent-Replayed: 1` response header.

Returns:

```json
{
  "order_id": "ord_a1b2c3d4e5f6",
  "product": "solo_manual",
  "price_cents": 7900,
  "price_currency": "USD",
  "status": "pending",
  "provider": "nowpayments",
  "payment_address": "bc1qexample...",
  "pay_currency": "btc",
  "pay_amount": 0.00123,
  "created_at": "2026-05-22T10:00:00Z"
}
```

Send exactly `pay_amount` `pay_currency` to `payment_address`. The
customer-dashboard UI renders this address in a copy-friendly
modal; SDK consumers should mirror that pattern. Underpayment
puts the order in the `partial` state (not credited as paid);
overpayment is treated as fully paid and the surplus stays on the
NowPayments side (issue a refund manually via the NowPayments
dashboard if needed).

### Supported products

| Product slug    | Price (USD) | Floor cleared                   |
| --------------- | ----------- | ------------------------------- |
| `solo_manual`   | $79/mo      | yes                             |
| `team_manual`   | $249/mo     | yes                             |
| `agency_manual` | $699/mo     | yes                             |
| `api_starter`   | $149/mo     | yes                             |
| `api_builder`   | $499/mo     | yes                             |
| `api_scale`     | $1,499/mo   | yes                             |
| `trial_pack`    | $2.99       | NO — returns `provider: 'stub'` |

The server short-circuits to the stub posture (`provider: 'stub'`

- null payment fields) for products priced below the
  NowPayments-USD floor; no upstream call is made.

## Order status lifecycle

```
pending → confirming → paid
       ↘  partial    → paid (top-up) | failed
       ↘  cancelled (customer-initiated)
       ↘  failed (timeout / refund / expired)
```

Terminal states (`paid`, `failed`, `cancelled`) cannot transition
out. A late-arriving payment to a cancelled order leaves the
order cancelled but records the `payment_id` for support
reconciliation.

## List customer orders

`GET /v1/billing/crypto-orders`

Returns the authenticated customer's crypto orders, newest first.

```json
{
  "data": [
    {
      "order_id": "ord_a1b2c3d4e5f6",
      "product": "solo_manual",
      "price_cents": 7900,
      "price_currency": "USD",
      "payment_id": "12345678",
      "status": "paid",
      "customer_note": null,
      "events": [
        { "status": "pending", "at": 1779565200000, "source": "create" },
        { "status": "confirming", "at": 1779565260000, "source": "ipn" },
        { "status": "paid", "at": 1779565800000, "source": "ipn" }
      ],
      "created_at": 1779565200000,
      "updated_at": 1779565800000
    }
  ]
}
```

`events` is an append-only state-transition log — the canonical
record of how the order reached its current state, for support
forensics.

## Webhook event: `crypto.order.paid`

When an order transitions to `paid`, Driftstack fires a
`crypto.order.paid` webhook event to your configured endpoints.

```json
{
  "event_type": "crypto.order.paid",
  "data": {
    "order_id": "ord_a1b2c3d4e5f6",
    "product": "solo_manual",
    "price_cents": 7900,
    "price_currency": "USD",
    "payment_id": "12345678",
    "paid_at": "2026-05-22T10:30:00Z"
  }
}
```

Same HMAC-SHA256 signature scheme as every other Driftstack
webhook ([webhook signing](../webhooks/events)). Idempotent: the
same `event_id` may be redelivered up to 5 times if your endpoint
returns non-2xx; verify by checking the `paid_at` timestamp or
storing seen `event_id`s.

The companion `crypto.order.failed` event fires on the
`pending|confirming|partial → failed` transition (whether driven
by an IPN status, customer cancellation, or admin sweep).

## Idempotency

Same contract as the rest of the API. Send an `Idempotency-Key`
header (1-255 ASCII printable chars, no whitespace) on every
checkout call:

```http
POST /v1/billing/crypto-checkout
Idempotency-Key: a1b2c3d4-5e6f-7890-1234-567890abcdef
```

Duplicate keys within the 24h cache window return the original
order verbatim with an `Idempotent-Replayed: 1` response header.
A duplicate key with a different request body fires a structured
`crypto_checkout_idempotency_body_mismatch` warn log; the
contract still replays the original order, but operators can grep
for accidental key reuse.

## Pricing notes

- All amounts are in USD cents; NowPayments converts to crypto
  using their rate engine at the moment of `pay_address` mint.
- The `pay_amount` returned to your customer locks the exchange
  rate for the duration of the payment window (~20 minutes per
  NowPayments default). Outside that window the customer may need
  to re-create the order.
- Driftstack does not retain crypto; with NowPayments
  auto-conversion enabled (recommended) we receive USDT/EUR and
  the customer's crypto exposure is eliminated on receipt.

## Manual reconciliation

If an order is stuck (e.g., NowPayments IPN failed to deliver,
customer reports payment but Driftstack shows `pending`), contact
[billing@driftstack.dev](mailto:billing@driftstack.dev) with the
`order_id` and the customer's transaction hash. Manual replay is
audit-logged and reflects the same `crypto.order.paid` webhook
event your endpoint would have received on the original IPN.
