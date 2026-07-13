---
layout: ../../layouts/DocLayout.astro
title: Session lifecycle
description: The full lifecycle of a Driftstack session — create, drive, capture, destroy, and how concurrency and duration caps shape the boundaries.
---

# Session lifecycle

A **session** is one running iPhone Safari instance on the modified WebKit fork. Every session occupies one of your account's concurrent slots from creation until destruction; understanding the lifecycle is the difference between using your tier's capacity well and burning slots on stuck sessions.

## States

The wire-level `session.status` enum has five values: `creating` / `ready` / `busy` / `destroyed` / `errored`.

```
              create
                │
                ▼
            ┌──────────┐  (transient — server resolves        ┌───────┐
            │ creating │───────────────────────────────────▶  │ ready │
            └──────────┘   driver allocation + handshake)     └───────┘
                                                                  │  ▲
                                              navigate / interact │  │ ack / settle
                                              / wait / capture    │  │
                                                                  ▼  │
                                                              ┌──────┐
                                                              │ busy │
                                                              └──────┘
                                                                  │
                                                                  │ destroy
                                                                  │ OR free-tier 20-min cap
                                                                  ▼
                                                            ┌───────────┐
                                                            │ destroyed │
                                                            └───────────┘
                                                            (or `errored` on driver failure)
```

In practice you don't observe `creating` separately — the SDK's `sessions.create()` blocks until the server-side transition reaches `ready` (the driver is allocated and the harness is responding). Every method call flips the session into `busy` for the duration and back to `ready` on ack. `errored` is a terminal failure state mirroring `destroyed` but caused by a driver-side fault (not by an explicit destroy or the free-tier duration cap).

## Concurrency

Each tier has a hard cap on simultaneously-active sessions. Exceeding the cap returns `429 Too Many Requests` on `sessions.create()`, with `current_sessions` and `limit` in the problem body. Unlike rate-limit 429s there is no `Retry-After` header — capacity frees when one of your sessions ends, so destroy one (or wait for your own workflow to finish) and retry.

| Tier        | Concurrent sessions |
| ----------- | ------------------- |
| Free        | 1                   |
| Personal    | 1                   |
| Team        | 3                   |
| Agency      | 8                   |
| API Starter | 2                   |
| API Builder | 8                   |
| API Scale   | 24                  |
| Enterprise  | Custom              |

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

**Returns** a `Session` with `id`, `archetype`, `status`, `label`, `metadata`, `created_at`. The `id` is the handle for every subsequent call.

**Tier check:** if you're at your concurrent cap, the call returns `429 concurrency-limit`. If your tier's profile cap is reached on a profile-binding flow, `429 tier-limit`. If your account is suspended, `403 forbidden`.

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

**`GET /v1/sessions/:id/state`** — read-only introspection: current `url`, `title`, persisted `cookies` + `local_storage`, and a `captured_at` timestamp. Cheap; safe to poll at low frequency.

## Capture

`POST /v1/sessions/:id/capture` returns a screenshot, DOM snapshot, or PDF.

```ts
const shot = await client.sessions.capture(session.id, { kind: 'screenshot' });
// shot.kind, shot.data, shot.encoding, shot.byte_size, shot.duration_ms
```

The response carries the capture inline — `data` is the content itself (base64-encoded for screenshots and PDFs) — and nothing is stored server-side. Persist the bytes yourself if you need them long-term.

## Destroy

```ts
await client.sessions.destroy(session.id);
```

`destroy` is idempotent — calling it twice on the same `id` is a no-op the second time. It releases the concurrent slot immediately. If the session was bound to a profile, the profile's storage state is captured and saved on a clean destroy.

**Always destroy.** Forgotten sessions burn concurrent slots until you destroy them (only free-tier sessions stop on their own, at the 20-minute cap). A `try / finally` around your session work is the safe pattern:

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

## Auto-destroy: the free-tier duration cap

Paid-tier sessions are never auto-destroyed — a forgotten session holds its concurrent slot until you destroy it, which is why the `try / finally` pattern above matters. On the free tier, a session is capped at 20 minutes of wall-clock time; when the cap is reached the runtime destroys it for you. There is no idle timeout on any tier.

## Error shapes

Every error returned by the session endpoints conforms to the [problem+json shape](/api/) with a `type` URL identifying the error class:

- `429 Too Many Requests` (`https://errors.driftstack.dev/rate-limited`) — global / per-bucket rate limit exceeded. `Retry-After` carries the wait time.
- `429 Too Many Requests` (`https://errors.driftstack.dev/concurrency-limit`) — concurrent-session cap reached. Wait for an active session to finish.
- `429 Too Many Requests` (`https://errors.driftstack.dev/tier-limit`) — a tier-derived cap (e.g. profile count) is reached.
- `404 Not Found` — session ID doesn't exist (or already destroyed and TTL-evicted).
- `409 Conflict` — operation invalid for the current state (e.g. `navigate` after destroy).
- `410 Gone` (`https://errors.driftstack.dev/session-destroyed`) — operating on a session that has already been destroyed.
- `502 Bad Gateway` / `503 Service Unavailable` — driver-side error (`driver-error` / `driver-not-integrated` / `feature-unavailable`).

The SDKs map these to typed error classes — catch `RateLimitError`, `ConcurrencyLimitError`, the tier-limit class (`TierLimitError` in TypeScript, `QuotaExceededError` in Python and Go), `SessionDestroyedError`, `DriverError`, etc. The full mapping lives at [/reference/errors](/reference/errors).

## Session events on the webhook bus

If you've configured a webhook endpoint, terminal session events fire on the bus:

- `session.completed` — session destroyed cleanly (customer-driven destroy, or the free-tier duration cap).
- `session.failed` — session terminated due to a runtime / driver error.
- `session.egress_capability_changed` — Arc 5 EGRESS eg.7.e — the session's egress capability state changed (e.g. proxy connectivity verified or lost). Lets subscribers react to capability transitions without polling.
- `session.challenge_detected` — W393 — the in-session harness flagged a bot-check (DataDome / Arkose / PerimeterX / AWS-WAF / GeeTest / …). The session auto-pauses; resolve the challenge (e.g. in the live view) and it resumes.
- `session.profile_save_failed` — a profile-backed session did not replace the stored profile at teardown. Failure reasons are terminal and the next restore will be stale; `superseded` is benign and means a newer saved profile won the conditional write.

Intermediate state transitions (e.g. a hypothetical `session.created`) are not on the bus today — the create + destroy round-trip is fast enough that polling `sessions.getState` covers in-flight needs. See the [webhook events catalog](/webhooks/events/) for full payload shapes and signature verification.

## Notes

- A destroyed session requires a fresh `sessions.create()`; sessions are not resumable after destroy. Plan your workflow to recreate cleanly when a long pause is expected.
- Session-level resource quotas (per-session bandwidth, memory) are not customer-facing today. Fleet-level enforcement runs internally; tier concurrent caps are the only customer-visible meter.

## Next steps

- **[Profile management](/guides/profile-management/)** — bind sessions to profiles for storage-state continuity.
- **[Webhook events](/webhooks/events/)** — react to session state transitions.
- **[API versioning](/api/versioning/)** — how additive lifecycle fields roll out.
