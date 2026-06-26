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

Auth: any authenticated bearer (the `read` scope is sufficient — the
GET metadata route requires only authentication, not a write scope).
Any account member can check whether the account has a BYOK key set;
the plaintext stays inaccessible regardless.

## Set or rotate

`PUT /v1/account/me/byok-anthropic-key`

```json
{ "api_key": "sk-ant-api03-..." }
```

Required scope: `account_owner` (team members can USE the resolved
key but cannot manage it — Q3 verdict).

Validation:

- `api_key` — non-empty string. Server-side validation checks the
  `sk-ant-` prefix; mismatched prefixes return `400 InvalidKeyFormat`
  with a clear message naming the expected shape.

On success the key is encrypted at rest via AES-256-GCM (sealed
with `MFA_ENCRYPTION_KEY`) and the response is the new `set_at`:

```json
{ "set_at": "2026-05-18T16:42:00Z" }
```

The plaintext is NEVER echoed. If the customer loses the key,
they must generate a new one from the Anthropic console and PUT
it again (Driftstack cannot recover it).

Rotation: PUT replaces the existing key atomically. There is no
grace window — the next agent session turn uses the new key
immediately. Customers running long-lived agent sessions across
a rotation should wait for in-flight turns to complete before
rotating.

## Clear

`DELETE /v1/account/me/byok-anthropic-key`

Returns `204 No Content` on success (idempotent — clearing a
non-existent key is also 204). Required scope: `account_owner`.

After clearing, agent sessions fall through to the bundled-LLM
leg (if the customer has opted into bundled-LLM) or surface
`502 ByokAnthropicRequired` (if neither path resolves).

## Test connection

`POST /v1/account/me/byok-anthropic-key/test`

Sends a minimal Anthropic API ping with the stored key and reports
whether the round-trip succeeded. Required scope: `account_owner`
(team members would otherwise burn the owner's quota).

Response (200):

```json
{ "ok": true, "tested_at": "2026-05-18T16:42:00Z" }
```

On failure:

```json
{
  "ok": false,
  "tested_at": "2026-05-18T16:42:00Z",
  "error_kind": "anthropic_unauthorized",
  "error_detail": "Anthropic API returned 401 — key may be expired or revoked."
}
```

`error_kind` enum:

- `no_key_set` — `has_key: false`; nothing to test.
- `anthropic_unauthorized` — Anthropic returned 401 / 403.
- `anthropic_rate_limited` — Anthropic returned 429.
- `anthropic_server_error` — Anthropic returned 5xx.
- `network_error` — TCP / TLS / DNS failure reaching Anthropic.

The test response NEVER echoes any part of the key (prefix or
otherwise) — the customer's only audit trail is `set_at` /
`last_used_at` plus this test result.

## Encryption at rest

The plaintext is encrypted with AES-256-GCM keyed by the
deployment's `MFA_ENCRYPTION_KEY` env var (shared with the
v2-#8 sub-slice 8.4 gui_control_key encryption per Q2=C). The
canonical blob shape is `[12-byte IV | 16-byte auth tag |
ciphertext]`. Storage column: `accounts.byok_anthropic_key_blob`
(bytea).

Rotation of `MFA_ENCRYPTION_KEY` invalidates every existing BYOK
key — customers re-set after the rotation runbook fires (see
docs/runbooks/mfa-encryption-key-rotation.md).

## TTL + rotation reminders (v2-#21)

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
|    400 | invalid-key-format      | api_key doesn't match the `sk-ant-` prefix / is empty                                                                                                 |
|    401 | unauthorized            | missing or invalid bearer token                                                                                                                       |
|    403 | forbidden               | scope check failed (write op without account_owner)                                                                                                   |
|    502 | byok-anthropic-required | session turn resolved no key (no BYOK + no bundled-llm + no fallback) — surfaced from the agent-session message route, not from this surface directly |
|    503 | feature-unavailable     | deployment hasn't wired the BYOKAnthropicService (typical pre-`MFA_ENCRYPTION_KEY` posture)                                                           |

## Privacy

- The plaintext key is encrypted at rest + never logged. Sentry
  breadcrumbs around the route paths scrub via the V-494 secret
  filter.
- The connection-test endpoint does not log the key plaintext in
  the test failure trail — only the Anthropic-side error code.
- Driftstack does NOT proxy or cache responses from the Anthropic
  API; the customer's BYOK key talks directly to Anthropic from
  the agent-runtime fork.
