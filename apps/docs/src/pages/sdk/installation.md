---
layout: ../../layouts/DocLayout.astro
title: SDK installation
description: Installation and configuration for the Driftstack TypeScript, Python, and Go SDKs.
---

# SDK installation

> **Draft — founder review pending.** Reflects shipped state of `@driftstack/sdk` (TypeScript, on npm) and the alpha Python + Go SDKs.

The Driftstack SDKs share a typed surface generated from the same OpenAPI 3.1 contract. Pick the language that fits your stack.

## TypeScript / Node.js

**Status:** published on npm. Pre-1.0 — the API contract is stable but the SDK shape may shift before `1.0`. Don't pin to an exact version yet.

**Install:**

```bash
npm install @driftstack/sdk
# or
pnpm add @driftstack/sdk
# or
yarn add @driftstack/sdk
```

**Requirements:** Node.js ≥ 18 (uses native `fetch`). Works in any modern runtime exposing `fetch` and `node:crypto` (Bun, Deno via npm specifier).

**Configure:**

```ts
import { Driftstack } from '@driftstack/sdk';

const client = new Driftstack({
  apiKey: process.env.DRIFTSTACK_API_KEY!,
  baseUrl: 'https://api.driftstack.dev', // optional override
  timeoutMs: 30_000,
  retry: {
    maxAttempts: 3,
    initialDelayMs: 250,
    maxDelayMs: 8_000,
  },
});
```

**Resources** (every method is fully typed):

```ts
client.sessions.create(body?);
client.sessions.list(query?);
client.sessions.navigate(id, body);
client.sessions.interact(id, body);
client.sessions.wait(id, body);
client.sessions.getState(id);
client.sessions.capture(id, body);
client.sessions.destroy(id);

client.profiles.create(body);
client.profiles.list(query?);
client.profiles.get(id);
client.profiles.delete(id);

client.apiKeys.create(body); // requires admin scope
client.apiKeys.list();
client.apiKeys.revoke(id); // requires admin scope

client.usage.current();
client.account.me();
```

**Errors:** every error extends `DriftstackError`. Catch the base for blanket handling, or specific subclasses (`RateLimitError`, `ConcurrencyLimitError`, `ValidationError`, `AuthError`) for granular logic.

## Python

**Status:** alpha. The SDK is built, tested, and wheel-buildable. The first PyPI release tags shortly after launch verification.

**Install (when published):**

```bash
pip install driftstack-sdk
```

The dist name is `driftstack-sdk`; the import name is `driftstack`.

**Requirements:** Python 3.10+.

**Configure (sync):**

```python
import os
from driftstack import Driftstack

with Driftstack(api_key=os.environ["DRIFTSTACK_API_KEY"]) as client:
    me = client.account.me()
    print(me.email)
```

**Configure (async):**

```python
import asyncio
import os
from driftstack import AsyncDriftstack

async def main():
    async with AsyncDriftstack(api_key=os.environ["DRIFTSTACK_API_KEY"]) as client:
        me = await client.account.me()
        print(me.email)

asyncio.run(main())
```

**Resources:**

| Accessor          | Methods                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `client.sessions` | `create`, `list`, `get`, `navigate`, `interact`, `wait`, `get_state`, `capture`, `destroy` |
| `client.profiles` | `create`, `list`, `get`, `delete`                                                          |
| `client.api_keys` | `create`, `list`, `revoke`                                                                 |
| `client.usage`    | `current_period`                                                                           |
| `client.webhooks` | `create`, `list`, `get`, `delete`, `list_deliveries`                                       |
| `client.account`  | `me`                                                                                       |

Inputs accept either a Pydantic model OR a plain `dict`. Outputs are typed Pydantic models.

## Go

**Status:** alpha. Builds, tests pass, examples compile. The first tagged release lands shortly after launch verification.

**Install:**

```bash
go get github.com/driftstackdev/driftstack-api/packages/sdk-go
```

**Requirements:** Go 1.21+ (any version supporting `errors.As` and `context.Cancel*` patterns).

**Configure:**

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
    me, err := client.Account.Me(ctx)
    if err != nil {
        log.Fatal(err)
    }
    log.Println(me.Email)
}
```

The Go SDK is single-package, has zero non-stdlib runtime dependencies, and is context-aware throughout.

## Versioning across SDKs

The HTTP API and the SDKs version independently. SDKs at any version stay compatible with the live API contract; SDK upgrades unlock newer fields and new resource methods, but won't break older method calls. See [SDK versioning policy](/sdk/versioning/) for the full guarantee.

## What ships, what's planned

| Capability          | TS  | Python | Go  | Notes                                  |
| ------------------- | --- | ------ | --- | -------------------------------------- |
| Sessions            | ✅  | ✅     | ✅  | Full CRUD + navigate/interact/wait     |
| Profiles            | ✅  | ✅     | ✅  | Create, list, get, delete              |
| API keys            | ✅  | ✅     | ✅  | Admin scope required for create/revoke |
| Webhooks            | ✅  | ✅     | ✅  | CRUD + delivery introspection          |
| Usage               | ✅  | ✅     | ✅  | Current-period read                    |
| Streaming responses | ⏳  | ⏳     | ⏳  | Planned for 1.0                        |
| Recording playback  | ⏳  | ⏳     | ⏳  | Tied to recording feature shipping     |

## Next steps

- **[Quickstart](/quickstart/)** — first session in under five minutes.
- **[Profile management](/guides/profile-management/)** — persistent profiles across sessions.
- **[Session lifecycle](/guides/session-lifecycle/)** — full state diagram and recovery semantics.
