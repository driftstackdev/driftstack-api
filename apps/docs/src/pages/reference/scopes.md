---
layout: ../../layouts/DocLayout.astro
title: API key scopes
description: Full reference of API key scopes — broad, granular, and the broad-satisfies-granular rule.
---

# API key scopes

Every Driftstack API key carries a set of
scopes. Endpoints that declare a required scope allow the
request only if the key's scope set satisfies it. A few
endpoints require no specific scope beyond a valid key — their
docs pages say so explicitly (the `GET /v1/legal/*` reads are
examples).

## Scope categories

There are three categories of scopes, in order of breadth:

1. **Broad scopes** — `read`, `write`, `admin`. Cover every
   resource of the corresponding verb across the customer's
   account. The simplest mental model: "this key can do
   everything a customer can do at this verb level."
2. **Account-control scopes** — `account_owner`,
   `driftstack_internal_admin`. Gate customer-account control
   (`account_owner`) and Driftstack-staff-only operations
   (`driftstack_internal_admin`). Customer keys never carry
   `driftstack_internal_admin`.
3. **Granular scopes ** — `verb:resource` syntax (e.g.
   `read:sessions`, `write:webhooks`). Narrow keys for
   integrations that should not have full account access.

## Full scope list

| Scope                       | Category        | Grants                                                                                                                                                                                                                                                                                                |
| --------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`                      | broad           | All read-side operations across every resource the customer owns.                                                                                                                                                                                                                                     |
| `write`                     | broad           | All state-mutating operations except destructive admin actions. Does NOT include read — pair with `read`.                                                                                                                                                                                             |
| `admin`                     | broad (legacy)  | Pre-alias. Treated as satisfying both `account_owner` + `driftstack_internal_admin`.                                                                                                                                                                                                                  |
| `account_owner`             | account-control | Mint API keys, revoke API keys, manage subscription, `/v1/account/*`. Customer dashboard scope.                                                                                                                                                                                                       |
| `driftstack_internal_admin` | account-control | `/v1/admin/*` — list all accounts, suspend account, change tier, force-actions. Driftstack staff.                                                                                                                                                                                                     |
| `gui_control`               | special         | Manual-control plane (`tap_at`, `type_focused`). Self-hosted GUI workflow only (locked-decision L-001).                                                                                                                                                                                               |
| `read:sessions`             | granular        | Read sessions endpoints only.                                                                                                                                                                                                                                                                         |
| `write:sessions`            | granular        | Create + drive + delete sessions. Does not include read — pair with `read:sessions` to list/get.                                                                                                                                                                                                      |
| `read:profiles`             | granular        | Read profiles endpoints only.                                                                                                                                                                                                                                                                         |
| `write:profiles`            | granular        | Create + edit + delete profiles (and their snapshots). Does not include read — pair with `read:profiles`.                                                                                                                                                                                             |
| `admin:profiles`            | granular        | All admin operations on profiles.                                                                                                                                                                                                                                                                     |
| `read:webhooks`             | granular        | Read webhook endpoints only.                                                                                                                                                                                                                                                                          |
| `write:webhooks`            | granular        | Declared but enforced on no route today — reads require `read:webhooks`, and endpoint management (create / update / delete / rotate-secret / send-test) requires `account_owner` — see note.                                                                                                          |
| `admin:webhooks`            | granular        | Reserved. Webhook endpoint management is account-control-level and requires `account_owner`, not this granular scope.                                                                                                                                                                                 |
| `read:api-keys`             | granular        | Read API keys list / metadata only.                                                                                                                                                                                                                                                                   |
| `admin:api-keys`            | granular        | Reserved. API-key management (mint / rotate / revoke) is account-control-level and requires `account_owner`, not this granular scope.                                                                                                                                                                 |
| `read:billing`              | granular        | Read billing state. Enforced on `GET /v1/billing`, the crypto-order reads (`GET /v1/billing/crypto-orders` + its single-order and `receipt`/`receipt.txt`/`receipt.pdf` variants), and `GET /v1/account/cost` — a broad `read` or `account_owner` key also satisfies it; a write-only key is refused. |
| `admin:billing`             | granular        | All admin operations on billing (start trial, change subscription, manage portal).                                                                                                                                                                                                                    |
| `read:audit`                | granular        | Read account audit log only.                                                                                                                                                                                                                                                                          |

> **Note — webhook + API-key management are account-control operations.**
> Creating, updating, deleting, or rotating webhook endpoints — and minting
> or revoking API keys — requires the `account_owner` scope, not a granular
> `write:webhooks` / `admin:webhooks` scope. Account-configuration surfaces
> are deliberately gated at the account-control level rather than at
> granular write level. (A broad `admin` key still satisfies `account_owner`
> via the V-174 alias.)

> **Note — agent-session endpoints require the broad `write` scope.**
> Driver-session routes accept the granular `write:sessions`, but
> agent-session endpoints (`/v1/agent-sessions/*` — create,
> send-message, input-event, mode/takeover transitions) gate on the
> broad `write` scope. There is no agent-sessions-specific granular
> scope. If you mint a narrow CI key, include the broad `write` scope
> to call these endpoints.

## broad-satisfies-granular rule

A key with a broad scope **satisfies** any granular scope on
the same verb:

- A key with `read` satisfies every `read:*` granular scope
  (`read:sessions`, `read:profiles`, `read:webhooks`,
  `read:api-keys`, `read:billing`, `read:audit`).
- A key with `write` satisfies any `write:*`.
- A key with `admin` (or `account_owner`) satisfies any
  `admin:*`.

The reverse is **not** true: a key with `read:sessions` does
NOT satisfy `read` — narrow keys stay narrow. That's the
point of granular scoping; a `read:sessions` key can only
ever read sessions, not profiles or webhooks.

```text
key with: read              → can do: read, plus every read:* (read:sessions, read:profiles, read:webhooks, read:api-keys, read:billing, read:audit)
key with: read:sessions     → can do: read:sessions  (only)
key with: write             → can do: write, plus every write:* — but NO read:* (writes never imply reads)
key with: account_owner     → can do: read, write, plus any read:*/write:*/admin:*
```

## What happens on a scope mismatch

The API returns HTTP 403 with an RFC 9457 problem-details body:

```json
{
  "type": "https://errors.driftstack.dev/forbidden",
  "title": "Forbidden",
  "status": 403,
  "detail": "This action requires the \"write:sessions\" scope."
}
```

The detail string names the exact scope required so you can
mint a correctly-scoped replacement key (or extend the
existing one).

## Picking scopes for a new key

When you mint a key from the dashboard or via
`POST /v1/api-keys`, you pick scopes per use case. Defaults:

- **CI / test runner:** `read:sessions` + `write:sessions`.
  No access to profiles, webhooks, or billing.
- **Production application:** `read` + `write`. Excludes
  account-management surfaces.
- **Backup automation:** `read` + `read:audit`.
- **Webhook signing-only key:** mint a key with NO scopes.
  The key authenticates the webhook signature but cannot
  call any `/v1/*` endpoint. (This is the recommended
  pattern — the webhook signing secret is separate from API
  keys; see [webhooks docs](/webhooks/endpoints/) for details.)
- **Dashboard / customer self-service:** `account_owner`. The
  default scope minted by the customer dashboard's "first key"
  flow.

## Source of truth

The full scope enum lives in
`packages/api-types/src/common.ts:ApiKeyScopeSchema`. The
`requireScope` predicate is mirrored at two server-side call
sites (`apps/server/src/lib/errors-helpers.ts` +
`apps/server/src/services/auth.ts`) and verified by the
41-case unit test at
`apps/server/tests/unit/scope-check.test.ts`.

Any scope additions land via V-NNN slice that updates the
schema, both predicate sites, and this docs page.
