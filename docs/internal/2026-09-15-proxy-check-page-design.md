# A check page of our own — measuring a proxy the way a website does

**Owner's question, 2026-09-15:** _"if we took an architectural change, for example
have our own local page for proxy testing, wouldn't proxy checks be a lot faster
and more smooth and trustworthy?"_

**Answer: yes on trustworthy, yes on smooth, mostly yes on fast — and the design
below is the one worth building.** The two-port diagnostic that settled the OS
chip is the argument: the only reading that agreed with reality was the one
taken **on the port a website uses, by the path a website takes**. A check page
is that vantage, generalised to every measurement we make.

## What a proxy check is today

Three different instruments answer one question ("what does a site see through
this proxy?"), each from a different vantage:

| measurement                       | who measures                                          | vantage                      | what it can miss                                                                                                 |
| --------------------------------- | ----------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| reachability / auth / UDP / route | the desktop app, natively (Rust SOCKS5)               | the customer's Mac           | fine — this is the customer's own path                                                                           |
| exit IP / geo                     | the app, via `/v1/egress/echo` **through Cloudflare** | CDN edge                     | the exit a CDN-fronted site sees ≠ the exit a direct site sees (measured: mobile providers route by destination) |
| QUIC relay                        | a fleet Mac's handshake, or a live session            | fleet Mac                    | a verdict from a different machine than the customer's                                                           |
| OS stack                          | the control plane's SOCKS5 CONNECT to the origin      | server, port 443 since today | a relay's stack, not the device's, on any port a site does not use                                               |

Each is correct about its own proposition and none is the customer's browser on
the customer's proxy. That is why four of tonight's defects were "a correct
measurement of the wrong proposition".

## The design

**One page, served from our origin at an IP-literal-resolvable, non-CDN host,
loaded by the app's real WebKit through the customer's proxy.** The page is the
instrument. It is what browserleaks is, except we own both ends, so the server
side can bind every observation to _this_ page load.

```
Tauri app ── hidden WebView ── customer's proxy ── check.driftstack.dev:443 (origin, grey-cloud)
                                                          │
                                        nginx ─┬─ page + JSON report (HTTP/1.1, h2, h3)
                                               └─ observer.py sees the SYN, keyed by (ip, 443)
```

The app opens `https://check.driftstack.dev/p/<nonce>` in a hidden WebView
configured with the proxy under test. The nonce is minted by the control plane
for this check. Server side, one request handler records, **keyed by nonce**:

- the **exit address** — the source of the TLS connection carrying the nonce, on
  a direct (non-CDN) host, so it is the address a direct site sees;
- the **TCP stack** — the observer's SYN for that source on 443, bound by the
  nonce's own connection rather than by a per-address last-SYN slot (this
  removes the shared-slot race we documented and could not close today);
- the **protocol** — whether the same page loads over **HTTP/3**: the page
  fetches its report over h3 with `Alt-Svc`, and reports which ALPN it got. That
  is the customer's browser doing QUIC through the customer's proxy — a stronger
  QUIC verdict than either the fleet handshake or the inference from UDP;
- **WebRTC candidates** — the page gathers ICE candidates and posts them; a leak
  is a candidate that is not the exit;
- **timezone / language / DNS** — from the page itself, for coherence checks
  against the profile.

The app then reads one JSON report for the nonce. Everything on it was measured
through one connection path by one browser, at one instant, with a timestamp the
server wrote.

## Why it is more trustworthy

- **Same vantage as a website.** Port 443, TLS, a real browser, the customer's
  own proxy session. No inference from a different port, machine or protocol.
- **Bound, not correlated.** Today every reading is keyed by an address and
  bound by a timestamp window. The nonce binds each reading to the request that
  produced it — which is the property every one of tonight's freshness and
  vantage defects lacked.
- **One clock.** All fields are stamped by one server write, so the "Tested" time
  IS the date of every field shown beside it. The borrowed-freshness class
  cannot occur.

## Why it is smoother and (mostly) faster

- One round trip through the proxy instead of three instruments in sequence
  (native probe → CP test → fleet dispatch). A fleet Mac is no longer needed for
  a SOCKS5 check at all, which removes the "no Mac was free" outcome.
- The WebView is already in the app (the simulator uses it). A hidden one costs a
  page load — 1–3 s through a residential proxy — versus 12 s of CP probe budget
  plus a fleet dispatch today.
- **What it does not speed up:** OpenVPN/WireGuard rows. A tunnel has to be
  brought up somewhere, and that stays with the fleet Mac. But the fleet Mac can
  load the same check page through the tunnel and report the nonce, so VPN rows
  get the identical report shape — including OS, which they cannot get today.

## What it costs

1. A grey-cloud host (`check.driftstack.dev` → origin IP, like `fleet.`) with
   h3 enabled in nginx (`listen 443 quic reuseport; add_header Alt-Svc`). Small.
2. A control-plane route pair: mint nonce; read report. Reports live in Redis
   with a short TTL. Small.
3. The observer binds by nonce: nginx logs the client port of the nonce request,
   the observer keys SYNs by (ip, port, client-port). Medium — an observer
   contract change, which is the one we already know we need.
4. The app: a hidden WebView driven with the proxy, a timeout, and the existing
   cache writes fed from the report instead of three sources. Medium.
5. The fleet half for VPN rows (A3): load the page through the tunnel, return
   the nonce. Small once the page exists.

## What it replaces, and what it does not

Replaces: the exit echo through Cloudflare, the CP SOCKS5 OS observation for
SOCKS5 rows, and the fleet QUIC handshake for SOCKS5 rows. Keeps: the native
reachability/auth/UDP probe (it is fast and it is the customer's own path) and
the fleet tunnel bring-up for VPN rows.

## Sequencing

Ship it behind the existing surfaces, not instead of them: the report feeds the
same cache fields the chips already read, so no chip changes on day one. Then
retire each old instrument once the page's reading agrees with it on the owner's
proxies for a week. The first slice — host, nonce route, page reporting exit +
ALPN + stack-by-nonce — is a few days of work and settles the OS question for
good.
