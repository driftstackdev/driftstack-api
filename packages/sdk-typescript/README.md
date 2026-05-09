# @driftstack/sdk

Official TypeScript SDK for the [Driftstack](https://driftstack.dev) API.

> **Status:** pre-1.0. Stable surface for the API contract; the SDK API may shift before 1.0. Don't pin against an exact version yet.

## Install

```bash
npm install @driftstack/sdk
# or
pnpm add @driftstack/sdk
# or
yarn add @driftstack/sdk
```

Requires Node.js ≥ 18 (uses native `fetch`). Works in any modern runtime that exposes `fetch` and `node:crypto`.

## Quickstart

```ts
import { Driftstack } from '@driftstack/sdk';

const client = new Driftstack({ apiKey: process.env.DRIFTSTACK_API_KEY! });

const session = await client.sessions.create({ label: 'login flow' });
await client.sessions.navigate(session.id, { url: 'https://example.com' });
const screenshot = await client.sessions.capture(session.id, { kind: 'screenshot' });
await client.sessions.destroy(session.id);
```

## Configuration

```ts
new Driftstack({
  apiKey: 'ds_live_…', // required
  baseUrl: 'https://api.driftstack.dev', // optional override
  timeoutMs: 30_000, // per-request timeout
  retry: {
    // retry policy (defaults shown)
    maxAttempts: 3,
    initialDelayMs: 250,
    maxDelayMs: 8_000,
  },
});
```

## Resources

```ts
client.sessions.create(body?)
client.sessions.list(query?)
client.sessions.navigate(id, body)
client.sessions.interact(id, body)
client.sessions.wait(id, body)
client.sessions.getState(id)
client.sessions.capture(id, body)
client.sessions.destroy(id)

client.profiles.create(body)
client.profiles.list(query?)
client.profiles.iterate(opts?)
client.profiles.get(id)
client.profiles.update(id, body)
client.profiles.delete(id)
client.profiles.clone(id, body?)        // V-313 — auto-derives "(copy)" name when omitted

client.profileSnapshots.capture(profileId, body)            // V-312 — immutable point-in-time copy
client.profileSnapshots.listForProfile(profileId, query?)
client.profileSnapshots.list(query?)                        // cross-account
client.profileSnapshots.iterate(opts?)
client.profileSnapshots.get(id)
client.profileSnapshots.restore(id, body)                   // creates a NEW profile
client.profileSnapshots.delete(id)

client.apiKeys.create(body)             // requires admin scope
client.apiKeys.list()
client.apiKeys.rotate(id, options?)     // V-296 — 24h grace, plaintext shown once
client.apiKeys.revoke(id)               // requires admin scope

client.webhooks.create(body)            // requires admin scope
client.webhooks.list()
client.webhooks.get(id)
client.webhooks.delete(id)
client.webhooks.listDeliveries(id, query?)
client.webhooks.iterateDeliveries(id, opts?)
client.webhooks.replayDelivery(id)      // V-307 — re-fire a failed/DLQ delivery

client.team.invite(email, options?)     // V-298 — invite by email
client.team.listMembers()
client.team.listInvites()
client.team.acceptInvite(token)
client.team.removeMember(membershipId)

client.account.me()                     // calling account's full state

client.billing.getState()
client.billing.startCheckout(body)
client.billing.startTrialPack(body)
client.billing.startPortalSession()

client.auth.signup(body)
client.auth.verifyEmail(body)
client.auth.login(body)                 // V-353d — returns LoginResponse OR LoginMfaRequiredResponse
client.auth.refresh(body)
client.auth.logout(body)
client.auth.requestMagicLink(body)
client.auth.consumeMagicLink(body)
client.auth.requestPasswordReset(body)
client.auth.confirmPasswordReset(body)

client.usage.current()
```

Every method is fully typed against the public OpenAPI 3.1 contract sourced from `@driftstack/api-types`. Hover anywhere in your editor to see the request and response shapes.

## Errors

Every error thrown by the SDK extends `DriftstackError`. Catch the base class to handle anything, or specific subclasses for granular logic:

```ts
import {
  Driftstack,
  RateLimitError,
  ConcurrencyLimitError,
  ValidationError,
  DriftstackError,
} from '@driftstack/sdk';

try {
  const session = await client.sessions.create();
  // ...
} catch (err) {
  if (err instanceof RateLimitError) {
    console.warn(`Rate limited; retry after ${err.retryAfterSeconds}s`);
  } else if (err instanceof ConcurrencyLimitError) {
    console.warn(`At ${err.currentSessions}/${err.limit} concurrent sessions`);
  } else if (err instanceof ValidationError) {
    console.error('Validation failed:', err.issues);
  } else if (err instanceof DriftstackError) {
    console.error(`API error ${err.status}: ${err.title}`, err.detail);
  } else {
    throw err;
  }
}
```

## Retry behaviour

By default the SDK retries automatically on:

- network failures (`TransportError`)
- 5xx server errors
- 429 rate-limit responses (honours `Retry-After` header / `retry_after_seconds` body field)

It does **not** retry 4xx responses other than 429. Backoff is exponential with full jitter, capped at `maxDelayMs`. Set `retry: { maxAttempts: 0 }` to disable retries entirely.

## Webhook signature verification

When you wire up Driftstack webhooks, verify each delivery before processing:

```ts
import { verifyWebhookSignature } from '@driftstack/sdk';

app.post('/driftstack-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const ok = await verifyWebhookSignature({
    body: req.body, // raw bytes — DO NOT use a parsed body
    header: req.headers['x-driftstack-signature'],
    secret: process.env.DRIFTSTACK_WEBHOOK_SECRET!,
  });
  if (!ok) return res.status(401).end();
  // ... process the event ...
  res.status(204).end();
});
```

The verifier uses HMAC-SHA256 with constant-time comparison and rejects timestamps older than 5 minutes (configurable via `toleranceSec`). It's browser-isomorphic — `verifyWebhookSignature` works the same way in Node 20+, every modern browser, Tauri WebViews, Cloudflare Workers, Deno, and Bun (uses Web Crypto API under the hood, hence the `await`).

## Examples

See [`examples/`](./examples/) for complete runnable demos:

- `quickstart.ts` — happiest path, end-to-end
- `error-handling.ts` — every documented error class
- `rate-limit-handling.ts` — explicit retry-after honouring on top of the built-in retry

## License

MIT
