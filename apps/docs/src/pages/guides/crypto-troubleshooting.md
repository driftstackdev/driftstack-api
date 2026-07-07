---
layout: ../../layouts/DocLayout.astro
title: Crypto payment troubleshooting
description: Decision tree for crypto payment problems — stuck pending orders, partial payments, failed orders, wrong-network sends, lost addresses, and receipts.
---

# Crypto payment troubleshooting

You're here because something about a crypto payment looks wrong.
Work through the symptom that matches — these cover almost every
case support sees. If yours doesn't fit, go straight to
[support@driftstack.dev](mailto:support@driftstack.dev) with your
`order_id`.

## Where's my order_id?

Two places, depending on how you paid:

- **Dashboard** — **Billing → Crypto payments** lists your most
  recent orders with their current state and a receipt download.
- **API** — `GET /v1/billing/crypto-orders` returns every order on
  the account, newest first, with the full state-transition
  timeline per order. Filter with `?status=` if the list is long.

Order ids look like `ord_a1b2c3d4e5f6` — the prefix is part of the
id.

## I paid, but the order is still `pending`

1. **Check the block explorer first.** Paste your TX hash into the
   canonical explorer for the network you used. If it shows the
   transaction as _not yet broadcast_, the issue is on the wallet
   side — retry the send. If it shows _broadcast, 0 confirmations_,
   you're waiting on the network.
2. **Give it the confirmation window.** NowPayments waits for the
   confirmation depth it requires on that network before reporting
   the payment, so the order flips to `confirming` (and then `paid`)
   with a delay that varies by coin and by network congestion.
3. **Confirmed on-chain but still `pending` after 30 minutes?**
   Skip to the [escalation section](#escalate-to-support) with your
   TX hash — that combination usually means the payment needs manual
   reconciliation.

## My order is `partial`

`partial` means an on-chain payment arrived but the
crypto-denominated amount is short of the quoted `pay_amount`
(beyond the small slippage tolerance), or it arrived in a currency
that doesn't match the quote. Common causes:

- Your wallet deducted network fees from the amount instead of
  adding them on top, so less than the displayed amount arrived.
- The send was rounded down from the quoted amount.
- A different coin than the quoted `pay_currency` landed at the
  address.

Partial orders need a human. Email
[support@driftstack.dev](mailto:support@driftstack.dev) with the
`order_id` and the TX hash. Crypto payments are non-refundable
([policy](https://driftstack.dev/legal/refunds)), so the resolution
path is completing the order — support arranges a top-up for the
difference — not sending the partial payment back. No tier is
activated while an order sits in `partial`.

## My order moved to `failed`

`failed` means one of:

- NowPayments reported a terminal non-paid status for the payment
  (`failed`, `expired`, or `refunded`), or
- the order sat in `pending` with no settled payment and was retired
  as stale (typically after 24 hours).

If you never sent funds: just open a fresh order and pay it within
the displayed window. **If funds left your wallet and the order
still failed**, that's a reconciliation problem — escalate to
support immediately with the TX hash. If the upstream provider
returns funds on their own, that's a NowPayments-side action outside
Driftstack's control.

## I sent funds on the wrong network

The deposit address is only valid on the network shown at checkout.
If you sent on a different one:

- **Same address format on both chains** (typical for EVM-style
  networks): the funds sit at the same address on the wrong chain.
  Often recoverable — contact support with the TX hash.
- **Different address formats**: the transaction usually fails to
  send at all. If it didn't, recovery depends on the chain.

We do our best to help recover wrong-network sends but can't
guarantee it. Always double-check the network indicator before
broadcasting.

## I can't see the deposit address anymore

The checkout modal is the only surface that shows the address — the
order endpoints deliberately don't return it, so refreshing or
re-opening the order won't re-display it. Two ways out:

- **API checkouts:** if you sent an `Idempotency-Key` on the
  original request (you should — see
  [Idempotency keys](/reference/idempotency/)), repeat the exact
  same `POST /v1/billing/crypto-checkout` with the same key. The
  replay returns the original order **including the original payment
  address**, and carries an `Idempotent-Replayed: 1` header.
- **Dashboard checkouts:** cancel the pending order
  (**Billing → Crypto payments**, or
  `POST /v1/billing/crypto-orders/:order_id/cancel`) and start a
  fresh checkout. Cancelling is only possible while the order is
  still `pending` with no payment activity.

Never re-use an address from an earlier, different order.

## I want a receipt

Available for every order via the API — three formats:

```bash
# JSON envelope (programmatic)
curl -H "authorization: Bearer ds_live_…" \
  https://api.driftstack.dev/v1/billing/crypto-orders/ord_a1b2c3d4e5f6/receipt

# Plain text (cron / curl pipelines)
curl -H "authorization: Bearer ds_live_…" \
  https://api.driftstack.dev/v1/billing/crypto-orders/ord_a1b2c3d4e5f6/receipt.txt

# PDF (accounting / archival)
curl -H "authorization: Bearer ds_live_…" -O -J \
  https://api.driftstack.dev/v1/billing/crypto-orders/ord_a1b2c3d4e5f6/receipt.pdf
```

The dashboard's **Billing** view exposes the PDF as a one-click
download next to each order.

## Escalate to support

Email [support@driftstack.dev](mailto:support@driftstack.dev) with
as much of the following as you have:

- Your account email.
- The `order_id` (from the dashboard or the order list API).
- The TX hash — an explorer link is fine. This is the single most
  useful item; most payment escalations resolve quickly once we
  have it.
- The network you sent on.
- A screenshot of your wallet's send confirmation, if you still
  have it.

## Related

- [Paying with crypto](/guides/paying-with-crypto/) — the full checkout walkthrough
- [Crypto checkout API reference](/api/billing-crypto/)
- [Crypto order events](/webhooks/crypto-events/) — get notified instead of polling
