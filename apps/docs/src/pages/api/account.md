---
layout: ../../layouts/DocLayout.astro
title: Account
description: Read + edit the calling account — name, timezone, slug (V-298a), region preference (V-298b), avatar (V-352b).
---

# Account

`/v1/account/me` is the calling account's self-edit surface. The
endpoint is bearer-authenticated; it never honours the team-RBAC
`X-Driftstack-Account` header — `/me` always operates on the
caller's own account, even when the caller has admin role on a
team owner's account.

## Get the calling account

`GET /v1/account/me`

```ts
const me = await client.account.me();
```

Returns the account's full self-visible state:

| Field                       | Type           | Notes                                                                                                                                                                   |
| --------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | string         | Public id, prefixed `acc_`.                                                                                                                                             |
| `email`                     | string         | Login email.                                                                                                                                                            |
| `name`                      | string \| null | Display name; null falls back to email in the UI.                                                                                                                       |
| `tier`                      | enum           | One of the seven tier slugs.                                                                                                                                            |
| `status`                    | enum           | `active` / `suspended` / `deleted`.                                                                                                                                     |
| `timezone`                  | string \| null | IANA name (`Europe/Amsterdam`); null means UTC fallback for client renders.                                                                                             |
| `slug`                      | string \| null | V-298a — readable handle (lowercase a-z + 0-9 + hyphen, 3-32 chars). Null when unset.                                                                                   |
| `region`                    | enum \| null   | V-298b — stated infrastructure-region preference (`us` / `eu` / `apac`). Informational for v1; routing is governed by [DPA Annex 3](/legal/dpa#annex-3-sub-processors). |
| `avatar_url`                | string \| null | V-352b — short-lived (1h) presigned R2 GET URL. Null when no avatar uploaded or the public bucket isn't wired in this deploy.                                           |
| `mfa_enrolled`              | boolean        | True once TOTP enrolment is verified.                                                                                                                                   |
| `concurrent_session_cap`    | number         | Per-tier active-session ceiling.                                                                                                                                        |
| `concurrent_session_active` | number         | Currently-active count.                                                                                                                                                 |
| `profile_cap`               | number \| null | Per-tier profile ceiling; null on enterprise (custom).                                                                                                                  |
| `profile_count`             | number         | Currently-saved profiles.                                                                                                                                               |
| `teams`                     | array          | V-326c — owner accounts the caller is a member of. Each entry: `owner_account_id`, `role`, `membership_id`. Empty array when not on any team.                           |

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
- `region` — V-298b. One of `us` / `eu` / `apac`. Null clears.

Returns the same shape as `GET /v1/account/me` with the new values applied.

## Avatar upload

`POST /v1/account/me/avatar` — V-352b.

Inline base64 body. The image lands in the EU-jurisdiction
Cloudflare R2 bucket; the response includes a presigned read URL.
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

## Why `/me` ignores team-RBAC

The `X-Driftstack-Account` header (V-326e) routes most `/v1/*`
requests to a team owner's account. `/v1/account/me` is the
exception: editing a team owner's display name, slug, region, or
avatar via a member's bearer token would be surprising. If
team-scoped account editing is needed in the future, it lands as
a separate `/v1/team/owners/:id/...` surface with explicit
semantics — not an opt-in flag on `/me`.
