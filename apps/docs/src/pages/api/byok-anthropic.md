---
layout: ../../layouts/DocLayout.astro
title: BYOK Anthropic key
description: Bring-your-own Anthropic API key management — set, rotate, clear, test. Encrypted at rest; never echoed back in responses.
---

# BYOK Anthropic key

The **BYOK Anthropic key** surface lets customers store their own
Anthropic API key against their Driftstack account so the
[agent session](/api/agent-sessions/) decomposer runs against the
customer's Anthropic billing rail instead of Driftstack's
[bundled-LLM](/api/bundled-llm/). BYOK always wins over bundled-LLM
in the resolution chain — per Driftstack design verdict Q4=A
(2026-05-16), BYOK is the v1.0 primary path; bundled-LLM is the
no-BYOK fallback.

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

Required scope: `account_owner` (team members can USE the resolved
key but cannot manage it — Q3 verdict).

Validation:

- `api_key` — non-empty string. Server-side validation checks the
  `sk-ant-` prefix; mismatched prefixes return `400 Bad Request`
  (type `…/bad-request`) with a clear message naming the expected shape.

On success the key is encrypted at rest via AES-256-GCM (sealed
with `MFA_ENCRYPTION_KEY`) and the response is the new `set_at`:

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

After clearing, agent sessions fall through to the bundled-LLM
leg (if the customer has opted into bundled-LLM) or surface
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

The test response NEVER echoes any part of the key, Anthropic response
body, or native transport error. Provider failures map to fixed invalid-key,
rate-limit, service, timeout, or network guidance. Audit and metrics retain
only a bounded outcome; they do not record the upstream response. The
customer can review `set_at` / `last_used_at`, the test result, and the
corresponding account-audit event.

## Encryption at rest

The plaintext is encrypted with AES-256-GCM keyed by the
deployment's `MFA_ENCRYPTION_KEY` env var (shared with encrypted
GUI control keys). The
canonical blob shape is `[12-byte IV | 16-byte auth tag |
ciphertext]`. Storage column: `accounts.byok_anthropic_key_blob`
(bytea).

Rotation of `MFA_ENCRYPTION_KEY` invalidates every existing BYOK
key — customers re-set after the rotation runbook fires (see
docs/runbooks/mfa-encryption-key-rotation.md).

## TTL + rotation reminders

Stored keys carry an implicit 90-day staleness window. After 60
days the customer receives a one-time Postmark reminder email
(`sendByokAnthropicKeyRotationReminder`). After 90 days the
`BYOKAnthropicService.getPlaintext({ now })` call returns null
(treats the stored key as absent), forcing the resolution chain
to fall through to header / bundled / fallback per the agent
session route's posture.

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
|    503 | feature-unavailable     | encrypted BYOK key storage is unavailable for this deployment (for example, encryption configuration is missing)                                      |

## Privacy

- The plaintext key is encrypted at rest + never logged. Sentry
  breadcrumbs around the route paths use the shared secret-redaction
  filter.
- The API server sends the connection-test request only to the fixed
  Anthropic model-list endpoint. It does not run inference, read or proxy
  the response body, or cache the response.
- Normal agent turns continue to use the customer's key from the
  agent-runtime fork; the connection-test route is the only server-side
  provider probe described here.
