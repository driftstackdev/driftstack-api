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
| `fleet_nodes` SQL table       | Agent 2           | Pending Tier-2 founder review. Design doc: `docs/internal/fleet-nodes-sql-migration-design.md` (shipped 2026-05-16; 5 open questions for founder).                                                                                                                                                                                       |
| `DrizzleFleetNodesRepo`       | Agent 2           | Pending SQL migration.                                                                                                                                                                                                                                                                                                                   |
| Nonce cache                   | Agent 2           | `InMemoryFleetNonceCache` foundation shipped `1b97a5e0`; replay-defence wiring into `FleetNodeAuthImpl.verify` shipped `f2a6c603` (6 + 4 unit tests; NUL-byte-delimited `(nodeId, nonce)` scope; TTL eviction on each access). Redis-backed prod impl pending.                                                                           |
| `/v1/fleet/events` route stub | Agent 2           | Route stub SHIPPED `ae670c80` — path is addressable on the deployment (5th activation-gate-pattern feature); both AppDeps-wired + disabled postures currently 503 FeatureUnavailable. WebSocket handler + fastify-websocket plugin pending. Agent 1 can wire V-820.B.1.b client against this URL now and get a clean 503 in development. |
| mTLS layer                    | Infra             | Cloudflare Authenticated Origin Pulls; Agent 2 receives client-cert hash via header.                                                                                                                                                                                                                                                     |
| Fleet-side JWT signer         | Agent 1 / Harness | Signs JWT with provisioned Ed25519 private key; opens WebSocket; ACKs work events.                                                                                                                                                                                                                                                       |

**Agent 1 dependency (V-820.B.1.b)** waits Agent 2 to land the
`/v1/fleet/events` route. Auto-expires 2026-06-15 per
ORCHESTRATOR-STATE.md.

---

## AI chat — agent layer (planning 132 §"Phase 7"; founder verdict 2026-05-16)

