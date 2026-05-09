---
layout: ../../layouts/DocLayout.astro
title: Authentication flows
description: Sign up, log in, verify email, MFA challenge + step-up, magic link, password reset, refresh, and logout for the customer dashboard. Distinct from API-key bearer auth used by SDK consumers.
---

# Authentication flows

Driftstack has two auth surfaces:

1. **API-key bearer auth** for SDK consumers — covered in
   [API keys](/api/api-keys/). The 99% case for production code.
2. **Web-session auth** for the customer dashboard — covered here.
   Email + password (or magic link), optional TOTP, exchanged for an
   opaque session token stored in the dashboard's local storage.

Both auth modes use the same `Authorization: Bearer <token>` header.
The server distinguishes them by token shape (`ds_live_…` /
`ds_test_…` for API keys; opaque base64 for web sessions).

## Sign up

`POST /v1/auth/signup`

```json
{
  "email": "you@example.com",
  "password": "<min 12 chars>",
  "name": "Acme B.V."
}
```

Returns `200` with `verification_email_expires_at` (ISO timestamp).
The account exists in `unverified` status until the customer clicks
the verification link emailed to `email`. The link's token expires
at the timestamp returned.

`409 Conflict` is returned when `email` is already registered.

## Verify email

`POST /v1/auth/verify-email`

```json
{ "token": "<from the verification email>" }
```

Returns `200` with a fresh web session:

```json
{
  "session": {
    "token": "<opaque base64>",
    "expires_at": "2026-05-23T22:00:00.000Z",
    "account_id": "acc_<uuid>"
  }
}
```

The dashboard stores `session.token` in local storage and uses it
as the bearer for every subsequent `/v1/*` request. Verifying email
also marks the account `active` so the customer can sign in
directly afterward.

## Log in

`POST /v1/auth/login`

```json
{ "email": "you@example.com", "password": "<password>" }
```

Returns a **discriminated union**:

- **No MFA enrolled** — same shape as `verify-email`:
  ```json
  { "session": { "token": "...", "expires_at": "...", "account_id": "..." } }
  ```
- **MFA enrolled** — challenge token returned; the dashboard drops
  into the second-factor UI:
  ```json
  {
    "mfa_required": true,
    "challenge_token": "<one-time, expires in 5 minutes>",
    "challenge_expires_at": "2026-05-09T22:35:00.000Z"
  }
  ```

Branch on the `mfa_required` literal. When it's present + true, do
not store anything — wait for the customer to enter their TOTP
code and call the challenge endpoint below.

**SDK usage** (V-423/V-441 type narrowing):

```ts
// TypeScript — discriminated-union return type narrows automatically.
const out = await client.auth.login({ email, password });
if ('mfa_required' in out && out.mfa_required) {
  // out: LoginMfaRequiredResponse — challenge_token + challenge_expires_at typed.
  const session = await client.auth.exchangeMfaChallenge({
    challenge_token: out.challenge_token,
    code: userTotpCode,
  });
} else {
  // out: LoginResponse — out.session is the real session.
  store(out.session.token);
}
```

```python
# Python — dict-shape, branch on the same key.
out = client.auth.login({"email": ..., "password": ...})
if out.get("mfa_required"):
    session = client.auth.mfa_challenge({
        "challenge_token": out["challenge_token"],
        "code": user_totp_code,
    })["session"]
else:
    session = out["session"]
```

```go
// Go — LoginResponse carries both branches; check MfaRequired.
out, err := client.Auth.Login(ctx, &driftstack.LoginRequest{Email: e, Password: p})
if err != nil { return err }
if out.MfaRequired {
    // out.ChallengeToken / out.ChallengeExpiresAt populated.
} else {
    // out.Session.Token is the real session.
}
```

## MFA challenge (V-353d)

`POST /v1/auth/mfa/challenge`

```json
{
  "challenge_token": "<from the login response>",
  "code": "123456" // OR "recovery_code": "ABCDE-FGHJK"
}
```

Returns the same `session` shape as a non-MFA login. The
discriminator `via: "totp" | "recovery"` indicates which factor
was used; `recovery_code` consumption decrements
`unused_recovery_codes` on the account and is recorded as
`account.recovery_code_used` in the audit log with
`payload.remaining`.

## MFA step-up (V-353e)

`POST /v1/auth/mfa/step-up`

Refreshes `mfa_satisfied_at` on the calling web session. Used by
the dashboard when a sensitive operation (disable MFA, regenerate
recovery codes, delete account) requires re-asserting the second
factor within a 15-minute freshness window.

```json
{ "code": "123456" }
```

Returns `200`; no new session issued — the existing session row
gets `mfa_satisfied_at = now()`.

## Magic link

For customers who prefer email-based sign-in over password:

`POST /v1/auth/magic-link/request` with `{ "email": "..." }`. Always
returns `200` regardless of whether the address matches an account
(no account-enumeration signal). When the address does match, an
email is delivered with a one-time link.

`POST /v1/auth/magic-link/consume` with `{ "token": "..." }` from the
link returns the same `session` shape as `verify-email`.

## Password reset

`POST /v1/auth/password-reset/request` with `{ "email": "..." }`.
Same no-enumeration semantics as magic-link: always `200`.

`POST /v1/auth/password-reset/confirm`:

```json
{ "token": "<from email>", "password": "<new password>" }
```

Issues a fresh session and invalidates ALL prior sessions for the
account (per V-303 active-sessions rev). The customer is logged in
on the device that confirmed the reset; every other device must
re-authenticate.

## Refresh

`POST /v1/auth/refresh`

```json
{ "token": "<existing session token>" }
```

Issues a fresh session token with a new `expires_at`. The previous
token is invalidated. Use this to keep dashboard sessions alive
without re-prompting for credentials.

## Logout

`POST /v1/auth/logout`

```json
{ "token": "<session to revoke>" }
```

Returns `204 No Content`. Subsequent requests with that token
return `401 Unauthorized`.

## Sessions list + revoke (V-355)

For "active sign-ins" management, see [Account](/api/account/) and
the `/v1/account/web-sessions` endpoints — they let customers see
every device currently signed in and revoke any individual session
or every-other.

## Auth + scoping

None of `/v1/auth/*` honors the team-RBAC
`X-Driftstack-Account` header — auth is always per-credential, not
per-team-context. The team header is only consulted on `/v1/*`
endpoints that operate on resources (sessions, profiles, webhooks,
…). See [Team RBAC](/api/team/) for the full list.
