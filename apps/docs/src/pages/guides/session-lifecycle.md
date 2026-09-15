---
layout: ../../layouts/DocLayout.astro
title: Session lifecycle
description: The full lifecycle of a Driftstack session — create, drive, capture, destroy, and how concurrency and duration caps shape the boundaries.
---

# Session lifecycle

A **session** is one running iPhone Safari browser. Every session occupies one of your account's concurrent slots from creation until destruction; understanding the lifecycle is the difference between using your tier's capacity well and burning slots on stuck sessions.

## States

The `session.status` field has five values: `creating` / `ready` / `busy` / `destroyed` / `errored`.

```
              create
                │
                ▼
            ┌──────────┐  (transient — the browser            ┌───────┐
            │ creating │───────────────────────────────────▶  │ ready │
            └──────────┘   is being started)                  └───────┘
                                                                  │  ▲
                                              navigate / interact │  │ call finishes
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
                                                            (or `errored` if the browser fails)
```

`sessions.create()` returns only once the session is `ready`, although a list or read made at the same time can still show it as `creating`. Each driving call (navigate, interact, wait, capture) moves the session from `ready` to `busy`; while it is `creating` or `busy`, any other call returns `409 Conflict`. When the call succeeds the session goes back to `ready`. If the browser fails, the session becomes `errored`; if you destroy the session mid-call, it becomes `destroyed` and the interrupted call returns `410 Gone`.

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
| Enterprise  | 32                  |

Enterprise's 32 is a contract floor — per-account overrides raise it
further, and until one is applied the cap behaves like every other tier's.

Concurrent caps are the only metering on paid tiers — there are no hour caps and no overage charges. Run sessions for as long as your workflow needs within your concurrent cap.

Pricing source of truth: [driftstack.io/pricing](https://driftstack.io/pricing/).

## Create

```ts
const session = await client.sessions.create({
  label: 'checkout flow',
  // archetype: optional override of your tier's default device
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

**`POST /v1/sessions/:id/interact`** — tap, scroll, type, or press keys on the page.

**`POST /v1/sessions/:id/wait`** — block until a selector appears, a URL pattern is reached, or a timeout elapses.

**`GET /v1/sessions/:id/state`** — live page introspection: current `url`, `title`, cookies + `local_storage`, and a `captured_at` timestamp. This call runs in the live browser session and marks it `busy` while it captures, so poll it sparingly and only while the session is `ready` (a call made while the session is `busy` returns `409`); to check `creating` / `busy` without tying up the session, use `GET /v1/sessions/:id` or the list endpoint instead. When acting as a team owner, state requires the `admin` role because it returns browser secrets such as cookies and local storage; a `member` can still read list/detail metadata but gets `403` for state, and the session is left untouched. Self-account `read:sessions` access is unchanged.

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

Paid-tier sessions are never auto-destroyed — a forgotten session holds its concurrent slot until you destroy it, which is why the `try / finally` pattern above matters. On the free tier, a session is capped at 20 minutes of wall-clock time; when the cap is reached Driftstack destroys it for you. There is no idle timeout on any tier.

## Error shapes

Every error returned by the session endpoints conforms to the [problem+json shape](/api/) with a `type` URL identifying the error class:

- `429 Too Many Requests` (`https://errors.driftstack.dev/rate-limited`) — global / per-bucket rate limit exceeded. `Retry-After` carries the wait time.
- `429 Too Many Requests` (`https://errors.driftstack.dev/concurrency-limit`) — concurrent-session cap reached. Wait for an active session to finish.
- `429 Too Many Requests` (`https://errors.driftstack.dev/tier-limit`) — a tier-derived cap (e.g. profile count) is reached.
- `404 Not Found` — session ID doesn't exist (or was destroyed and has since been cleaned up).
- `409 Conflict` — the session is still `creating`, or another operation is already running (`busy`); retry once it reports `ready`.
- `410 Gone` (`https://errors.driftstack.dev/session-destroyed`) — the session is `destroyed` or `errored`, or this operation lost a race to destroy; create a fresh session.
- `502 Bad Gateway` / `503 Service Unavailable` — the browser session hit an error, or the requested feature is not available (`driver-error` / `driver-not-integrated` / `feature-unavailable`).

The SDKs map these to typed error classes — catch `RateLimitError`, `ConcurrencyLimitError`, the tier-limit class (`TierLimitError` in TypeScript, `QuotaExceededError` in Python and Go), `SessionDestroyedError`, `DriverError`, etc. The full mapping lives at [/reference/errors](/reference/errors/).

## Session events on the webhook bus

If you've configured a webhook endpoint, terminal session events fire on the bus:

- `session.completed` — one per logical destroy of a non-terminal session: a customer-driven destroy, the free-tier duration cap, or an account suspension reclaiming its live sessions. The last two also send `auto_destroyed: true` and a `reason`; branch on `auto_destroyed` if you attribute completions.
- `session.failed` — the session ended because of an unrecoverable error (for example, a timeout or a crash during a page action). Create a new session to continue.
- `session.egress_capability_changed` — the session reported its proxy capabilities. It fires on **every** report, not only when the state changed: there is no change detection, so identical consecutive reports each emit an event with a fresh `event_id`. Treat it as "here is the current capability state" and compare against what you last stored, rather than as a transition signal. Note also that `warnings` carries video-stream faults (`streaming_blank`, `streaming_failed`) alongside proxy ones like `dead_proxy`, so this event can fire when only the video stream degraded.
- `session.challenge_detected` — the session detected a bot-check (DataDome / Arkose / PerimeterX / AWS-WAF / GeeTest / …). The session auto-pauses; resolve the challenge (e.g. in the live view) and it resumes.
- `session.profile_save_failed` — a profile-backed session did not replace the stored profile at teardown. Failure reasons are terminal and the next restore will be stale; `superseded` is harmless and means a newer save of the same profile landed first.

Intermediate state transitions (e.g. a hypothetical `session.created`) are not on the bus today. Read the session resource or list endpoint for persisted lifecycle status; do not poll `sessions.getState` while the session is `busy` with another operation. See the [webhook events catalog](/webhooks/events/) for full payload shapes and signature verification.

## Notes

- A destroyed session requires a fresh `sessions.create()`; sessions are not resumable after destroy. Plan your workflow to recreate cleanly when a long pause is expected.
- A session left in `busy` after a server crash is not reset automatically: the operation that was running may already have changed the page, and repeating it could duplicate that work. Destroy the session and create a fresh one.
- There are no per-session bandwidth or memory limits for you to manage today. The limit that governs sessions is your tier's concurrent-session cap (rate limits and profile caps are separate — see Error shapes above).

## Next steps

- **[Profile management](/guides/profile-management/)** — bind sessions to profiles for storage-state continuity.
- **[Webhook events](/webhooks/events/)** — react to session state transitions.
- **[API versioning](/api/versioning/)** — how additive lifecycle fields roll out.
