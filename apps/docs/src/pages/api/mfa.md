---
layout: ../../layouts/DocLayout.astro
title: Two-factor authentication (MFA)
description: TOTP enrollment, verification, login challenge, step-up reauth, recovery codes — the /v1/account/mfa and /v1/auth/mfa endpoints.
---

# Two-factor authentication (MFA)

Driftstack supports time-based one-time passwords (TOTP) per RFC 6238
plus single-use recovery codes. Once enrolled, sign-in to the dashboard
requires a 6-digit code from your authenticator app, and the most
sensitive operations (disabling MFA; future: account deletion) require
a fresh code within a 15-minute window.

This doc covers the API surface. The dashboard at `/settings → Two-factor
authentication` wraps these endpoints into a flow most customers will
never need to call directly.

MFA credential changes are interactive-account operations. `POST /enroll`,
`POST /verify`, both disable routes, and recovery-code regeneration require a
web-session bearer; API keys cannot call them, even with `account_owner`.
`GET /v1/account/mfa` remains available to appropriately scoped API keys for
status and monitoring only.

## Enrollment

Enrollment is a two-step flow: start enrollment to mint a fresh TOTP
secret, then verify a code from the authenticator app to activate it
and receive recovery codes.

## Start enrollment

`POST /v1/account/mfa/enroll`

Requires an interactive web-session bearer. No body. Generates a fresh TOTP
secret on the server, encrypts it at
rest, and returns the otpauth URI for QR rendering plus the manual-
entry base32 secret.

Response (200):

```json
{
  "otpauth_uri": "otpauth://totp/Driftstack:you@example.com?secret=...&issuer=Driftstack&algorithm=SHA1&digits=6&period=30",
  "secret_base32": "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
  "algorithm": "SHA1",
  "digits": 6,
  "period_seconds": 30
}
```

If MFA is **already enrolled**, the endpoint returns `409 Conflict`.
Disable first via `DELETE /v1/account/mfa`, then re-enroll.

Re-calling `/enroll` while still pending (no `/verify` yet) is OK —
each call returns a fresh secret. The customer's authenticator app
should be re-scanned each time.

## Confirm + receive recovery codes

`POST /v1/account/mfa/verify`

Requires the same interactive web-session boundary as start enrollment; an
API key cannot activate a pending factor.

```json
{
  "code": "123456"
}
```

The server checks the 6-digit against the pending secret with ±1
window drift tolerance (90 seconds total). On success, marks the
enrollment active and returns 10 single-use recovery codes:

Response (200):

```json
{
  "recovery_codes": [
    "ABCDE-FGHJK",
    "MNPQR-STVWX",
    ...
  ]
}
```

> **Recovery codes are shown ONCE.** Store them somewhere safe (a
> password manager, a printed copy, a secure note). Each code works
> exactly once. Without your authenticator AND these codes, account
> access requires support intervention.

If the code is invalid, the endpoint returns `400 Bad Request`. The
pending secret stays alive — the customer can retype within the
authenticator's window. If the code is malformed (not 6 digits) the
response is also 400.

## Status

`GET /v1/account/mfa`

Requires the broad `read` scope; `account_owner` also satisfies the
gate. Resource-granular and zero-scope keys cannot inspect enrollment,
last-use, or remaining recovery-code metadata.

Response (200):

```json
{
  "enrolled": true,
  "enrolled_at": "2026-05-08T22:14:11.000Z",
  "last_used_at": "2026-05-08T22:30:55.000Z",
  "unused_recovery_codes": 9
}
```

When not enrolled: `enrolled: false`, both timestamps null,
`unused_recovery_codes: 0`.

## Login challenge

When MFA is enrolled, `POST /v1/auth/login` responds with a
challenge token instead of a session:

Request:

```json
{ "email": "you@example.com", "password": "..." }
```

Response (200):

```json
{
  "mfa_required": true,
  "challenge_token": "...",
  "challenge_expires_at": "2026-05-08T22:35:00.000Z"
}
```

The token is valid for 5 minutes, single-use, and bound to the
issuing IP address. Exchange it for the real session at:

`POST /v1/auth/mfa/challenge`

```json
{
  "challenge_token": "...",
  "code": "123456"
}
```

Or use a recovery code (hyphen optional; codes normalize to upper-
case + no separators internally):

```json
{
  "challenge_token": "...",
  "recovery_code": "ABCDE-FGHJK"
}
```

Response (200):

```json
{
  "session": {
    "token": "ds_web_session_token_...",
    "expires_at": "2026-06-07T22:30:00.000Z",
    "account_id": "acc_..."
  },
  "via": "totp"
}
```

`via` is `"totp"` when matched against the 6-digit; `"recovery"` when
a recovery code was consumed. Recovery-code success consumes the row
permanently — it can't be used again.

Failure modes:

- Invalid 6-digit / recovery code: `400 Bad Request`. Token is NOT
  consumed; customer can retype.
