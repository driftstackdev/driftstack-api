---
layout: ../../layouts/DocLayout.astro
title: OAuth 2.0 (third-party clients)
description: Authorization-code + PKCE flow for third-party apps that integrate with a customer's Driftstack account on the customer's behalf — register a client, run the dance, validate tokens, revoke.
---

# OAuth 2.0 — third-party clients

Driftstack ships an **OAuth 2.0 Authorization Server** so third-party
apps can act on a customer's behalf without ever holding the
customer's API key. The flow is the standard Authorization Code grant
with **PKCE required** (RFC 7636 — no exceptions, even for confidential
clients); access tokens are bearer-style and short-lived (one hour);
no refresh tokens are issued.

OAuth customer authorization requires a paid account tier, including any
Manual tier. Free dashboard sessions remain valid for interactive desktop use,
but approval returns RFC 9457 `403 Forbidden` with the actionable `apiAccess`
upgrade detail and does not consume the staged authorization. Existing OAuth
access tokens are rejected while their account is Free and resume after an
upgrade if they have not expired or been revoked.

> Bearer API keys (`ds_live_…`) and OAuth access tokens BOTH use the
> `Authorization: Bearer <token>` header on `/v1/*` requests. The
> server differentiates by token prefix; both surfaces respect the
> same scope + rate-limit + audit pipeline.

## When to use this

- **First-party UIs** (the customer's dashboard, their own internal
  apps) → use API keys + the dashboard auth flows. OAuth is overkill.
- **Third-party integrations** (Zapier-style automation, customer
  agencies acting on a customer's behalf, a SaaS product that hooks
  into a customer's Driftstack account) → use OAuth so the customer
  can revoke your integration without rotating their API key.

If you're a first-party customer integrating into your own backend,
just use an API key.

## Register a client

Client registration is currently **admin-gated** — talk to
[support@driftstack.dev](mailto:support@driftstack.dev) with:

- your app's label (shown to the customer on the consent screen)
- the redirect URIs you'll use (HTTPS-only, except `localhost` for
  native-app development per RFC 8252)
- whether the client is account-scoped (one specific customer
  account) or multi-tenant (any customer can authorize)

Support returns:

```json
{ "client_id": "oac_<base64url>", "client_secret": "oas_<base64url>" }
```

The `client_secret` is shown **once** and never recoverable; the
server stores only its SHA-256 hash. Lost secrets require rotation
via support.

## The flow

```
┌──────┐                                         ┌────────────┐
│  3p  │                                         │ Driftstack │
│  app │                                         │   server   │
└──┬───┘                                         └─────┬──────┘
   │                                                   │
   │ 1. redirect customer's browser to                 │
   │    app.driftstack.dev/oauth/authorize/?PKCE=…     │
   │ ────────────────────────────────────────────────► │
   │                                                   │
   │                 ┌────────────────┐                │
   │ 2. dashboard    │ customer-      │                │
   │    renders      │ dashboard      │                │
   │    consent      │ (browser)      │                │
   │                 └─────┬──────────┘                │
   │                       │ approve                   │
   │                       ▼                           │
   │              POST /v1/oauth/authorize/complete    │
   │                       │                           │
   │                       ▼                           │
   │ 3. redirect to your redirect_uri?code=…&state=…   │
   │ ◄──────────────────────────────────────────────── │
   │                                                   │
   │ 4. POST /v1/oauth/token (with code + verifier)    │
   │ ────────────────────────────────────────────────► │
   │ 5. { access_token, token_type, expires_in,        │
   │     scope }                                       │
   │ ◄──────────────────────────────────────────────── │
   │                                                   │
   │ 6. Authorization: Bearer <access_token>           │
   │    on subsequent /v1/* requests                   │
   │ ────────────────────────────────────────────────► │
```

## 1 — Redirect to Driftstack

`GET https://app.driftstack.dev/oauth/authorize/`

Query parameters (RFC 7636 PKCE — `S256` only):

| Parameter               | Required | Notes                                                                |
| ----------------------- | -------- | -------------------------------------------------------------------- |
| `client_id`             | yes      | your `oac_…` value                                                   |
| `redirect_uri`          | yes      | must match one of the URIs registered with the client                |
| `state`                 | yes      | opaque value 8–256 chars; you'll receive it back unchanged in step 3 |
| `code_challenge`        | yes      | 43–128 chars; `base64url(SHA-256(code_verifier))`                    |
| `code_challenge_method` | yes      | literal `S256` (the plain method is rejected)                        |
| `scope`                 | optional | space-separated list from the curated third-party scope set          |