| Layer                         | Owner   | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentSessionsRepo`           | Agent 2 | InMemory shipped (`cc876a49`); Drizzle pending (Tier-2 SQL).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `AgentDecomposer`             | Agent 2 | Deterministic shipped (`b4caffa4`); AI-B1.b Claude wire = BYOK Anthropic, pending key + focused session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `AgentExecutor`               | Agent 2 | Stub shipped (`3a0b9469`); real harness-wired pending (in-process SessionsService dispatch).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `AgentRuntime` composition    | Agent 2 | Shipped (`09487cc6`); composes the three primitives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Routes `/v1/agent-sessions/*` | Agent 2 | Shipped activation-gated (`611ddc8f`). 4 endpoints + OpenAPI specs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| SDK surface                   | Agent 2 | TS + Python + Go all at parity (`aadc3ffb` + `d2c85e21`); REQUIRED_RESOURCES at 17. Sample programs in all 3 languages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Customer-dashboard chat UI    | Agent 2 | Pending (A1-A4 in `ai-chat-agent-layer-design.md`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| BYOK key path                 | Agent 2 | HTTP → runtime chain SHIPPED across `1b97a5e0` (route header → runtime), `f2a6c603` (runtime → DecomposeArgs), `9d7dded2` (cross-source invariant including OpenAPI), `a79796ae` (cross-SDK convenience layer + per-customer storage design doc), `2048c45f` (OpenAPI extension of the invariant): `x-byok-anthropic-api-key` request header → route handler → `AgentRuntime.runTurn({byokApiKey})` → `DecomposeArgs.byokAnthropicApiKey` → reaches the future Claude-wired decomposer. Audit invariant pinned (secret NEVER in transcript/response body). Per-account encrypted storage + settings UI to set/clear/rotate pending. |

**Tier-3 verdict 2026-05-16:** BYOK Anthropic for v1.0; bundled-LLM
billing deferred to v1.1.

### Pair-mode takeover / handback — harness↔control-plane event contract (OPEN — needs Agent-1 + harness)

**Problem (the `*-pending` stick):** the pair-mode state machine
(`apps/server/src/services/agent-pair-mode-state.ts`) is a 6-state
reducer. The customer-facing routes drive only the _request_ half:

| Route                                  | Transition fired                                                              | Resulting state                        |
| -------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| `POST /v1/agent-sessions/:id/takeover` | `takeover-request` (or `takeover-request-queued` if a decompose is in flight) | `takeover-pending` / `takeover-queued` |
| `POST /v1/agent-sessions/:id/handback` | `handback-request`                                                            | `handback-pending`                     |

The transitions that DRAIN those pending states —
`takeover-grant` (→ `human-driving`) and `handback-complete`
(→ `ai-driving`) — exist in the reducer but **nothing fires them**, and
there is **no control-plane surface for the harness to fire them**. So a
session that requests takeover sits in `takeover-pending` forever. The
grant/complete signal must come from the harness once it has actually
flipped WebRTC input routing (AI executor paused / human input wired, or
vice-versa) — only the harness knows when the swap physically happened.

**Proposed contract (Agent-2 builds the control-plane half; Agent-1's harness calls it):**

- Control-plane surface (Agent 2): a fleet-authed signal carrying
  `{ session_id, transition: 'takeover-grant' | 'handback-complete' }`.
  **Recommended mechanism: a new fleet-authed route**
  `POST /v1/fleet/agent-sessions/:id/pair-mode/transition` (same
  `FleetNodeAuth` + nonce-replay defence as `/v1/fleet/events`), which
  applies the transition via `applyPairModeTransition` + `setPairModeState`
  and emits the existing `agent_session.pair_mode.*` customer audit/event
  rows. Alternative considered: piggyback on the `/v1/fleet/events`
  WebSocket channel — rejected for now because that channel is itself a
  pending stub and a discrete idempotent POST is easier to test + retry.
- Harness side (Agent 1): after the executor pause / input-routing flip
  completes, call the route with the matching transition. Idempotent —
  re-firing `takeover-grant` from `human-driving` is a no-op 200 (mirror
  the existing reducer's idempotent arms).
- Invalid-transition handling: the reducer throws
  `InvalidPairModeTransition`; the route maps it to 409 (the harness
  raced a customer decline / heartbeat-timeout — safe to drop).

This stays behind the agent-sessions activation gate (503 when
`agentSessionsService` is unwired), same as the sibling routes.

### `POST /v1/agent-sessions/:id/abort` (OPEN — contract proposal, not yet built)

There is **no documented spec** for abort today — only an internal
"three consecutive same-intent failures abort the run" auto-stop in
`ai-chat-agent-layer-design.md`. Proposed customer-facing contract for
review before build:

- **Purpose:** customer cancels an in-flight agent run (the decompose /
  execute loop kicked off by `POST /:id/message`).
- **Shape:** `POST /v1/agent-sessions/:id/abort` → 200
  `{ aborted: true, run_id }`; 409 if no run is in flight; activation
  -gated 503.
- **Semantics:** sets a cancel flag the `AgentExecutor` checks between
  intents (cooperative cancel — never mid-intent, to avoid leaving the
  browser session in a half-applied state); the current intent finishes,
  the run stops, the transcript records an `aborted` terminal event.
- **Dependency:** the real harness-wired `AgentExecutor` (AI-B2.b,
  pending) must honour the cancel flag. The route + flag + transcript
  event can be built + tested control-plane-side ahead of that (mirrors
  takeover/handback being built before the harness emit), but the flag
  is a no-op until AI-B2.b lands.

**Status:** both contracts above are **proposals pending founder/Agent-1
alignment** — documented here so Agent 2 doesn't ship a harness-facing
shape the harness then can't match. Once aligned, Agent 2 builds the
control-plane halves gated + tested.

### Intent-dispatch contract — AgentIntent ↔ harness IntentDispatch (reverse-engineered from the wired harness 2026-06-05)

Agent-3 has fully wired the harness intent executor (`harness/Sources/BrowserController/IntentExecutor.swift`,
`agent3-progress.md` W1–W9) and asked Agent 2 to "expose scroll/behavioral_pause intents + per-session
persona". Per-session **persona is DONE + ALIGNED** (`behavioral_profile` on session-create = `casual|regular|
power_user`, matching the harness's `shared/behavior/personas.json` ids; commits c0a46694/2990fb86/7309117c).
The **intents** are NOT a quick add — there are THREE divergent intent vocabularies that must be reconciled:

1. **`AgentIntent`** (driftstack-api `api-types/agent-intents.ts` — the LLM decomposer's output): discriminated
   union `navigate{url}` / `interact{action: tap|type|scroll|swipe, selector?, value?}` / `wait{condition:
idle|selector_visible}` / `capture{screenshot|dom_snapshot|pdf}`.
2. **`InteractActionSchema`** (driftstack-api `api-types/sessions.ts` — the DIRECT `/v1/sessions/:id/interact`
   route + the `Driver` contract): discriminated union `tap{selector}` / `type{selector,text,delay_ms}` /
   `scroll{selector?,delta_x,delta_y}` / `press{key}`.
3. **Harness `ControlInbound.IntentDispatch`** (Agent-3, what ACTUALLY executes): `{ intentName: string,
inputParams: <opaque JSON> }`. The 9 `intentName`s + params the harness handles:
   - `navigate` — `{url}`
   - `click` — `{element_id}` OR `{strategy, value}` (NOT "tap")
   - `send_keys` — `{strategy, value, text}` (NOT "type")
   - `execute_script` — `{script, args?}`
   - `screenshot` — `{}`
   - `get_page_source` — `{}` (≈ dom_snapshot)
   - `wait_for` — `{predicate, timeout_seconds?}`
   - `scroll` — `{direction?: up|down, distance_px?: number, start_x?: int, start_y?: int}` (persona drives the flick/momentum/overshoot)
   - `behavioral_pause` — `{duration_ms?}` OR `{kind:"reading", word_count}` OR (none → persona idle pause)

**Proposed AgentIntent → IntentDispatch translation (the executor-wiring layer — still `StubAgentExecutor`;
real dispatch = "AI-B2.b, pending"):** navigate→navigate; interact:tap→click{strategy,value from selector};
interact:type→send_keys; interact:scroll→scroll{direction,distance_px}; capture:screenshot→screenshot;
capture:dom_snapshot→get_page_source; wait:selector_visible→wait_for{predicate}.

**GAPS / product decisions to resolve before wiring:**

- `AgentIntent.interact:swipe` has NO harness target (harness has `scroll`, not swipe) — drop swipe or map to scroll?
- `AgentIntent.capture:pdf` has NO harness target — drop or add a harness `pdf` intentName?
- `behavioral_pause` is harness-only — the decomposer CANNOT currently emit it; needs a new `AgentIntent` kind
  (and/or a direct-route exposure) for customers/the agent to invoke it.
- `AgentIntent.scroll` carries no direction/distance; the harness `scroll` wants `direction`+`distance_px`.
- `wait`: AgentIntent `condition: idle|selector_visible` vs harness `wait_for{predicate}` + `behavioral_pause`(idle) — map which to which.

**Two-behavioral-models ownership split = FOUNDER-DECISION-PENDING** (Agent-3 `agent3-progress.md`): the harness
self-generates touch/timing from `personas.json` + `BehavioralRhythm` (Swift) and is the DE-FACTO executor+model
today; the Agent-2 `behavioural-simulation` TS lib (rich distributions) is unwired/parallel. Proposed (relayed):
TS lib generates the plan, harness executes — but the harness already works standalone, so consolidation
(personas.json ⟷ the TS distributions) is a real divergent-fingerprint risk needing a founder call. **Do NOT
unilaterally build the intent reconciliation or pick the model owner** — it needs the executor-wiring (gated) +
these product decisions. This section is the map so whoever builds it has the exact contract.

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
(commit `e074fcf6`; extended to 5 features at `ae670c80`; 6th
per-feature assertion at `5b4336c5` requires non-empty detail string;
grown to 6 features with BYOK Anthropic at `994336cd`; 7 features
with recipes at `b165c8dd`; **43 test cases total** as of `b165c8dd`).
Covers billing + session-proxy + saved-proxies + agent-sessions +
fleet-events + byok-anthropic + recipes. Runtime mirror in
`scripts/post-deploy-verify.mjs` `featureGateStub()` (also asserts
`detail` length ≥8; grown to 7 checks at `dd5f8b29` to match the
compile-time invariant). Future gated features append to the
FEATURES list in the compile-time test AND the checks array in
post-deploy-verify.

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
