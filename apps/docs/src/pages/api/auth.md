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

## Resend verification email

`POST /v1/auth/resend-verification`

```json
{ "email": "you@example.com" }
```

Self-service re-send of the signup verification email, for when the
original expired or never arrived. Returns `200` with the new
token's `expires_at`:

```json
{ "sent": true, "expires_at": "2026-05-23T22:00:00.000Z" }
```

The response shape is **identical** whether the email matched an
unverified account, an already-verified account, or no account at
all — the server silently no-ops in the latter two cases, so the
wire never leaks account existence (same no-enumeration posture as
magic-link and password-reset). Because each call can trigger an
email send, the endpoint is tightly rate-limited per IP (the same
budget as password-reset requests).

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

**SDK usage** (type narrowing + MFA exchange):

```ts
// TypeScript — discriminated-union return type narrows automatically.
const out = await client.auth.login({ email, password });
if ('mfa_required' in out && out.mfa_required) {
  // out: LoginMfaRequiredResponse — challenge_token + challenge_expires_at typed.
  const exchange = await client.auth.mfaChallenge({
    challenge_token: out.challenge_token,
    code: userTotpCode,
  });
  store(exchange.session.token);
} else {
  // out: LoginResponse — out.session is the real session.
  store(out.session.token);
}
```

```python
# Python — dict-shape, branch on the same key.
out = client.auth.login({"email": ..., "password": ...})
if out.get("mfa_required"):
    exchange = client.auth.mfa_challenge({
        "challenge_token": out["challenge_token"],
        "code": user_totp_code,
    })
    session = exchange["session"]
else:
    session = out["session"]
```

```go
// Go — LoginResponse carries both branches; check MfaRequired.
out, err := client.Auth.Login(ctx, &driftstack.LoginRequest{Email: e, Password: p})
if err != nil { return err }
if out.MfaRequired {
    exchange, err := client.Auth.MfaChallenge(ctx, &driftstack.MfaChallengeRequest{
        ChallengeToken: out.ChallengeToken,
        Code:           userTotpCode,
    })
    if err != nil { return err }
    // exchange.Session.Token is the real session.
} else {
    // out.Session.Token is the real session.
}
```

## MFA challenge

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

## MFA step-up

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
link returns the same discriminated union as password login: a normal
`session` when MFA is not enrolled, or `mfa_required` plus a one-time
challenge token when it is. The enrolled branch mints no session until
the caller completes `POST /v1/auth/mfa/challenge`; mailbox access is
the first factor, not a bypass for TOTP or recovery-code proof.

## Password reset

`POST /v1/auth/password-reset/request` with `{ "email": "..." }`.
Same no-enumeration semantics as magic-link: always `200`.

`POST /v1/auth/password-reset/confirm`:

```json
{ "token": "<from email>", "password": "<new password>" }
```

Changes the password and invalidates ALL prior sessions for the
account. It then returns the same discriminated union as login:

- without enrolled MFA, a fresh `session` is issued;
- with enrolled MFA, `mfa_required` is returned and **no replacement
  session** is minted until `POST /v1/auth/mfa/challenge` succeeds.

Every prior device must re-authenticate. The reset-confirming device
is logged in only after it receives the no-MFA session branch or
successfully exchanges the MFA challenge.

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

Returns `200` with `{ "ok": true }`. Subsequent requests with that
token return `401 Unauthorized`.

## Sessions list + revoke

For "active sign-ins" management, see [Account](/api/account/) and
the `/v1/account/web-sessions` endpoints — they let customers see
every device currently signed in and revoke any individual session
or every-other.

## CLI / GUI activation flow

