---
layout: ../../layouts/DocLayout.astro
title: Account proxies
description: Register your own SOCKS5 proxies against your account and route a session's egress through one. Passwords are encrypted at rest under your account key and never echoed back.
---

# Account proxies

The **account proxies** surface lets you register your own SOCKS5
proxies against your Driftstack account and route an
[agent session](/api/agent-sessions/)'s traffic through one — so a
session browses from your egress IP instead of the default.

Proxy **passwords are write-only**: they're accepted on create/update,
encrypted at rest under your account's key, and **never returned** in
any response. Responses expose `has_password` instead. Every endpoint
is scoped to the calling account — you can only see and use your own
proxies.

## Resource shape

```json
{
  "id": "a1b2c3d4-...",
  "label": "amsterdam residential",
  "scheme": "socks5",
  "host": "proxy.example.com",
  "port": 1080,
  "username": "user",
  "has_password": true,
  "created_at": "2026-06-16T09:15:00Z",
  "updated_at": "2026-06-16T09:15:00Z"
}
```

`host`, `port`, and `username` are not secret. `has_password` is the
only signal about the password; the plaintext is never readable back.

## List

`GET /v1/account/me/proxies` → `{ "data": [ ...proxy ] }`

Required scope: `account_owner`.

## Create

`POST /v1/account/me/proxies`

```json
{
  "label": "amsterdam residential",
  "scheme": "socks5",
  "host": "proxy.example.com",
  "port": 1080,
  "username": "user",
  "password": "••••••"
}
```

`scheme` defaults to `socks5`. `username`/`password` are optional (some
SOCKS5 servers accept unauthenticated or username-only access). Returns
the created proxy metadata (no password) with `201`.

**Host safety:** the `host` must be a public address. Private, loopback,
link-local, and cloud-metadata addresses (e.g. `127.0.0.1`,
`10.0.0.0/8`, `169.254.169.254`) are rejected with `400` — a proxy that
pointed at an internal address could be used to reach networks you
shouldn't.

## Update

`PUT /v1/account/me/proxies/{id}`

Every field is optional. For the password:

- **omit** `password` → keep the existing one
- `"password": null` → clear it
- `"password": "..."` → set/replace it

`404` if the id isn't one of your proxies.

## Delete

`DELETE /v1/account/me/proxies/{id}` → `204` (idempotent; `404` for an
unknown id).

## Test reachability

`POST /v1/account/me/proxies/{id}/test`

Runs a server-side TCP-reachability probe to the proxy's `host:port` and
returns a result (always `200` — an unreachable proxy is a result, not
an error):

```json
{ "ok": true, "latency_ms": 142 }
```

```json
{ "ok": false, "reason": "egress-tunnel-unreachable: timed out connecting to ..." }
```

This confirms the proxy port is reachable; SOCKS5 authentication is not
exercised by the probe.

## Route a session through a proxy

Pass `proxy_id` when you
[create an agent session](/api/agent-sessions/):

```json
{ "profile_id": "prof_...", "proxy_id": "a1b2c3d4-..." }
```

The session's egress is routed through that proxy. The `proxy_id` must
be one of your account's proxies (an unknown or not-owned id returns
`404`). Omit it to use the default egress.

> The Driftstack desktop app manages this for you: add a proxy under
> **Proxies**, set it as a profile's default, and launching the profile
> routes that session through it automatically.
