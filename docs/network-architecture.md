# Driftstack — network architecture

> **Founder review required before fleet integration begins.** The
> control-plane → Mac-Mini-fleet auth path described in §4 is the
> primary load-bearing decision; v1 is "public internet + signed JWT
> over mTLS" with WireGuard mesh as a v2 improvement. Nothing has
> been wired in code yet — this doc is the contract that fleet code
> (Agent 1's territory) and control-plane code (this repo) will
> respect once the founder signs off.

**Effective:** 2026-05-03 · **Version:** 0.1.0-draft (Workstream A foundational)

## Overview

Driftstack at launch is a single-region deployment with three
network surfaces:

1. **Customer ↔ control plane** — public HTTPS API on
   `api.driftstack.dev`. TLS terminated at Cloudflare, plain HTTP to
   the Hetzner VM over a Cloudflare Tunnel.
2. **Customer ↔ marketing site** — public HTTPS on `driftstack.dev`,
   `docs.driftstack.dev`, and (future) `app.driftstack.dev`. Static
   on Cloudflare Pages; signup flow lives on the control plane and is
   served via `app.driftstack.dev` reverse-proxied to the Hetzner VM.
3. **Control plane ↔ Mac Mini fleet** — the load-bearing internal
   surface. v1 plan: signed JWT over mTLS, fleet pulls work from the
   control plane; v2: WireGuard mesh.

This doc focuses on (3) because (1) and (2) are standard
public-internet patterns. (3) involves cross-provider trust between
the Hetzner VM and the MacStadium-hosted fleet.

## §1. Customer ↔ control plane

```
Customer                Cloudflare           Hetzner VM
SDK / GUI               (proxy + WAF)        (Docker container)
   │                       │                       │
   │  HTTPS                │  Tunnel              │
   ├──────────────────────►│──────────────────────►│  /v1/* + /health + /ready
   │  api.driftstack.dev   │                       │  Fastify @ :7780 (loopback)
   │                       │                       │
```

- Customer SDKs hit `https://api.driftstack.dev` (DNS in Cloudflare,
  Cloudflare proxy on).
- Cloudflare Tunnel from the Hetzner VM connects outbound to
  Cloudflare; no inbound port is open on the VM beyond SSH for
  ops.
- TLS terminated at Cloudflare's edge. Hetzner VM serves plain HTTP
  on `127.0.0.1:7780` (compose file binds localhost-only).
- Cloudflare WAF rules: rate-limit per-IP for unauthenticated
  requests, block known-bad ASNs from the auth surface only.
- Customer base is EU + UK + US + Switzerland; Cloudflare's EU
  region is selected for the account, so processing happens in EU
  PoPs.

### Headers + auth

- API keys in `Authorization: Bearer <plaintext>`.
- Server reads `X-Forwarded-For` (Cloudflare populates) into
  `request.ip`. The legal-acceptance audit log records this IP.
- `request-id` propagated through requests via Fastify's
  `request-id` plugin (V-001 / V-006).

### Failure modes

- **Cloudflare-side failure** (rare): `cf.driftstack.dev/health`
  fails; status page polls the Hetzner VM directly via SSH-tunnel
  fallback.
- **Cloudflare Tunnel restart**: ~5 second blip; readiness probe
  catches it.
- **Hetzner VM down**: 503s from Cloudflare. Customer SDK retry
  policy (V-005) handles transient ones; persistent failure
  triggers the alert path.

## §2. Customer ↔ marketing site

`driftstack.dev` and `docs.driftstack.dev` deploy via Cloudflare
Pages (Astro static-first build per Workstream B). No backend on the
marketing site itself; the signup flow + customer dashboard surface
live on the control plane.

```
Customer Browser    Cloudflare Pages    Hetzner VM
       │                  │                  │
       │  HTTPS           │                  │
       ├─────────────────►│                  │  driftstack.dev
       │                  │                  │  docs.driftstack.dev
       │                                     │
       │  HTTPS           Tunnel             │
       ├────────────────────────────────────►│  app.driftstack.dev
                                                (signup + acceptance + first-key)
```

The split between `driftstack.dev` (static marketing) and
`app.driftstack.dev` (dynamic onboarding + dashboard) keeps the
marketing site cacheable at the edge while the dynamic surface goes
through the Tunnel.

## §3. Cross-provider data flow

Per the V-048-bumped sub-processor list, EU residency is preserved
end-to-end:

| Service               | Provider               | Region               |
| --------------------- | ---------------------- | -------------------- |
| Compute               | Hetzner Cloud          | Falkenstein, Germany |
| Postgres              | Neon                   | EU Frankfurt         |
| Redis                 | Upstash                | EU Frankfurt         |
| Object storage        | Cloudflare R2          | EU jurisdiction      |
| CDN / DNS             | Cloudflare             | EU PoPs              |
| Static site hosting   | Cloudflare Pages       | EU PoPs              |
| Transactional email   | Postmark               | EU sending region    |
| Error tracking        | Sentry                 | EU region            |
| Payment (fiat EU)     | Stripe Payments Europe | Ireland              |
| Payment (fiat non-EU) | Stripe Inc.            | US (DPF + 2021 SCCs) |
| Crypto payment        | Coinbase Commerce      | US (DPF + 2021 SCCs) |
| Accounting            | Moneybird              | Netherlands          |
| Fingerprint fleet     | MacStadium             | US, California       |
| Bundled LLM (opt-in)  | Anthropic              | US (DPF + 2021 SCCs) |

Cross-provider transfers within the EU don't require SCCs (Article
44 GDPR — within the Union). Transfers to US-hosted Sub-processors
ride on EU-US DPF + 2021 SCCs as documented in the DPA Annex 3
(V-046 / V-048).

