---
layout: ../layouts/DocLayout.astro
title: Quickstart
description: From signup to your first iPhone Safari session in about five minutes — working examples in TypeScript, Python, or Go.
---

# Quickstart

This guide takes you from a fresh signup to your first iPhone Safari session. Allow about five minutes. A session is a phone browser running in Driftstack's cloud — your code tells it where to go and what to do, and it reports back what it sees.

You will need:

- A Driftstack account ([sign up](https://app.driftstack.dev/signup/) or [sign in](https://app.driftstack.dev/login/))
- An API key (created in the dashboard under **API keys**)
- Node.js 18+, Python 3.10+, or Go 1.22+

## 1. Get an API key

After signing up and verifying your email:

1. Open [app.driftstack.dev/api-keys](https://app.driftstack.dev/api-keys/).
2. Click **Create key**, give it a name (e.g. `quickstart`), and copy the value. The key is shown once.
3. Export it in your shell:

```bash
export DRIFTSTACK_API_KEY="ds_live_…"
```

API keys are scoped to the account that created them. Paid-tier keys carry the `ds_live_` prefix; free-tier accounts get `ds_test_` keys (same shape, test environment) — upgrade and mint a new key when you want production traffic.

## 2. Install the SDK

Pick the language you want to use. See [SDK installation](/sdk/installation/) for full details.

**TypeScript / Node.js:**

```bash
npm install @driftstack/sdk
```

**Python:**

```bash
pip install driftstack-sdk
```

**Go:**

```bash
go get github.com/driftstackdev/driftstack-api/packages/sdk-go
```

> The TypeScript SDK is published on npm today. The Python and Go SDKs are alpha and may install from a checkout until the first registry tag.

## 3. Run your first session

This snippet creates a session, navigates to a URL, captures a screenshot, and tears the session down.

**TypeScript:**

```ts
import { Driftstack } from '@driftstack/sdk';

const client = new Driftstack({ apiKey: process.env.DRIFTSTACK_API_KEY! });

const session = await client.sessions.create({ label: 'quickstart' });
await client.sessions.navigate(session.id, { url: 'https://example.com' });
const shot = await client.sessions.capture(session.id, { kind: 'screenshot' });
console.log('captured:', shot);
await client.sessions.destroy(session.id);
```

**Python (sync):**

```python
import os
from driftstack import Driftstack

with Driftstack(api_key=os.environ["DRIFTSTACK_API_KEY"]) as client:
    session = client.sessions.create({"label": "quickstart"})
    client.sessions.navigate(str(session.id), {"url": "https://example.com"})
    shot = client.sessions.capture(str(session.id), {"kind": "screenshot"})
    print("captured:", shot)
    client.sessions.destroy(str(session.id))
```

**Go:**

```go
package main

import (
    "context"
    "log"
    "os"

    driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

func main() {
    client := driftstack.New(os.Getenv("DRIFTSTACK_API_KEY"))
    defer client.Close()

    ctx := context.Background()
    session, err := client.Sessions.Create(ctx, &driftstack.CreateSessionRequest{Label: "quickstart"})
    if err != nil { log.Fatal(err) }

    if _, err := client.Sessions.Navigate(ctx, session.ID, &driftstack.NavigateRequest{URL: "https://example.com"}); err != nil {
        log.Fatal(err)
    }
    if _, err := client.Sessions.Capture(ctx, session.ID, &driftstack.CaptureRequest{Kind: "screenshot"}); err != nil {
        log.Fatal(err)
    }
    if err := client.Sessions.Destroy(ctx, session.ID); err != nil {
        log.Fatal(err)
    }
}
```

## 4. What happened

- `client.sessions.create()` reserved one of your account's concurrent session slots. Each tier has a concurrent cap (Free: 1, API Starter: 2, API Builder: 8, API Scale: 24 — see [pricing](https://driftstack.dev/pricing/)). Exceeding the cap returns 429.
- `client.sessions.navigate()` drove the iPhone Safari runtime to the URL on Driftstack's WebKit build. The runtime is built from Apple's WebKit source directly — not a Chromium-stealth shim pretending to be Safari.
- `client.sessions.capture()` returned a `{ kind, data, encoding, byte_size, duration_ms }` object. For a screenshot, `data` is the PNG **base64-encoded** (`encoding: "base64"`), so decode it to bytes before saving — e.g. `fs.writeFileSync('shot.png', Buffer.from(shot.data, 'base64'))`. A `dom_snapshot` capture instead returns the raw HTML as UTF-8 text (`encoding: "utf8"`).
- `client.sessions.destroy()` released the concurrent slot. Only free-tier sessions stop on their own (at the 20-minute cap) — on paid tiers a forgotten session holds its slot until you destroy it.

## 5. Next steps

- **[Profile management](/guides/profile-management/)** — persistent profiles let a session resume cookies, storage, and trust signals across runs.
- **[Session lifecycle](/guides/session-lifecycle/)** — full lifecycle reference (states, the free-tier 20-minute duration cap, recovery on reconnect).
- **[Agent sessions](/api/agent-sessions/)** — natural-language decompose-and-execute on top of any driver session. Three operational modes: AI (default), manual (pass-through), pair (interactive takeover state machine). Live transcript stream via Server-Sent Events.
- **[Bundled LLM](/api/bundled-llm/)** and **[BYOK Anthropic](/api/byok-anthropic/)** — the two LLM rails agent sessions can use. BYOK encrypts your Anthropic key at rest + decrypts in-memory only at execution; the bundled rail uses a deployment-managed budget for accounts that don't want to manage their own key.
- **[Idempotency keys](/reference/idempotency/)** — send an `Idempotency-Key` header on create-style POSTs so a network retry replays the original response instead of minting a duplicate session.
- **[Webhook event catalog](/webhooks/events/)** — push notifications when sessions transition state, billing events fire, etc.
- **[API versioning policy](/api/versioning/)** — what changes are additive, what triggers `/v2/*`, deprecation cycles.

Stuck? Email [support@driftstack.dev](mailto:support@driftstack.dev). Include your account ID (`acc_…`) + the request ID from any error response (returned in the `x-request-id` header) so we can trace it.
