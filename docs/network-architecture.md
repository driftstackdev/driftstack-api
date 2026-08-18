# Driftstack — network architecture

> **Founder review required before fleet integration begins.** The
> control-plane → Mac-Mini-fleet auth path described in §4 is the
> primary load-bearing decision; v1 is "public internet + signed JWT
> over mTLS" with WireGuard mesh as a v2 improvement.
>
> **V-809 — this is no longer a forward contract.** The banner used to say
> nothing had been wired in code and that both sides would respect the doc
> once it was signed off. Much of it has since shipped in this repo:
> `infra/nginx/` carries the Hetzner edge config including
> `cloudflare-real-ip.conf`, fleet authentication is implemented in
> `apps/server/src/services/fleet-node-auth.ts` with the client-certificate
> surface in `fleet-events.ts`, `apps/status-site/` exists, and the customer
> dashboard deploys via `.github/workflows/deploy-customer-dashboard.yml`.
> Read the sections below as describing live surfaces unless a section says
> otherwise, and treat any remaining unbuilt item as scoped rather than the
> whole document.

**Effective:** 2026-05-03 · **Version:** 0.1.0-draft (Workstream A foundational)

## Overview

Driftstack at launch is a single-region deployment with three
network surfaces:

1. **Customer ↔ control plane** — public HTTPS API on
   `api.driftstack.dev`. TLS terminated at Cloudflare, plain HTTP to
   the Hetzner VM over a Cloudflare Tunnel.
2. **Customer ↔ marketing site** — public HTTPS on `driftstack.dev`,
   `docs.driftstack.dev`, and `app.driftstack.dev`, all static on
   Cloudflare Pages. V-809 — `app.driftstack.dev` is its own Cloudflare
   Pages project, deployed by
   `.github/workflows/deploy-customer-dashboard.yml`; it is neither a future
   surface nor served through the Hetzner VM at all. The dashboard is a
   static SPA that calls the control-plane API cross-origin, which is why
   the CORS allowlist matters (see the control-plane surface above).
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

### Revocation (required from day one)

Per founder direction (V-052, decision 1B): revocation is required
infrastructure, not a follow-up. Building it in is an order of
magnitude cheaper than retrofitting; deploying without it leaves the
control plane unable to respond to a compromised mac mini, a stolen
keypair, or a decommissioned node.

**Data model:** the `fleet_nodes` table gains a `revoked_at`
timestamp column (nullable; `NULL` = active). When admin revokes,
`revoked_at` is set to `now()` along with a `revocation_reason`
(free-form text recorded for audit).

**JWT validation:** the control plane's JWT verifier checks
`fleet_nodes.revoked_at IS NULL` for the issuing `node_id` on every
request. A revoked node's JWTs fail validation immediately, even if
the JWT itself is otherwise well-formed and within its 5-minute
expiry. There is no propagation delay because the check hits the
hot row in `fleet_nodes`.

**Cache strategy:** the JWT validation path caches the
`(node_id, public_key, revoked_at)` tuple in Redis with a short TTL
(15 seconds is enough to absorb burst traffic without delaying a
revocation past a quarter-minute). Admin revoke also issues a
`DEL` on the cached entry, so revocation propagates immediately to
the validation hot path.

**Admin API:** new endpoint `POST /v1/admin/fleet/{node_id}/revoke`,
`admin` scope required. Body: `{reason: string}`. Response: 200 with
the new `revoked_at` timestamp. Idempotent: revoking a revoked node
is a 200 no-op.

**Audit log:** revocation events written to the existing
`admin_audit_log` table (V-025 / D-025) with action
`fleet_node.revoked`, target = node_id, payload = reason. No
separate audit table needed.

**WebSocket / long-poll behaviour on revocation:** if a revoked
node has an active connection, the control plane sends a close
frame on the next outbound message attempt. The fleet node's
reconnect loop will fail JWT validation and stop trying. No
zombie-connection risk because all messages flow through the JWT
validator.

### JWT signing-key rotation event format

