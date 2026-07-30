---
layout: ../../layouts/DocLayout.astro
title: SDK installation
description: Installation and configuration for the Driftstack TypeScript, Python, and Go SDKs.
---

# SDK installation

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
    initialDelayMs: 200,
    maxDelayMs: 10_000,
  },
});
```

**Resources** (every method is fully typed):

```ts
client.sessions.create(body?);
client.sessions.list(query?);
client.sessions.iterate(opts?);
client.sessions.navigate(id, body);
client.sessions.interact(id, body);
client.sessions.wait(id, body);
client.sessions.getState(id);
client.sessions.capture(id, body);
client.sessions.destroy(id);

client.agentSessions.create(body?);
client.agentSessions.get(id);
client.agentSessions.message(id, userMessage, opts?); // BYOK header opt-in
client.agentSessions.close(id);
client.agentSessions.takeover(id, clientId); // pair-mode
client.agentSessions.handback(id);
client.agentSessions.livekitToken(id); // LK.3 re-mint after 24h TTL

client.recipes.create(body); // snapshot an agent-session intent_log
client.recipes.list(query?);
client.recipes.iterate(opts?);
client.recipes.get(id);
client.recipes.delete(id);

client.profiles.create(body);
client.profiles.list(query?);
client.profiles.get(id);
client.profiles.export(id); // metadata-only JSON envelope
client.profiles.import(body); // mint a profile from an envelope
client.profiles.delete(id);

client.profileSnapshots.capture(profileId, body?);
client.profileSnapshots.listForProfile(profileId, query?);
client.profileSnapshots.list(query?);
client.profileSnapshots.iterate(opts?);
client.profileSnapshots.get(snapshotId);
client.profileSnapshots.restore(snapshotId, body?);
client.profileSnapshots.delete(snapshotId);

client.apiKeys.create(body); // requires account_owner scope
client.apiKeys.list();
client.apiKeys.rotate(id); // 24-hour grace on prior key
client.apiKeys.revoke(id); // requires account_owner scope

client.webhooks.create(body);
client.webhooks.list();
client.webhooks.get(id);
client.webhooks.update(id, body); // partial update
client.webhooks.delete(id);
client.webhooks.listDeliveries(webhookId, query?);
client.webhooks.iterateDeliveries(webhookId, opts?);
client.webhooks.replayDelivery(deliveryId);
client.webhooks.rotateSecret(id); // 24h grace dual-sign
client.webhooks.sendTest(id); // synthetic test.ping

client.auth.cliAuthorizeInitiate(body); // CLI/GUI activation
client.auth.cliAuthorizeBind(body);
client.auth.cliAuthorizeExchange(body);
client.auth.mfaChallenge(body); // login MFA exchange
client.auth.mfaStepUp(body); // step-up freshness

client.auditLog.list(query?);
client.auditLog.iterate(opts?);
client.auditLog.export(); // GDPR Article 20 JSON

client.legal.documents();
client.legal.required();
client.legal.accept(body);

client.mfa.status();
client.mfa.enroll();
client.mfa.verify(body);
client.mfa.disable();
client.mfa.regenerateRecoveryCodes();

client.team.invite(email, opts?);
client.team.listMembers();
client.team.listInvites();
client.team.acceptInvite(token);
client.team.removeMember(membershipId);

client.emailPreferences.list();
client.emailPreferences.set(body);
client.emailPreferences.optIn(category);
client.emailPreferences.optOut(category);

client.billing.getState();
client.billing.createCheckoutSession(body);
client.billing.createPortalSession();

client.cryptoOrders.quote(body);
client.cryptoOrders.createCheckout(body);
client.cryptoOrders.list(query?);
client.cryptoOrders.get(orderId);
client.cryptoOrders.cancel(orderId);
client.cryptoOrders.receipt(orderId);

client.usage.current();
client.account.me();
```

**Errors:** every error extends `DriftstackError`. Catch the base for blanket handling, or specific subclasses (`RateLimitError`, `ConcurrencyLimitError`, `ValidationError`, `AuthError`) for granular logic.

## Python

**Status:** published on PyPI, pre-1.0, and classified Alpha. Use requirements constraints or a lockfile for reproducible deployments.

**Install:**

```bash
pip install driftstack-sdk
```

The distribution name is `driftstack-sdk`; the import name is `driftstack`. Pin a compatible release in your requirements or generated lockfile before production deployment.

**Requirements:** Python 3.10+.

**Configure (sync):**

```python
import os
from driftstack import Driftstack

with Driftstack(api_key=os.environ["DRIFTSTACK_API_KEY"]) as client:
    me = client.account.me()
    print(me["email"])
```

**Configure (async):**

```python
import asyncio
import os
from driftstack import AsyncDriftstack

async def main():
    async with AsyncDriftstack(api_key=os.environ["DRIFTSTACK_API_KEY"]) as client:
        me = await client.account.me()
        print(me["email"])

