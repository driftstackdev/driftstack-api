---
layout: ../../layouts/DocLayout.astro
title: API keys
description: Create, list, rotate, and revoke API keys via /v1/api-keys.
---

# API keys

Driftstack uses bearer-token authentication. Every API request includes
`Authorization: Bearer <key>`. Keys are issued, listed, rotated, and
revoked via the `/v1/api-keys` endpoints below.

Customer API keys require a paid tier. Every paid tier, including Manual,
issues `ds_live_…` keys. Free is supported through desktop browser sign-in,
which automatically stores a restricted `ds_test_…` device credential; that
credential is not a customer API key or a general sandbox key.

Free dashboard web sessions may still list and revoke keys created before a
downgrade, but create and rotate return the normal RFC 9457 `403 Forbidden`:
`The "apiAccess" feature is not available on the "free" tier. Upgrade to a tier that includes this feature.`
Existing ordinary keys are rejected on every request while the account is
Free and resume after upgrade unless revoked or expired.

> **Plaintext is shown ONCE.** When a key is created or rotated, the
> response includes the plaintext value. Store it now — Driftstack
> hashes it server-side and cannot recover it later. If you lose a key,
> revoke it and mint a fresh one.

## Create a key

`POST /v1/api-keys`

Available to all paid tiers, including Manual. The entitlement check runs
before key, audit, or webhook side effects.

Request:

```json
{
  "name": "production",
  "scopes": ["read", "write"]
}
```

Response (201):

```json
{
  "id": "key_00000000-0000-4000-8000-000000000001",
  "name": "production",
  "key_prefix": "ds_live_a1b2c3",
  "scopes": ["read", "write"],
  "last_used_at": null,
  "revoked_at": null,
  "expires_at": null,
  "created_at": "2026-05-08T10:00:00Z",
  "plaintext": "ds_live_a1b2c3secretsecretsecretsecretsec"
}
```

> **Scope de-escalation.** A key can only grant scopes its own key
> already holds. An `account_owner` key can mint keys with any
> customer-level scope (`read`, `write`, `account_owner`, or a granular
> `verb:resource`), but cannot grant the staff-only
> `driftstack_internal_admin` (or legacy `admin`) scope. Requesting a
> scope the calling key does not hold returns `403 Forbidden`:
> `Cannot grant the "<scope>" scope: the calling key does not hold it.`

## List keys

`GET /v1/api-keys` returns all active and revoked keys for the calling
account. Plaintext is never included.

## Rotate a key

`POST /v1/api-keys/:id/rotate`

Available to all paid tiers. Free may revoke an old key but cannot rotate it
into new programmatic authority.

Rotation mints a fresh plaintext while keeping the old key active for a
24-hour grace period. Use this to swap deployments without downtime:

1. Call rotate on the existing key — receive a new plaintext.
2. Deploy the new key to your applications.
3. After all instances are confirmed using the new key, the old key
   auto-revokes at the grace boundary (24h from the rotate call).

Optional `name` field renames the new key (default: preserves the old
name).

Request:

```json
{ "name": "production-2025" }
```

Response (201):

```json
{
  "id": "key_00000000-0000-4000-8000-000000000002",
  "name": "production-2025",
  "key_prefix": "ds_live_NEWKEY",
  "scopes": ["read", "write"],
  "last_used_at": null,
  "revoked_at": null,
  "expires_at": null,
  "created_at": "2026-05-08T10:00:00Z",
  "plaintext": "ds_live_NEWKEYsecretsecretsecretsecretsecre",
  "rotated_from": "key_00000000-0000-4000-8000-000000000001",
  "grace_period_ends_at": "2026-05-09T10:00:00Z"
}
```

After `grace_period_ends_at`, requests using the old key receive `401
Unauthorized` because the existing `expires_at`-driven auth gate
short-circuits. No separate revocation endpoint is needed.

### SDK examples

**TypeScript:**

```ts
import { Driftstack } from '@driftstack/sdk';

const client = new Driftstack({ apiKey: process.env.DRIFTSTACK_API_KEY });

const result = await client.apiKeys.rotate('key_old', { name: 'production-2025' });
console.log('New plaintext:', result.plaintext);
console.log('Old key auto-revokes at:', result.grace_period_ends_at);
```

**Python:**

```python
from driftstack import Driftstack

with Driftstack(api_key=os.environ["DRIFTSTACK_API_KEY"]) as client:
    result = client.api_keys.rotate("key_old", name="production-2025")
    print("New plaintext:", result.plaintext)
    print("Old key auto-revokes at:", result.grace_period_ends_at)
```

**Go:**

```go
result, err := client.APIKeys.Rotate(
    ctx,
    "key_old",
    &driftstack.RotateAPIKeyRequest{Name: "production-2025"},
)
if err != nil {
    return err
}
fmt.Println("New plaintext:", result.Plaintext)
fmt.Println("Old key auto-revokes at:", result.GracePeriodEndsAt)
```

## Revoke a key

`DELETE /v1/api-keys/:id`

Idempotent. Revoking an already-revoked key returns the same `204 No
Content` response. Revoked keys cannot be reactivated; mint a fresh
key instead.

## Scopes

| Scope                       | Capability                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `read`                      | Read-only access (list sessions, recordings, profiles, usage).                                    |
| `write`                     | Mutations (create/destroy sessions, profiles, etc.). Does NOT include read — pair it with `read`. |
| `account_owner`             | Self-service mutations (create/rotate/revoke API keys, billing portal redirect).                  |
| `gui_control`               | Reserved for the GUI Client; do not request manually.                                             |
| `driftstack_internal_admin` | Internal Driftstack staff scope; never granted to customer accounts.                              |

There is no default scope set — `scopes` is required on create
(at least one entry; omitting it is a `400`). Most application
keys should request `read` + `write` together. Issue
`account_owner` only to keys used by the dashboard or operator
tooling — application keys do not need it.
