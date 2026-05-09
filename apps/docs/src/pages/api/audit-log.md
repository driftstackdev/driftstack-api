---
layout: ../../layouts/DocLayout.astro
title: Audit log
description: Programmatic access to the customer audit log — list with filters + cursor pagination, plus CSV/JSON export for GDPR portability.
---

# Audit log

Every action on your account lands in an append-only audit log:
API key lifecycle, session events, profile changes, subscription
changes, MFA enrollment, webhook config, team member changes, and
admin-recorded support notes. Customers can read the log
programmatically for compliance + monitoring, and export the
complete history per the GDPR Article 20 right to data portability.

## List

`GET /v1/account/audit-log`

Query parameters:

- `limit` — page size, 1-100; default 50.
- `cursor` — pagination token from a prior page's `next_cursor`.
- `action` — filter to a single action name (see catalog below).

Response (200):

```json
{
  "data": [
    {
      "id": "<uuid>",
      "account_id": "<account-uuid>",
      "actor_type": "customer",
      "actor_account_id": "<account-uuid>",
      "actor_key_id": "key_<uuid>",
      "action": "api_key.minted",
      "target_resource_id": "key_<new-key-uuid>",
      "payload": { "name": "production", "scopes": ["read", "write"] },
      "ip_address": null,
      "user_agent": null,
      "timestamp": "2026-05-09T22:30:00.000Z"
    }
  ],
  "next_cursor": "<opaque-cursor>"
}
```

`next_cursor` is `null` when there are no more pages.

The `actor_type` enum:

- `customer` — a human action through the dashboard or an API call
  with a customer-issued bearer.
- `system` — an automated event (Stripe-driven tier changes, email
  verification, scheduled-job side-effects).
- `staff` — a Driftstack support-team action against the account
  (rare; recorded for transparency).

`actor_account_id` is the calling account for `customer` actions.
`actor_key_id` is the synthetic `wsk_<session-uuid>` for web-session
calls and `key_<key-uuid>` for API-key calls. Both are `null` for
`system` and `staff` events.

`ip_address` and `user_agent` are surfaced in the schema but
deliberately omitted in production responses for privacy (per
V-211): the dashboard rendering doesn't display them, and the
admin tooling reads them out of a separate internal store.

## Action catalog

