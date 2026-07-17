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
- Any paid Driftstack tier, including Manual. Free is supported through the
  desktop app, whose browser sign-in automatically stores a restricted
  `ds_test_…` device credential; that credential is not a general SDK or
  sandbox key.
- A `ds_live_…` customer API key. Mint one at
  [app.driftstack.dev/api-keys](https://app.driftstack.dev/api-keys/);
  the plaintext is shown once on creation.

## 1. Install

```bash
npm install @driftstack/sdk
# or: pnpm add @driftstack/sdk
# or: yarn add @driftstack/sdk
```

The package is dual-published (ESM + CommonJS via conditional
`exports`) and ships full TypeScript types. Both `import` and
`require('@driftstack/sdk')` work out of the box.

## 2. Configure the client

```ts
import { Driftstack } from '@driftstack/sdk';

const client = new Driftstack({
  apiKey: process.env.DRIFTSTACK_API_KEY!,
  // Optional — defaults to https://api.driftstack.dev. Override
  // for staging or self-hosted deployments.
  // baseUrl: 'https://staging.driftstack.dev',
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

    // Capture screenshot or DOM. `kind` is required. The result is
    // { kind, data, encoding, byte_size, duration_ms } — for a screenshot
    // `data` is the PNG base64-encoded (decode with Buffer.from(data, 'base64')).
    const screenshot = await client.sessions.capture(session.id, {
      kind: 'screenshot',
    });
    console.log(`captured ${screenshot.byte_size} bytes (${screenshot.encoding})`);

    // Inspect runtime state without modifying it.
    const state = await client.sessions.getState(session.id);
    console.log('url:', state.url, 'title:', state.title);
  } finally {
    // Always destroy — the concurrent slot stays held until you do.
    // There is no idle timeout on any tier; the only auto-destroy is
    // the free tier's 20-minute duration cap.
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
      // Tier usage quota reached (not the concurrency cap — that is
      // /concurrency-limit). Wait + retry, or upgrade tier.
      console.error('cap reached:', err.detail);
    } else if (err.status === 403 && err.detail?.includes('apiAccess') === true) {
      // Customer API access is paused while the account is Free. Upgrade to
      // resume this key unless it was separately revoked or expired.
      console.error(err.detail);
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
  secret: process.env.DRIFTSTACK_WEBHOOK_SECRET!,
});
if (!ok) return res.status(401).send('invalid signature');
```

During the 24h signing-secret rotation grace window the single
`x-driftstack-signature` header carries both the new and old HMACs
as two `v1=` entries (`t=…,v1=<new>,v1=<old>`) — see
[`/webhooks/endpoints`](/webhooks/endpoints/) for the rotate-secret
endpoint. `verifyWebhookSignature` already checks every `v1=` entry
in that header, so the call above keeps verifying through a rotation
with no extra arguments and your verifier won't drop deliveries.

## Pair-mode takeover (interactive AI sessions)

For sessions where a human needs to step in mid-flight, the SDK
exposes pair-mode helpers that drive the same takeover state
machine the dashboard uses.

```ts
// Create or upgrade a session into pair mode.
const session = await client.agentSessions.create({ mode: 'pair' });
// OR: switch an existing AI session into pair mode at any time.
await client.agentSessions.setMode(session.id, 'pair');

// Driver code keeps running. When the human is ready to take over,
// the first input-event from the dashboard automatically fires the
// takeover-request transition — no explicit /takeover call needed:
await client.agentSessions.sendInputEvent(
  session.id,
  // Touch is the iPhone-native input (preferred over the mouse variants).
  { type: 'tap', x: 200, y: 430 },
  { clientId: 'dashboard-tab-a' },
);
// Response is a discriminated union — branch on `kind`:
//   - 'pair-mode-takeover-fired' → pair_mode_state populated
//   - 'forwarded' → duration_ms populated (after takeover-grant)

// Programmatic takeover from your own code (e.g. an ops dashboard)
// is identical to the explicit POST /:id/takeover call:
const after = await client.agentSessions.takeover(session.id, 'cli-bot');
console.log(after.pair_mode_state.kind); // takeover-pending

// Hand control back to the AI driver when the human is done:
const back = await client.agentSessions.handback(session.id);
console.log(back.pair_mode_state.kind); // handback-pending
```

The state machine kinds you'll see: `ai-driving`,
`takeover-pending`, `takeover-queued` (when the runtime is
mid-decompose), `human-driving`, `handback-pending`,
`handback-queued`. The dashboard polls `agent-sessions/:id` to
display the current kind.

### Modifier vocabulary

`keyDown` / `keyUp` events accept a `modifiers` array. Use the
canonical 4-name set — these map 1:1 onto Quartz `CGEventFlags`
on the macOS harness side:

```ts
await client.agentSessions.sendInputEvent(
  session.id,
  { type: 'keyDown', key: 'k', modifiers: ['cmd', 'shift'] },
  { clientId: 'dashboard-tab-a' },
);
```

DOM-standard names (`Shift / Control / Alt / Meta`) round-trip
through the schema unchanged but the harness decoder drops them.
The TS SDK re-exports `CANONICAL_MODIFIER_NAMES` from
`@driftstack/api-types` if you want to reference it from your code.

## Next steps

- [Session lifecycle reference](/guides/session-lifecycle/) — states,
  the free-tier 20-minute duration cap, reconnect semantics.
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