Per founder direction (V-052, decision 1C): document the rotation
event so security audits can reconstruct which key signed which
JWT at which time.

**Storage:** signing keys live in a `fleet_signing_keys` table.

```
CREATE TABLE fleet_signing_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kid          text NOT NULL UNIQUE,         -- key identifier embedded in JWT
                                             -- header `kid` claim
  public_key   text NOT NULL,                -- PEM-encoded
  -- Private key NOT stored in this table; lives in HashiCorp Vault
  -- or equivalent secret store, fetched into memory on rotation.
  created_at   timestamptz NOT NULL DEFAULT now(),
  active_from  timestamptz NOT NULL,         -- earliest timestamp this key may sign
  active_until timestamptz NOT NULL,         -- last timestamp this key may sign
                                             -- (active_from + 30 days for normal rotation)
  retired_at   timestamptz                   -- nullable; set when key is no longer
                                             -- accepted for verification (active_until + 24h)
);
```

**Rotation event** (logged to `admin_audit_log`):

```
{
  "event": "fleet_signing_key.rotated",
  "previous_kid": "<old kid>",
  "new_kid": "<new kid>",
  "previous_active_until": "<ISO 8601>",
  "new_active_from": "<ISO 8601>",
  "overlap_window_hours": 24,
  "rotation_actor": "automated_monthly_rotation" | "<admin_id> manual"
}
```

**JWT header:** every fleet-issued JWT includes `kid` in the JOSE
header. The verifier looks up the kid in `fleet_signing_keys`,
checks the JWT's `iat` falls within `[active_from, active_until]`,
and verifies signature against the corresponding public key.
Fast-fails outside the active window.

**24-hour overlap rationale:** during the overlap window, both the
old and new keys are accepted for verification (`retired_at IS NULL`
on both rows). Fleet nodes that were briefly offline during rotation
can finish their old key's in-flight JWTs without auth failures.
After 24 hours, the old key's `retired_at` is set, validation
rejects, and the only path forward for the fleet node is to fetch
the new public key (which it does on JWT-validation 401 → public-key
refresh).

**Audit reconstruction:** for any historical JWT, querying
`fleet_signing_keys WHERE kid = ?` yields the public key, the
active window, and (via `created_at`) when the key entered service.
Cross-referencing `admin_audit_log` for `fleet_signing_key.rotated`
events gives the full rotation history.

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

### Decided architecture (V-052 founder sign-off)

1. **mTLS terminator placement: Hetzner-side direct.** Cloudflare
   Tunnel handles edge HTTPS for the public API surface; mTLS
   between Mac Mini fleet and control plane terminates on the
   Hetzner VM directly. Skips Cloudflare API Shield (paid feature),
   simpler architecture, fewer moving parts.
2. **Fleet node identity provisioning: on-device keypair generation
   plus admin-API public-key registration.** Founder provisions the
   Mac Mini → keypair generated on-device (private key never leaves
   the device) → public key posted to the control plane via an
   admin endpoint that requires the founder's existing admin API
   key. Plus the mandatory revocation flow documented above.
3. **JWT signing-key rotation: monthly auto-rotate with 24h
   overlap.** Per-node keypairs don't rotate (long-term identity).
   The control plane's signing key for control-plane-issued tokens
   rotates monthly with a 24-hour overlap window so briefly-offline
   fleet nodes don't fail auth. Rotation event format documented
   above.

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

## §7. Open architecture decisions

Three V-051 open questions resolved by founder direction in V-052
(see §4 "Decided architecture"). Remaining open items:

1. **Log shipping trigger threshold (§5).** Currently journald-only;
   moving to Loki / Better Stack / equivalent when traffic justifies.
2. **Status page provider** — Cloudflare Workers status page vs
   Better Stack vs Statuspage. Founder review when first paying
   customer onboards.

---

_§1–§5 documented in V-051; §4 "Decided architecture" + revocation
flow + JWT rotation event format added in V-052. Agent 1's fleet
integration may begin against the §4 contract as documented._
