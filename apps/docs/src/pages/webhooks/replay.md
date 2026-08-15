---
layout: ../../layouts/DocLayout.astro
title: Replaying webhook deliveries
description: Re-fire a failed or DLQ webhook delivery via /v1/webhook-deliveries/:id/replay.
---

# Replaying webhook deliveries

Driftstack retries failed webhook deliveries 5 times with exponential
backoff before parking them in the DLQ. When your endpoint goes down
for a brief outage and you fix it, you can re-fire any delivery
yourself rather than emailing support.

## Replay a delivery

`POST /v1/webhook-deliveries/:deliveryId/replay`

Resets the delivery to `pending` so the worker re-fires it on the next
poll cycle — up to 60 seconds, since the delivery worker polls once a
minute. Account-scoped: the delivery must belong to a webhook endpoint
your account owns. Returns the updated delivery.

Request body: `{}` (empty).

Response (200):

```json
{
  "id": "wdl_00000000-0000-4000-8000-000000000001",
  "webhook_id": "whk_00000000-0000-4000-8000-000000000099",
  "event_id": "00000000-0000-4000-8000-0000000000aa",
  "event_type": "session.completed",
  "status": "pending",
  "attempts": 0,
  "next_attempt_at": "2026-05-08T10:00:00Z",
  "last_response_status": null,
  "last_response_excerpt": null,
  "last_error": null,
  "delivered_at": null,
  "created_at": "2026-05-08T09:00:00Z"
}
```

## Typical flow

1. Your endpoint goes down at 10:00 — Driftstack retries each delivery
   on the backoff schedule (1m, 5m, 15m, 30m, 60m). It stays down past
   the last retry, so ~2 hours later the deliveries land in DLQ
   (`status: "dlq"`).
2. You fix your endpoint at 13:00.
3. List the DLQ deliveries:
   `GET /v1/webhooks/:webhookId/deliveries?status=dlq`
4. Replay each one: `POST /v1/webhook-deliveries/:deliveryId/replay`.
   Within a minute the worker re-fires and (if your endpoint is
   healthy) marks them `delivered`.

## SDK examples

**TypeScript:**

```ts
const dlq = await client.webhooks.listDeliveries('whk_xxx', { status: 'dlq' });
for (const delivery of dlq.data) {
  await client.webhooks.replayDelivery(delivery.id);
}
```

The same call iterates lazily across all pages:

```ts
for await (const delivery of client.webhooks.iterateDeliveries('whk_xxx', { status: 'dlq' })) {
  await client.webhooks.replayDelivery(delivery.id);
}
```

**Python:**

```python
for delivery in client.webhooks.iterate_deliveries("whk_xxx", status="dlq"):
    client.webhooks.replay_delivery(delivery.id)
```

**Go:**

```go
page, err := client.Webhooks.ListDeliveries(
    ctx,
    "whk_xxx",
    &driftstack.ListDeliveriesQuery{Status: driftstack.DeliveryDLQ},
)
if err != nil {
    return err
}
for _, delivery := range page.Data {
    if _, err := client.Webhooks.ReplayDelivery(ctx, delivery.ID); err != nil {
        return err
    }
}
```

## Errors

- `404 Not Found` — the delivery id is unknown, or the delivery belongs
  to an endpoint that isn't yours. (We return 404 not 403 so the
  endpoint doesn't leak the existence of other accounts' deliveries.)
- `400 Bad Request` — the delivery id is malformed (must be `wdl_<uuid>`).
- `429 Too Many Requests` — global rate limit; back off and retry.

## Audit

Every customer-initiated replay records a `webhook_delivery.replayed`
entry in your account audit log:
`GET /v1/account/audit-log?action=webhook_delivery.replayed`. The
payload includes `endpoint_id` and `event_type` for cross-reference.
