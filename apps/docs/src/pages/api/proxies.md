---
layout: ../../layouts/DocLayout.astro
title: Account proxies
description: Register your own SOCKS5, HTTP, OpenVPN, or WireGuard proxies against your account and route a session's traffic through a SOCKS5, OpenVPN, or WireGuard one. Secrets are encrypted at rest under your account key and never echoed back.
---

# Account proxies

The **account proxies** surface lets you register your own proxies
against your Driftstack account and route an
[agent session](/api/agent-sessions/)'s traffic through one — so a
session browses from your proxy's IP address instead of the default.
Four schemes can be **registered**: `socks5`, `http`, `openvpn`, and
`wireguard`.

Three of them can currently **route a browser session**: `socks5`,
`openvpn`, and `wireguard`. `http` proxies can be stored and managed
here, but cannot carry a session on this deployment — passing an
`http` proxy to a session create is refused with `400`, not silently
ignored.

Proxy **secrets are write-only**: passwords (SOCKS5/HTTP), the OpenVPN
config blob (which embeds your certs/keys), and the WireGuard private
key and pre-shared key are accepted on create/update, encrypted at rest under your
account's key, and **never returned** in any response. Responses expose
`has_password` (a password is stored) and `has_secret` (a VPN secret is
stored) instead. Every endpoint is scoped to the calling account — you
can only see and use your own proxies.

## What kind of proxy works

Profiles run on Driftstack's servers, not on your computer. A proxy that
works from your desk can still fail from there, and the desktop app's
**Test** button — which runs from your own machine — cannot tell the
difference. What you need:

- **A public address.** Not `localhost`, `127.0.0.1`, or a private-network
  address such as `10.x.x.x`, `172.16.x.x`–`172.31.x.x`, or `192.168.x.x`.
  A proxy on your own machine or office network tests fine from the app and
  is unreachable from Driftstack's servers.
- **Username and password authentication.** IP-allowlist access does not
  work: profiles run from Driftstack's servers, not from your IP, so an
  allowlist that names your address never matches. Ask your provider for
  user/pass credentials.
