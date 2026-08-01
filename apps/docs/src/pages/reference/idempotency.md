---
layout: ../../layouts/DocLayout.astro
title: Idempotency keys
description: Stripe-pattern Idempotency-Key header — safely retry POST requests without minting duplicates. Which endpoints honour it, scope semantics, lifetime, and best-practice generation.
---

# Idempotency keys

The non-idempotent POST requests that wire idempotency accept an optional
`Idempotency-Key` header. When set, the server or payment provider binds the
first operation to the account-scoped key and prevents a retry from performing
that operation twice. Depending on the endpoint, a completed request replays
the same response and a changed or still-running request fails closed. This is
the standard
[Stripe-pattern](https://stripe.com/docs/api/idempotent_requests)
that exists to make network retries safe.

## Why this exists

Network requests fail. Sometimes a `502` from the edge means the
request never reached the server; sometimes it means the server
processed the request but the response was lost. Without an idempotency
key, retrying the request after the latter case would mint a duplicate
resource or repeat browser work (a second session, a second checkout, a second
form submission). With one, the retry returns the original terminal outcome or
an explicit non-dispatching conflict and no duplicate is created.

## Which endpoints honour it

The header is honoured on these explicitly wired endpoints:

- `POST /v1/agent-sessions` — agent (chat-style) session creation
- `POST /v1/agent-sessions/{id}/message` — one decompose→execute browser turn
- `POST /v1/billing/checkout-session` — Stripe subscription checkout
- `POST /v1/billing/crypto-checkout` — crypto checkout (NOWPayments invoice)

Every other endpoint — including `POST /v1/sessions`, the PATCH/DELETE
surface, the GET surface, and idempotent-by-design POSTs like
`/v1/auth/login` — ignores the header. Sending it is harmless but has no
dedupe effect; guard those calls separately if they need at-most-once behavior.

## Format

The header value is a printable-ASCII string, 1–255 characters, with no
whitespace. The server trims surrounding whitespace, then stores and
matches the trimmed value exactly; a key that is empty, longer than 255
characters, or contains whitespace or non-printable characters is
rejected with a `400`. Recommended format:

```
Idempotency-Key: <UUID-v4 or other globally-unique identifier>
```

Stripe-pattern best practice: generate a new key per logical
operation (not per retry of the same operation). A client retrying
the same `POST /v1/agent-sessions` after a timeout should send the same
key on the retry; the next create gets a fresh key. For an agent message,
the key must stay attached to the exact same session, message, and ordered
approval list. The explicit BYOK credential and admitted AI/manual control
lane are deliberately outside receipt identity: they are execution inputs
read only after the receipt and control-authority fences.

Constraints:

- Empty string is treated as **absent** (so a stray
  `Idempotency-Key:` header from an overeager proxy doesn't collapse
  every request to the same phantom-keyed row).
- Scope is **per-account**, not global. Two different customers
  using the same idempotency-key string see independent results.

## Semantics

For create-style requests, the server/provider records the operation and a
duplicate key replays the original response. Agent message turns use a stronger
durable receipt because browser work deliberately continues after an SSE viewer
disconnects:

1. Validate session ownership and the request, then atomically reserve
   `(account_id, idempotency_key)` before decomposition or dispatch.
2. **Completed exact match** → replay the stored terminal status and JSON body.
3. **Different session, message, or approval list** → return `409` without
   dispatch.
4. **Still running or terminal outcome unknown** → return `409` with
   `idempotency_status: "in_progress"`; inspect the durable transcript rather
   than minting a new key and repeating the task.
5. **New key** → run once and application-encrypt the terminal response before
   marking the receipt completed.

A completed replay returns the same status code and body as the original —
including generated IDs or a terminal RFC 7807 problem.
The client can treat the replay as if the original response had been
received successfully.

That completed terminal remains authoritative if the session later closes,
its control lane changes between AI and manual, or the explicit BYOK
credential rotates. Reusing the same key after any of those changes replays
the original terminal result and never starts another provider request or
browser operation. A manual transcript turn never reads or hashes an
irrelevant BYOK header. Use a new `Idempotency-Key` only for an intentionally
new AI turn with new browser work.

### What happens if I send the same key with a different body?

Do not do this. What happens depends on the surface:

- **Agent message turns** reject a changed request with `409` and
  `idempotency_status: "mismatch"`, without dispatching browser work.
- **Crypto checkout** does **not** reject. It replays the original order
  verbatim with `Idempotent-Replayed: 1` and records the key reuse for support.
  So a changed body returns you the **first** order — not the one you just
  asked for. Check that header, or the returned `order_id`, before treating a
  checkout response as the order you requested.
- **The legacy agent-session create path** likewise replays the existing
  session.

Stripe also validates parameters on a reused checkout key. In every case, mint
a new key for a new logical operation.

### What happens during a concurrent retry?

Database uniqueness/provider idempotency chooses one create operation. For an
agent turn, the first request owns the durable reservation; an overlapping
retry receives `409 in_progress` and never enters the browser runtime. Retry the
same key after the original completes to retrieve its terminal result.

## Lifetime

Lifetime is endpoint-specific:

- **Crypto checkout** keys are enforced by a permanent unique
  index on the orders table (`INSERT … ON CONFLICT DO NOTHING`,
  then select-and-replay), so a same-key retry replays the
  original order no matter how much later it arrives. A 24-hour
  in-memory cache exists purely as a same-process fast-path; the
  database is the cross-instance source of truth.
- **Agent-session** keys live in a partial unique index on the
  session row and replay for as long as the row exists.
- **Agent-message** receipts live in their own durable table and are deleted
  only if the owning account/session row is deleted.
- **Stripe checkout-session** keys are forwarded to Stripe and follow Stripe's
  provider-side retention rather than Driftstack's resource-row lifetime.

Practical upshot: never reuse an idempotency key for a NEW logical
request — mint a fresh UUID per logical operation. An exact retry with a reused
key returns the original cached response instead of creating a new
resource. For agent turns, keep the key until a terminal response is received;
after an `in_progress` conflict, inspect the transcript before deciding whether
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
  receipt replays; an `in_progress` receipt refuses to dispatch again.

## Implementation notes

- **Storage.** Create receipts generally live alongside the protected resource.
  Agent-message terminal bodies instead use a dedicated receipt table and are
  application-encrypted because they can contain customer/model transcript data.
- **TTL enforcement.** There is no scheduled key-expiry job and no
  effective TTL. Crypto-order keys are backed by a permanent unique
  index on the order row — the 24-hour in-memory cache is only a
  same-process fast-path, and after a restart (or on another
  instance) the database still replays the key. Resource-backed
  keys (e.g. `agent_sessions.idempotency_key`) live in the
  partial-unique index for the lifetime of the row. Agent-message receipts
  follow their owning session row. Stripe checkout is provider-managed.
- **Replay observability.** Where an operation writes an audit-log entry, it is
  written for the first request but NOT the replays. This intentionally mirrors
  Stripe — the original is the operationally-significant action; the replays
  are transport noise.
