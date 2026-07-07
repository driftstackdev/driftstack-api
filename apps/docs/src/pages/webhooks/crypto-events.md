---
layout: ../../layouts/DocLayout.astro
title: Crypto order events
description: Subscribe to crypto.order.paid and crypto.order.failed for push notification of crypto payment settlement — payload contracts, reason codes, and the polling-vs-webhooks tradeoff.
---

# Crypto order events

The crypto-orders surface emits two live, subscribable event types:
`crypto.order.paid` when a payment settles, and `crypto.order.failed`
when an order reaches the terminal failure state. This page is the
payload contract for both, plus guidance on choosing between
webhooks and polling for order-state changes. The generic delivery
mechanics (envelope, signing, retries, DLQ) are shared with every
other event type and documented in the
[event catalog](/webhooks/events/).

## Subscribing

Register an HTTPS endpoint for one or both event types — the same
`POST /v1/webhooks` call as any other subscription
([endpoint management](/webhooks/endpoints/)):

```json
POST /v1/webhooks
{
  "url": "https://example.com/webhooks/driftstack",
  "events": ["crypto.order.paid", "crypto.order.failed"]
}
```

Deliveries carry the standard envelope (`id` / `type` /
`created_at` / `data`) and the `X-Driftstack-Signature`
HMAC-SHA256 header; verify them exactly like every other event
([verification](/webhooks/events/#verification)).

## Event: `crypto.order.paid`

Fires once when an order transitions to `paid` — NowPayments
reported the payment finished **and** the received
crypto-denominated amount reconciled against the quoted amount. A
re-delivered provider notification for an already-paid order does
not fire the event again.

| `data` field     | Type            | Description                                                 |
| ---------------- | --------------- | ----------------------------------------------------------- |
| `order_id`       | string          | The Driftstack order id (`ord_…`).                          |
| `product`        | string          | The tier purchased (e.g. `team_manual`).                    |
| `price_cents`    | integer         | Order total in fiat cents.                                  |
| `price_currency` | string          | ISO 4217 fiat currency the price is denominated in (`USD`). |
| `payment_id`     | string          | The NowPayments-side payment id bound to the order.         |
| `paid_at`        | ISO 8601 string | Server timestamp of the `paid` transition.                  |

```json
{
  "id": "<uuid>",
  "type": "crypto.order.paid",
  "created_at": "2026-07-07T10:30:00.000Z",
  "data": {
    "order_id": "ord_a1b2c3d4e5f6",
    "product": "team_manual",
    "price_cents": 24900,
    "price_currency": "USD",
    "payment_id": "12345678",
    "paid_at": "2026-07-07T10:30:00.000Z"
  }
}
```

## Event: `crypto.order.failed`

Fires once when an order transitions into the terminal `failed`
state. The `reason` field tells you which of the three failure paths
produced it:

- `ipn` — NowPayments reported a terminal non-paid payment status
  (`failed`, `expired`, or `refunded`).
- `expired` — an operator retired this specific order after its pay
  window lapsed with no settled payment.
- `swept` — the stale-order sweep retired the order along with other
  long-pending orders.

A customer **cancellation does not fire this event** — a cancelled
order moves to `cancelled`, which is a distinct terminal state with
no webhook emission. If you track cancellations, poll for the
`cancelled` status.

| `data` field     | Type            | Description                                                                           |
| ---------------- | --------------- | ------------------------------------------------------------------------------------- |
| `order_id`       | string          | The Driftstack order id (`ord_…`).                                                    |
| `product`        | string          | The tier the order was for.                                                           |
| `price_cents`    | integer         | Order total in fiat cents.                                                            |
| `price_currency` | string          | ISO 4217 fiat currency (`USD`).                                                       |
| `payment_id`     | string \| null  | NowPayments payment id, or `null` when the order never got as far as a bound payment. |
| `reason`         | string          | One of `ipn`, `expired`, `swept`.                                                     |
| `failed_at`      | ISO 8601 string | Server timestamp of the `failed` transition.                                          |

```json
{
  "id": "<uuid>",
  "type": "crypto.order.failed",
  "created_at": "2026-07-07T10:35:00.000Z",
  "data": {
    "order_id": "ord_a1b2c3d4e5f6",
    "product": "team_manual",
    "price_cents": 24900,
    "price_currency": "USD",
    "payment_id": null,
    "reason": "swept",
    "failed_at": "2026-07-07T10:35:00.000Z"
  }
}
```

## Receiver idempotency

Crypto events ride the standard delivery pipeline — 6 attempts with
exponential backoff, then DLQ — so your receiver **must** tolerate
the same event arriving more than once (retries after a slow 2xx,
manual replays, DLQ requeues). Dedup on the envelope `id` (also
surfaced as the `X-Driftstack-Event-Id` header), or make the write
idempotent by keying on `(order_id, status)`:

```ts
app.post('/webhooks/driftstack', verifySignature, async (req, res) => {
  const event = req.body;
  if (event.type === 'crypto.order.paid') {
    await db.markOrderPaid(event.data.order_id); // upsert — replay-safe
  } else if (event.type === 'crypto.order.failed') {
    await db.markOrderFailed(event.data.order_id, event.data.reason);
  }
  res.status(200).end();
});
```

Grant entitlements on `crypto.order.paid` only — never on your own
observation of `confirming` or `partial` while polling.

## Polling instead of webhooks

If you can't accept inbound HTTPS callbacks, poll the order until
its status goes terminal. The `status` field on
`GET /v1/billing/crypto-orders/:order_id` transitions on exactly the
same triggers that fire these events:

```ts
for (;;) {
  const order = await client.cryptoOrders.get(orderId);
  if (['paid', 'failed', 'partial', 'cancelled'].includes(order.status)) break;
  await new Promise((r) => setTimeout(r, 5_000));
}
```

Pick a cadence that matches who's waiting:

- **A few seconds** while a customer is watching a "pay with crypto"
  screen; stop as soon as the status is terminal.
- **Minutes** for a background process tied to an open dashboard.
- **Hourly or nightly** for reconciliation — combine the `status`
  filter with cursor pagination and the `created_after` /
  `created_before` date-range filters so each window only scans what
  it needs:

```ts
for await (const order of client.cryptoOrders.listAll({
  status: 'paid',
  created_after: since,
  limit: 100,
})) {
  await reconcile(order);
}
```

Note that polling adds one wrinkle webhooks don't have: `partial` is
a semi-terminal status (only `paid` or `failed` can follow it, after
manual support resolution), so treat it as "stop polling, involve a
human", not as a state to wait out.

## Recommended: hybrid

For production billing integrations, use both: webhooks for prompt
notification, plus a periodic reconciliation poll as the safety net
for the rare delivery that exhausts its retries. The reconciliation
loop is naturally idempotent when your local write is keyed on
`(order_id, status)`.

## Related

- [Event catalog](/webhooks/events/) — envelope, signing, retry schedule, DLQ semantics
- [Endpoint management](/webhooks/endpoints/) — subscribe, rotate secrets, send test events
- [Paying with crypto](/guides/paying-with-crypto/) — the checkout walkthrough these events belong to
- [Crypto checkout API reference](/api/billing-crypto/) — order endpoints + lifecycle
