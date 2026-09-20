---
layout: ../../layouts/DocLayout.astro
title: Idempotency keys
description: Stripe-pattern Idempotency-Key header — safely retry POST requests without minting duplicates. Which endpoints honour it, scope semantics, lifetime, and best-practice generation.
---

# Idempotency keys

The POST requests listed below accept an optional `Idempotency-Key`
header. When set, the server or payment provider binds the
first operation to the account-scoped key and prevents a retry from performing
that operation twice. Depending on the endpoint, a completed request replays
the same response and a changed or still-running request fails closed. This is
the standard
[Stripe-pattern](https://stripe.com/docs/api/idempotent_requests)
that exists to make network retries safe.

## Why this exists

Network requests fail. Sometimes a `502` from the network means the
request never reached the server; sometimes it means the server
processed the request but the response was lost. Without an idempotency
key, retrying the request after the latter case would mint a duplicate
resource or repeat browser work (a second session, a second checkout, a second
form submission). With one, the retry returns the original outcome or an explicit
conflict that runs nothing, and no duplicate is created.

## Which endpoints honour it

The header is honoured on these endpoints:

- `POST /v1/agent-sessions` — agent (chat-style) session creation
- `POST /v1/agent-sessions/{id}/message` — one browser turn
- `POST /v1/billing/checkout-session` — Stripe subscription checkout
- `POST /v1/billing/crypto-checkout` — crypto checkout (NOWPayments invoice)

Every other endpoint — including `POST /v1/sessions`, the PATCH/DELETE
surface, the GET surface, and idempotent-by-design POSTs like
`/v1/auth/login` — ignores the header. Sending it is harmless but has no
dedupe effect; guard those calls separately if they need at-most-once behavior.

### One case where sending a key can fail a request that omitting it would not

`POST /v1/agent-sessions/{id}/message` stores its receipt encrypted, which
is not available on every deployment. Where it is not, that endpoint
answers a valid `Idempotency-Key` with `503 feature-unavailable` — _"We could
not safely record this request. Do not retry it without the same
Idempotency-Key. Contact support."_ — while the same request WITHOUT the header
runs the turn normally.

That is deliberate: a browser turn is expensive and side-effecting, and
the server would rather refuse than accept a key it cannot honour and let
you believe a retry is safe. It is worth knowing because it inverts the
usual advice — on that one endpoint, in that one deployment state, the
header is the reason the call fails. A `503` here means "your retry
protection is not available", not "the turn failed"; no turn ran.

## Format

The header value is a printable-ASCII string, 1–255 characters, with no
whitespace. The server trims surrounding whitespace, then stores and
matches the trimmed value exactly. A key longer than 255 characters, or
one containing whitespace or non-printable characters, is rejected with a
`400`.

An **empty or whitespace-only** header is treated as **absent**, not
rejected: the request is processed normally, without idempotency
protection and without an error. Send a real key or omit the header —
an empty one silently gives you neither deduplication nor a `400` to
tell you so. Recommended format:

```
Idempotency-Key: <UUID-v4 or other globally-unique identifier>
```

Stripe-pattern best practice: generate a new key per logical
operation (not per retry of the same operation). A client retrying
the same `POST /v1/agent-sessions` after a timeout should send the same
key on the retry; the next create gets a fresh key. For an agent message,
the key must stay attached to the exact same session, message, and ordered
approval list. Your BYOK key and the session's AI/manual mode are not part
of the key's identity — changing them does not change how a replay is
matched.

Constraints:

- Empty string is treated as **absent** (so a stray empty header from a
  proxy doesn't make every request look like the same operation).
- Scope is **per-account**, not global. Two different customers
  using the same idempotency-key string see independent results.

## Semantics

For create-style requests, the server/provider records the operation and a
duplicate key replays the original response. Agent message turns use a stronger
durable receipt because browser work deliberately continues after an SSE viewer
disconnects:

1. Session ownership and the request are validated, then the key is reserved
   before any work starts.
2. **Completed exact match** → the stored status and body are replayed.
3. **Different session, message, or approval list** → `409` with
   `idempotency_status: "mismatch"`; nothing runs.
4. **Still running or outcome unknown** → `409` with
   `idempotency_status: "in_progress"`; check the transcript rather than
   sending a new key and repeating the task.
5. **New key** → the turn runs once and its result is stored encrypted.

A completed replay returns the same status code and body as the original —
including generated IDs or a terminal RFC 7807 problem.
The client can treat the replay as if the original response had been
received successfully.

For an agent message turn, a refusal raised **before the turn did any work**
gives the key back instead of storing it: nothing ran, so there is nothing a
retry could repeat, and the same key runs the turn once the cause is gone.
These are the refusals that free their key:

| Status | `type`                         | The refusal                                                                                                                |
| -----: | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
|    409 | `conflict`                     | `turn_in_progress: true` — another message is still running on this session                                                |
|    429 | `rate-limited`                 | your account already has the most AI messages it may run at once, across your sessions or on Driftstack's included AI      |
|    402 | `bundled-llm-consent-required` | the account has not opted in to Driftstack's included AI                                                                   |
|    402 | `bundled-llm-budget-exhausted` | this month's included-AI budget is used up                                                                                 |
|    403 | `forbidden`                    | the plan does not include the included AI, or the session's model runs only on your own Anthropic key (`requires_own_key`) |
|    502 | `byok-anthropic-required`      | no Anthropic key was available for the turn — the case **without** `key_rejected: true`                                    |

Fix the cause or wait, then send the same request again with the **same** key.
While the first request is still being resolved you may get `409` with
`idempotency_status: "in_progress"`; that is safe to retry with the same key
too.

Every other answer is final for its key, and sending the same key again
replays it. That includes every completed turn, every failure after the turn
started, `502` `byok-anthropic-required` with `key_rejected: true` (Anthropic
refused your key on the first planning call), `500` `internal`, `200` with
`kind: "refuse"` (including "the AI is briefly unavailable"), and the `409`
for a session that is closed or paused (`session_status`) or whose control
changed (`ai_control_unavailable`). To send one of those again, fix the cause
and use a **new** key.

That completed result remains authoritative if the session later closes,
its mode changes between AI and manual, or your BYOK key rotates. Reusing
the same key after any of those changes replays the original result and never
starts another provider request or browser operation. A manual-mode turn
never reads the BYOK header. Use a new `Idempotency-Key` only for an
intentionally new AI turn with new browser work.

### What happens if I send the same key with a different body?

Do not do this. What happens depends on the surface:

- **Agent message turns** reject a changed request with `409` and
  `idempotency_status: "mismatch"`, without doing any browser work.
- **Crypto checkout** does **not** reject. It replays the original order
  verbatim with `Idempotent-Replayed: 1` and records the key reuse for support.
  So a changed body returns you the **first** order — not the one you just
  asked for. Check that header, or the returned `order_id`, before treating a
  checkout response as the order you requested.
- **Agent-session create** likewise replays the existing session.

Stripe also validates parameters on a reused checkout key. In every case, mint
a new key for a new logical operation.

### What happens during a concurrent retry?

Only one of the concurrent requests performs the operation. For an agent
turn, the first request wins; an overlapping retry receives `409 in_progress`
and does no browser work. Retry the same key after the original completes to
retrieve its result.

## Lifetime

Lifetime is endpoint-specific:

- **Crypto checkout** keys never expire: a same-key retry replays the
  original order no matter how much later it arrives.
- **Agent-session** keys replay for as long as the session exists.
- **Agent-message** keys replay for as long as the session and account exist.
- **Stripe checkout-session** keys are forwarded to Stripe and follow Stripe's
  own retention rules.

Practical upshot: never reuse an idempotency key for a NEW logical
request — mint a fresh UUID per logical operation. An exact retry with a reused
key returns the original cached response instead of creating a new
resource. For agent turns, keep the key until a final response is received;
after an `in_progress` conflict, check the transcript before deciding whether
a different task and fresh key are appropriate.

## Examples

### TypeScript

```ts
import { randomUUID } from 'node:crypto';

async function createAgentSessionWithRetry(
  apiKey: string,
  body: { token_budget: number },
): Promise<unknown> {
  const idempotencyKey = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://api.driftstack.dev/v1/agent-sessions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();
      if (res.status >= 500) throw new Error(`5xx, retrying: ${res.status.toString()}`);
      throw new Error(`non-retryable: ${res.status.toString()}`);
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
  throw new Error('unreachable');
}
```

Note: the same `idempotencyKey` is reused across all three attempts.
The first successful response (whether on attempt 1, 2, or 3) is the
only one the server records; subsequent successes are replays.

### curl

```bash
curl -X POST https://api.driftstack.dev/v1/agent-sessions \
  -H "authorization: Bearer ds_live_…" \
  -H "content-type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "mode": "ai", "token_budget": 100000 }'
```

## Common mistakes

- **Reusing one key across logically-distinct operations.** If your
  client uses the same key for two different POSTs (e.g. creating two
  separate sessions for the same customer), the second one returns
  the first's response. Generate a fresh key per logical operation.

- **Reusing one key across accounts.** Scope is per-account, so this
  is technically safe — but it confuses your debugging if two
  customers' requests end up with the same key in your logs.

- **Treating a replay as a no-op.** A replay returns the same body
  as the original, including the resource ID. If your client logic
  assumes "I just minted this resource, so the post-conditions hold,"
  a replay still satisfies that — the resource exists. If your client
  logic assumes "I just charged the customer," a replay does NOT
  re-charge them (it returns the original charge response).

- **Minting a new key after an agent-message timeout.** The server may still be
  finishing the original browser work. Reuse the original key. A completed
  turn replays; an `in_progress` turn refuses to run again.

## Notes

- Driftstack does not expire keys on a timer. How long each endpoint keeps a
  key is described under Lifetime above.
- Where an operation writes an audit-log entry, it is written for the first
  request but NOT the replays.