Browser-OAuth-style activation lets CLI and GUI tools obtain an API
key without asking the user to copy/paste from the dashboard. The
dance is three steps — [Initiate](#initiate-activation),
[Bind](#bind-activation-dashboard), then
[Exchange](#exchange-for-the-api-key) — each backed by one endpoint
below.

## Initiate activation

`POST /v1/auth/cli-authorize/initiate`

Step 1 — **Initiate** — the CLI/GUI generates a CSRF nonce + optional
client label, calls `POST /v1/auth/cli-authorize/initiate`, and
gets back a one-shot `code`, a separate device-displayed `user_code`,
and a `browser_url` that opens the dashboard's Authorize page.

## Bind activation (dashboard)

`POST /v1/auth/cli-authorize/bind-device-code`

Step 2 — **Bind** — the user signs in to the dashboard (if not already),
types the `user_code` shown by the initiating device, and clicks
Authorize. The dashboard hits
`POST /v1/auth/cli-authorize/bind-device-code` with the user's
web-session bearer; the server mints a scoped API key on the calling
account and stores only its encrypted envelope under a hashed code
identifier (Redis, 2-minute post-bind TTL).

## Exchange for the API key

`POST /v1/auth/cli-authorize/exchange`

Step 3 — **Exchange** — the CLI/GUI polls
`POST /v1/auth/cli-authorize/exchange` until the response
transitions from `{ status: "pending" }` to
`{ status: "bound", api_key, account_id }`. Bound is one-shot: the
server deletes the code as it hands back the key, so a subsequent
poll returns `{ status: "expired" }` (HTTP `200`). The same
`{ status: "expired" }` is returned if the user takes too long;
either way the CLI/GUI restarts the flow.

## CSRF state

The `state` parameter is a client-supplied 16-128 character random
nonce. The dashboard echoes it back; the server verifies it matches
on `bind` — defends against the dashboard being tricked into binding
a code that wasn't issued in the same session.

## SDK example

```ts
const { code, user_code, browser_url } = await client.auth.cliAuthorizeInitiate({
  state: crypto.randomUUID(),
  client_label: 'My CLI on darwin-arm64',
});
console.log(`Enter ${user_code} in the browser to approve this device.`);
open(browser_url); // open in system browser

for (;;) {
  const out = await client.auth.cliAuthorizeExchange({ code, state });
  if (out.status === 'bound') {
    saveApiKey(out.api_key);
    break;
  }
  if (out.status === 'expired') throw new Error('User took too long');
  await sleep(2000);
}
```

```python
out = client.auth.cli_authorize_initiate({
    "state": secrets.token_urlsafe(24),
    "client_label": "My CLI",
})
print(f'Enter {out["user_code"]} in the browser to approve this device.')
webbrowser.open(out["browser_url"])

while True:
    poll = client.auth.cli_authorize_exchange({
        "code": out["code"],
        "state": state,
    })
    if poll["status"] == "bound":
        save_api_key(poll["api_key"])
        break
    if poll["status"] == "expired":
        raise RuntimeError("expired")
    time.sleep(2)
```

```go
init, _ := client.Auth.CliAuthorizeInitiate(ctx, &driftstack.CliAuthorizeInitiateRequest{
    State:       state,
    ClientLabel: "My Go CLI",
})
fmt.Printf("Enter %s in the browser to approve this device.\n", init.UserCode)
exec.Command("open", init.BrowserURL).Run()

for {
    poll, _ := client.Auth.CliAuthorizeExchange(ctx, &driftstack.CliAuthorizeExchangeRequest{
        Code:  init.Code,
        State: state,
    })
    if poll.Status == "bound" {
        saveAPIKey(poll.APIKey)
        break
    }
    if poll.Status == "expired" {
        return errors.New("expired")
    }
    time.Sleep(2 * time.Second)
}
```

## Default scopes

The minted key carries `["account_owner"]` scope by default. CLI tools
that only need read access should pass `scopes: ["read"]` on the
`bind` call to follow least-privilege; GUI clients that drive sessions
end-to-end keep the default.

## Auth + scoping

None of `/v1/auth/*` honors the team-RBAC
`X-Driftstack-Account` header — auth is always per-credential, not
per-team-context. The team header is only consulted on `/v1/*`
endpoints that operate on resources (sessions, profiles, webhooks,
…). See [Team RBAC](/api/team/) for the full list.