- Token expired or unknown: `400 Bad Request`.
- Token + IP mismatch: `400 Bad Request`. Defense against challenge-
  token theft from chat / email paste; legitimate caller is on the
  same IP.
- Token already consumed (re-use after success): `400 Bad Request`.

Magic-link sign-in, password-reset confirm, and email-verification do
NOT trigger the MFA challenge. Those flows prove ownership of the
email address via single-use link; the MFA gate fires at the next
`/v1/auth/login`.

## Step-up reauth

Some operations require a fresh MFA proof (currently: disabling MFA;
the locked verdict adds account-deletion when self-service
deletion ships). When a gated route is called without a fresh proof,
it returns:

```
403 Forbidden
Content-Type: application/problem+json

{
  "type": "https://errors.driftstack.dev/mfa-step-up-required",
  "title": "MFA step-up required",
  "status": 403,
  "detail": "This action requires a fresh MFA challenge. ...",
  "requires_mfa_step_up": true,
  "reason": "never_satisfied"
}
```

`reason` is `"never_satisfied"` when the calling session has never
passed an MFA challenge (e.g. a session issued by signup-verify
before MFA was enrolled), and `"expired"` when the freshness window
(15 minutes) has elapsed since the last successful challenge.

The client posts a 6-digit (or recovery) code to:

`POST /v1/auth/mfa/step-up`

```json
{ "code": "123456" }
```

Response (200):

```json
{
  "via": "totp",
  "mfa_satisfied_at": "2026-05-08T22:34:11.000Z"
}
```

The `mfa_satisfied_at` field on the calling session is updated to
"now"; gated routes pass for the next 15 minutes. The original
gated request can be retried.

The generic step-up middleware has a machine-auth carve-out because an API key
has no human session to refresh. MFA credential-management routes do not rely
on that carve-out: they reject API-key bearers before step-up evaluation.
`POST /v1/auth/mfa/step-up` itself also returns 403 for an API key because
there is no session row to refresh.

## Disabling

`DELETE /v1/account/mfa`

The same operation is also exposed as `POST /v1/account/mfa/disable`
— an alias route with the same body, gates, and semantics.

```json
{ "confirm": "disable-mfa" }
```

Both endpoints require:

1. Interactive web-session bearer; API-key bearers are rejected even when the
   key has `account_owner`.
2. A fresh MFA proof (15-minute window). On stale, the response is
   the 403 step-up envelope above.
3. The `confirm: "disable-mfa"` body field — defensive layer beneath
   the gate so a stray client request can't accidentally disable.

Response: `204 No Content`. Idempotent on already-disabled accounts.

Disabling clears the TOTP secret AND every unused recovery code.
Re-enabling requires the full enrollment dance from scratch.

## Recovery code regeneration

`POST /v1/account/mfa/recovery-codes/regenerate`

No body. Marks every prior unused code consumed; mints 10 new codes;
returns them in the same shape as the enrollment response:

Response (200):

```json
{
  "recovery_codes": [
    "WERTY-PASDF",
    ...
  ]
}
```

This endpoint **is** step-up gated, the same as MFA disable and
account-delete: a stale web session returns the `403` step-up
envelope above (`requires_mfa_step_up: true`). Without the gate a
stolen web session could mint fresh recovery codes, then redeem one
to satisfy step-up on disable — a full MFA bypass. The legitimate
lost-device-but-logged-in flow still works: an existing recovery
code satisfies `POST /v1/auth/mfa/step-up` before regenerating.
API-key callers are rejected before the step-up gate and cannot replace the
human account's recovery credentials.

Returns `404 Not Found` when the calling account isn't enrolled.

## Algorithm details

| Field               | Value                          |
| ------------------- | ------------------------------ |
| Algorithm           | SHA-1                          |
| Period              | 30 seconds                     |
| Digits              | 6                              |
| Drift tolerance     | ±1 window (90s total)          |
| Issuer              | `Driftstack`                   |
| At-rest encryption  | AES-256-GCM (env-keyed)        |
| Recovery code shape | 10 chars, Crockford base32     |
| Recovery code count | 10 per enrollment / regenerate |
| Recovery code hash  | scrypt-kdf (same as API keys)  |
| Challenge token TTL | 5 minutes                      |
| Step-up freshness   | 15 minutes                     |

SHA-1 is the RFC 6238 default and what every authenticator app
(Google Authenticator, 1Password, Authy, Bitwarden, etc.) supports.
SHA-256/SHA-512 are out of scope for v1.

## Audit trail

Every MFA lifecycle event lands in the customer audit log
(`GET /v1/account/audit-log`):

| Action                       | When                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `account.mfa_enrolled`       | First successful `/verify`                                                        |
| `account.mfa_disabled`       | Successful disable                                                                |
| `account.recovery_code_used` | Recovery code consumed (login or step-up)                                         |
| `account.login`              | Successful challenge exchange (with `method: mfa_totp` or `mfa_recovery` payload) |
