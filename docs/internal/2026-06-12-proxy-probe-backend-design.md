# Proxy probe backend — design (organization: proxy-health arc, phase 2)

**Status:** DESIGN — decision points surfaced to founder, nothing built.
**Context:** the founder approved the proxy-health board demo r2 (per-exit
TCP / UDP / QUIC / WebRTC capabilities). The GUI half is SHIPPED honest-to-
current-data: the native Rust `proxy_test` probes TCP CONNECT + auth + UDP
ASSOCIATE + latency, and the view derives QUIC/WebRTC as "rides UDP". This
doc designs the rest of the demo's ambitions: exit-geo + geo-drift, true
h3/ICE probes, and scheduled re-probing.

## The constraint that shapes everything

The Proxies view carries a **pinned privacy promise**: proxies are "stored
locally on this device only — never uploaded to the Driftstack control
plane" (ProxiesView empty-state copy, drift-guarded). Any probe design must
preserve it. Consequences:

- Probes must originate **from the customer's device** (the Tauri native
  layer), through the proxy. Server-side probing would require uploading
  proxy credentials — breaks the promise outright.
- Exit-geo needs an echo endpoint the probe can call _through_ the proxy.
  Whoever operates that endpoint sees the proxy's **exit IP** (not its
  address, port, or credentials).

## Component design

### 1. Exit-geo + geo-drift (highest customer value)

Probe: native Rust, `CONNECT`s through the proxy to an echo endpoint,
reads back `{ ip, country, city }`.

Echo endpoint options:

| Option                                                 | Privacy                                                                                                      | Notes                                                                                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Self-hosted `GET /v1/egress/echo` (RECOMMENDED)** | Driftstack sees the exit IP only — same thing every visited website sees. Creds/host never leave the device. | Tiny route: returns caller IP + MaxMind-style geo (we already geo-resolve for SOCKS5 auto-geo-locale). Unauthenticated-but-rate-limited, or authed (then we can also correlate per-account — see decision F1). |
| B. Third-party (ipify/ip-api)                          | Leaks customer proxy exit IPs to a third party on our behalf.                                                | Rejected — violates the privacy-first posture even though the data is "public".                                                                                                                                |

Geo-drift: pure client-side comparison — exit country from the echo vs the
locale/timezone of profiles whose sessions use that proxy. v1 GUI-only
(profile→proxy bindings already live client-side in `profile-bindings.ts`).

### 2. True h3 probe (upgrade from "rides UDP")

The current derivation (UDP ASSOCIATE ⇒ QUIC-capable) is honest but
optimistic: some relays accept ASSOCIATE yet drop/garble UDP datagrams.
Upgrade: send a real **QUIC Initial** through the UDP relay to the echo
host (or any h3 endpoint we operate) and require a valid Server Initial
back. Rust: `quinn`/`quiche` handshake-only, abort after the first flight —
no full connection needed. Falls back gracefully: probe failure downgrades
the chip to "UDP relay accepts but QUIC failed — verify with provider".

### 3. ICE/WebRTC probe

A STUN Binding request through the UDP relay to a STUN server, assert a
mapped address comes back AND it matches the echo exit IP (the demo's
"reflexive address matches exit geo" check). STUN server: ours (coturn
already in the LiveKit stack) — same third-party-leak reasoning as the
echo endpoint. Cheap (one datagram each way) — can ride the same UDP
ASSOCIATE session as the h3 probe.

### 4. Scheduled re-probing

GUI-side interval (the only place the proxies exist). Default: re-probe on
app launch + every 6h while running + manual Test-all. Sequential, jittered.
NOT a daemon — no background probing when the app is closed (matches "this
device only" expectations; a closed app generating traffic through customer
proxies would be surprising).

## What stays out (v1)

- Server-side probing of session-wired proxies: becomes possible _with
  consent_ once EG-API-1.6 emission wiring lands (the server already
  resolves saved-proxy → `inlineProxyConfig` at assign time) — but that is
  a different proxy population (org-level, uploaded by choice) and a
  different doc.
- Latency history/sparklines persistence: ride the existing settings-store
  pattern later; not load-bearing.

## Founder decision points

- **F1 — echo endpoint authentication.** Unauthenticated + IP-rate-limited
  (exit IPs never tied to accounts; maximum privacy) vs authed (lets us
  warn "your proxy's exit is a known datacenter range" per account later).
  Recommendation: start unauthenticated; revisit with an opt-in.
- **F2 — STUN reuse.** Reusing the LiveKit coturn for probe STUN mixes
  probe traffic into media infra. Fine at current scale? (Alternative: a
  stunner sidecar on the API box.)
- **F3 — cadence default.** 6h + launch + manual proposed.

## Build order (once F1 decided)

1. `/v1/egress/echo` route + geo (server, ~small; reuses geo infra).
2. Rust probe v2: echo fetch through proxy (exit-geo) + QUIC Initial +
   STUN Binding, one `proxy_capabilities` command returning the full set.
3. GUI: geo column + drift callout (the demo's design, real data) +
   chip upgrade from derived to probed.
4. Scheduled re-probe + jitter.
