# OAuth operator runbook (V-682)

Internal operational reference for the V-667 OAuth subsystem. The
customer-facing developer docs live at
[`/docs/oauth-apps`](../../apps/marketing-site/src/pages/docs/oauth-apps.astro)
on the marketing site — this runbook is for Driftstack ops handling
the admin surface, incident response, and revocation/rotation
workflows.

Read this when:

- A third-party developer requests a new OAuth client.
- A leaked client_secret needs to be rotated.
- A misbehaving client needs to be revoked.
- An access-token introspection turns up unexpected state.
- The OAuth subsystem is implicated in a security incident.

## Surface at a glance

```
   third-party app
       │
       │  3. POST /v1/oauth/token         (exchange code → access token)
       │  4. Authorization: Bearer oat_…  (use the token)
       │  5. POST /v1/oauth/revoke        (client-authenticated revoke)
       ▼
   Driftstack API
       ▲
       │  1. POST /v1/admin/oauth/clients              (register — V-667.B)
       │  2. POST /v1/admin/oauth/clients/:id/rotate-  (V-667.E)
       │  3. DELETE /v1/admin/oauth/clients/:id        (revoke — V-667.B)
       │
   founder / ops (driftstack_internal_admin key)
```

Token TTL: **1 hour**. There are no refresh tokens (intentional —
forces consent re-confirmation on a regular cadence).

## Client registration

A developer requests a client by emailing
`developers@driftstack.dev` (the contract lives in the customer
docs page). The ops workflow:

1. Triage the request:
   - Is the redirect_uri HTTPS (or `http://localhost:…` for dev)?
   - Are the requested scopes proportional to the use case?
   - Is the app name/description coherent + spelled correctly?
2. Register the client:

   curl -X POST \
    -H "Authorization: Bearer $INTERNAL_ADMIN_KEY" \
         -H "Content-Type: application/json" \
         -d '{
           "label": "Acme Sales Bot",
           "redirect_uris": ["https://app.acme.example/oauth/callback"]
         }' \
         "$BASE_URL/v1/admin/oauth/clients"

3. The response returns `client_id` + `client_secret`. Both are
   plaintext; the secret is shown ONCE — copy it into the
   founder's password manager + the email reply to the developer.
4. Reply to the developer with the credentials. Use the standard
   template (see `docs/internal/v663-customer-success-templates.md`,
   "OAuth client onboarding" section once it exists).

## Lookup + audit

Single client:

    curl -H "Authorization: Bearer $INTERNAL_ADMIN_KEY" \
         "$BASE_URL/v1/admin/oauth/clients/<client_id>"

All clients:

    curl -H "Authorization: Bearer $INTERNAL_ADMIN_KEY" \
         "$BASE_URL/v1/admin/oauth/clients"

Both surfaces redact the secret hash — that's never echoed back.
Both surfaces include `revoked_at` so revoked clients are still
auditable.

## Rotating a client_secret (V-667.E)

Use cases:

- Developer suspects the secret leaked.
- Regular hygiene (the developer is rotating credentials).
- A compromised laptop / git push of the secret.

Procedure:

    curl -X POST \
      -H "Authorization: Bearer $INTERNAL_ADMIN_KEY" \
      "$BASE_URL/v1/admin/oauth/clients/<client_id>/rotate-secret"

The response carries the NEW plaintext `client_secret`. Email it
to the developer + delete from the response cache. The old secret
is invalid immediately — any in-flight `/token` exchanges using
the old secret will fail. **Existing access tokens stay valid**
because they're bearer-authenticated. The new secret is required for
subsequent `/token`, `/introspect`, and `/revoke` requests.

If the developer has running services that ran out of access
tokens (1-hour TTL), those services will fail to re-exchange until
they're updated with the new secret. Coordinate the rotation with
the developer if the change-window matters.

## Revoking a client (full kill)

Use case: client is malicious, customer requested the integration
be cut, developer asks for full deletion.

    curl -X DELETE \
      -H "Authorization: Bearer $INTERNAL_ADMIN_KEY" \
      "$BASE_URL/v1/admin/oauth/clients/<client_id>"

