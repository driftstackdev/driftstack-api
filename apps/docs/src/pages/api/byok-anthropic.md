---
layout: ../../layouts/DocLayout.astro
title: BYOK Anthropic key
description: Bring-your-own Anthropic API key management — set, rotate, clear, test. Encrypted at rest; never echoed back in responses.
---

# BYOK Anthropic key

The **BYOK Anthropic key** surface lets customers store their own
Anthropic API key against their Driftstack account so
[agent sessions](/api/agent-sessions/) run on the customer's own
Anthropic account instead of Driftstack's
[bundled-LLM](/api/bundled-llm/). A stored key is always used instead
of the bundled LLM; the bundled LLM is used only when no key is set
(and the customer has opted in to it).

## Resource shape

```json
{
  "has_key": true,
  "set_at": "2026-05-12T09:15:00Z",
  "last_used_at": "2026-05-18T16:42:00Z"
}
```

`has_key` is the only stable signal. `set_at` and `last_used_at`
are convenience timestamps; the actual API key plaintext is
NEVER returned in any response — even after a successful PUT.

## Get metadata

`GET /v1/account/me/byok-anthropic-key`

Returns the metadata above. Defaults to
`{ has_key: false, set_at: null, last_used_at: null }` for accounts
that have never set a key.

Required scope: broad `read` (also satisfied by `account_owner`). The
set/use timestamps are account-wide credential metadata, so a
resource-granular or zero-scope key cannot query them. The plaintext
stays inaccessible regardless.

## Set or rotate

`PUT /v1/account/me/byok-anthropic-key`

```json
{ "api_key": "sk-ant-api03-..." }
```

Required scope: `account_owner` (team members can use the key but
cannot manage it).

Validation:

- `api_key` — non-empty string. Server-side validation checks the
  `sk-ant-` prefix; mismatched prefixes return `400 Bad Request`
  (type `…/bad-request`) with a clear message naming the expected shape.

On success the key is stored encrypted and the response is the new
`set_at`:

```json
{ "set_at": "2026-05-18T16:42:00Z" }
```

The plaintext is NEVER echoed. If the customer loses the key,
they must generate a new one from the Anthropic console and PUT
it again (Driftstack cannot recover it).

Rotation: PUT replaces the existing key atomically. There is no
grace window — rotation applies to the next turn on every agent
session, including sessions that were already open. A turn resolves
its key once, up front, so a turn already in flight completes on the
key it started with; you do not need to drain sessions before
rotating.

## Clear

`DELETE /v1/account/me/byok-anthropic-key`

Returns `204 No Content` on success (idempotent — clearing a
non-existent key is also 204). Required scope: `account_owner`.

After clearing, agent sessions fall back to bundled-LLM
(if the customer has opted into bundled-LLM) or surface
`502 ByokAnthropicRequired` (if neither path resolves). This applies
to sessions that were already open as well — clearing takes effect
from their next turn, not only for sessions started afterwards.

## Test connection

`POST /v1/account/me/byok-anthropic-key/test`

Calls Anthropic's authenticated `GET /v1/models?limit=1` endpoint with
the stored key and reports whether the round-trip succeeded. The test
does not run a model or spend inference tokens. Required scope:
`account_owner` (team members would otherwise consume the owner's provider
request budget).

Response (200) on a successful round-trip:

```json
{ "ok": true }
```

On a failed round-trip the response is still `200` with `ok: false`
plus a human-readable `reason` string:

```json
{
  "ok": false,
  "reason": "Anthropic rejected this API key as invalid or unauthorized. Check or rotate it and try again."
}
```

The `reason` text is advisory only — it is not a stable enum, so do
not branch on its exact contents. If no key is set on the account,
the endpoint instead returns `400 Bad Request` (type `…/bad-request`)
telling you to PUT a key first.

The test response NEVER echoes any part of the key, Anthropic's response
body, or a low-level network error. Provider failures map to fixed
invalid-key, rate-limit, service, timeout, or network guidance. The audit
log records only the outcome, never Anthropic's response. The
customer can review `set_at` / `last_used_at`, the test result, and the
corresponding account-audit event.

## Encryption at rest

The key is encrypted at rest with AES-256-GCM and is never returned
in any response. If Driftstack rotates its encryption key, existing
stored keys stop working and customers need to set their key again.

## TTL + rotation reminders

Stored keys carry an implicit 90-day staleness window. After 60 days
the customer receives a one-time reminder email. After 90 days the
stored key is treated as absent: a turn that sends its own
`x-byok-anthropic-api-key` header still works, accounts that have
opted into [bundled-LLM](/api/bundled-llm/) fall back to it, and
otherwise the turn returns `502 byok-anthropic-required` (see
[Errors](#errors) below).

Customers can refresh the staleness window by PUTting the same
key (resets `set_at`) — the timestamp update is enough to
satisfy the 90-day gate.

## Errors

| Status | Type                    | When                                                                                                                                                  |
| -----: | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
|    400 | bad-request             | api_key doesn't match the `sk-ant-` prefix / is empty, or /test was called with no key set                                                            |
|    401 | unauthorized            | missing or invalid bearer token                                                                                                                       |
|    403 | forbidden               | scope check failed (write op without account_owner)                                                                                                   |
|    502 | byok-anthropic-required | session turn resolved no key (no BYOK + no bundled-llm + no fallback) — surfaced from the agent-session message route, not from this surface directly |
|    503 | feature-unavailable     | encrypted key storage is not available on this deployment                                                                                             |

## Privacy

- The plaintext key is encrypted at rest + never logged. It never
  appears in our error reports.
- The API server sends the connection-test request only to the fixed
  Anthropic model-list endpoint. It does not run inference, read or proxy
  the response body, or cache the response.
- Normal agent turns use the customer's key for model calls; the
  connection test is the only other request Driftstack makes with it.
