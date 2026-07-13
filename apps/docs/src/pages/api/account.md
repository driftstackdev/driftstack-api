---
layout: ../../layouts/DocLayout.astro
title: Account
description: Read + edit the calling account — name, timezone, slug , region preference , avatar .
---

# Account

`/v1/account/me` is the calling account's self-edit surface. The
endpoint is bearer-authenticated; it never honours the team-RBAC
`X-Driftstack-Account` header — `/me` always operates on the
caller's own account, even when the caller has admin role on a
team owner's account.

## Get the calling account

`GET /v1/account/me`

Requires the broad `read` scope; `account_owner` also satisfies this
gate. Zero-scope, write-only, and resource-granular keys cannot read
the account's login identity, team memberships, MFA flag, or presigned
avatar URL.

```ts
const me = await client.account.me();
```

Returns the account's full self-visible state:

| Field                       | Type           | Notes                                                                                                                                                                                                                  |
| --------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | string         | Public id, prefixed `acc_`.                                                                                                                                                                                            |
| `email`                     | string         | Login email.                                                                                                                                                                                                           |
| `name`                      | string \| null | Display name; null falls back to email in the UI.                                                                                                                                                                      |
| `tier`                      | enum           | One of the eight tier slugs.                                                                                                                                                                                           |
| `status`                    | enum           | `active` / `suspended` / `deleted`.                                                                                                                                                                                    |
| `timezone`                  | string \| null | IANA name (`Europe/Amsterdam`); null means UTC fallback for client renders.                                                                                                                                            |
| `slug`                      | string \| null | — readable handle (lowercase a-z + 0-9 + hyphen, 3-32 chars). Null when unset.                                                                                                                                         |
| `region`                    | enum \| null   | — stated infrastructure-region preference (`us` / `eu` / `apac`). Informational for v1; routing is governed by [DPA Annex 3](https://driftstack.dev/legal/dpa#annex-3--sub-processors).                                |
| `avatar_url`                | string \| null | Selected image URL: the customer's short-lived (1h) presigned R2 upload, otherwise the linked-sign-in provider fallback. Null when neither source is available.                                                        |
| `avatar_source`             | enum           | `user` for a removable customer upload, `idp` for the read-only linked-sign-in fallback, or `none`. Use this field—not the URL host—to decide whether to offer Remove.                                                 |
| `mfa_enrolled`              | boolean        | True once TOTP enrolment is verified.                                                                                                                                                                                  |
| `concurrent_session_cap`    | number         | Per-tier active-session ceiling.                                                                                                                                                                                       |
| `concurrent_session_active` | number         | Currently-active count.                                                                                                                                                                                                |
| `profile_cap`               | number \| null | Per-tier profile ceiling; null on enterprise (custom).                                                                                                                                                                 |
| `profile_count`             | number         | Currently-saved profiles.                                                                                                                                                                                              |
| `teams`                     | array          | — owner accounts the caller is a member of. Each entry: `owner_account_id`, `owner_email` (falls back to `acc_<id>` when unknown), `owner_name` (nullable), `role`, `membership_id`. Empty array when not on any team. |

## Update the calling account

`PATCH /v1/account/me`

Partial update — pass any subset of `name`, `timezone`, `slug`,
`region`. At least one field must be present. Pass `null` to clear
a nullable field.

```json
{
  "name": "Acme B.V.",
  "timezone": "Europe/Amsterdam",
  "slug": "acme",
  "region": "eu"
}
```

- `name` — 1-120 trimmed chars; null clears (UI falls back to email).
- `timezone` — IANA name (`Europe/Amsterdam`); null clears (UTC fallback).
- `slug` — 3-32 chars, lowercase a-z + 0-9 + hyphen, no leading or trailing hyphen, no consecutive hyphens. Returns `409 Conflict` when another account already owns the slug. Null clears.
- `region` — One of `us` / `eu` / `apac`. Null clears.

Returns the same shape as `GET /v1/account/me` with the new values applied.

## Avatar upload

`POST /v1/account/me/avatar` —

Inline base64 body. The image is stored privately on Cloudflare R2
(its storage network can replicate outside the EU); the response
includes a presigned read URL.
Field shape:

```json
{
  "data_base64": "iVBORw0KGgoAAAANSUhEUgAAA...",
  "content_type": "image/png"
}
```

- Allowed `content_type`: `image/png`, `image/jpeg`, `image/webp`.
- Max raw size: 2 MiB (route body limit is 3.5 MiB to allow the base64 envelope).
- Returns `{ avatar_url, content_type, bytes }`.

`DELETE /v1/account/me/avatar` clears the avatar pointer; the R2
object is left in place (a sweeper job collects orphaned keys
off the hot path).

## Active sign-ins

The dashboard's "active sign-ins" panel and SDK `client.account`
resource expose the calling account's web-session list:

Listing active sign-ins requires broad `read`. Revoking one or all
sign-ins remains an `account_owner` operation.

```ts
const { data } = await client.account.listWebSessions();
for (const session of data) {
  console.log(session.os, session.browser, session.last_used_at, session.current);
}
```

```python
sessions = client.account.list_web_sessions()
for s in sessions["data"]:
    print(s["os"], s["browser"], s["last_used_at"], s["current"])
```

```go
list, _ := client.Account.ListWebSessions(ctx)
for _, s := range list.Data {
    fmt.Println(s.OS, s.Browser, s.LastUsedAt, s.Current)
}
```

The entry with `current: true` is the calling session itself.
IP addresses are deliberately omitted; user-agents are reduced to
OS + browser bucket per the anonymity. Revoke individual
sessions with `revokeWebSession(id)` / `revoke_web_session(id)` /
`RevokeWebSession(ctx, id)`. Revoke every other session in one
call with `revokeAllOtherWebSessions()` / equivalent.

## Effective rate limits

Read the calling account's effective per-bucket rate-limit config
including any active overrides:

This account-wide read requires broad `read`; `account_owner` also
satisfies it.

```ts
const cfg = await client.account.rateLimits();
for (const bucket of cfg.buckets) {
  console.log(bucket.bucket_key, bucket.capacity, bucket.refill_per_second, bucket.source);
}
```

`source` is `tier_default` for unbounded tier-derived caps or
`override` when staff has applied a per-account adjustment;
`override_expires_at` is non-null in the override case.

## Email preferences

Per-event opt-out toggles for non-critical customer emails:

```ts
const prefs = await client.emailPreferences.list();
await client.emailPreferences.optOut('billing-renewal-reminder');
```

Critical emails (verification, password-reset, billing-failure)
are not opt-outable —
they're absent from the `OptOutableEmailEvent` enum on purpose.

## Audit log

Programmatic access to the customer audit log lives at
[`/api/audit-log`](/api/audit-log/) — `client.auditLog.list()` /
`client.auditLog.iterate()` walk the same ledger the
dashboard renders. Pair with the export endpoint for GDPR
Article 20 portability bulk-pulls.

## MFA enrollment + step-up

MFA management is on `client.mfa.*` — `status`,
`enroll`, `verify`, `disable`, `regenerateRecoveryCodes`. The
login-time MFA exchange + step-up are on `client.auth.*` —
`mfaChallenge` + `mfaStepUp` . Full walkthrough
at [`/api/auth#mfa-challenge`](/api/auth/#mfa-challenge).

## Why `/me` ignores team-RBAC

The `X-Driftstack-Account` header routes most `/v1/*`
requests to a team owner's account. `/v1/account/me` is the
exception: editing a team owner's display name, slug, region, or
avatar via a member's bearer token would be surprising. If
team-scoped account editing is needed in the future, it lands as
a separate `/v1/team/owners/:id/...` surface with explicit
semantics — not an opt-in flag on `/me`.
