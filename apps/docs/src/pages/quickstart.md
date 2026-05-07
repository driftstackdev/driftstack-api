---
layout: ../layouts/DocLayout.astro
title: Quickstart
description: Get from signup to your first Driftstack session in under five minutes — TypeScript, Python, or Go.
---

# Quickstart

> **Draft — founder review pending.** Endpoints and code samples are verified against shipped routes; copy is the first pass and may shift before launch.

This guide takes you from a fresh signup to your first iPhone Safari session. Allow about five minutes. You will need:

- A Driftstack account (sign up at [app.driftstack.dev](https://app.driftstack.dev))
- An API key (created in the dashboard under **API keys**)
- Node.js 18+, Python 3.10+, or Go 1.21+

## 1. Get an API key

After signing up and verifying your email:

1. Open [app.driftstack.dev/api-keys](https://app.driftstack.dev/api-keys).
2. Click **Create key**, give it a name (e.g. `quickstart`), and copy the value. The key is shown once.
3. Export it in your shell:

```bash
export DRIFTSTACK_API_KEY="ds_live_…"
```

API keys are scoped to the account that created them. The key prefix (`ds_live_`) tells you it's a production key. Trial-pack and pre-billing accounts get the same key shape.

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

- `client.sessions.create()` reserved one of your account's concurrent session slots. Each tier has a concurrent cap (Trial pack: 1, API Starter: 2, API Builder: 8, API Scale: 24 — see [pricing](https://driftstack.dev/pricing)). Exceeding the cap returns 429.
- `client.sessions.navigate()` drove the iPhone Safari runtime to the URL on the modified WebKit fork. The runtime is real Safari on real iOS — not a desktop browser pretending.
- `client.sessions.capture()` returned a screenshot of the rendered page.
- `client.sessions.destroy()` released the concurrent slot. Sessions also auto-expire after the per-tier idle timeout if you forget to destroy them.

## 5. Next steps

- **[Profile management](/guides/profile-management/)** — persistent profiles let a session resume cookies, storage, and trust signals across runs.
- **[Session lifecycle](/guides/session-lifecycle/)** — full lifecycle reference (states, idle timeout, recovery on reconnect).
- **[Webhook event catalog](/webhooks/events/)** — push notifications when sessions transition state, billing events fire, etc.
- **[API versioning policy](/api/versioning/)** — what changes are additive, what triggers `/v2/*`, deprecation cycles.

Stuck? Email [support@driftstack.dev](mailto:support@driftstack.dev) — first paying customers get a direct response window.