| Action                            | Origin   | Notes                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `account.email_verified`          | system   | Customer clicked the verify-email link                                                                                                                                                                                                                                                                                   |
| `account.login`                   | customer | Successful sign-in. `payload.method` ∈ {`password`, `magic_link`, `password_reset`, `mfa_totp`, `mfa_recovery`}                                                                                                                                                                                                          |
| `account.logout`                  | customer | Web session revoked                                                                                                                                                                                                                                                                                                      |
| `account.password_changed`        | customer | Password reset confirmed                                                                                                                                                                                                                                                                                                 |
| `account.mfa_enrolled`            | customer | First successful TOTP verify (V-353b)                                                                                                                                                                                                                                                                                    |
| `account.mfa_disabled`            | customer | DELETE /v1/account/mfa (V-353b/e)                                                                                                                                                                                                                                                                                        |
| `account.recovery_code_used`      | customer | Recovery code consumed (login or step-up). `payload.remaining`                                                                                                                                                                                                                                                           |
| `api_key.minted`                  | customer | POST /v1/api-keys                                                                                                                                                                                                                                                                                                        |
| `api_key.rotated`                 | customer | POST /v1/api-keys/:id/rotate (V-296). 24h grace                                                                                                                                                                                                                                                                          |
| `api_key.revoked`                 | customer | DELETE /v1/api-keys/:id                                                                                                                                                                                                                                                                                                  |
| `session.created`                 | system   | New session row inserted                                                                                                                                                                                                                                                                                                 |
| `session.destroyed`               | system   | Session reached `destroyed`                                                                                                                                                                                                                                                                                              |
| `profile.created`                 | customer | POST /v1/profiles, /clone (V-313 — `payload.cloned_from: "profile_<uuid>"`), or /v1/profile-snapshots/:id/restore (V-312 — `payload.restored_from_snapshot: "psnap_<uuid>"`). Pre-existing format asymmetry: `cloned_from` uses an internal `profile_` prefix; `restored_from_snapshot` uses the public `psnap_` prefix. |
| `profile.deleted`                 | customer | DELETE /v1/profiles/:id                                                                                                                                                                                                                                                                                                  |
| `subscription.tier_changed`       | system   | Stripe portal-driven tier change                                                                                                                                                                                                                                                                                         |
| `webhook_endpoint.created`        | customer | POST /v1/webhooks                                                                                                                                                                                                                                                                                                        |
| `webhook_endpoint.updated`        | customer | PATCH /v1/webhooks/:id (V-351)                                                                                                                                                                                                                                                                                           |
| `webhook_endpoint.deleted`        | customer | DELETE /v1/webhooks/:id                                                                                                                                                                                                                                                                                                  |
| `webhook_endpoint.secret_rotated` | customer | POST /v1/webhooks/:id/rotate-secret (V-359). Payload includes new + old prefixes + grace expiry                                                                                                                                                                                                                          |
| `webhook_delivery.replayed`       | customer | POST /v1/webhook-deliveries/:id/replay (V-307) or POST /v1/webhooks/:id/test (V-356)                                                                                                                                                                                                                                     |
| `team.member_invited`             | customer | Team owner invited a new member                                                                                                                                                                                                                                                                                          |
| `team.invite_accepted`            | customer | Member accepted the invite                                                                                                                                                                                                                                                                                               |
| `team.member_removed`             | customer | Owner removed a member                                                                                                                                                                                                                                                                                                   |
| `admin.refund_recorded`           | staff    | Support recorded a Stripe refund post-hoc                                                                                                                                                                                                                                                                                |
| `admin.support_note`              | staff    | Free-form support-operator note attached to the account                                                                                                                                                                                                                                                                  |

## Filter examples

Latest 25 logins:

```
GET /v1/account/audit-log?action=account.login&limit=25
```

All MFA lifecycle events:

```
GET /v1/account/audit-log?action=account.mfa_enrolled
GET /v1/account/audit-log?action=account.mfa_disabled
GET /v1/account/audit-log?action=account.recovery_code_used
```

(Multi-action filtering in a single call isn't supported; the
dashboard's filter dropdown calls separately and merges client-side
when it needs a composite view.)

Walk every entry:

```
let cursor = null;
while (true) {
  const url = '/v1/account/audit-log?limit=100' + (cursor ? `&cursor=${cursor}` : '');
  const page = await fetch(url, { headers: { authorization: `Bearer ${KEY}` } }).then((r) => r.json());
  for (const entry of page.data) console.log(entry.timestamp, entry.action);
  if (!page.next_cursor) break;
  cursor = page.next_cursor;
}
```

## Export

`GET /v1/account/audit-log/export?format=csv` (or `format=json`)

Returns the FULL audit-log history for the calling account as a
single download (no pagination). Used for GDPR Article 20
portability — customer takes their compliance record off the
platform.

Response headers:

- `Content-Type` — `text/csv` or `application/json`
- `Content-Disposition` — `attachment; filename="audit-log.{ext}"`

Cap: 10,000 rows per file. Older entries remain accessible via the
paginated read endpoint above.

CSV columns: `id`, `timestamp`, `action`, `actor_type`,
`actor_account_id`, `actor_key_id`, `target_resource_id`,
`payload_json`. The `payload_json` column is the JSON-encoded
`payload` field (stringified + escaped per CSV rules).

## Auth + scoping

Both endpoints accept a customer bearer (API key OR web session)
with `read` scope. The X-Driftstack-Account header is honored for
team scopes (V-326c): a member with read access on the team owner
sees the OWNER's audit log when the header is set.

## Errors

| Status | When                                                                   |
| ------ | ---------------------------------------------------------------------- |
| 401    | Missing / invalid bearer                                               |
| 403    | X-Driftstack-Account points at an account the caller isn't a member of |
| 400    | Invalid `limit` (outside [1, 100]) or unknown `action` enum value      |
