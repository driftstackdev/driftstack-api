---
layout: ../../layouts/DocLayout.astro
title: Account
description: Read + edit the calling account — name, timezone, slug , region preference , avatar .
---

# Account

The exact `/v1/account/me` identity resource is the calling
account's self-edit surface. It is bearer-authenticated and never
honours the team-RBAC `X-Driftstack-Account` header, even when the
caller has admin role on a team owner's account. This self-only
rule also covers its avatar mutations. The nested
`/v1/account/me/organization` profile-taxonomy resource is an
explicit exception: it honours the selected effective account so
folders and tags stay with the profiles they organize.

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
| `region`                    | enum \| null   | — stated infrastructure-region preference (`us` / `eu` / `apac`). Informational for v1; routing is governed by [DPA Annex 3](https://driftstack.io/legal/dpa/#annex-3--sub-processors).                                |
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

Inline base64 body. The image is stored on Cloudflare R2 in the
public-readable bucket (its storage network can replicate outside the
EU). The response includes a presigned read URL, which is a stable
time-limited link rather than an access control — anyone holding the
object URL can fetch it. Treat an avatar as public content.
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

`DELETE /v1/account/me/avatar` clears the avatar pointer on your
account, so the image stops being served from `/v1/account/me`. The R2
object itself is left in place and there is no sweeper collecting
orphaned keys today, so a previously-shared object URL keeps resolving.
Do not treat the delete as an erasure of the image.

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

## Linked sign-in identities

`GET /v1/account/me/oauth-links`

Lists the sign-in-with-Google/GitHub identities linked to the calling
account. Requires broad `read`. There is no SDK wrapper for this endpoint
yet — call it over HTTP.

Pass `?active_only=true` to omit links that were revoked upstream at the
identity provider.

```json
{
  "data": [
    {
      "id": "ol_a1b2c3d4-...",
      "provider": "google",
      "provider_email": "you@example.com",
      "linked_at": "2026-05-12T09:14:22.000Z",
      "last_login_at": "2026-08-17T21:03:11.000Z",
      "last_revoked_at": null
    }
  ]
}
```

`provider` is `google` or `github`. `provider_email`, `last_login_at`
and `last_revoked_at` are all nullable — a link created before the
provider returned an email, or never signed in with since, reads `null`
rather than being omitted.

A non-null `last_revoked_at` means the provider link was revoked on the
provider's side; sign in with a password or re-link to restore it.
Removing a link from the Driftstack side is not exposed yet.

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

## Profile organization taxonomy

`GET /v1/account/me/organization` reads the effective account's
saved folder/icon and tag taxonomy. It requires `read:profiles`;
broad `read` and `account_owner` credentials satisfy that granular
gate. Both team `member` and `admin` roles may read the selected
owner's taxonomy.

`PUT /v1/account/me/organization` replaces that complete taxonomy
and requires `write:profiles`; broad `write` and `account_owner`
credentials satisfy the gate. In team context, only `admin` may
write. The server resolves membership and role before validating
or persisting the body, and writes only the account named by
`X-Driftstack-Account`. Without the header, both methods retain
their original calling-account behavior.

## Why identity `/me` ignores team-RBAC

The `X-Driftstack-Account` header routes most `/v1/*`
requests to a team owner's account. The exact identity/edit route
`/v1/account/me` is an exception: editing a team owner's display
name, slug, region, or avatar via a member's bearer token would be
surprising. Those account edits stay bound to the authenticated
account. This does not cover the nested profile taxonomy described
above, whose owner must match the selected profile workspace.