`revoked_at` is set on the client row. Effects:

- New `/authorize` requests for the client fail.
- New `/token` exchanges fail (the service blocks revoked clients).
- **Every existing access token issued by the client is revoked in
  the same database transaction.** Central API authentication rejects
  them on the next request; there is no positive OAuth-auth cache or
  one-hour residual-access window.

This intentionally differs from secret rotation. Rotation replaces
only the client authenticator and keeps current bearer tokens alive;
client revocation is the full-kill incident/customer-removal action.

## Triage workflow — "this token is failing"

The developer reports a 401 on a previously-working token. Do not ask
them to send Driftstack the bearer token or client secret: base64 is
not encryption, and collecting both credentials expands the incident
blast radius. Have the developer run authenticated introspection from
their own secure server and share only the response:

```bash
jq -n \
  --arg token "$OAUTH_TOKEN" \
  --arg client_id "$OAUTH_CLIENT_ID" \
  --arg client_secret "$OAUTH_CLIENT_SECRET" \
  '{token:$token, client_id:$client_id, client_secret:$client_secret}' | \
  curl --fail-with-body -X POST \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "$BASE_URL/v1/oauth/introspect"
```

Driftstack stores only the client-secret hash and cannot run this
request on the developer's behalf. If they no longer possess the
secret, coordinate a rotation; do not ask them to disclose a surviving
copy. Interpret the sanitized response:

- `401 invalid_client` → client id/secret mismatch or revoked client.
  Confirm the client state through the admin lookup; rotate only with
  the developer's approval unless this is an active incident.
- `active: false` → token is revoked or expired. If expired,
  the developer needs to run the dance again (the 1h TTL is
  intentional). If revoked, check whether the client is
  revoked (see the lookup section).
- `active: true` with the wrong `scope` → the developer
  requested narrower scopes than the call they're attempting
  needs. Tell them to re-authorize with broader scope.
- `active: true` with the right scope but the call still 401s
  → not an OAuth problem; check the account's API rate-limit
  state + V-481 scope predicate edge cases.

## Security incident posture

If an OAuth client is implicated in a security incident:

1. **Revoke the client immediately** (above). Don't wait for
   developer confirmation. This atomically revokes its active tokens.
2. Open an incident in the `incidents` runbook with severity
   `major` or `critical` depending on impact.
3. Notify the affected customer (the one whose data the client
   could access) within 24h via the standard incident-comms path.
4. Post-mortem includes a check of `oauth_clients.created_at` vs.
   `oauth_access_tokens.created_at` — was this a long-resident
   compromised client or one created during the attack?

## Failure modes

| Symptom                                         | Likely cause + action                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/authorize` returns 400 "invalid_request"      | redirect_uri doesn't match what's registered, or PKCE challenge missing/malformed. Check the request vs. registered URIs.              |
| `/token` returns 401 "invalid_client"           | client_id wrong, client revoked, or client_secret wrong (e.g. the developer used an old one post-rotation).                            |
| `/token` returns 400 "invalid_grant"            | Code already exchanged (codes are single-use), code expired, or code_verifier doesn't match the original challenge.                    |
| `/introspect` returns 401 "invalid_client"      | Client id/secret mismatch or revoked client. Check admin state; rotate only through the credential workflow.                           |
| `/introspect` returns active:false unexpectedly | Token expired, revoked, unknown, or belongs to another client id. Verify the client id before re-authorizing.                          |
| Customer sees an unexpected OAuth consent       | Phishing — someone got their session and tried to authorize a malicious client. Lock the account, force re-auth, audit /authorize log. |

## Related runbooks

- [`incidents.md`](incidents.md) — when an OAuth issue is a
  customer-facing incident.
- [`observability.md`](observability.md) — Sentry alert wiring for
  unusual `/authorize` or `/token` failure rates.
- [`first-customer-day.md`](first-customer-day.md) — what to watch
  in the first 24h after a new client is registered.
