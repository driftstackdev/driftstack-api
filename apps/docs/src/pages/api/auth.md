---
layout: ../../layouts/DocLayout.astro
title: Authentication flows
description: Sign up, log in, verify email, MFA challenge + step-up, magic link, password reset, refresh, and logout for the customer dashboard. Distinct from API-key bearer auth used by SDK consumers.
---

# Authentication flows

Driftstack has three auth surfaces:

1. **Customer API-key bearer auth** for SDK consumers on any paid
   tier, including Manual — covered in [API keys](/api/api-keys/).
2. **Web-session auth** for the customer dashboard — covered here.
   Email + password (or magic link), optional TOTP, exchanged for an
   opaque session token stored in the dashboard's local storage.
3. **Browser-authorized device credentials** for the desktop app.
   On Free, this restricted `ds_test_…` credential is stored
   automatically and is limited to the supported desktop route surface;
   it is not a general sandbox/customer key.

All three use the same `Authorization: Bearer <token>` header. Paid
customer keys use `ds_live_…`; the desktop device flow returns a
device credential (`ds_test_…` on Free); web sessions are
opaque base64 tokens. The server enforces the stored credential type
and account tier as well as the token shape.

Ordinary customer API keys and OAuth access tokens are rejected while
their account is on Free, on every request.
They resume after an upgrade unless separately revoked or expired. The
response is the normal RFC 9457 `403 Forbidden`, with actionable detail:
`The "apiAccess" feature is not available on the "free" tier. Upgrade to a tier that includes this feature.`

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
The link's token expires at the timestamp returned.

There is no `unverified` account status — `status` is one of
`active`, `suspended`, `deleted`, and a new signup is created
`active`. What verification changes is `email_verified_at`, which
starts null and is stamped when the customer clicks the link. Gates
that care about verification test that field, not `status`; `login`
refuses while it is null.

`409 Conflict` is returned when `email` is already registered.

## Verify email

`POST /v1/auth/verify-email`

```json
{ "token": "<from the verification email>", "password": "<the password chosen at signup>" }
```