## §4. Control plane ↔ Mac Mini fleet (load-bearing)

The fleet is at MacStadium (US, California). The control plane is at
Hetzner (Germany). Both are public-internet endpoints. The fleet
must:

1. Authenticate to the control plane.
2. Receive session-creation work (which archetype, which proxy URI,
   which Customer-Provided Secrets).
3. Stream session events back (status changes, captures,
   recordings).
4. Reject any inbound request that isn't from a known fleet node.

### v1 design — signed JWT over mTLS

**Auth direction:** fleet nodes initiate. The control plane never
calls _into_ the fleet; the fleet polls / streams _out_ to the
control plane. This is critical: it means the fleet's network can
sit behind NAT or restrictive egress rules without inbound holes.

**Authentication primitive:**

1. Each fleet node has a long-lived **node identity** issued at
   provisioning time. The identity is a keypair (Ed25519) plus a
   `node_id` registered in the control plane's `fleet_nodes` table.
2. On connect, the fleet node generates a JWT signed with its
   private key, including `iss=<node_id>`, `iat`, `exp` (5 min).
3. The control plane verifies the JWT against the public key on
   record for `node_id`. Reject on mismatch, expiry, or revocation.

**Transport primitive:**

1. **mTLS** between fleet node and control plane. The control plane
   has a mTLS-enabled endpoint at `fleet.driftstack.dev` (separate
   Cloudflare hostname from the customer-facing one). Cloudflare
   passes mTLS certs through to the Hetzner VM via Cloudflare's
   Authenticated Origin Pulls or a similar mechanism.
2. Fleet node's certificate is signed by Driftstack's internal CA.
   The control plane verifies the cert chain on every request.
3. Even if the JWT is leaked, the mTLS cert is required to present
   it — defence in depth.

**Why this shape:**

- Fleet-initiates → no inbound exposure on the fleet side.
- mTLS → defeats accidental public exposure of the control-plane
  fleet endpoint.
- Signed JWT → authenticates the specific node, not just "some
  fleet member with a cert".
- Long-lived node identity + short-lived JWT → revocation is just
  marking the node row.

**What the JWT carries:**

- `iss`: `node_id` (UUID).
- `sub`: `node_id` (the same — JWT is for self-authentication).
- `iat`: issue time.
- `exp`: 5 minutes after issue.
- `nonce`: per-request random; control plane caches issued nonces
  for the JWT lifetime to defeat replay.

**Control plane → fleet flow:**

1. Fleet node opens an authenticated long-poll or WebSocket
   connection to `wss://fleet.driftstack.dev/v1/fleet/events`.
2. Control plane streams session-creation events as the API issues
   them. Each event includes the session ID + archetype + proxy
   config + Customer-Provided Secrets (encrypted with the fleet
   node's public key — defence-in-depth even within the mTLS
   tunnel).
3. Fleet node ACKs each event after picking it up; control plane
   marks the session "assigned" to that node.

**Fleet → control plane flow:**

- Session events (`navigate`, `interact`, `capture`, `wait`) flow
  back via the same authenticated connection.
- Recording frames (PNG) upload to R2 via a presigned URL the
  control plane generates per-session.

### v2 design — WireGuard mesh

