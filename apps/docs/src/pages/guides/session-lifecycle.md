---
layout: ../../layouts/DocLayout.astro
title: Session lifecycle
description: The full lifecycle of a Driftstack session — create, drive, capture, destroy, and how concurrency and idle timeouts shape the boundaries.
---

# Session lifecycle

> **Draft — founder review pending.** Endpoint shapes verified against `apps/server/src/routes/sessions.ts` and `packages/api-types/src/sessions.ts`.

A **session** is one running iPhone Safari instance on the modified WebKit fork. Every session occupies one of your account's concurrent slots from creation until destruction; understanding the lifecycle is the difference between using your tier's capacity well and burning slots on stuck sessions.

## States

```
              create
                │
                ▼
            ┌───────┐    navigate / interact / wait      ┌────────┐
            │ ready │───────────────────────────────────▶│ active │
            └───────┘                                    └────────┘
                ▲                                             │
                │                                             │ destroy
                │ idle ≥ idle_timeout                         │ or idle ≥ idle_timeout
                │                                             ▼
                │                                       ┌──────────┐
                └────────reconnect (V-NNN+)─────────────│ destroyed│
                                                        └──────────┘
```

In practice you don't observe `ready` separately — the SDK's `sessions.create()` returns once the session is `active` and ready for the first method call.

## Concurrency

Each tier has a hard cap on simultaneously-active sessions. Exceeding the cap returns `429 Too Many Requests` on `sessions.create()`, with a `Retry-After` header indicating when capacity will free up (worst case = soonest tracked session's idle-timeout boundary).

| Tier          | Concurrent sessions |
| ------------- | ------------------- |
| Trial pack    | 1                   |
| Solo Manual   | 1                   |
| Team Manual   | 3                   |
| Agency Manual | 8                   |
| API Starter   | 2                   |
| API Builder   | 8                   |
| API Scale     | 24                  |
| Enterprise    | Custom              |

Concurrent caps are the only metering on paid tiers — there are no hour caps and no overage charges. Run sessions for as long as your workflow needs within your concurrent cap.

Pricing source of truth: [driftstack.dev/pricing](https://driftstack.dev/pricing).

## Create

```ts
const session = await client.sessions.create({
  label: 'checkout flow',
  // archetype: optional override of the locked default
  // metadata: optional Record<string, unknown> for your own tracking
});
console.log(session.id, session.created_at);
```

**Returns** a `Session` with `id`, `archetype`, `state`, `label`, `metadata`, `created_at`. The `id` is the handle for every subsequent call.

**Tier check:** if you're at your concurrent cap, the call returns `429`. If your tier's profile cap blocks profile binding, `402 profile_cap_reached`. If your account is suspended, `403 forbidden`.

## Drive: navigate, interact, wait

A session is driven through three primary methods plus state introspection.

**`POST /v1/sessions/:id/navigate`** — go to a URL.

```ts
const result = await client.sessions.navigate(session.id, {
  url: 'https://example.com/checkout',
  wait_until: 'networkidle', // or 'load' (default), 'domcontentloaded'
  timeout_ms: 30_000,
});
console.log(result.final_url, result.status, result.duration_ms);
```

`wait_until` controls when the call returns. `load` returns on the `load` event; `domcontentloaded` is faster but earlier; `networkidle` waits until network is quiet for a brief window — best for SPAs that load content after the initial render.

**`POST /v1/sessions/:id/interact`** — synthesise touch / scroll / type input on the iPhone Safari runtime. Subject to the realistic-input behavioural-simulation layer that ships with every session.

**`POST /v1/sessions/:id/wait`** — block until a selector appears, a URL pattern is reached, or a timeout elapses.

**`GET /v1/sessions/:id/state`** — read-only introspection: current `url`, `title`, `ready_state`, `viewport`. Cheap; safe to poll at low frequency.

## Capture

`POST /v1/sessions/:id/capture` returns a screenshot or full-page render.

```ts
const shot = await client.sessions.capture(session.id, { kind: 'screenshot' });
// shot.kind, shot.format, shot.bytes_url, shot.captured_at
```

Captures are stored on the EU-resident object-storage sub-processor (Cloudflare R2) and the response includes a signed URL that's valid for a bounded window (~15 minutes). Persist the bytes if you need them long-term.

## Destroy

```ts
await client.sessions.destroy(session.id);
```

`destroy` is idempotent — calling it twice on the same `id` is a no-op the second time. It releases the concurrent slot immediately. If the session was bound to a profile, the profile's storage state is captured and saved on a clean destroy.

**Always destroy.** Forgotten sessions burn concurrent slots until their idle timeout fires. A `try / finally` around your session work is the safe pattern:

```ts
const session = await client.sessions.create();
try {
  await client.sessions.navigate(session.id, { url: 'https://example.com' });
  // … your logic
} finally {
  await client.sessions.destroy(session.id);
}
```

Python and Go SDK examples follow the same pattern (`with` block in Python sync; `defer` in Go).

## Idle timeout

If a session sees no API call for the per-tier idle window, the runtime auto-destroys it and emits a `session.destroyed` webhook with `reason: "idle_timeout"`. This protects against stuck workflows burning your concurrent capacity indefinitely.

Default idle window: 10 minutes. Higher tiers may extend (configured per-account by the control plane).

To keep a session alive during a slow workflow, periodically call any method — `sessions.getState()` is the cheapest heartbeat.

## Error shapes

Every error returned by the session endpoints conforms to the [problem+json shape](/api/) with a `type` URL identifying the error class:

- `429 Too Many Requests` — concurrent cap reached. `Retry-After` header tells you when slots free up.
- `402 Payment Required` — trial-pack credit exhausted (`trial_pack_exhausted`) or profile cap reached (`profile_cap_reached`).
- `404 Not Found` — session ID doesn't exist (or already destroyed and TTL-evicted).
- `409 Conflict` — operation invalid for the current state (e.g. `navigate` after destroy).
- `503 Service Unavailable` — fleet at capacity beyond your account's cap (rare; surfaces during regional fleet incidents).

The SDKs map these to typed error classes — catch `RateLimitError`, `ConcurrencyLimitError`, `PaymentRequiredError`, etc.

## Session events on the webhook bus

If you've configured a webhook endpoint, every state transition fires an event:

- `session.created`
- `session.destroyed` (with `reason`: `customer_destroyed`, `idle_timeout`, `fleet_evicted`)
- `session.error` (runtime crash; auto-destroyed)

See the [webhook events catalog](/webhooks/events/) for full payload shapes and signature verification.

## What's NOT in the lifecycle yet

- **Reconnect after disconnect** — currently a session destroyed by idle-timeout requires a fresh `sessions.create()`. A planned `sessions.reconnect()` API will allow resuming a session within a grace window after disconnect; lands post-launch.
- **Session-level resource quotas** — per-session bandwidth or memory caps aren't customer-facing today. Fleet-level enforcement runs internally.

## Next steps

- **[Profile management](/guides/profile-management/)** — bind sessions to profiles for storage-state continuity.
- **[Webhook events](/webhooks/events/)** — react to session state transitions.
- **[API versioning](/api/versioning/)** — how additive lifecycle fields roll out.