- **SOCKS5, OpenVPN, or WireGuard.** These are the schemes that can carry a
  session. `http` proxies can be saved but not used for a session.

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
  "quic_measured": null,
  "quic_measured_at": null,
  "quic_probe": null,
  "quic_probe_at": null,
  "udp_probe": null,
  "udp_probe_at": null,
  "exit_observed": null,
  "exit_superseded_at": null,
  "os_fingerprint": null,
  "os_fingerprint_at": null,
  "created_at": "2026-06-16T09:15:00Z",
  "updated_at": "2026-06-16T09:15:00Z"
}
```

`scheme` is one of `socks5` | `http` | `openvpn` | `wireguard`. `host`,
`port`, and `username` are not secret. `has_password` / `has_secret`
are the only signals about the stored credentials; the plaintext is
never readable back. For VPN schemes, `host`/`port` are the display
endpoint (parsed from your `.ovpn` / `wg0.conf`).

`quic_probe` is whether QUIC traffic got through this proxy the last time it
was tested — `true`, `false`, or `null` when no test has checked it yet — and
`quic_probe_at` is when that test ran (ISO 8601), or `null`. `udp_probe` and
`udp_probe_at` say the same about UDP traffic. `false` is a result, not a gap: it
means a test of a working proxy checked and the traffic did not get through.
`null` means never tested, never "no" — it is the only value that tells you the
answer is still missing, so do not treat it as `false`. Each answer keeps its own
date, and one test can fill in one without the other. Age them by their `_at`
stamps rather than by the time of your request: they are stored results and can
be any age. Changing the proxy's address, scheme, or credentials resets all four
to `null`, because the stored answer described the proxy as it was before. They
are filled in by the full test described under [Test a proxy](#test-a-proxy) —
the quick test does not check them — and an `openvpn` or `wireguard` proxy
currently leaves them `null`. A server that
predates them omits the four fields — read an absent field as `null`.

`quic_measured` is a different fact: what a live session actually used through
this proxy — `h3` (QUIC worked) or `h2-only` (it fell back) — or `null` when no
session has reported one, with `quic_measured_at` saying when. A test result in
`quic_probe` never changes it, and the two are dated separately, so they can
disagree for a while after a provider changes what it carries.

`exit_observed` is the last exit identity seen **through** the proxy —
`{ ip, country, timezone, observed_via, observed_at }` — or `null` when
nothing has observed one yet. `observed_via` is `session` (a live session
reported it) or `probe` (a Driftstack proxy test measured it); `country` and
`timezone` are `null` when they could not be determined. For an OpenVPN or
WireGuard proxy this is the only source of its location and timezone short
of running a test, since only a session or a Driftstack test can see through
the tunnel. `null` means not observed, never "no location".

`exit_superseded_at` is when a later Driftstack test found the tunnel
**down** after `exit_observed` was recorded (ISO 8601), or `null` if that
never happened. The stored exit is kept as the last one seen, at its own
`observed_at`; clients should ignore an `exit_observed` dated at or before
`exit_superseded_at` (the desktop app does). The next successful observation
— a session report or a test that saw an exit through a working tunnel —
clears it; a test that finds the tunnel down sets it. A test that could not
run (`not_run`) measured nothing and never sets it, and while it is set a
`not_run` reply carries no `exit_observed` at all (see
[Test a proxy](#test-a-proxy)).

`os_fingerprint` is the last passive OS reading Driftstack took of the proxy's
own TCP stack — the same object [Test a proxy](#test-a-proxy) returns
(`os`, `confidence`, `reason`, `observed_ip`, `observed_via`,
`single_host_vantage`, `web_port_vantage`, `direct_reading`,
`website_like_reading`) — or `null` when the proxy has never been
fingerprinted. Only Driftstack can take this reading: it comes from the
connection the proxy's own kernel opens on our side, which the machine you are
calling from cannot see. `null` means not measured, never "no OS".

`single_host_vantage` and `web_port_vantage` are the original field names;
`direct_reading` and `website_like_reading` are the same two facts under their
customer-facing names, added alongside them — read whichever pair you like,
they always agree. `direct_reading` (`single_host_vantage`) is true only when
the address you gave, the address that answered, and the address your traffic
exits from are one machine, so nothing sat between what was read and what a
website would see. `website_like_reading` (`web_port_vantage`) is true when
the reading was taken the way a real website connection is — a literal
address on the standard secure-web port, not a name that could route to
shared infrastructure. Read a missing or false value on either pair as "this
reading does not describe that path," never as an assurance that it does.

`os_fingerprint_at` is when that reading was taken (ISO 8601), or `null`. Age the
reading by this stamp rather than by the time of your request: it is a stored
measurement, it can be any age, and a reading you cannot date should be treated
as stale rather than current. The desktop app hides one older than 30 minutes.

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

**How many you can save:** each tier caps the number of saved proxies on
the account. Crossing it on `POST /v1/account/me/proxies` returns `400`
with `Proxy limit reached (<cap>). Delete an existing proxy to add
another.` — note this is a `400`, not the `429 Tier limit` the profile
cap uses. The caps are below (the public `@driftstack/api-types` package
also exports them as `PROXIES_PER_TIER`):

| Tier            | Saved proxies |
| --------------- | ------------: |
| `free`          |             1 |
| `solo_manual`   |            10 |
| `team_manual`   |            25 |
| `agency_manual` |            50 |
| `api_starter`   |            25 |
| `api_builder`   |           100 |
| `api_scale`     |           500 |
| `enterprise`    |        custom |

`free` gets exactly one and SOCKS5 only — OpenVPN and WireGuard need a
paid tier. The enterprise allowance is negotiated rather than a number
this page can print.

### VPN proxies (OpenVPN / WireGuard)

For a VPN scheme, the secret config rides a nested block. `host`/`port`
are the display endpoint (most clients fill them from the parsed config).

**OpenVPN** — paste the full `.ovpn` as `config_blob` (it must be a client
configuration: it needs a `client` line and a `remote` line with the server
address; up to 256 KiB). Some providers ship profiles without the `client`
line — paste one into the desktop app and it offers to add that line for you,
leaving the rest of the file unchanged. `username`/`password` are optional
inline credentials:

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

**WireGuard** — the `private_key` and `peer_public_key` are WireGuard
keys (44 characters, base64); `endpoint` is `host:port` (an IPv6 host may
be bracketed, `[2001:db8::1]:51820`); `address` is the interface address
(e.g. `10.7.0.2/32`) and is required; `allowed_ips` defaults to
`0.0.0.0/0`; `dns` is optional; `preshared_key` (also a 44-character
base64 key) is optional and only needed when the peer requires a
pre-shared key:

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

The `config_blob` / `private_key` / `preshared_key` are write-only — the response returns
`has_secret: true`, never the secret. On an installation where VPN
proxies are not available, create returns `503` with the message
`VPN proxies are not available on this installation.`

Required scope: `account_owner` — a broad `write` key is not sufficient.

## Update

`PUT /v1/account/me/proxies/{id}`

Every field is optional. For the password on a **SOCKS5 or HTTP** proxy:

- **omit** `password` → keep the existing one
- `"password": null` → clear it
- `"password": "..."` → set/replace it

**VPN proxies are different.** On a saved `openvpn` or `wireguard` proxy,
sending `password` at all — a new value _or_ `null` — without also
sending `scheme` and the matching config block is rejected with `400`:
`To change a VPN password, submit the full VPN configuration again.` The
credential is stored together with the config, so there is no way to
change one without the other. To change a VPN password, resubmit the
full VPN body as you would on create.

`404` if the id isn't one of your proxies.

`409` — `This proxy changed since you last loaded it. Refresh and try
again.` Something else — another dashboard tab or a concurrent API call —
changed this proxy's `scheme` between your read and your write, so the
write was refused instead of being applied to a proxy that is no longer
the one you edited. Re-read the proxy and reissue the update. A
`409` here means the row still exists; a `404` means it is gone.

Required scope: `account_owner` — a broad `write` key is not sufficient.

## Delete

`DELETE /v1/account/me/proxies/{id}` → `204` (idempotent; `404` for an
unknown id).

Required scope: `account_owner` — a broad `write` key is not sufficient.

## Test a proxy

`POST /v1/account/me/proxies/{id}/test`

Answers one question: **would a session launched through this proxy work right
now?** For a `socks5` proxy that is the same check Driftstack runs before
launching a session — it connects, authenticates, and makes a real request
through the proxy — so a green test and a successful launch mean the same
thing. Always `200`; a proxy that fails the test is a result, not an error:

```json
{ "ok": true, "latency_ms": 142 }
```

```json
{
  "ok": false,
  "reason": "The proxy connected but could not reach the internet. Check with your proxy provider."
}
```

`reason` is a fixed sentence written for a person to read and act on, drawn from
the same four cases a refused launch reports (see
[Why a launch is refused](#why-a-launch-is-refused)). It is not an enum — branch
on the `reason` field of a `422` instead. Raw error text from the network or
from the proxy itself never appears in the response.

A proxy that authenticates but cannot route is the case worth knowing about: it
looks healthy to anything that only opens the port, and it fails every launch.
This test reports it.

An `ok: true` result carries `os_fingerprint` when Driftstack read the proxy's
own TCP stack during the test, and `os_fingerprint_unavailable` when it could
not:

| Code                    | What it means                                                                            | Worth retrying?                     |
| ----------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------- |
| `not_available_for_vpn` | An `openvpn` or `wireguard` proxy has no single address of its own to read a stack from. | No — permanent for this proxy.      |
| `not_captured`          | The reading was attempted and produced nothing this time.                                | Yes.                                |
| `not_offered_here`      | This deployment does not take this reading at all.                                       | No — permanent for this deployment. |

When this test read nothing but the proxy has a STORED reading, that
one is returned instead, with `os_fingerprint_at` saying when it was taken and
the `os_fingerprint_unavailable` cause still beside it: the cause is about this
test, the stamp is about the reading. A reading with **no** `os_fingerprint_at`
was measured by the request you just made.

An `ok: true` result also carries `quic_probe`, `quic_probe_at`, `udp_probe` and
`udp_probe_at` exactly as the proxy object lists them **after** this test — so a
full test that checked QUIC or UDP returns the answer it just stored, dated to
the test, and any other returns the stored answer at its own, older date (or
`null` when the proxy has never been tested for it). A proxy that fails the test
stores nothing: there was no working proxy to check them over. If the proxy's
address, scheme, or credentials were submitted again while the test was running
— even with the same values — or the proxy was deleted, the test's answer may not
be stored. Either way the four fields match the proxy object as it then stands:
`null` after a change that resets them, and the earlier answer otherwise.

`?check=quick` (the default) is measured by Driftstack itself, right now: for
an `openvpn` or `wireguard` proxy it only checks that the address answers and
does not connect the tunnel. Add `?check=full` to run a fuller check,
dispatched through the machine that will actually run your profile — the same
path a real session takes, which is what connects the tunnel and is worth
running before you rely on a proxy for a real session. The `not_run` values
below cover the cases where a full check could not run.

> The original `?vantage=cp|fleet` query parameter is still accepted
> (`cp` = `check=quick`, `fleet` = `check=full`) so an existing integration
> keeps working; `check` is the name documented from here on.

A `?check=full` result also carries `measured_by`, saying where the
measurement actually came from: `phone` when a real phone session took it —
the machine `?check=full` asks for — or `driftstack` when Driftstack itself
did, the honest fallback when a `?check=full` request could not reach a phone
in time. `?check=quick` is always `driftstack` and carries no field to say so.
The original `measured_from` field (`fleet` / `control_plane`) is still sent
beside it, unchanged, for an integration that already reads it; `measured_by`
is the name documented from here on.

An `ok: false` result that also carries `not_run` is **not a result about the
proxy** — nothing was measured. Branch on `not_run`, never on the `reason`
prose, before treating the result as a failed proxy:

```json
{
  "ok": false,
  "not_run": "live_session",
  "reason": "This VPN is being used by a running session, so the exit IP shown is from that session. End the session to check the VPN.",
  "measured_by": "driftstack",
  "exit_observed": {
    "ip": "203.0.113.9",
    "country": "NL",
    "timezone": "Europe/Amsterdam",
    "region": null,
    "city": null,
    "observed_at": "2026-09-09T18:21:07.000Z"
  }
}
```

- `live_session` — a `?check=full` test of an `openvpn` / `wireguard`
  proxy was skipped because a live session is browsing through this VPN. A
  second connection on a one-connection VPN account would drop that session,
  so nothing was tested. `measured_by` is `driftstack` (nothing measured
  the tunnel) and `exit_observed`, when present, is the exit that session saw
  — the same `exit_observed` the proxy object lists — so a client can still
  show where the tunnel exits. End the session to test the tunnel.
- `config_unresolvable` — the stored configuration could not be turned into
  anything Driftstack could run (the same fact the `config_unresolvable`
  reason in [Why a launch is refused](#why-a-launch-is-refused) names — the
  `reason` field says to re-add it; a retry will not help).
- `check_unavailable` — a `?check=full` test of an `openvpn` / `wireguard`
  proxy that was not run for a reason on our side: the machine that would
  have run it was busy or the dispatch timed out (try again in a minute), the
  tunnel could not be brought up (a bad config, a handshake failure, or a
  timeout — also worth a retry), or full checks are not set up on this
  deployment (a retry will not change that). The `reason` field says which.
  In every case there is no fallback to a plain reachability check of the
  tunnel endpoint. `measured_by` is `driftstack` and `exit_observed`,
  when present, is the stored exit a session observed.

The `exit_observed` beside a `not_run` is the proxy's **stored** observation,
not something this test measured, so it carries `observed_at` — when it was
observed (`null` for an observation recorded before the field existed). Date
it by that, never by the reply: a later test that found the tunnel down can
postdate it. A stored exit a later test has since contradicted (the proxy's
`exit_superseded_at` is set) is **not attached** — and the `live_session`
reason then does not say the exit is shown — because the last check found the
tunnel down and produced no exit to show.

Absent `not_run`, an `ok: false` result is a measurement. Two of those are
worth knowing for a VPN proxy on a `?check=full` test: a stored
configuration Driftstack cannot read (the `reason` says to re-add it — a retry
will not help), and a **403** when your tier no longer includes VPN proxies —
the same refusal you get when launching a session through it.

Two cases fall back to a plain reachability check, which confirms the address
answers and nothing more: an `openvpn` or `wireguard` proxy on the default
test (`check=quick`), which does not connect the tunnel itself, and a
deployment where the full tunnel test is not available.

Required scope: `account_owner` — a broad `write` key is not sufficient.

## Route a session through a proxy

Pass `proxy_id` when you
[create an agent session](/api/agent-sessions/):

```json
{ "profile_id": "prof_...", "proxy_id": "a1b2c3d4-..." }
```

The session's traffic is routed through that proxy. The `proxy_id` must
be one of your account's proxies (an unknown or not-owned id returns
`404`), and its scheme must be one that can route a session — an
`http` proxy returns `400` with a message naming the supported
schemes. Omit it to use the default connection.

> The Driftstack desktop app manages this for you: add a proxy under
> **Proxies**, set it as a profile's default, and launching the profile
> routes that session through it automatically.

## Why a launch is refused

Before a session is created, Driftstack proves the proxy can actually carry it.
If it cannot, the create returns `422`
`errors.driftstack.dev/proxy-validation-failed` and **no session is created and
nothing is billed** — the refusal happens before any browser starts.

The problem body carries a `reason` alongside the human `detail`:

```json
{
  "type": "https://errors.driftstack.dev/proxy-validation-failed",
  "title": "Proxy validation failed",
  "status": 422,
  "detail": "The proxy connected but could not reach the internet. Check with your proxy provider.",
  "reason": "egress_blocked",
  "resource": "proxy"
}
```

`reason` is a closed set. Branch on it — `detail` is prose and may be reworded.

| Reason                | What it means                                                                                                                                                                                           | What fixes it                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `unreachable`         | Nothing answered at `host:port`.                                                                                                                                                                        | Check the host, the port, and that the proxy is online.                                                                 |
| `auth_failed`         | The proxy answered and rejected the username or password.                                                                                                                                               | Re-enter the credentials.                                                                                               |
| `timeout`             | The proxy accepted the connection but did not finish in time.                                                                                                                                           | It is overloaded or half-down; retry, then change proxy.                                                                |
| `egress_blocked`      | The proxy authenticated, then refused or failed to reach the destination.                                                                                                                               | Ask the provider — this is usually plan, quota, or an ACL.                                                              |
| `config_unresolvable` | The stored configuration could not be used, so **nothing was dialled**. The other four reasons are results from a real round-trip through the proxy; this one is not a measurement of the proxy at all. | Open the proxy and fix or re-paste its configuration. Checking the host and port will not help — they were never tried. |

`egress_blocked` is the one that surprises people. The credentials are correct
and the proxy is up, so anything that only checks reachability calls it healthy;
the provider is simply declining to route. A provider that has suspended an
account, exhausted its bandwidth quota, or restricted destinations by ruleset
refuses every request this way. Nothing on the Driftstack side will change it.

To distinguish "this proxy is broken" from "this provider is refusing
everything", test a second proxy from a different provider: if that one launches,
the fault is the first provider's.

Retrying a `422` with the same proxy will fail the same way — it is a statement
about the proxy, not a transient error, so the SDKs do not retry it.