asyncio.run(main())
```

**Resources:**

| Accessor                   | Methods                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.sessions`          | `create`, `list`, `iterate`, `get`, `navigate`, `interact`, `wait`, `get_state`, `capture`, `extract`, `search`, `login`, `destroy`           |
| `client.agent_sessions`    | `create`, `get`, `message`, `close`, `takeover`, `handback`, `livekit_token` (sync + async)                                                   |
| `client.recipes`           | `create`, `list`, `iterate`, `get`, `delete` (recipe management only; no execute method)                                                      |
| `client.profiles`          | `create`, `list`, `get`, `delete`                                                                                                             |
| `client.api_keys`          | `create`, `list`, `rotate` , `revoke`                                                                                                         |
| `client.usage`             | `current_period`                                                                                                                              |
| `client.webhooks`          | `create`, `list`, `get`, `update` , `delete`, `list_deliveries`, `iterate_deliveries`, `replay_delivery` , `rotate_secret` , `send_test`      |
| `client.team`              | `invite`, `list_members`, `list_invites`, `accept_invite`, `remove_member`                                                                    |
| `client.account`           | `me`, `update_me`, `upload_avatar`, `clear_avatar`, `list_web_sessions`, `revoke_web_session`, `revoke_all_other_web_sessions`, `rate_limits` |
| `client.auth`              | `cli_authorize_initiate / bind / exchange` , `mfa_challenge` , `mfa_step_up` , plus signup / login / logout / refresh / magic-link / reset    |
| `client.audit_log`         | `list`, `iterate`, `export`                                                                                                                   |
| `client.mfa`               | `status`, `enroll`, `verify`, `disable`, `regenerate_recovery_codes`                                                                          |
| `client.email_preferences` | `list`, `set`, `opt_in`, `opt_out`                                                                                                            |
| `client.legal`             | `documents`, `required`, `accept`                                                                                                             |
| `client.profile_snapshots` | `capture`, `list_for_profile`, `list`, `iterate`, `get`, `restore`, `delete`                                                                  |

Inputs accept either a Pydantic model OR a plain `dict`. Outputs are typed Pydantic models.

`sessions.search` and `sessions.login` are typed in every SDK, but the routes
themselves are capability-gated: they require a deployment advertising a real
direct-driver search/login capability and otherwise return `503` before the
session is looked up or any browser work starts. See
[Sessions](/api/sessions/) for both response branches.

## Go

**Status:** published as a tagged pre-1.0 module. Commit `go.mod` and `go.sum` for reproducible deployments.

**Install:**

```bash
go get github.com/driftstackdev/driftstack-api/packages/sdk-go@latest
```

**Requirements:** Go 1.22+ (the toolchain floor declared in `go.mod`).

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

## What ships

| Capability        | TS  | Python | Go  | Notes                                                                                          |
| ----------------- | --- | ------ | --- | ---------------------------------------------------------------------------------------------- |
| Sessions          | ✅  | ✅     | ✅  | Full CRUD + navigate/interact/wait/capture/getState/extract; search/login are capability-gated |
| Agent sessions    | ✅  | ✅     | ✅  | create/get/message/close/takeover/handback/livekitToken                                        |
| Recipes           | ✅  | ✅     | ✅  | create/list/get/delete; no execute method                                                      |
| Profiles          | ✅  | ✅     | ✅  | Create, list, get, delete                                                                      |
| Profile snapshots | ✅  | ✅     | ✅  | capture/list/restore/delete                                                                    |
| API keys          | ✅  | ✅     | ✅  | Includes `rotate` with 24h grace                                                               |
| Webhooks          | ✅  | ✅     | ✅  | CRUD + delivery introspection + `replayDelivery` + `rotateSecret`                              |
| Team RBAC         | ✅  | ✅     | ✅  | Invite/accept/list/remove                                                                      |
| Usage             | ✅  | ✅     | ✅  | Current-period read + 30-day daily series                                                      |
| Audit log         | ✅  | ✅     | ✅  | Paginated read + GDPR-Article-20 CSV/JSON export                                               |
| MFA               | ✅  | ✅     | ✅  | TOTP enroll/verify/disable + recovery-code regen                                               |
| Billing           | ✅  | ✅     | ✅  | State read + Stripe checkout/portal                                                            |
| Email preferences | ✅  | ✅     | ✅  | List + set + opt-in/out (non-critical templates only)                                          |
| Legal             | ✅  | ✅     | ✅  | Catalog + required + accept (content-hash-bound)                                               |
| Account self      | ✅  | ✅     | ✅  | `me` returns tier + concurrent + profile counts + teams[]                                      |

## Next steps

- **[Quickstart](/quickstart/)** — first session in under five minutes.
- **[Profile management](/guides/profile-management/)** — persistent profiles across sessions.
- **[Session lifecycle](/guides/session-lifecycle/)** — full state diagram and recovery semantics.
