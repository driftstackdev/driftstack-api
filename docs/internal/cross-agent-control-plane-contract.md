# Cross-agent control-plane contract

**Purpose:** single page documenting every concrete interface across the
Agent-1 (driftstack + webkit-driftstack) ↔ Agent-2 (driftstack-api) ↔ Harness
boundary so neither side has to read the other's code to understand the
contract. Update when a new cross-agent surface ships.

**Sources of truth (read first):**

- `/Users/john/code/driftstack/docs/planning/133-egress-architecture-cross-agent.md`
  — EGRESS binding spec (7 Tier-3 verdicts LOCKED 2026-05-16).
- `/Users/john/code/driftstack/docs/planning/132-ml-expansion-roadmap.md`
  — Three-Layer surface generalization (AI Phase 7 = Agent 2 territory).
- `/Users/john/code/driftstack/ORCHESTRATOR-STATE.md` — authoritative
  for cross-session decisions.
- `/Users/john/code/driftstack-api/AGENTS.md` — Rule G scope boundary.

This doc is the **landing page** that points at the per-surface contracts;
the detailed JSON schemas + IPC shapes live in planning 133 + 132 + the
per-feature design docs.

---

## EGRESS — customer-configurable proxies (planning 133)

### Schema (LOCKED 2026-05-16)

The binding shape is `SessionEgressConfig` in
`packages/api-types/src/egress.ts` (commit `555d8001`). Both Agent 1 +
Agent 2 + harness consume from this single Zod source.

```ts
{
  session_id: string,
  proxy: { type: 'socks5' | 'openvpn' | 'wireguard', socks5 | openvpn | wireguard: {...} },
  egress_safeguard: {
    block_direct_internet: true,
    block_unproxied_dns: true,
    block_webrtc_stun_leakage: true,
  },
}
```

### Phase 1 SOCKS5 (in progress)

