---
layout: ../../layouts/DocLayout.astro
title: Idempotency keys
description: Stripe-pattern Idempotency-Key header — safely retry POST requests without minting duplicates. Which endpoints honour it, scope semantics, lifetime, and best-practice generation.
---

# Idempotency keys

The create-style POST requests that wire idempotency (agent sessions
and crypto-invoice orders) accept an optional `Idempotency-Key` header.
When set, the server stores the first response keyed by `(account_id,
idempotency_key)` and **replays the same response** on subsequent
requests with the same key — even if the operation is otherwise
non-idempotent. This is the standard
[Stripe-pattern](https://stripe.com/docs/api/idempotent_requests)
that exists to make network retries safe.

## Why this exists

Network requests fail. Sometimes a `502` from the edge means the
request never reached the server; sometimes it means the server
processed the request but the response was lost. Without an idempotency
key, retrying the request after the latter case would mint a duplicate
resource (a second session, a second checkout). With one, the retry
returns the original response and no duplicate is created.

## Which endpoints honour it

The header is honoured (stored-and-replayed) on the **create-style**
endpoints that wire it explicitly:

- `POST /v1/agent-sessions` — agent (chat-style) session creation
- `POST /v1/billing/crypto-checkout` — crypto checkout (NOWPayments invoice)

Every other endpoint — including `POST /v1/sessions`, the Stripe
checkout-session create, the PATCH/DELETE surface, the GET surface,
and idempotent-by-design POSTs like `/v1/auth/login` — accepts the
header but does not store or replay on it. Sending an `Idempotency-Key`
to one of those endpoints is harmless but has no effect; retries are
not collapsed, so guard those calls with your own dedupe if you need
exactly-once semantics.

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
key on the retry; the next time the customer creates an agent session, a
fresh key.

Constraints:

- Empty string is treated as **absent** (so a stray
  `Idempotency-Key:` header from an overeager proxy doesn't collapse
  every request to the same phantom-keyed row).
- Scope is **per-account**, not global. Two different customers
  using the same idempotency-key string see independent results.

## Semantics

When the server sees a POST with an `Idempotency-Key`:

1. Look up `(account_id, idempotency_key)` in the cache.
2. **Hit** → replay the original response status + body, byte-for-byte.
3. **Miss** → execute the operation as usual, then record the
   response keyed by `(account_id, idempotency_key)` before
   returning.

A replay returns the same status code (typically `201 Created`) and
the same body as the original — including any server-generated IDs.
The client can treat the replay as if the original response had been
received successfully.

### What happens if I send the same key with a different body?

The server **ignores the new body** and replays the cached response.
This matches Stripe's behaviour: the idempotency key is the
contract; if the customer wants a different result they need a
different key.

(This deliberately favours "duplicate-prevention is more important
than parameter-correctness." If you're worried about silently
returning an old response when your body changed, generate a new
key.)

### What happens during a concurrent retry?

Two requests with the same `(account_id, idempotency_key)` race the
underlying `INSERT` on the resource row. The unique constraint on
`idempotency_key` ensures exactly one wins; the loser sees the
constraint violation and replays the winner's cached response.

The window between "cache hit check" and "row insert" is the only
unsafe interval; the constraint check closes it. The customer never
sees a `409 Conflict` from this race — the loser falls through to a
clean replay.

## Lifetime

Idempotency-key records are retained **24 hours** by default. Retries
within the window return the cached response; retries after it are
treated as a fresh request (and may mint a duplicate resource if you
expected the key to still gate it).

The 24-hour window matches Stripe's policy and is documented per
endpoint in the OpenAPI spec.

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

- **Not retrying on idempotency-key 5xx.** A 5xx response on an
  idempotent POST is safe to retry — that's the whole point of the
  header. Don't skip retrying because "the server might have processed
  it"; if it did, the retry replays; if it didn't, the retry creates.

## Implementation notes

- **Storage.** Idempotency-key records live alongside the resource
  they protected (e.g. `agent_sessions.idempotency_key` is a
  partial-unique-indexed column on the table itself). There's no
  separate idempotency-key table — the resource row IS the cache.
- **TTL enforcement.** There is no scheduled key-expiry job. Behaviour
  differs by subsystem: crypto-order keys are held in an in-memory cache
  with a 24-hour TTL and pruned lazily — an entry is dropped the next
  time the cache is consulted after its cutoff, so a key stops replaying
  ~24h after first use. Resource-backed keys (e.g.
  `agent_sessions.idempotency_key`) have no TTL: the value lives in the
  partial-unique index for the lifetime of the row, so those keys replay
  for as long as the resource exists.
- **Replay observability.** Audit-log entries are written for the
  first request but NOT the replays. This intentionally mirrors
  Stripe — the original is the operationally-significant action; the
  replays are transport noise.
