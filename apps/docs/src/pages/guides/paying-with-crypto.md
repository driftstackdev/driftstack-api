---
layout: ../../layouts/DocLayout.astro
title: Paying with crypto
description: How to pay for a Driftstack tier with cryptocurrency — the dashboard flow, the checkout API, the order lifecycle, safe retries, and receipts.
---

# Paying with crypto

Every self-serve paid tier can be bought with cryptocurrency instead
of a card. Payments run through
[NowPayments](https://nowpayments.io) — Driftstack never custodies
your coins. You get a single-use payment address, send the exact
amount shown, and Driftstack activates the tier once the payment
settles on-chain. **Crypto payments are final and non-refundable**
([refund policy](https://driftstack.dev/legal/refunds)), so this page
also covers what each order state means and how to retry safely.

This is the walkthrough. The endpoint-by-endpoint reference lives at
[Crypto checkout](/api/billing-crypto/).

## The dashboard flow (no code)

1. Open **Select tier** in the [dashboard](https://app.driftstack.dev)
   and pick a tier.
2. Click **or pay with crypto →** under the tier card (instead of the
   card-checkout button).
3. The modal shows three things: the exact amount, the currency to
   send it in, and a single-use deposit address. Copy the address
   verbatim and send the exact amount from your wallet.
4. You can close the window — the order is tracked even if you
   navigate away. Once the payment settles, the order shows as
   `paid` under **Billing → Crypto payments**, where you can also
   download a PDF receipt.

## What you need for the API flow

- Authentication that carries the `admin:billing` scope. A dashboard
  (account-owner) session has it; a plain `read`/`write` API key does
  **not** — starting a checkout is a subscription-change action. See
  [API key scopes](/reference/scopes/).
- A tier to buy. The six self-serve paid tiers are purchasable with
  crypto (`solo_manual`, `team_manual`, `agency_manual`,
  `api_starter`, `api_builder`, `api_scale`); the free tier is not a
  purchasable product.

## Step 1 — mint an order

Create a checkout order with `POST /v1/billing/crypto-checkout`.
Always send an `Idempotency-Key` header so a retried request returns
the original order instead of minting a duplicate:

```ts
import { randomUUID } from 'node:crypto';

const order = await client.cryptoOrders.createCheckout(
  {
    product: 'team_manual',
    price_cents: 24900,
    price_currency: 'USD',
  },
  { idempotencyKey: randomUUID() },
);
```

```bash
curl -X POST https://api.driftstack.dev/v1/billing/crypto-checkout \
  -H "authorization: Bearer ds_live_…" \
  -H "content-type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "product": "team_manual", "price_cents": 24900, "price_currency": "USD" }'
```

Two things to know about the request body:

- **The price you send is validated for shape but ignored.** The
  amount charged always comes from the server-side price table, so a
  tampered `price_cents` can't buy a tier at the wrong price. Fetch
  the current price first with `POST /v1/billing/crypto-checkout/quote`
  (same `product` body) if you don't want to hardcode it.
- **The settlement currency is locked to USD server-side.**
  NowPayments converts the USD amount to crypto with its own rate
  engine at address-mint time.

The `201` response carries the `order_id` (an `ord_`-prefixed id —
quote it in every support request), the `status` (always `pending` at
mint), and the payment details:

```json
{
  "order_id": "ord_a1b2c3d4e5f6",
  "product": "team_manual",
  "price_cents": 24900,
  "price_currency": "USD",
  "status": "pending",
  "provider": "nowpayments",
  "payment_address": "bc1qexample...",
  "pay_currency": "btc",
  "pay_amount": 0.00123,
  "created_at": "2026-07-07T10:00:00.000Z"
}
```

If `provider` is `"stub"` the payment fields are `null` — the
NowPayments side couldn't mint an address for this order and support
completes the payment setup manually. The order still exists and is
trackable by its `order_id`.

A replayed request (same `Idempotency-Key`) returns the **original**
order verbatim plus an `Idempotent-Replayed: 1` response header —
including the original payment address, so a retry never shows you a
second address. Keys replay for as long as the order exists; see
[Idempotency keys](/reference/idempotency/).

## Step 2 — pay the address

Send **exactly** `pay_amount` in `pay_currency` to
`payment_address`, on the network the checkout shows. The address is
single-use and network-specific — a token sent on a different
network than the one displayed can be lost. While the order is
`pending`, its envelope carries an `expires_at` hint
(`created_at + 60 minutes`) that the dashboard renders as a
countdown; treat it as the window in which to broadcast your
payment.

Don't round the amount. An under-payment (beyond a ~1% slippage
tolerance) parks the order in `partial` instead of `paid`, and
resolving a partial takes a manual support step.

## Step 3 — watch the order settle

Two supported patterns, and they compose:

- **Webhooks (push):** subscribe to `crypto.order.paid` and
  `crypto.order.failed` — both are live, subscribable event types.
  Payload contract and receiver guidance:
  [Crypto order events](/webhooks/crypto-events/).
- **Polling (pull):** read the order until its `status` goes
  terminal.

```ts
for (;;) {
  const order = await client.cryptoOrders.get(orderId);
  if (['paid', 'failed', 'partial', 'cancelled'].includes(order.status)) break;
  await new Promise((r) => setTimeout(r, 5_000));
}
```

**Grant anything on your side only when you observe
`status === 'paid'`** — never on `confirming` (not settled yet) and
never on `partial` (under-paid; not credited). Driftstack applies the
same rule: the tier purchase is activated on the `paid` transition,
not before.

Activation applies your account's tier automatically on that `paid`
transition. A crypto payment is a **one-time payment for one month**:
it entitles the purchased tier for a fixed **31-day term** from the
payment, and the tier lapses when that term ends unless you buy again.
There is no auto-charge and no stored payment method — renewing is
always a fresh order you choose to open.

A few rules make this predictable:

- **Upgrade-only apply.** If your account already sits on a higher tier
  when the order settles (say a card subscription started after you
  minted the order), the paid order never downgrades you. The
  entitlement is still recorded — it acts as a **floor**: if the higher
  rail later lapses, your account falls back to this crypto-paid tier
  (not straight to free) until its 31-day term ends.
- **Re-buying the tier you already hold extends it.** A same-tier
  purchase **stacks** onto your running term — the new 31 days begin
  when the current entitlement would have ended, so no paid day is lost
  and there is no duplicate email.
- **When a term ends**, your account is recomputed to the best coverage
  you still have — a live card subscription, another still-valid crypto
  entitlement, or the free tier — never stranded below what you paid for.

Each real tier change is written to your [audit log](/api/audit-log/)
as a `subscription.tier_changed` entry carrying the `order_id`.

## The order lifecycle

| Status       | What it means                                                                                             | What you can do                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pending`    | Order minted; no payment seen yet.                                                                        | Pay the address, or cancel the order if you changed your mind.                             |
| `confirming` | NowPayments has seen the payment; waiting on network confirmations.                                       | Wait. Cancelling now needs support so your on-chain funds can be reconciled.               |
| `paid`       | Confirmations complete and the received amount reconciled against the quote. Tier purchase is activated.  | Download the receipt.                                                                      |
| `partial`    | A payment arrived but the crypto-denominated amount is short of the quote (or in a mismatched currency).  | Contact support with the `order_id` + TX hash — resolution is a top-up, never a send-back. |
| `failed`     | NowPayments reported `failed` / `expired` / `refunded`, or the order sat unpaid and was retired as stale. | Open a fresh order. If funds left your wallet, escalate to support with the TX hash.       |
| `cancelled`  | You cancelled while the order was still `pending`. Terminal.                                              | Open a fresh order whenever you're ready.                                                  |

Terminal states (`paid`, `failed`, `cancelled`) never transition out.
`partial` is semi-terminal: only `paid` (after a top-up) or `failed`
can follow. Every transition is recorded on the order's append-only
`events` timeline, which the order endpoints return — useful when
you need to reconstruct what happened.

## Step 4 — receipts

Every order exposes a receipt in three formats (the download is
meaningful once the order is `paid`):

```bash
# JSON envelope — programmatic consumers
curl -H "authorization: Bearer ds_live_…" \
  https://api.driftstack.dev/v1/billing/crypto-orders/ord_a1b2c3d4e5f6/receipt

# Plain text — cron / curl pipelines
curl -H "authorization: Bearer ds_live_…" \
  https://api.driftstack.dev/v1/billing/crypto-orders/ord_a1b2c3d4e5f6/receipt.txt

# PDF — accounting / archival (Content-Disposition download)
curl -H "authorization: Bearer ds_live_…" -O -J \
  https://api.driftstack.dev/v1/billing/crypto-orders/ord_a1b2c3d4e5f6/receipt.pdf
```

The receipt's `paid_at` comes from the order's event log — the
moment of the actual `paid` transition. The dashboard's
**Billing → Crypto payments** list has the same PDF as a one-click
download.

## Backfill + reconciliation

For nightly jobs, walk your paid orders with the cursor-managed
iterator and a date-range filter:

```ts
const since = lastReconcileTimestamp().toISOString();
for await (const order of client.cryptoOrders.listAll({
  status: 'paid',
  created_after: since,
  limit: 100,
})) {
  await db.ensureOrderPaid(order.order_id);
}
```

`listAll()` (alias `iterate()`) yields one order at a time and stops
when the server stops emitting a `next_cursor`. `created_after` is
inclusive, `created_before` exclusive, and a window where
`created_before <= created_after` is rejected with a `400`.

## Cancelling + refunds

While an order is still `pending` you can abandon it yourself with
`POST /v1/billing/crypto-orders/:order_id/cancel`. Once any payment
activity exists, the cancel returns `409` and reconciliation goes
through support. Cancelling a **subscription** stops future billing
periods, but the current period is not refunded — crypto payments
are non-refundable end to end
([policy](https://driftstack.dev/legal/refunds)). If you expect to
need cash refunds, the card path (Stripe) is the right channel.

## Related

- [Crypto checkout API reference](/api/billing-crypto/) — every endpoint, full response shapes
- [Crypto order events](/webhooks/crypto-events/) — `crypto.order.paid` / `crypto.order.failed` payloads
- [Crypto payment troubleshooting](/guides/crypto-troubleshooting/) — the "something looks stuck" decision tree
- [Idempotency keys](/reference/idempotency/) — safe retries on checkout
- [API key scopes](/reference/scopes/) — why checkout needs `admin:billing`
