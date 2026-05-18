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

`actor_account_id` is the **calling** account for `customer` actions
— which is NOT necessarily the same as the row's `account_id`.
When a team member acts on the owner's account via the
`X-Driftstack-Account` header , the entry lands on the
**owner's** audit log (`account_id = acc_<owner>`) but
`actor_account_id` records the **member** who performed the
action (`acc_<member>`). Owners reading their audit log can
therefore see "who on my team did what" without separate
correlation. Self-action audit entries have
`actor_account_id == account_id`.

`actor_key_id` is the synthetic `wsk_<session-uuid>` for web-session
calls and `key_<key-uuid>` for API-key calls. Both are `null` for
`system` and `staff` events.

`ip_address` and `user_agent` (top-level fields on the entry) are
surfaced in the schema but deliberately null in production
customer-facing responses for privacy (per the): the dashboard
rendering doesn't display them, and the admin tooling reads them
out of a separate internal store.

**Caveat (V-413):** the auth-flow audit events
(`account.email_verified`, `account.login`, `account.logout`,
`account.password_changed`) currently store `issued_from_ip` +
`user_agent` inside `payload` — contrary to the intent at
the row-level columns. The fields appear in the customer's own
audit log (acceptable under GDPR Article 15 right of access to
own data) AND in a team member's view of the owner's audit log
when the member uses the X-Driftstack-Account header
to read the owner's account. Team owners aware of this caveat
can mitigate by limiting team-member access to admins-only or by
filing a privacy request; a server-side payload scrub is queued
as a separate slice (TD-audit-payload-scrub) since it touches
both new emit paths AND historical row backfill.

## Action catalog

| Action                             | Origin   | Notes                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `account.email_verified`           | system   | Customer clicked the verify-email link                                                                                                                                                                                                                                                                       |
| `account.login`                    | customer | Successful sign-in. `payload.method` ∈ {`password`, `magic_link`, `password_reset`, `mfa_totp`, `mfa_recovery`}                                                                                                                                                                                              |
| `account.logout`                   | customer | Web session revoked                                                                                                                                                                                                                                                                                          |
| `account.password_changed`         | customer | Password reset confirmed                                                                                                                                                                                                                                                                                     |
| `account.mfa_enrolled`             | customer | First successful TOTP verify                                                                                                                                                                                                                                                                                 |
| `account.mfa_disabled`             | customer | DELETE /v1/account/mfa (/e)                                                                                                                                                                                                                                                                                  |
| `account.recovery_code_used`       | customer | Recovery code consumed (login or step-up). `payload.remaining`                                                                                                                                                                                                                                               |
| `api_key.minted`                   | customer | POST /v1/api-keys                                                                                                                                                                                                                                                                                            |
| `api_key.rotated`                  | customer | POST /v1/api-keys/:id/rotate . 24h grace                                                                                                                                                                                                                                                                     |
| `api_key.revoked`                  | customer | DELETE /v1/api-keys/:id                                                                                                                                                                                                                                                                                      |
| `session.created`                  | system   | New session row inserted                                                                                                                                                                                                                                                                                     |
| `session.destroyed`                | system   | Session reached `destroyed`                                                                                                                                                                                                                                                                                  |
| `profile.created`                  | customer | POST /v1/profiles, /clone (— `payload.cloned_from: "profile_<uuid>"`), or /v1/profile-snapshots/:id/restore (— `payload.restored_from_snapshot: "psnap_<uuid>"`). Pre-existing format asymmetry: `cloned_from` uses an internal `profile_` prefix; `restored_from_snapshot` uses the public `psnap_` prefix. |
| `profile.deleted`                  | customer | DELETE /v1/profiles/:id                                                                                                                                                                                                                                                                                      |
| `profile.exported`                 | customer | GET /v1/profiles/:id/export . Payload carries `source_profile_id` + `source_account_id` for portability lineage                                                                                                                                                                                              |
| `profile.imported`                 | customer | POST /v1/profiles/import — new profile minted from an export envelope; payload mirrors the source ids                                                                                                                                                                                                        |
| `subscription.tier_changed`        | system   | Stripe portal-driven tier change                                                                                                                                                                                                                                                                             |
| `webhook_endpoint.created`         | customer | POST /v1/webhooks                                                                                                                                                                                                                                                                                            |
| `webhook_endpoint.updated`         | customer | PATCH /v1/webhooks/:id                                                                                                                                                                                                                                                                                       |
| `webhook_endpoint.deleted`         | customer | DELETE /v1/webhooks/:id                                                                                                                                                                                                                                                                                      |
| `webhook_endpoint.secret_rotated`  | customer | POST /v1/webhooks/:id/rotate-secret . Payload includes new + old prefixes + grace expiry                                                                                                                                                                                                                     |
| `webhook_delivery.replayed`        | customer | POST /v1/webhook-deliveries/:id/replay or POST /v1/webhooks/:id/test                                                                                                                                                                                                                                         |
| `team.member_invited`              | customer | Team owner invited a new member                                                                                                                                                                                                                                                                              |
| `team.invite_accepted`             | customer | Member accepted the invite                                                                                                                                                                                                                                                                                   |
| `team.member_removed`              | customer | Owner removed a member                                                                                                                                                                                                                                                                                       |
| `admin.refund_recorded`            | staff    | Support recorded a Stripe refund post-hoc                                                                                                                                                                                                                                                                    |
| `admin.support_note`               | staff    | Free-form support-operator note attached to the account                                                                                                                                                                                                                                                      |
| `agent.decompose.claude`           | system   | Per-turn AI agent decompose() call against Claude. Payload: result-kind discriminant + token counts + cost cents (operator-only surface; the customer sees the plan/clarify/refuse in their dashboard chat UI).                                                                                              |
| `agent.decompose.deterministic`    | system   | Per-turn AI agent decompose() call against the deterministic decomposer. Payload: result-kind discriminant (no token / cost counters — deterministic is free).                                                                                                                                               |
| `agent_session.pair_mode.takeover` | customer | POST /v1/agent-sessions/:id/takeover — pair-mode state-machine transition out of `ai-driving`. Payload: `{ from, to, client_id }`.                                                                                                                                                                           |
| `agent_session.pair_mode.handback` | customer | POST /v1/agent-sessions/:id/handback — pair-mode state-machine transition out of `human-driving`. Payload: `{ from, to }`.                                                                                                                                                                                   |
| `agent_session.pair_mode.timeout`  | system   | Heartbeat timeout sweep promoted the pair-mode session back to `ai-driving` after 30s of no client heartbeat. Payload: `{ from, to }`.                                                                                                                                                                       |

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

