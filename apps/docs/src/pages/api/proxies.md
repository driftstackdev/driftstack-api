---
layout: ../../layouts/DocLayout.astro
title: Account proxies
description: Register your own SOCKS5, HTTP, OpenVPN, or WireGuard proxies against your account and route a session's egress through one. Secrets are encrypted at rest under your account key and never echoed back.
---

# Account proxies

The **account proxies** surface lets you register your own proxies
against your Driftstack account and route an
[agent session](/api/agent-sessions/)'s traffic through one — so a
session browses from your egress IP instead of the default. Four
schemes are supported: `socks5`, `http`, `openvpn`, and `wireguard`.

Proxy **secrets are write-only**: passwords (SOCKS5/HTTP), the OpenVPN
config blob (which embeds your certs/keys), and the WireGuard private
key are accepted on create/update, encrypted at rest under your
account's key, and **never returned** in any response. Responses expose
`has_password` (a password is stored) and `has_secret` (a VPN secret is
stored) instead. Every endpoint is scoped to the calling account — you
can only see and use your own proxies.

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
  "has_secret": false,
  "created_at": "2026-06-16T09:15:00Z",
  "updated_at": "2026-06-16T09:15:00Z"
}
```

`scheme` is one of `socks5` | `http` | `openvpn` | `wireguard`. `host`,
`port`, and `username` are not secret. `has_password` / `has_secret`
are the only signals about the stored credentials; the plaintext is
never readable back. For VPN schemes, `host`/`port` are the display
endpoint (parsed from your `.ovpn` / `wg0.conf`).

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

### VPN proxies (OpenVPN / WireGuard)

For a VPN scheme, the secret config rides a nested block. `host`/`port`
are the display endpoint (most clients fill them from the parsed config).

**OpenVPN** — paste the full `.ovpn` as `config_blob` (must contain a
`client` directive and a `remote <host> <port>` directive; up to 256 KiB).
`username`/`password` are optional inline credentials:

```json
{
  "label": "frankfurt ovpn",
  "scheme": "openvpn",
  "host": "vpn.example.com",
  "port": 1194,
  "openvpn": {
    "config_blob": "client\nremote vpn.example.com 1194\n...",
    "username": "user",
    "password": "••••••"
  }
}
```

**WireGuard** — the `private_key` and `peer_public_key` are 44-char
base64 curve25519 keys; `endpoint` is `host:port`; `address` is the
interface address (e.g. `10.7.0.2/32`); `allowed_ips` defaults to
`0.0.0.0/0`; `dns` is optional:

```json
{
  "label": "frankfurt wg",
  "scheme": "wireguard",
  "host": "vpn.example.com",
  "port": 51820,
  "wireguard": {
    "private_key": "<44-char base64>",
    "peer_public_key": "<44-char base64>",
    "endpoint": "vpn.example.com:51820",
    "address": "10.7.0.2/32",
    "allowed_ips": "0.0.0.0/0",
    "dns": "1.1.1.1"
  }
}
```

The `config_blob` / `private_key` are write-only — the response returns
`has_secret: true`, never the secret. VPN proxies require encryption to
be configured server-side; if it isn't, create returns `503`.

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
{ "ok": false, "reason": "Proxy unreachable. Check the host, port, and firewall." }
```

Failure reasons are stable customer guidance. Raw socket, DNS, TLS, and remote
proxy response text is kept out of the API response.

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
