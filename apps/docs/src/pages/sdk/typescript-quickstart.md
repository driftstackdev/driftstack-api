---
layout: ../../layouts/DocLayout.astro
title: TypeScript / Node.js quickstart
description: 5-minute getting-started for the @driftstack/sdk TypeScript client. Install, auth, first session, error handling, and next steps.
---

# TypeScript quickstart

— laser-focused 5-minute path to a working TypeScript Driftstack
session. For the multi-language overview see the [combined quickstart](/quickstart/).

## Prerequisites

- Node.js 18+ (Node 22 LTS recommended; the SDK declares
  `engines.node: ">=18"` and is built / tested against the same
  toolchain Driftstack runs in production).
- A Driftstack API key. Mint one at
  [app.driftstack.dev/api-keys](https://app.driftstack.dev/api-keys);
  the plaintext is shown once on creation.

## 1. Install

```bash
npm install @driftstack/sdk
# or: pnpm add @driftstack/sdk
# or: yarn add @driftstack/sdk
```

The package is ESM-only and ships full TypeScript types. CommonJS
consumers that can't migrate need to use dynamic `import()`.

## 2. Configure the client

```ts
import { Driftstack } from '@driftstack/sdk';

const client = new Driftstack({
  apiKey: process.env.DRIFTSTACK_API_KEY!,
  // Optional — defaults to https://api.driftstack.dev. Override
  // for staging or self-hosted deployments.
  // baseUrl: 'https://api-staging.driftstack.dev',
});
```

The constructor doesn't make any network calls. Authentication is
deferred to the first request; an invalid key returns 401 on first
use, not on construction.

## 3. Run a session

```ts
async function main() {
  // Reserve a concurrent slot.
  const session = await client.sessions.create({ label: 'demo' });

  try {
    // Navigate the iPhone Safari runtime.
    await client.sessions.navigate(session.id, {
      url: 'https://example.com',
    });

    // Capture screenshot or DOM. `kind` is required.
    const screenshot = await client.sessions.capture(session.id, {
      kind: 'screenshot',
    });
    console.log('captured', screenshot.id);

    // Inspect runtime state without modifying it.
    const state = await client.sessions.getState(session.id);
    console.log('url:', state.url, 'title:', state.title);
  } finally {
    // Always destroy — concurrent slot stays held until you do or
    // the per-tier idle timeout fires.
    await client.sessions.destroy(session.id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## 4. Error handling

The SDK surfaces server-shape errors as typed exceptions. Match on
`err.status` for HTTP semantics or `err.type` for the RFC 9457
Problem Details URL:

```ts
import { DriftstackError } from '@driftstack/sdk';

try {
  await client.sessions.create({ label: 'demo' });
} catch (err) {
  if (err instanceof DriftstackError) {
    if (err.status === 429 && err.type.endsWith('/tier-limit')) {
      // Concurrent-session cap exceeded. Wait + retry, or upgrade tier.
      console.error('cap reached:', err.detail);
    } else if (err.status === 401) {
      console.error('bad API key');
    } else {
      console.error('driftstack error:', err.type, err.detail);
    }
  } else {
    throw err;
  }
}
```

Errors also carry typed `kind` (`'rate_limited'`, `'tier_limit'`, …)
and `extensions` (e.g. `RateLimitError.retryAfterSeconds`) for
fine-grained switching without string parsing.

## 5. Webhooks (optional)

Verify webhook signatures from the same SDK:

```ts
import { verifyWebhookSignature } from '@driftstack/sdk';

const ok = await verifyWebhookSignature({
  body: rawRequestBody,
  header: req.headers['x-driftstack-signature'] as string,
  headerPrev: req.headers['x-driftstack-signature-prev'] as string | undefined,
  secret: process.env.DRIFTSTACK_WEBHOOK_SECRET!,
});
if (!ok) return res.status(401).send('invalid signature');
```

`headerPrev` is set by the API during the 24h signing-secret
rotation grace window — see
[`/webhooks/endpoints`](/webhooks/endpoints/) for the rotate-secret
endpoint. Accept either header during the overlap and your verifier
won't drop deliveries.

## Next steps

- [Session lifecycle reference](/guides/session-lifecycle/) — states,
  idle timeouts, reconnect semantics.
- [Profile management](/guides/profile-management/) — persistent
  identity slots that survive across sessions.
- [Agent sessions](/api/agent-sessions/) — natural-language
  decompose-and-execute on top of the regular driver surface;
  AI / manual / pair modes, live SSE transcript stream, and the
  LiveKit-based live video subscription (auto-populated `livekit`
  field on session-create, or re-mint via
  `client.agentSessions.livekitToken(id)` after the 24h token TTL).
- [Bundled LLM](/api/bundled-llm/) and
  [BYOK Anthropic](/api/byok-anthropic/) — the two LLM rails
  agent sessions can use; bring your own key OR consent to the
  deployment-fallback budget.
- [Idempotency keys](/reference/idempotency/) — `Idempotency-Key`
  header on create-style POSTs makes retries safe.
- [Webhook event catalog](/webhooks/events/) — every event the
  platform can push.
- [Error catalogue](/sdk/error-handling/) — every problem-type
  you might see and how to react.
- [API versioning](/api/versioning/) — what's additive vs. major.

Stuck? Email
[support@driftstack.dev](mailto:support@driftstack.dev) with your
account id (`acc_…`) and the failing `x-request-id`.