## Payload reference

Several action types carry typed `payload` fields the customer
dashboard renders inline. Consumers parsing the JSON should expect
the following shapes:

```json
// account.login
{ "method": "password" | "magic_link" | "password_reset" | "mfa_totp" | "mfa_recovery" }

// account.recovery_code_used
{ "remaining": <integer 0-9> }

// profile.created — three creation paths
{ "name": "<profile-name>", "archetype": "<archetype-slug>" }                          // direct create
{ "name": "...", "archetype": "...", "cloned_from": "profile_<uuid>" } // clone
{ "name": "...", "archetype": "...", "restored_from_snapshot": "psnap_<uuid>" } // restore

// webhook_endpoint.secret_rotated (V-359)
{
  "new_secret_prefix": "whsec_<first-12>",
  "old_secret_prefix": "whsec_<first-12>",
  "grace_expires_at": "2026-05-10T00:00:00.000Z"
}

// team.member_invited
{ "invitee_email": "<invited-address>", "role": "admin" | "member" }

// subscription.tier_changed
{ "from": "<tier-slug>", "to": "<tier-slug>" }

// api_key.minted
{ "name": "<key-name>", "scopes": ["read", "write"] }
```

Other action types carry minimal payloads (often `{}` or a single
contextual field — e.g. `account.password_changed` is empty).
Consumers should default-handle unknown payload shapes gracefully;
new fields are additive.

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

JSON envelope:

```json
{
  "generated_at": "2026-05-09T18:00:00Z",
  "account_id": "acc_abc",
  "row_count": 142,
  "truncated": false,
  "data": [
    /* up to 10,000 audit-log entries — same shape as the read endpoint */
  ]
}
```

The `truncated` flag is `true` when the row count hit the 10,000-row
ceiling and older entries weren't included. Customers needing the
full history should narrow the date window or paginate via the
read endpoint above.

### SDK examples (; JSON branch only)

The SDKs expose the JSON branch only — CSV download is browser-driven
and not useful through a typed SDK call. Customers wanting CSV hit
the URL directly with their bearer.

```ts
const dump = await client.auditLog.export();
console.log(dump.row_count, dump.truncated);
for (const entry of dump.data) {
  console.log(entry.timestamp, entry.action, entry.target_resource_id);
}
```

```python
dump = client.audit_log.export()
print(dump["row_count"], dump["truncated"])
for entry in dump["data"]:
    print(entry["timestamp"], entry["action"])
```

```go
dump, _ := client.AuditLog.Export(ctx)
fmt.Println(dump.RowCount, dump.Truncated)
for _, entry := range dump.Data {
    fmt.Println(entry.Timestamp, entry.Action)
}
```

## Auth + scoping

Both endpoints accept a customer bearer (API key OR web session)
with `read` scope. The X-Driftstack-Account header is honored for
team scopes : a member with read access on the team owner
sees the OWNER's audit log when the header is set.

## Errors

| Status | When                                                                   |
| ------ | ---------------------------------------------------------------------- |
| 401    | Missing / invalid bearer                                               |
| 403    | X-Driftstack-Account points at an account the caller isn't a member of |
| 400    | Invalid `limit` (outside [1, 100]) or unknown `action` enum value      |