| Layer               | Owner   | Contract                                                                                                                                                           |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API route           | Agent 2 | `POST /v1/sessions/{id}/proxy` accepts `SessionEgressConfig`; safeguards stay on at v1.0. Activation-gated 503 until `sessionEgressService` wires.                 |
| Saved configs       | Agent 2 | `POST/GET/DELETE /v1/proxies` for the customer's reusable library.                                                                                                 |
| API safeguard       | Agent 2 | `POST /v1/sessions` refuses without `proxy` when `egressProxyRequired === true`.                                                                                   |
| Dashboard UI        | Agent 2 | `/proxies` page; SOCKS5 form lit, Phase 2/3 placeholders.                                                                                                          |
| WebKit fork         | Agent 1 | Per-WebContent-process SOCKS5 via `[NSURLSessionConfiguration connectionProxyDictionary]`; honors `DRIFTSTACK_SOCKS5_PROXY` env var at WebContent process startup. |
| WebRTC              | Agent 1 | ICE candidate filtering (host-only on SOCKS5 interface) + UDP ASSOCIATE for the WebRTC traffic.                                                                    |
| LiveKit publisher   | Harness | HOST-process (NOT VM-guest); screen-mirrors the session VM. Customer proxy CANNOT affect GUI streaming (Tier-3 #7 LOCKED).                                         |
| Harness propagation | Harness | Reads the per-session config from API, exports `DRIFTSTACK_SOCKS5_PROXY` into the WebContent process env.                                                          |

### Phase 2 OpenVPN (founder priority — Agent 2 focus area)

| Layer              | Owner   | Contract                                                                                                                                                                             |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Schema             | Agent 2 | `OpenVpnProxyConfig.config_blob` is the full `.ovpn` file contents; max 256 KB. Optional `username` + `password` for auth-user-pass setups.                                          |
| Validation         | Agent 2 | Server-side .ovpn syntactic sanity check (`client` / `remote` / `dev tun` / `cipher` directives present). Not a deep parse — defence-in-depth, harness owns the real OpenVPN client. |
| API route          | Agent 2 | Same `POST /v1/sessions/{id}/proxy` route, discriminated by `type: 'openvpn'`.                                                                                                       |
| Dashboard UI       | Agent 2 | `.ovpn` textarea + validation feedback (Phase 2 deliverable, Phase 1 page has the placeholder card).                                                                                 |
| VM provisioning    | Harness | Apple Virtualization.framework Lightweight VM per session; OpenVPN client inside VM; TUN interface inside VM.                                                                        |
| WebKit-in-VM       | Agent 1 | WebKit fork inside the VM uses VM's default route (TUN).                                                                                                                             |
| Connectivity check | Harness | Fail-fast at session create (Tier-3 #5 LOCKED). Verify `remote` host:port reachable + auth accepted BEFORE starting the WebKit fork.                                                 |
| Routing isolation  | Harness | LiveKit publish bypasses VM TUN (host's direct network); customer's target site WebRTC goes through TUN.                                                                             |

### Phase 3 WireGuard (deferred priority)

Same VM architecture as OpenVPN. WireGuard client (kernel module or
wireguard-go) inside the macOS guest VM. Per founder direction
2026-05-16 — focus OpenVPN/SOCKS5 first; WireGuard implementation
slips behind those.

---

## V-820 — fleet-node auth (per docs/network-architecture.md)

| Layer                         | Owner             | Status                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JWT verifier (Ed25519)        | Agent 2           | Shipped commit `95353f2a`. `FleetNodeAuthImpl` + `InMemoryFleetNodesRepo` + 8 unit tests covering 7 reject reasons.                                                                                                                                                                                                                      |
| `fleet_nodes` SQL table       | Agent 2           | Pending Tier-2 founder review. Design doc: `docs/internal/fleet-nodes-sql-migration-design.md` (this wave).                                                                                                                                                                                                                              |
| `DrizzleFleetNodesRepo`       | Agent 2           | Pending SQL migration.                                                                                                                                                                                                                                                                                                                   |
| Nonce cache                   | Agent 2           | `InMemoryFleetNonceCache` foundation shipped this wave (6 unit tests; NUL-byte-delimited `(nodeId, nonce)` scope; TTL eviction on each access). Redis-backed prod impl + integration with `FleetNodeAuthImpl.verify` pending.                                                                                                            |
| `/v1/fleet/events` route stub | Agent 2           | Route stub SHIPPED `ae670c80` — path is addressable on the deployment (5th activation-gate-pattern feature); both AppDeps-wired + disabled postures currently 503 FeatureUnavailable. WebSocket handler + fastify-websocket plugin pending. Agent 1 can wire V-820.B.1.b client against this URL now and get a clean 503 in development. |
| mTLS layer                    | Infra             | Cloudflare Authenticated Origin Pulls; Agent 2 receives client-cert hash via header.                                                                                                                                                                                                                                                     |
| Fleet-side JWT signer         | Agent 1 / Harness | Signs JWT with provisioned Ed25519 private key; opens WebSocket; ACKs work events.                                                                                                                                                                                                                                                       |

**Agent 1 dependency (V-820.B.1.b)** waits Agent 2 to land the
`/v1/fleet/events` route. Auto-expires 2026-06-15 per
ORCHESTRATOR-STATE.md.

---

## AI chat — agent layer (planning 132 §"Phase 7"; founder verdict 2026-05-16)

| Layer                         | Owner   | Status                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AgentSessionsRepo`           | Agent 2 | InMemory shipped (`cc876a49`); Drizzle pending (Tier-2 SQL).                                                                                                                                                                                                                                                                                                             |
| `AgentDecomposer`             | Agent 2 | Deterministic shipped (`b4caffa4`); AI-B1.b Claude wire = BYOK Anthropic, pending key + focused session.                                                                                                                                                                                                                                                                 |
| `AgentExecutor`               | Agent 2 | Stub shipped (`3a0b9469`); real harness-wired pending (in-process SessionsService dispatch).                                                                                                                                                                                                                                                                             |
| `AgentRuntime` composition    | Agent 2 | Shipped (`09487cc6`); composes the three primitives.                                                                                                                                                                                                                                                                                                                     |
| Routes `/v1/agent-sessions/*` | Agent 2 | Shipped activation-gated (`611ddc8f`). 4 endpoints + OpenAPI specs.                                                                                                                                                                                                                                                                                                      |
| SDK surface                   | Agent 2 | TS + Python + Go all at parity (`aadc3ffb` + `d2c85e21`); REQUIRED_RESOURCES at 17. Sample programs in all 3 languages.                                                                                                                                                                                                                                                  |
| Customer-dashboard chat UI    | Agent 2 | Pending (A1-A4 in `ai-chat-agent-layer-design.md`).                                                                                                                                                                                                                                                                                                                      |
| BYOK key path                 | Agent 2 | HTTP → runtime chain SHIPPED this wave: `x-byok-anthropic-api-key` request header → route handler → `AgentRuntime.runTurn({byokApiKey})` → `DecomposeArgs.byokAnthropicApiKey` → reaches the future Claude-wired decomposer. Audit invariant pinned (secret NEVER in transcript/response body). Per-account encrypted storage + settings UI to set/clear/rotate pending. |

**Tier-3 verdict 2026-05-16:** BYOK Anthropic for v1.0; bundled-LLM
billing deferred to v1.1.

---

## Other landed cross-agent surfaces (reference)

- **V-531.B LiveKit SFU** — landed; tokens at `/v1/livekit/sessions/:id/token`. See `docs/internal/v531-cross-agent-contract.md`.
- **V-533 admin force-actions** — destroy session / revoke API key from admin panel. See `docs/internal/v533-cross-agent-contract.md`.
- **OAuth Google + GitHub** — LIVE on prod via per-provider callback URLs at `https://api.driftstack.dev/v1/auth/oauth/{provider}/callback`.

---

## Activation-gate pattern (uniform across all surfaces)

When a feature's prerequisites aren't met on a deployment, the route
file exports `registerXxxRoutes` (real handlers) AND
`registerXxxDisabledRoutes` (503 `FeatureUnavailableError` stubs).
`app.ts` wires them via `if (deps.xxxService !== undefined)` / else.

Cross-source invariant pinned in
`apps/server/tests/unit/activation-gate-pattern-cross-source-invariant.test.ts`
(commit `e074fcf6`). Covers billing + session-proxy + saved-proxies +
agent-sessions. Future gated features append to the FEATURES list.

---

## Maintenance protocol

This doc reflects the current state of cross-agent surfaces. Update when:

- A new cross-agent surface ships
- A Tier-3 verdict changes a layer ownership or contract shape
- An entry's status moves from "pending" to "shipped" (link the
  commit SHA)

Don't update for in-track changes that don't cross the agent boundary
(e.g. a single-SDK refactor); those stay in the relevant per-feature
design doc.
