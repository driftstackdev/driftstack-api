# Webhook delivery worker is unwired in production (LATENT, surface — do not auto-wire)

**Date:** 2026-06-02 · **Author:** autopilot (Agent 2) · **Status:** SURFACED — founder/architectural decision required · **Severity:** HIGH when triggered; **current impact: ZERO** (feature unused in prod today)

## Finding

The webhook **delivery** machinery (claim → sign → POST → retry/backoff/DLQ) is fully
implemented and well-tested, but **no production code path ever constructs or drives a
delivery worker**. Webhook events are enqueued into `webhook_deliveries`, but nothing in
the running server claims those rows and POSTs them to customer endpoints.

The producer side works: `WebhooksService.enqueueEvent` / `sendTestEvent`
(`apps/server/src/services/webhooks.ts:712` / `:639`) write delivery rows via
`enqueueDelivery` (`apps/server/src/db/webhooks-repo.ts:300`). Live producers are wired in
bootstrap — `session.completed` / `session.failed` (sessions.ts), `api_key.revoked`
(api-keys.ts), and `crypto.order.paid` / `crypto.order.failed`
(`bootstrap.ts:968-974`, landed 2026-05-22).

The consumer side is **not** wired:

- The outbound POST + `repo.claim` live only in `WebhookDeliveryWorker`
  (`apps/server/src/services/webhook-worker.ts:64`, the "production-today" inline impl) and
  `DurableWebhookWorker` (`apps/server/src/services/durable-webhook-delivery.ts:322`, the
  V-173 "FORWARD path").
- **`WebhookDeliveryWorker` is constructed only in `apps/server/tests/e2e/helpers/server.ts:227`** (the e2e harness, driven manually via `tickOnce()`). It is **never** constructed in `apps/server/src`.
- **`createDurableWebhookDelivery` has zero call sites** outside its own definition.
- The production entrypoint (`apps/server/src/index.ts` → `createProductionDeps`/`bootstrap.ts` → `buildApp`/`app.ts`) starts **10 background timers** (scheduled-jobs, validation-harness, health-probe, status-snapshot, status-purge, 2× rotation-reminder, pair-mode heartbeat, force-rotation, secret-prev cleanup) — **none drives webhook delivery**.
- Registered scheduled-job handlers are `cost.recompute_nightly`, `auth_tokens.sweep`, `sessions.duration_sweep` — **no webhook-delivery job_type**.
- No app/route/plugin worker start; no internal cron-pump endpoint; `package.json` has a single entrypoint (`node dist/index.js`) — **no separate worker process**.
- Git: the worker was **never** wired in `bootstrap.ts` (`git log -S` empty) — this is original, not a regression.

Secondary: the customer + admin "replay delivery" routes (`/v1/webhook-deliveries/:id/replay`, `/v1/admin/webhook-deliveries/:id/replay|requeue`) only set rows back to `pending`, so they would also never be sent.

## Why prior auditing missed it

Extensive prior webhook work audited the worker's **logic** in isolation (SSRF, retry/backoff/DLQ, signing, cursor keyset, scope, orphaned-lock reclaim) but never verified the worker is **invoked** in production. The e2e tests construct their **own** worker in the harness and drive it via `tickOnce()`, so end-to-end webhook tests pass — masking that production never starts one. (Same class as the 2026-06-02 in-memory-repo divergence: test infra diverging from production wiring.)

## Current impact: ZERO (verified against prod)

Read-only prod query (`webhook_deliveries`, `webhook_endpoints`) on 2026-06-02:

```
endpoints=0   active_endpoints=0   deliveries=0
```

No customer has created a webhook endpoint, so nothing has been enqueued and there is **no
stuck backlog** (contrast the 2026-05-20 "13 pending auth_tokens.sweep rows" incident). The
gap is latent: it activates the first time a customer creates an endpoint, subscribes to an
event type, and a qualifying event fires.

## Recommendation (founder/architectural — NOT auto-wired)

Must-fix **before webhooks are exercised by any customer** (i.e., before/at launch if
webhooks are a launch feature). Decisions required:

1. **Is webhook delivery intended to be live at v1.0?** (If webhooks are deliberately dark pre-launch like the dormant OAuth provider / 503 proxy stubs, this is expected — but unlike those, there is no gate and the docs present webhooks as functional.)
2. **Which worker?** The inline `WebhookDeliveryWorker` is labelled "production today" and is the lower-risk choice; the durable `DurableWebhookWorker` is the documented FORWARD path but its own header says it needs "soak time + integration tests against real DB" first.
3. **Cadence/latency.** A 60s `setInterval` calling `worker.tickOnce()` mirrors the existing pollers exactly (unref + `clearInterval` in `teardown()`), but adds up to 60s delivery latency. The `run()` loop (continuous claim + ~2s idle sleep) gives near-real-time delivery. Multi-instance is already safe — `claim` uses `SELECT … FOR UPDATE SKIP LOCKED`.

Whichever is chosen, it must also be added to the graceful-shutdown `teardown()` in `bootstrap.ts` (stop the worker before closing the redis/db handles), consistent with the existing poller teardown ordering.

Graceful-shutdown / lifecycle teardown itself was audited the same session and is **sound** (bounded 10s drain race so a hung SSE can't block teardown; idempotent `torn` guard; correct stop-pollers → Sentry flush → redis → db ordering; all timers `unref()`'d).