Your app redirects the customer's browser to this page. The Dashboard
asks them to sign in when needed, stages the request through the
provider's `GET /v1/oauth/authorize` API, and shows the server-returned
app label, requested scopes, and callback host. Your integration never
receives or handles the intermediate `authorization_id`.

Approval returns the browser to the registered `redirect_uri` with
`?code=…&state=…`. Cancellation returns
`?error=access_denied&state=…`. Verify `state` exactly in either case.

## 2 — Customer approves (provider-internal)

`POST /v1/oauth/authorize/complete` (interactive dashboard session required)

Body:

```json
{ "authorization_id": "<from-step-1>" }
```

The approving account is derived from the authenticated dashboard
session — `account_id` is intentionally **not** accepted from the
body (a body-supplied `account_id` is rejected to prevent
cross-account takeover). General API keys cannot call this endpoint,
even if they have broad scopes: consent must be a human action from an
interactive dashboard session.

The approving account must currently include customer API access. On Free,
this endpoint fails before consuming the pending authorization, so the same
request can be approved after an upgrade.

An account-scoped client can be approved only by its registered
account. A different customer's consent attempt returns `access_denied`
without consuming the pending authorization; a multi-tenant client has
no account binding and may be approved by any customer.

The granted scopes are reduced against the dashboard session's
effective authority. Broad `read` and `write` authority can approve
their matching granular scopes (for example, `read:sessions`), while a
granular scope cannot approve a broad or sibling scope. Privileged
internal and account-owner scopes are never minted into OAuth tokens.
The OAuth request itself may contain only the 13 granular scopes in the
[integrator scope table](https://driftstack.dev/docs/oauth-apps/);
deprecated broad aliases, `gui_control`, and newly added API-key scopes
fail closed with `invalid_scope` rather than becoming available by
default.

Response:

```json
{
  "code": "<opaque>",
  "redirect_uri": "https://your-app/callback",
  "state": "<from-step-1>"
}
```

The dashboard assembles the final
`<redirect_uri>?code=<opaque>&state=<state>` URL and redirects the
browser there.

You shouldn't call this endpoint directly — the customer-dashboard
does. Your job is to receive the redirect at step 3.

## 3 — You receive the code at your redirect URI

The browser lands on `<redirect_uri>?code=<opaque>&state=<your-state>`.
Verify the `state` matches what you stored client-side (CSRF
protection per OAuth spec), then proceed to step 4.

Codes expire **5 minutes** after issue and are single-use.

## 4 — Exchange the code for a token

`POST /v1/oauth/token`

Body (`application/json`):

```json
{
  "grant_type": "authorization_code",
  "code": "<from-step-3>",
  "code_verifier": "<your-PKCE-verifier>",
  "client_id": "oac_…",
  "client_secret": "oas_…",
  "redirect_uri": "<same-as-step-1>"
}
```

Response (`200`):

```json
{
  "access_token": "<opaque>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": ["read:sessions", "write:sessions"]
}
```

`expires_in` is **3600 seconds** (1 hour) by design. No refresh tokens
are issued — when the access token expires, the customer must
re-authorize. This keeps the threat model simple (a leaked access
token's blast radius is bounded by the hour).

Errors (problem+json, `4xx`):

- `invalid_grant` — the code is unknown, expired, already used, or
  the `code_verifier` doesn't match the `code_challenge`
- `invalid_client` — the `client_id` + `client_secret` pair didn't
  match (the secret is wrong OR the client has been revoked)
- `invalid_request` — the body failed validation (missing field,
  `redirect_uri` mismatch)

## 5 — Use the access token

```http
GET /v1/sessions HTTP/1.1
Host: api.driftstack.dev
Authorization: Bearer <access_token>
```

The scopes you received in the token response gate which endpoints
you can call. Use a smaller scope than the customer's full API key
where you can — least-privilege keeps customers comfortable
approving the consent screen.

## Validating tokens (introspection)

`POST /v1/oauth/introspect` (RFC 7662)

Body:

```json
{
  "token": "<access_token>",
  "client_id": "oac_…",
  "client_secret": "oas_…"
}
```

Response when the token is active:

```json
{
  "active": true,
  "client_id": "oac_…",
  "account_id": "<customer-uuid>",
  "scope": ["read:sessions", "write:sessions"],
  "exp": 1747852800
}
```

After client authentication succeeds, an invalid, revoked, expired,
or foreign-client token returns the same minimal response:

```json
{ "active": false }
```

`exp` is Unix seconds (per RFC 7662 §2.2). Most third-party clients
don't need this endpoint (they get all the same info from the
`/token` response), but it's useful for resource servers proxying
Driftstack on behalf of a different upstream.

The endpoint returns `401` before token lookup when the client
credentials are invalid or the client has been revoked. Keep the
`client_secret` server-side; never call introspection from browser
code or log the request body.

## Revoking tokens

`POST /v1/oauth/revoke` (RFC 7009)

Body:

```json
{
  "token": "<access_token>",
  "client_id": "oac_…",
  "client_secret": "oas_…",
  "token_type_hint": "access_token"
}
```

`token_type_hint` is informational only. Once client authentication
succeeds, the endpoint returns `200 {}` for an owned, unknown, or
foreign-client token; only a token issued to the authenticated client
is revoked. This preserves RFC 7009 anti-enumeration behavior without
allowing cross-client revocation. Invalid or revoked client credentials
return `401` before mutation.

Client revocation is handled through Driftstack support. A client revoke
invalidates every access token issued by that client on the next API request.
Rotating only the client secret does not revoke existing bearer tokens.

## Errors at a glance

| Status | Code / problem                            | When                                                            |
| -----: | ----------------------------------------- | --------------------------------------------------------------- |
|    400 | `invalid_request`                         | body / query failed validation (schema-shape failures included) |
|    400 | `invalid_grant`                           | code unknown / expired / already used; PKCE verifier mismatch   |
|    400 | `invalid_scope`                           | requested scope outside the client's allowed set                |
|    400 | `access_denied`                           | customer rejected the consent screen                            |
|    401 | `invalid_client`                          | `client_id` + `client_secret` mismatch OR client revoked        |
|    403 | `https://errors.driftstack.dev/forbidden` | approving account is Free; upgrade to a tier with `apiAccess`   |

All responses use `application/problem+json` per RFC 9457 (status,
type, title, detail). The `type` field is a real RFC 9457 type URI:
`https://errors.driftstack.dev/bad-request` for the 400 cases and
`https://errors.driftstack.dev/unauthorized` for the 401 cases.

The OAuth code from the table above is returned as a top-level
**`error`** field on the problem document — the field name RFC 6749
§5.2 gives it, so a standard OAuth client reads it without
Driftstack-specific handling. Branch on `error`, not on `detail`:

```json
{
  "type": "https://errors.driftstack.dev/bad-request",
  "title": "Bad Request",
  "status": 400,
  "detail": "authorization code is invalid or expired",
  "error": "invalid_grant"
}
```

`detail` is human-readable prose and may change; `error` is the
stable discriminator. It matters most between the 400s, which share
one `type`: `invalid_grant` means restart the authorization flow,
while `invalid_request` means the request itself is malformed.

## Implementation notes

- **PKCE is mandatory**, including for confidential clients. The
  `plain` challenge method is rejected — `S256` only.
- **Codes are single-use** and expire 5 minutes after issue. Race a
  second `/token` exchange with the same code → exactly one exchange
  succeeds and every loser receives `invalid_grant` (the code is
  atomically consumed).
- **Access tokens are opaque** — don't try to parse them. They're
  not JWTs; introspect via `/v1/oauth/introspect` if you need the
  encoded fields. Introspection and revocation require the same
  confidential-client credentials used at `/v1/oauth/token` and are
  bound to that client's own tokens.
- **Provider state is persistent.** Client secrets, pending consent
  handles, authorization codes and access tokens are stored only as
  SHA-256 digests. Pending consent survives API restarts/replicas, and
  an issued `oat_` bearer enters the same account/scope/rate-limit/audit
  pipeline as an API key.
- **Refresh tokens are NOT issued.** When a token expires, the
  customer must re-authorize. This is intentional; refresh tokens
  are an attack surface and 1-hour TTL access tokens are a workable
  trade-off for the kinds of integrations Driftstack hosts.
- **Same scope set as API keys.** The OAuth `scope` value is parsed
  through `ApiKeyScopeSchema` — see the [API keys page](/api/api-keys/)
  for the full scope catalog.
