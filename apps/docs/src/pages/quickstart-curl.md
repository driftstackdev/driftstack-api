---
layout: ../layouts/DocLayout.astro
title: Quickstart (curl)
description: Drive your first iPhone Safari session with nothing but curl — create, navigate, capture, and destroy, straight against the HTTP API.
---

# Quickstart (curl)

This page runs your first Driftstack session using only `curl` — no
SDK, no install step. The core create, drive, capture, and destroy
lifecycle uses plain HTTPS calls, so this is the fastest way to see
that wire contract directly. Live video and event streams use their
documented streaming transports. If you'd rather start in TypeScript,
Python, or Go, use the [SDK quickstart](/quickstart/) instead.

You will need a Driftstack account on any paid tier (including a Manual tier)
([sign up](https://app.driftstack.io/signup/) or
[sign in](https://app.driftstack.io/login/)) and `curl`.

> Free is an interactive desktop tier, so this HTTP quickstart is paid-only.
> The desktop's browser sign-in automatically stores a restricted
> `ds_test_…` device credential; it is not a general sandbox/customer key and
> should not be copied into curl or an SDK.

## 1. Get an API key

1. Open [app.driftstack.io/api-keys](https://app.driftstack.io/api-keys/).
2. Click **Create key**, give it a name, and copy the value. The full
   key is shown once — Driftstack stores only a hash, so if you lose
   it you revoke it and mint a new one.
3. Export it in your shell:

```bash
export DRIFTSTACK_API_KEY="ds_live_…"
```

Customer keys on every paid tier, including Manual, start with `ds_live_` and
authenticate through an `Authorization: Bearer` header on every call. Free
does not create or rotate customer keys. Its browser-authorized desktop
credential starts with `ds_test_` and is restricted to the supported desktop
route surface.

Pick the narrowest scopes that fit the job — a scope is a permission
attached to the key. This page uses `read` + `write`: account/state
requests are reads, while create/navigate/capture/destroy drive the
session. Keep `account_owner` (full account control) for dashboards,
not runtime automation. Full list: [API key scopes](/reference/scopes/).

## 2. Check the key works

```bash
curl -H "Authorization: Bearer $DRIFTSTACK_API_KEY" \
  https://api.driftstack.dev/v1/account/me
```

```json
{
  "id": "acc_…",
  "email": "you@example.com",
  "name": "Your Name",
  "tier": "api_starter",
  "status": "active",
  "timezone": "Europe/Amsterdam",
  "mfa_enrolled": false,
  "concurrent_session_cap": 2,
  "concurrent_session_active": 0,
  "profile_cap": 25,
  "profile_count": 0,
  "teams": []
}
```

A `200` with a flat account object (no wrapper envelope) means the
key is good. A `401` means the key is wrong, malformed, or revoked —
check the dashboard. A `403` after a downgrade to Free means customer API
access is paused; its RFC 9457 `detail` tells you to upgrade to a tier that
includes the `apiAccess` feature. Upgrade to resume an unexpired, unrevoked
key. `concurrent_session_cap` /
`concurrent_session_active` are worth noting now: they're the
[concurrency budget](/guides/concurrency/) the next step draws from.

## 3. Create a session

```bash
curl -X POST \
  -H "Authorization: Bearer $DRIFTSTACK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "label": "first-session" }' \
  https://api.driftstack.dev/v1/sessions
```

```json
{
  "id": "ses_…",
  "account_id": "acc_…",
  "api_key_id": "key_…",
  "status": "ready",
  "archetype": "iphone17_ios18_7_safari26_4",
  "purpose": "production_customer",
  "label": "first-session",
  "metadata": null,
  "egress_capabilities": null,
  "egress_capability_report": null,
  "created_at": "2026-07-07T12:00:00.000Z",
  "updated_at": "2026-07-07T12:00:01.000Z",
  "last_state_at": null,
  "destroyed_at": null
}
```

The `201` response is the session record, already `ready` — the
create call holds until the phone-browser runtime is allocated and
responding, so there's nothing to poll before you drive it. All body
fields are optional: omitting `archetype` (the device + OS + browser
identity the session presents) gives you the locked default shown
above. Sessions can also start from a saved
[profile](/guides/profile-management/) via `profile_id`.

Every session occupies one concurrent slot until you destroy it.
Hitting your tier's cap returns a `429` — see
[Concurrency & backpressure](/guides/concurrency/).

## 4. Drive it

Point the session at a URL:

```bash
curl -X POST \
  -H "Authorization: Bearer $DRIFTSTACK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com" }' \
  https://api.driftstack.dev/v1/sessions/ses_…/navigate
```

```json
{
  "url": "https://example.com",
  "final_url": "https://example.com/",
  "status": 200,
  "duration_ms": 1412
}
```

Then read the live page state — URL, title, cookies, storage, and a
`page_state` block that tells you whether the page loaded or errored:

```bash
curl -H "Authorization: Bearer $DRIFTSTACK_API_KEY" \
  https://api.driftstack.dev/v1/sessions/ses_…/state
```

```json
{
  "url": "https://example.com/",
  "title": "Example Domain",
  "cookies": [],
  "local_storage": {},
  "page_state": { "state": "loaded" },
  "captured_at": "2026-07-07T12:00:04.000Z"
}
```

The full action surface — `interact` (tap / type / scroll / press),
`wait`, `extract`, `search`, `login` — is on the
[Sessions reference](/api/sessions/).

## 5. Capture a screenshot

```bash
curl -X POST \
  -H "Authorization: Bearer $DRIFTSTACK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "kind": "screenshot" }' \
  https://api.driftstack.dev/v1/sessions/ses_…/capture
```

```json
{
  "kind": "screenshot",
  "data": "iVBORw0KGgo…",
  "encoding": "base64",
  "byte_size": 184320,
  "duration_ms": 412
}
```

Captures return the bytes inline — there is no download URL to fetch.
For a screenshot, `data` is the PNG base64-encoded; decode it before
saving:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $DRIFTSTACK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "kind": "screenshot" }' \
  https://api.driftstack.dev/v1/sessions/ses_…/capture \
  | python3 -c 'import sys, json, base64; open("shot.png","wb").write(base64.b64decode(json.load(sys.stdin)["data"]))'
```

`kind` can also be `dom_snapshot` (the serialised page HTML, returned
as plain text with `encoding: "utf8"`) or `pdf`. Screenshots cap at
4 MiB, PDFs at 8 MiB.

## 6. Destroy the session

```bash
curl -X DELETE \
  -H "Authorization: Bearer $DRIFTSTACK_API_KEY" \
  https://api.driftstack.dev/v1/sessions/ses_…
```

Returns `204 No Content`, frees the concurrent slot immediately, and
is idempotent — destroying an already-destroyed session is a no-op.
Always destroy when you're done: a forgotten session keeps holding a
slot (on the free tier it's auto-destroyed after the 20-minute
session cap; paid tiers have no time cap, so the slot stays held
until you release it).

## Two habits worth starting now

- **Know which POSTs are safe to retry.** `Idempotency-Key` is honoured
  on four endpoints — agent-session creation, agent-session messages,
  and the two billing checkouts — where a retry replays the original
  response. It is **not** honoured on `POST /v1/sessions`: retrying that
  after a dropped connection mints a second session and takes another
  concurrent slot. See [Idempotency keys](/reference/idempotency/) for
  the exact list.
- **Prefer webhooks to polling.** `POST /v1/webhooks` subscribes an
  HTTPS endpoint of yours to events like `session.completed` and
  `session.failed`. See [Webhook endpoints](/webhooks/endpoints/).

## Next steps

- **[SDK quickstart](/quickstart/)** — the same flow in TypeScript, Python, or Go.
- **[Sessions reference](/api/sessions/)** — every session endpoint and field.
- **[Concurrency & backpressure](/guides/concurrency/)** — caps per tier and how to back off.
- **[Errors](/reference/errors/)** — the stable problem types every endpoint returns.
- **[Rate limits](/reference/rate-limits/)** — request-rate buckets, separate from concurrency.

Stuck? Email [support@driftstack.dev](mailto:support@driftstack.dev)
with your account ID (`acc_…`) and the `x-request-id` header from any
error response.