When the account has a password, verifying needs it too. The link proves
you control the mailbox; the password proves you are the person who signed
up. Without it, or with a wrong one, the answer is `401` with
`password_required: true`, and the link stays usable, so a mistyped password
can be fixed and sent again. If you didn't sign up, ignore the email: nobody
can use the account until the address is confirmed. If you forgot the
password, a [password reset](#password-reset) confirms the address too.
An account with no password (created by Google or GitHub sign-in) sends the
token alone.

Returns a **discriminated union**, the same shape as `login`:

- **No MFA enrolled** — `200` with a fresh web session:
  ```json
  {
    "session": {
      "token": "<opaque base64>",
      "expires_at": "2026-05-23T22:00:00.000Z",
      "account_id": "acc_<uuid>"
    }
  }
  ```
- **MFA enrolled** — `200` with a challenge instead of a session:
  ```json
  {
    "mfa_required": true,
    "challenge_token": "<one-time, expires in 5 minutes>",
    "challenge_expires_at": "2026-05-09T22:35:00.000Z"
  }
  ```

Verifying an email proves control of the mailbox, not possession of the
account's second factor, so an enrolled account gets a challenge here exactly
as it does on `login`, `magic-link/consume` and `password-reset/confirm`.
Exchange it at `/v1/auth/mfa/challenge` as described below. The email is
marked verified either way — only the session waits for the second factor.

Branch on the `mfa_required` literal, never on the presence of `session`.

The dashboard stores `session.token` in local storage and uses it
as the bearer for every subsequent `/v1/*` request. Verifying email
stamps `email_verified_at`; it does not change `status`, which was
already `active`. That stamp is what lets the customer sign in
directly afterward, since `login` refuses an unverified address.

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
budget as password-reset requests) and per address — see
[How often one address is emailed](#how-often-one-address-is-emailed).

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

Password sign-in is limited per email as well as per IP address. After
10 incorrect passwords for one email within 15 minutes, sign-in with a
password for that email is refused with `429` and `Retry-After` for 15
minutes, from any address. Gmail addresses that differ only in dots,
`+tag` or capital letters count as one email. The limit applies the same
way whether or not an account exists, so it does not reveal which emails
are registered. A correct password clears the count, and so does a
completed password reset.

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

A refused code answers `400` with a `detail` that says what to do next:
try the code again, sign in again (after 5 wrong codes on one challenge,
or when the challenge came from a different IP address), or that the
challenge is unknown or expired.

Wrong codes also count against the **account**, across every challenge,
separately for each way of signing in that starts one: a password (`login`,
and `password-reset/confirm`, which hands over a new password), a sign-in
link sent to the address (`magic-link/consume`, `verify-email`), and each
linked Google or GitHub account. After 10 wrong codes within 15 minutes by
one way, that way takes no new challenge and no code for 15 minutes: `429`
with `Retry-After` — for a password, even with the correct password on
`login`. The other ways in still work, so whoever holds one of them cannot
lock the owner out of the rest. The owner is emailed once per pause ("Someone
is trying to sign in to your Driftstack account", naming the way that was
used), and the audit log records `account.mfa_sign_in_locked` with
`payload.method`. A correct code does not clear the count.

## MFA step-up

`POST /v1/auth/mfa/step-up`

Refreshes `mfa_satisfied_at` on the calling web session. Used by
the dashboard when a sensitive operation (disable MFA, regenerate
recovery codes, delete account) requires re-asserting the second
factor within a 15-minute freshness window.

```json
{ "code": "123456" }
```

Returns `200`; no new session is issued — the existing session's
`mfa_satisfied_at` is set to now.

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
the first factor, not a bypass for TOTP or recovery-code proof. A
magic-link sign-in is recorded as `account.login` with
`payload.method: "magic_link"`.

If the magic link is the **first** time anyone proves the address, it
also confirms the email. Any password set before that is removed, and
every session signed in with it ends: whoever registered the address
never proved they owned it. You're signed in by the link; to use a
password again, set one with a [password reset](#password-reset). When
that happens the response carries `"password_removed": true` (on either
branch) and the account is emailed once ("The password on your Driftstack
account was removed"); otherwise the field is absent.

## Password reset

`POST /v1/auth/password-reset/request` with `{ "email": "..." }`.
Same no-enumeration semantics as magic-link: always `200`.

`POST /v1/auth/password-reset/confirm`:

```json
{ "token": "<from email>", "new_password": "<new password>" }
```

Changes the password and invalidates ALL prior sessions for the
account. It then returns the same discriminated union as login:

- without enrolled MFA, a fresh `session` is issued;
- with enrolled MFA, `mfa_required` is returned and **no replacement
  session** is minted until `POST /v1/auth/mfa/challenge` succeeds.

Every prior device must re-authenticate. The reset-confirming device
is logged in only after it receives the no-MFA session branch or
successfully exchanges the MFA challenge.

A completed reset also confirms the email address, since the link
arrived in the mailbox. An account that was never verified can sign in
with its new password straight away.

That includes the desktop app: its sign-in is revoked with the
dashboard sessions, and it asks you to sign in again. Each desktop
sign-in it ends appears in your audit log as `api_key.revoked`.

API keys you created yourself, and apps you authorized through OAuth,
are **not** revoked by a password reset, so your integrations keep
working. If you think one of them was exposed, revoke it on the API
keys page or with `DELETE /v1/api-keys/:id`.

## How often one address is emailed

Verification resends, magic links and password resets each send to the
address a request names, so each is also limited per **address**, whoever
asks and from wherever: at most 5 of each kind an hour and 10 in any 24
hours to one address. Spellings of one Gmail inbox (dots, a `+tag`) count
as that inbox. Past the limit the request is refused with `429`, a
`Retry-After` header, and a detail that says how long to wait:

```json
{
  "type": "https://errors.driftstack.dev/rate-limited",
  "status": 429,
  "detail": "Too many sign-in links have been requested for this address. Try again in 42 minutes.",
  "retry_after_seconds": 2520
}
```

The limit counts every request for the address, whether or not it has an
account, so a refusal says nothing about who has one. The per-IP limits
still apply as well.

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

The token can also be presented as `Authorization: Bearer <token>` with no
body; when a request carries both, both sessions are revoked. A token that
is already revoked or unknown is a no-op `200`. With neither a body nor a
bearer token the request is refused `400`.

## Sessions list + revoke

For "active sign-ins" management, see [Account](/api/account/) and
the `/v1/account/web-sessions` endpoints — they let customers see
every device currently signed in and revoke any individual session
or every-other.

## Desktop device activation flow

Browser authorization lets the desktop app obtain a restricted device
credential without asking the user to copy/paste a customer API key. The
dance is three steps — [Initiate](#initiate-activation),
[Bind](#bind-activation-dashboard), then
[Exchange](#exchange-for-the-device-credential) — each backed by one endpoint
below.

## Initiate activation

`POST /v1/auth/cli-authorize/initiate`

Step 1 — **Initiate** — the desktop app generates a CSRF nonce, a
`code_verifier` it keeps to itself, and an optional client label. It calls
`POST /v1/auth/cli-authorize/initiate` with the nonce, the label and the
verifier's `code_challenge` (see [Code verifier](#code-verifier-pkce)), and
gets back a one-shot `code`, a separate device-displayed `user_code`,
and a `browser_url` that opens the dashboard's Authorize page.

## Bind activation (dashboard)

`POST /v1/auth/cli-authorize/bind-device-code`

Step 2 — **Bind** — the user signs in to the dashboard (if not already),
types the `user_code` shown by the initiating device, and clicks
Authorize. The dashboard hits
`POST /v1/auth/cli-authorize/bind-device-code` with the user's
web-session bearer; the server creates a device credential on the calling
account, stored encrypted; the desktop app must collect it within 2 minutes.

## Exchange for the device credential

`POST /v1/auth/cli-authorize/exchange`

Step 3 — **Exchange** — the desktop app polls
`POST /v1/auth/cli-authorize/exchange`, sending `code`, `state` and its
`code_verifier`, until the response
transitions from `{ status: "pending" }` to
`{ status: "bound", api_key, account_id }`. Bound is one-shot: the
server deletes the code as it hands back the key, so a subsequent
poll returns `{ status: "expired" }` (HTTP `200`). The same
`{ status: "expired" }` is returned if the user takes too long;
either way the desktop app restarts the flow.

## CSRF state

The `state` parameter is a client-supplied 16-128 character random
nonce. The dashboard echoes it back; the server verifies it matches
on `bind` — defends against the dashboard being tricked into binding
a code that wasn't issued in the same session.

## Code verifier (PKCE)

`code` and `state` both appear in `browser_url` and in the link the
dashboard uses to return to the desktop app, so anyone who reads either
URL knows them. They are not enough to collect the credential: the flow is
bound to a secret that never leaves the device (RFC 7636, `S256` only).

1. Generate a `code_verifier`: 43-128 characters from `A-Z a-z 0-9 - . _ ~`
   (32 random bytes, base64url-encoded, gives 43).
2. Send `code_challenge` = unpadded base64url of the SHA-256 of the
   verifier, with `code_challenge_method: "S256"`, on `initiate`. Send both
   or neither; `plain` is refused.
3. Send the `code_verifier` in the body of every `exchange` call. Never put
   it in a URL.

When the flow started with a `code_challenge`, `exchange` answers `400` to
a request without the matching `code_verifier` — before and after the user
approves, and without revealing whether they have. The refusal does not use
up the code: the device holding the verifier still collects the credential.

**Flows without a code challenge end on 31 January 2027.** Until then, an
`initiate` without `code_challenge` works exactly as before, and its
response carries a `Deprecation` header and
`Sunset: Sun, 31 Jan 2027 00:00:00 GMT`. From that date, `initiate`
without a `code_challenge` returns `400`. Update the desktop app before
that date to keep signing in with the browser.

## SDK example

```ts
import { createHash, randomBytes } from 'node:crypto';

const state = crypto.randomUUID();
const codeVerifier = randomBytes(32).toString('base64url'); // stays on this device
const { code, user_code, browser_url } = await client.auth.cliAuthorizeInitiate({
  state,
  client_label: 'Driftstack Desktop on darwin-arm64',
  code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
  code_challenge_method: 'S256',
});
console.log(`Enter ${user_code} in the browser to approve this device.`);
open(browser_url); // open in system browser

for (;;) {
  const out = await client.auth.cliAuthorizeExchange({
    code,
    state,
    code_verifier: codeVerifier,
  });
  if (out.status === 'bound') {
    saveApiKey(out.api_key);
    break;
  }
  if (out.status === 'expired') throw new Error('User took too long');
  await sleep(2000);
}
```

```python
state = secrets.token_urlsafe(24)
code_verifier = secrets.token_urlsafe(32)  # stays on this device
code_challenge = (
    base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode()).digest())
    .rstrip(b"=")
    .decode()
)
out = client.auth.cli_authorize_initiate({
    "state": state,
    "client_label": "Driftstack Desktop",
    "code_challenge": code_challenge,
    "code_challenge_method": "S256",
})
print(f'Enter {out["user_code"]} in the browser to approve this device.')
webbrowser.open(out["browser_url"])

while True:
    poll = client.auth.cli_authorize_exchange({
        "code": out["code"],
        "state": state,
        "code_verifier": code_verifier,
    })
    if poll["status"] == "bound":
        save_api_key(poll["api_key"])
        break
    if poll["status"] == "expired":
        raise RuntimeError("expired")
    time.sleep(2)
```

```go
verifierBytes := make([]byte, 32)
rand.Read(verifierBytes)
codeVerifier := base64.RawURLEncoding.EncodeToString(verifierBytes) // stays on this device
sum := sha256.Sum256([]byte(codeVerifier))

init, _ := client.Auth.CliAuthorizeInitiate(ctx, &driftstack.CliAuthorizeInitiateRequest{
    State:               state,
    ClientLabel:         "Driftstack Desktop",
    CodeChallenge:       base64.RawURLEncoding.EncodeToString(sum[:]),
    CodeChallengeMethod: "S256",
})
fmt.Printf("Enter %s in the browser to approve this device.\n", init.UserCode)
exec.Command("open", init.BrowserURL).Run()

for {
    poll, _ := client.Auth.CliAuthorizeExchange(ctx, &driftstack.CliAuthorizeExchangeRequest{
        Code:         init.Code,
        State:        state,
        CodeVerifier: codeVerifier,
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

## Default scopes and Free restrictions

The minted device credential carries `["account_owner"]` scope by default. Device
clients that only need read access should pass `scopes: ["read"]` on the
`bind` call to follow least-privilege; the desktop app drives sessions
end-to-end and keeps the default. On Free, the server additionally restricts
this credential to the registered desktop route allowlist. Its broad scope
does not turn it into a general-purpose customer API key.

## Auth + scoping

None of `/v1/auth/*` honors the team-RBAC
`X-Driftstack-Account` header — auth is always per-credential, not
per-team-context. The team header is only consulted on `/v1/*`
endpoints that operate on resources (sessions, profiles, webhooks,
…). See [Team RBAC](/api/team/) for the full list.