When fleet size + cross-region complexity justify it (probably

> 5 nodes, multi-region), a WireGuard mesh between the Hetzner VM and
> the fleet replaces the public-internet hop. Same auth model on top
> (JWT), but transport is over a private overlay network.

Cost vs benefit at v1:

- WireGuard adds: NIC config on every fleet node + Hetzner peer config
  - WG tunnel monitoring + key rotation policy.
- WireGuard replaces: Cloudflare-frontend mTLS on the fleet endpoint.
- Net: not worth it at single-fleet-node scale. Re-evaluate at
  fleet-size = 5+.

### Open questions for founder

1. **mTLS terminator placement.** Cloudflare's Authenticated Origin
   Pulls mTLS-authenticates Cloudflare → origin (the Hetzner VM), not
   client → Cloudflare. For client → Cloudflare mTLS we'd use
   "Cloudflare API Shield" (paid feature) or terminate mTLS on the
   Hetzner VM directly (skipping Cloudflare for the fleet endpoint).
   Recommend: terminate on Hetzner VM (simpler, no Cloudflare paid
   feature, fleet endpoint isn't customer-facing so the Cloudflare
   WAF / DDoS protection is less load-bearing).
2. **Fleet node identity provisioning.** When a new mac mini joins
   the fleet, what's the bootstrap flow for the keypair? Recommend:
   founder provisions the mini, generates the keypair on-device,
   posts the public key to the control plane via an admin endpoint
   that requires the founder's existing admin API key.
3. **JWT secret rotation.** Per-node keypairs don't rotate (they're
   the long-term identity). The control plane's signing key for
   any _control-plane-issued_ tokens (e.g. session-creation tokens
   the fleet acts on) needs a rotation schedule — recommend monthly
   automated rotation with 24h overlap window.

## §5. Logging + observability

- **Structured logging:** Pino JSON to stdout, captured by Hetzner
  journald.
- **Sentry:** SDK integrated in the API server (project
  `driftstack-api`, EU region). DSN supplied via `SENTRY_DSN` env
  var. Source maps uploaded on deploy. The GUI has a separate Sentry
  project (`driftstack-gui`); the marketing site will get
  `driftstack-web` when Workstream B starts.
- **Health vs readiness:**
  - `/health` — process up. Cheap. Cloudflare healthcheck reads
    this.
  - `/ready` — DB + Redis + R2 reachable. More expensive (timed,
    parallel). Hetzner-internal readiness probe reads this.
- **Log shipping:** deferred. journald on the VM is sufficient for
  early traffic; log aggregator (Loki, Better Stack, etc.) lands when
  monthly traffic justifies. Founder review on triggers.

## §6. Disaster scenarios

| Scenario                         | Detection                    | Mitigation                                                                           | Status         |
| -------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ | -------------- |
| Hetzner VM down                  | /health 503 from CF          | Cloudflare 503 page; founder pages via Sentry                                        | Manual         |
| Postgres (Neon) down             | /ready 503                   | Read replica failover via Neon (managed)                                             | Managed        |
| Redis (Upstash) down             | /ready 503; rate limit fails | API degrades to in-memory rate limiting (existing fallback path)                     | Existing       |
| R2 down                          | Recording uploads fail       | Local cache on fleet (V-040 already does this); upload retries                       | Existing       |
| Postmark down                    | Email send fails             | Queue + retry; signup flow tolerates (verification email arrives late)               | Build during F |
| Cloudflare-side outage           | API unreachable globally     | Limited mitigation (Cloudflare scope); status-page comms                             | Manual         |
| MacStadium fleet down (regional) | Session-creation fails       | 503 to customer (no failover at v1; surface for "Mac mini fleet provisioning" Phase) | Manual         |
| GH Actions deploy fails          | Deploy job red               | Roll back via `docker compose up` to previous IMAGE_TAG (manual)                     | Manual         |

The "manual" entries are intentionally not yet automated; founder
review on which to automate first when traffic justifies.

## §7. Open architecture decisions (founder review)

1. mTLS terminator placement (§4 open Q1).
2. Fleet-node identity bootstrap flow (§4 open Q2).
3. JWT signing-key rotation cadence (§4 open Q3).
4. Log shipping trigger threshold (§5).
5. Status page provider — Cloudflare Workers status page vs Better
   Stack vs Statuspage. Recommend founder review when first paying
   customer onboards.

---

_This doc is V-051 / Workstream A. Founder review required before
fleet code starts; Agent 1 will integrate against the §4 contract
once signed off._
