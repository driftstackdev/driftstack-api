# Cross-agent control-plane contract

**Purpose:** single page documenting every concrete interface across the
Agent-1 (driftstack + webkit-driftstack) ↔ Agent-2 (driftstack-api) ↔ Harness
boundary so neither side has to read the other's code to understand the
contract. Update when a new cross-agent surface ships.

> **⚠️ This is the STATIC interface contract — NOT a message channel.** For LIVE
> A2↔A3 coordination (questions, replies, hand-offs), use the **BUS**:
> `/Users/john/code/driftstack/operations/agent-bus/A2-A3-BUS.md`. A3 watches the
> bus, **not** this doc and **not** any dated hand-off doc — a reply anywhere else
> is invisible to them (cost a real "you haven't replied" miss 2026-06-19). See
> the driftstack-api CLAUDE.md "A2↔A3 LIVE CHANNEL" note for the post recipe.

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

#### What the control plane enforces today, while abort stays a proposal (2026-09-20)

Two bounds are now enforced server-side and need nothing from the device. Both keep
the cooperative shape the abort proposal above describes — **never mid-intent**.

- **A turn-wide hard stop** (`TURN_HARD_STOP_MS`, five minutes, in
  `services/agent-turn-bounds.ts`). The executor's step loop checks the turn's
  deadline at the top of every step, beside the Stop check, and returns BETWEEN
  steps: the step in flight runs to its own end and is recorded, nothing after it
  is announced or dispatched. The same deadline is asked before a step's own retry
  budget sends another dispatch, so a node that has stopped answering is re-asked
  at most until the deadline rather than for the whole retry budget after it. Before it, the turn's three-minute bound was checked
  only at the top of the TURN loop, so one segment of long intents could run for
  tens of minutes before reaching the bound that would have refused the next
  segment. The customer is told the message took too long and to send "continue".
- **A `behavioral_pause` is abandoned on Stop.** It changes nothing on the page, so
  the control plane stops waiting for its result at once instead of holding the
  in-flight grace and then reporting an unknown outcome. It stays replay-**unsafe**
  — the device reads long content by scrolling through it — so nothing auto-retries
  a pause. Abandonable-on-Stop and safe-to-retry are separate properties.
  ⚠️ **The residual is the device's:** with no cancel verb on the wire, the device
  keeps pausing after we walk away, and the next turn's first dispatch can land on
  a device still inside a dwell.

### Intent-dispatch contract — AgentIntent ↔ harness IntentDispatch (reverse-engineered from the wired harness 2026-06-05)

Agent-3 has fully wired the harness intent executor (`harness/Sources/BrowserController/IntentExecutor.swift`,
`agent3-progress.md` W1–W9) and asked Agent 2 to "expose scroll/behavioral_pause intents + per-session
persona".

**PERSONA TRANSPORT — RESOLVED on the harness side by W17/W18 (updated 2026-06-05).** The
`SessionAssign.behaviorProfile: String` field is **polymorphic**: after Agent-3's W17 (CRITICAL fix —
`resolvePersonaForSession` previously did `personas[behaviorProfile]`, but `behaviorProfile` is the speed
axis, so it was always nil → ALL behavioural sim was INERT) + W18 (integration guard), the harness's
`resolvePersona(profileKey:in:)` resolves the field as **direct persona NAME** (`casual|regular|power_user`)
**OR** a **SPEED modifier** (`fast|balanced|careful` on the `regular` base) **OR** `custom` fallback. So:

- My session-create **`behavioral_profile`** (`casual|regular|power_user`, commits c0a46694/2990fb86/7309117c)
  is a DIRECT persona selector — and it now maps **cleanly** into `behaviorProfile` via the direct-name branch.
  No harness extension needed (W17 added it); no transport mismatch. (My prior "orthogonal — harness must be
  extended" note is SUPERSEDED — W17 made the field accept persona ids.)
- The field also still accepts the speed modifiers (`fast/balanced/careful/custom`) — a separate, complementary
  axis (speed on the `regular` base) that the API doesn't yet expose. Optional future: an API speed knob.
- **Only remaining piece = the control-plane→harness WIRING:** `apps/server/src/drivers/webkit.ts` is still a
  stub (`DriverNotIntegratedError` until Phase-2 integration, Agent-1-owned). When wired, it sets
  `SessionAssign.behaviorProfile = <the session's behavioral_profile>` (a persona name) and W17's resolver
  honours it. Gated on the webkit-driver integration; no Agent-2 schema change required.

The **intents** are NOT a quick add either — there are THREE divergent intent vocabularies that must be reconciled:

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

**Two-behavioral-models ownership split — FOUNDER-RATIFIED 2026-06-04 ("do everything as recommended").**
The Agent-2 decision below is now the ratified contract; founder-decision-queue item #2 is RESOLVED. Build is
greenlit (see AI-B2.b plan at the end of this section). Context: the harness self-generates touch/timing from
`personas.json` + `BehavioralRhythm` (Swift) and is the de-facto executor+model today; the Agent-2
`behavioural-simulation` TS lib (rich per-element-class distributions) is unwired/parallel → two models =
divergent-fingerprint risk.

- **DECISION (mine): the TS lib (`packages/behavioural-simulation/`) owns the MODEL; the harness EXECUTES the
  plan, verbatim, with NO Swift-side re-derivation.** One model → one fingerprint.
  - **TARGET:** the server runs the TS lib → emits the `TouchSample[]` (x/y/pressure/tMs) / `ScrollPattern`
    plan → ships it to the harness over the control-plane intent contract; the harness consumes + executes.
  - **INTERIM (until that plan-handoff is built):** `personas.json` stays the executor's source BUT must mirror
    the TS lib's persona catalogue (ids + key params) — the TS lib is the authority it mirrors — so the two
    don't diverge before consolidation. The server→harness plan transport is the consolidation milestone
    (future Agent-2 build).
- **Persona on session-create: ALREADY SHIPPED** (`behavioral_profile ∈ casual|regular|power_user`,
  c0a46694/2990fb86/7309117c, across api-types + 3 SDKs + docs). The harness `resolvePersona` is polymorphic
  (direct persona name OR speed modifier) so it maps cleanly; only the Agent-1 `webkit.ts` driver wiring remains.
- **FINDING (surfaced, founder/behavioral-data-gated): the over-dwell tap tell is MODEL-FAMILY-WIDE.** Founder
  H3.exec.38: real tap dwell ~37-54ms (median ~46, N=1) vs `personas.json` `tap_dwell_ms_mean` 82/95/105. My TS
  lib's per-element-class `meanDwellMs` (touch.ts) = 110/90/140/180/220/280/130 — also 2-6× the real ~46ms. DO
  NOT retune on N=1 (person-variable; needs ≥2-3 more captures; founder/behavioral-data call); when captures
  land I retune the TS lib `meanDwellMs` toward ~40-70ms IN LOCKSTEP with personas.json.
- **scroll/`behavioral_pause` intents — NOT yet buildable; gated on (not just param confirmation):** (a) the
  server `AgentExecutor` is still a STUB (AI-B2.b) — it would DROP the intents (synthetic success, no dispatch);
  (b) the vocabulary gaps below (swipe target, behavioral_pause-as-new-AgentIntent-kind, scroll direction/distance,
  wait mapping) are product decisions; (c) this ownership decision ratified. Param shapes ARE reverse-engineered
  (above) so the build is ready the moment (a)+(b) clear. **Do NOT unilaterally ship the intent schema before the
  executor can dispatch it** (would be a no-op customer capability). This section is the map for whoever wires it.

**AI-B2.b BUILD PLAN (scoped 2026-06-04; architecture + signatures confirmed). Two increments:**

_Increment 1 — RealAgentExecutor (server-side; NO customer-schema/SDK change; SAFE — prod driver is `mock`):_

- New `RealAgentExecutor implements AgentExecutor` in `services/agent-executor.ts` (keep `StubAgentExecutor`
  for tests/demo). Dispatches each `plan.intent` against the in-process `SessionsService` (the file header's
  stated AI-B2.b target), translating the EXISTING `AgentIntent` vocab:
  - `navigate{url}` → `sessionsService.navigate(ctx, sessionId, {url})` → summary `navigated → {finalUrl} (status {n})`.
  - `interact{action:'tap', selector}` → `interact(ctx, sessionId, {action:{kind:'tap', selector}})`.
  - `interact{action:'type', selector, value}` → `{action:{kind:'type', selector, text:value}}`.
  - `wait{condition, timeoutMs?}` → `wait(ctx, sessionId, {condition, timeout_ms:timeoutMs})` → summary incl. `satisfied`.
  - `capture{capture}` → `sessionsService.capture(...)` → `captureId` on the IntentResult.
  - `interact{action:'scroll'|'swipe'}` → typed `kind:'failure'` IntentResult, reason
    "scroll/swipe dispatch pending vocabulary reconciliation (AI-B2.c)" — NOT a guess; halts the plan like any failure.
- `ExecuteArgs` gains `account?: AccountContext` (ADDITIVE — stub ignores it; Real requires it, fails closed with a
  clear reason if absent). AgentRuntime passes its ctx through. Halt-on-first-failure + capture aggregation per the
  existing `ExecutorRunResult` contract. Map `SessionsService` problem-errors → `kind:'failure'` (never throw).
- Tests: unit-test RealAgentExecutor against a MOCK SessionsService (success path per intent kind; halt-on-failure;
  scroll/swipe→failure; capture→captureId). Update `services-agent-executor-content-parity` + the v-invariant for the
  additive field. DO NOT wire into bootstrap yet (stub stays wired) → zero prod-behavior change.
- PREREQ to verify before the bootstrap swap (Increment 1.5, 1-line): does agent-sessions provision a REAL
  `/v1/sessions` session for the executor to own/dispatch against? (agent-runtime.ts:330 warns the wired executor
  "will 400 without a [real session]".) Confirm the session-provisioning path, THEN swap stub→real in bootstrap.

_Increment 2 — customer-facing intents (schema/SDK/decomposer; needs the vocab product-calls):_ add
`scroll{direction, distance_px?}` + `behavioral_pause{reason?, hintMs?}` + `back`/`forward` to `AgentIntentSchema`
(align scroll to the harness's reverse-engineered `{direction, distance_px}`; drop `swipe` OR map→scroll), regen
SDKs, update the decomposer to emit them, fix the false "maps 1:1" docstring + the AgentIntent⇄driver drift. Confirm
final shapes with Agent-3 (harness `IntentDispatch`) before shipping the customer schema.

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

## A3→A2 StreamingBridge-hardening contract notes (2026-06-05, harness W81–87) — A2 triage

Agent-3 sent contract notes after the StreamingBridge hardening. Agent-2 (driftstack-api + gui-client) triage:

- **CapturedFrame ordering + `CapturedFrame.minimumPixelBytes` OOB guard (A3 item 1)** — NOT an Agent-2
  touchpoint. `FrameSinkHandle.ingestFrame`/`CapturedFrame`/`minimumPixelBytes` exist in NO driftstack-api or
  gui-client source (the TS `packages/webrtc-streaming` uses a separate `FrameSource`/`VideoFrame` abstraction;
  the gui-client subscribes to DECODED video via the LiveKit SDK and never touches raw frame pixels). Harness/Swift-side.
- **RTP per-NAL keyframe SPS/PPS depacketizer (A3 item 5)** — NOT an Agent-2 touchpoint. No custom RTP
  depacketizer in driftstack-api/gui-client; the LiveKit SDK handles RTP. N/A unless a future custom consumer lands.
- **GUI→harness DataChannel finite coords (A3 item 2)** — gui-client VERIFIED COMPLIANT: `livekit-input-capture.ts`
  `pointerToViewport` guards degenerate rect (width/height===0→null, no div-by-zero), returns null off-surface, else
  finite `Math.round`'d x/y; wheel deltaX/deltaY are browser-sourced (finite). Harness clamp = defense-in-depth. No change.
- **Intent caps (A3 item 3) — feed Increment 2 (customer intent schema), GATED/not-built:** when the customer-facing
  intents ship, the API must cap + surface: `behavioral_pause` duration ≤ 300_000ms (return `capped: bool`);
  `wait_for` timeout ≤ 300s (return `timeout_capped: bool`). Document the cap + flag (don't advertise unbounded).
- **New harness intents `back`/`forward` (A3 item 4)** — safe to expose; add to AgentIntentSchema in Increment 2.

**STILL NEEDED FROM A3 for Increment 2 (customer intents):** (1) the `scroll` intent param shape (direction +
distance_px? — not in these notes); (2) confirm the executor→harness dispatch path for behavioral_pause/back/forward
(these are harness `IntentDispatch` intents, NOT driver InteractAction/Navigate — the server AgentExecutor currently
dispatches to the DRIVER; bridging to harness IntentDispatch is the open architecture item). Until (1)+(2), Increment 2
stays gated; the caps/back-forward shapes above are recorded for the build.

## A3→A2 Increment-2 answers (2026-06-05) — scroll shape + dispatch path (ARCHITECTURE CORRECTION)

**(1) scroll params (mirror harness IntentExecutor):** `{ direction?: 'up'|'down' (default 'down'),
distance_px?: number (TOTAL distance, default 600; harness decomposes into momentum flicks),
start_x?: int (default 195), start_y?: int (default direction-aware 220up/660down) }`. PUBLIC SDK exposes
ONLY `{ direction?, distance_px? }` (omit start_x/start_y — harness defaults per-direction; a bad pair
pushes the synthetic touch off-screen). Result envelope `{ scrolled, flicks, steps, behavioral }`.

**(2) DISPATCH PATH — canonical = control-plane WSS `ControlInbound.intentDispatch`, NOT the driver.**
⚠️ This CORRECTS the prior agent-executor.ts assumption ("dispatches against the in-process SessionsService"
→ driver). Agent-3 (harness IntentExecutor owner) is explicit: do NOT route agent-session intents through the
server-local driver abstraction. The harness consumes:
`IntentDispatch { sessionId, intentId, intentName, inputParams: JSON(params) }`
over the control-plane WSS, routed by `intentName` through one `IntentExecutor.dispatch`. The AgentExecutor must:
decompose → for EACH step emit a `ControlInbound.intentDispatch(intentName, inputParams=JSON(params))` over the
control plane → harness (the harness does NOT consume the decomposer plan directly; one IntentDispatch per intent).
Current intentName vocabulary is the exact 18-name list in the 2026-07-15
protocol-truth correction below; the original 11-name planning roster here is
historical and must not be used as a sender allow-list.

**IMPACT on the shipped RealAgentExecutor (AI-B2.b/c, `aa37f891`/`26fce854`) — MISALIGNED, unwired (no harm):**
it dispatches AgentIntent → SessionsService.{navigate,interact,wait,capture} → DRIVER. That's the wrong layer
for agent-sessions. The driver path (`/v1/sessions/:id/{navigate,interact,...}`) remains the separate DIRECT
low-level control API; but the AGENT-SESSIONS executor must emit control-plane intentDispatch instead. The
translation logic (AgentIntent→params) is reusable; the dispatch TARGET changes.

**RE-SCOPED Increment 2 critical path (control-path buildable NOW per A3; end-to-end gated on item 9):**
(a) PREREQ — control-plane WSS sender: `/v1/fleet/events` (V-820) is still a 503 STUB (no fastify-websocket
handler). A functioning server→harness control channel + an `intentDispatch` send path is the prerequisite.
(b) AgentExecutor v2: emit `ControlInbound.intentDispatch` per intent (intentName + JSON params), replacing the
driver dispatch. Map AgentIntent verbs → intentName strings.
(c) Customer-facing AgentIntentSchema additions: scroll{direction?,distance_px?} + behavioral_pause + back +
forward + the caps (behavioral_pause ≤300_000ms/`capped`, wait_for ≤300s/`timeout_capped`) + 3 SDKs + decomposer.
(d) DOWNSTREAM GATE (not A2): harness→fork DRIVE (IntentExecutor→WebDriver→fork) NOT wired on Mac =
ORCHESTRATOR action-queue item 9 (cocoa WebDriver server; founder Option-1 sign-off; A1+A3). Intents REACH
the harness over the control path now, but won't execute against the fork until item 9 lands. A3: build+ship
the control-path wiring now; end-to-end goes live with item 9.
TODO: request A3's full intentName→params table (send_keys/click/wait_for/navigate/...) before mapping (a3 offered).

## A3 intent-contract reference COMPLETE (2026-06-05, W91) — Increment-2 spec is now fully specified

Agent-3 authored the canonical reference: `driftstack/docs/internal/harness-intent-contract.md` (grounded in
`harness/Sources/BrowserController/IntentExecutor.swift`). Mirror it exactly to prevent server↔harness divergence.
Build-relevant deltas beyond the scroll/dispatch notes already recorded:

- **Transport:** one `ControlInbound.intentDispatch(IntentDispatch{ sessionId, intentId, intentName, inputParams: JSON(paramsObj) })`
  per intent over the control-plane WSS. Result = `HarnessOutbound.IntentResult{ sessionId, intentId, success,
durationMs, outputData: base64(JSON) on success | errorCode + errorMessage? on failure }`.
- **Full param/result table** (in the ref): navigate{url}→{url}; back/forward{}→{url,action}; click{element_id}|{strategy,value}→{clicked,behavioral};
  send_keys{strategy,value,text}→{typed_into,length,behavioral}; scroll{direction?,distance_px?,start_x?,start_y?}→{scrolled,flicks,steps,behavioral}
  (SDK exposes direction+distance_px only); behavioral_pause{duration_ms}|{kind:'reading',word_count}|none→{paused_ms,capped,behavioral}
  (cap ≤300_000ms); wait_for{predicate,timeout_seconds?}→{waited,timeout_capped} (cap ≤300s); execute_script{script,args?}→{value};
  screenshot{}→{screenshot_b64,format,full_page,annotated}; get_page_source{}→{source,truncated}; the
  additional live handlers and their strict result shapes are enumerated in the 2026-07-15 correction below.
- **Error codes:** this original five-code planning roster is historical; the exact live ten-code set is
  enumerated in the 2026-07-15 correction below and must be mapped exhaustively.
- **`behavioral` flag** in results = persona attached (realistic dynamics) vs false (plain). Surface caps via capped/timeout_capped flags.

**STATUS: Increment-2 spec fully unblocked.** Remaining = the BUILD, gated only on the founder's go for the
control-plane WSS arc (prereq: /v1/fleet/events V-820 WSS handler is a 503 stub) + the wiring. Once greenlit:
(a) fleet-events WSS + intentDispatch sender, (b) AgentExecutor v2 (emit intentDispatch per intent, map verbs→intentName,
parse IntentResult→IntentResult/errors), (c) customer AgentIntentSchema(scroll/behavioral_pause/back/forward+caps)+SDKs.
End-to-end execution still gated on item 9 (harness→fork drive). Don't ship the schema before the dispatch path (no-op otherwise).

## ✅ Increment-2 (a) FIRST SLICE SHIPPED — wire-protocol schemas (2026-06-05, `3fa842fa`, founder-greenlit)

Founder greenlit the control-plane WSS arc ("you choose and do as recommended"). First slice landed:
`apps/server/src/schemas/harness-control-protocol.ts` + 32-test drift-guard/behavioral test
(`schemas-harness-control-protocol-content-parity.test.ts`). Mirrors A3's harness-intent-contract.md as Zod:

- Historical first slice: 11 dispatchable names plus three reserved names. The
  2026-07-15 correction below replaces that roster with all 18 live handlers.
- Per-intent param schemas (strict) + `HARNESS_INTENT_PARAM_SCHEMAS` map (intentName→schema) for server-side
  validation before dispatch.
- Historical first slice: permissive optional result fields and five errors.
  The 2026-07-15 correction below replaces this with exclusive envelopes,
  strict per-intent results, and all ten live error codes.
- Caps/defaults as exported consts (pause 300_000ms, wait_for 300s, scroll 600px/down, wait_for 30s).
- **Server-internal** (gui-input.ts/L-001 precedent) — NOT @driftstack/api-types (harness ≠ customer).

### 🔴 OPEN QUESTIONS FOR AGENT-3 (relay via founder) — needed for (a) WSS handler + (b) sender:

1. **`inputParams`/`outputData` wire codec.** Swift `Data` (JSON-encoded). On the wire is it (i) a nested JSON
   object, (ii) a JSON string, or (iii) base64 (Swift Codable's `Data` default)? Modeled `z.unknown()` until pinned.
2. **Envelope JSON key casing.** Does the harness JSONEncoder apply `.convertToSnakeCase` (→ `session_id`,
   `intent_id`, `intent_name`, `duration_ms`), or are the keys literally camelCase as written
   (`sessionId`/`intentId`/`intentName`/`durationMs`)? Schema currently uses camelCase per the contract doc.
3. **Harness WSS auth/handshake.** What does the harness present when it connects to `/v1/fleet/events`
   (Ed25519-signed JWT per fleet-node-auth + nonce? mTLS client cert at Cloudflare AOP? both?) and what's the
   first message exchange (node-register → which sessionIds it owns)? Needed to build the connection registry.

### Remaining (a)/(b)/(c) + gates:

- (a) `/v1/fleet/events` WSS handler — BLOCKED on: `fleet_nodes` SQL migration (Tier-2, founder approval;
  design at docs/internal/fleet-nodes-sql-migration-design.md) + mTLS at Cloudflare AOP (infra) +
  `@fastify/websocket` plugin (Agent-2 can add when building). Connection registry + intentId→promise correlation.
- (b) AgentExecutor v2 — emit `IntentDispatch` per intent (verb→intentName + build/validate params via the map),
  parse `IntentResultEnvelope` → existing `IntentResult`/typed errors. Buildable as a pure translation layer now.
- (c) customer `AgentIntentSchema` (scroll/behavioral_pause/back/forward + caps) + 3 SDKs + decomposer — HOLD
  until (a)/(b) wired (shipping the customer schema before the executor can dispatch = false affordance/no-op).
- End-to-end still gated on item 9 (harness→fork drive; founder Option-1 sign-off; A1+A3).

## ✅ 2026-06-05 — Increment-2 GO-LIVE RUNBOOK (supersedes the stale "open questions / gates" above)

All 3 wire questions are ANSWERED and the entire non-gated API data path is built + tested. This section is
the turnkey checklist for going live once the founder/infra gates clear.

### 2026-09-18 — result codes the control plane decodes but the harness emits only when armed

The 12-code list below is the harness's DEFAULT vocabulary. The control plane's
decode enum (`HARNESS_ERROR_CODES` in apps/server/src/schemas/harness-control-protocol.ts)
additionally knows three codes the harness emits only behind a switch. The order is
load-bearing in both directions: an intentResult carrying a code the control plane
does not decode fails `IntentResultEnvelopeSchema`, the correlator drops the frame, and
the dispatch hangs to its timeout. So the decode entry always ships first, and the
harness keeps the legacy code with a byte-stable message prefix until A2 says the entry
is LIVE IN PRODUCTION, not merely committed.

| Code                       | Harness switch                               | Legacy form until armed                                                          | Control-plane meaning                                                        |
| -------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `intent_element_not_found` | `DRIFTSTACK_INTENT_ELEMENT_NOT_FOUND_CODE=1` | `intent_invalid_parameter`, same prefix                                          | `element_not_found`, retryable                                               |
| `intent_page_load_failed`  | `DRIFTSTACK_INTENT_PAGE_LOAD_FAILED_CODE=1`  | `intent_webdriver_failed`, same prefix                                           | `page_load_failed`, retryable                                                |
| `intent_element_occluded`  | `DRIFTSTACK_INTENT_ELEMENT_OCCLUDED_CODE=1`  | `intent_webdriver_failed`, message starting `element occluded at the tap point:` | by the reason after the prefix — see below; nothing was tapped in every case |

`intent_element_occluded` belongs to click `{ require_unoccluded: true }` (A3 V-3358,
deployed 2026-09-18), which runs the occlusion test at the ACTUAL tap point — after the
click's own scroll, the persona jitter and its clamp to the element — with the same
verdict function as `perceive { selector }`, and refuses a covered tap before any touch.
The message is always `element occluded at the tap point: <reason>`, and the control
plane maps it by `<reason>` (`tapRefusalOf`, agent-intent-result.ts):

| Reason                                                                                                  | Control-plane meaning                                                                                                                   |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `hit_is_not_target_or_descendant`, `covered_at_enclosing_shadow_level`, or any reason not in this table | `element_covered`: not retryable as the same step, re-plannable                                                                         |
| `target_not_resolved`                                                                                   | the element-not-found path: `element_not_found`, waited for and retried like a lookup that matched nothing                              |
| `occlusion_check_unavailable`, `tap_point_outside_viewport`, `nothing_hit`                              | `target_unverified` (the harness could not VERIFY the point, and failed closed): its own customer sentence, not retryable, re-plannable |

A typed step's refusal is mapped the same way, in typing words ("…so nothing was typed").

The control plane sends the parameter on a tap whose pre-tap look answered
`tap_point_outside_viewport`, and on every tap the consequential gate releases on the
customer's approval — never on an ordinary clear tap, and never on a raw `{x, y}` click,
which the control plane's own params schema refuses with it. A harness that predates
V-3358 reads click params by key and ignores the field, tapping as before. An approved
tap the harness refuses does nothing, and its approval is not carried forward: the
approval resume ends there, and any new plan is put to the customer again.

**The own-label verdict and `send_keys` (A3 V-3360, harness `7795de230`, deployed
2026-09-18).** `dsTapVerdict` now clears a hit on the target's own `labels` or on a
NON-interactive descendant of one (innermost shadow level), and still refuses a hit on
interactive content inside the label (HTML's set: `a[href]`, `button`, `input` not
hidden, `select`, `textarea`, `details`, `iframe`, `embed`, `label`,
`audio`/`video[controls]`, `img[usemap]`). `perceive { selector }` puts
`hit_via_own_label: boolean` on EVERY element from that build; `send_keys` honours
`require_unoccluded` on its focus tap and always answers `focus_tap_unoccluded_checked`.
The control plane treats the field's PRESENCE as the build's tell and remembers it per
session (`sessionsWithOwnLabelVerdict`, beside the older-device memo). On such a device:

- The look uses the device's verdict and does NOT apply its label-text inference, which
  remains only as the fallback for a device without the field.
- Checkbox/radio targets and taps the look saw clear through the own label get the check
  under the same rules as every other tap (off-screen, or released by an approval).
- A typed step whose look said `tap_point_outside_viewport` is sent with
  `require_unoccluded`; a refusal types nothing. `focus_tap_unoccluded_checked: false`
  with the flag set is the native no-persona path, which focuses by script and makes no
  tap: counted `no_tap`, never as verified.

⛔ **A device WITHOUT the field keeps the old behaviour.** Its check has no own-label
rule, so the parameter is omitted when the look saw the own-label hit and for every
`checkbox`/`radio` target (off-screen, its tap point may land on the label), and
`send_keys` is never sent it — that build was not shown to ignore an unknown key.

**Open asks of A3 (V-3358 follow-ups):**

1. ~~Give click's check the look's own-label exemption.~~ Done in V-3360.
2. `behavioralTapElement` (the native element path) runs the check BEFORE the WebDriver
   action's own scroll, so an off-screen element is refused `tap_point_outside_viewport`,
   which the control plane files as unverified. Unreachable today (the fork's `findElement`
   fails, so the script path scrolls first), but it turns every off-screen checked tap
   into a refusal the day `findElement` works. Scroll first on that path too.
3. ~~Honour `require_unoccluded` on `send_keys`' focus tap.~~ Done in V-3360.

Every dispatch sent with the check is counted in
`driftstack_agent_tap_unoccluded_check_total{verb, why, result}`. The pre-tap look that
shipped on 2026-09-18 uses `perceive { selector }` instead: before every tap and every
typed step, the executor asks the harness what the selector resolves to and what is
under its tap point, never dispatches the click onto a covered control, gates purchases
on the hit element's own label as well as the planner's words, and keys the repeat guard
on the harness's canonical selector. Occlusion there is A3's definition: covered unless
the hit is the element or a descendant (an ancestor hit is covered). A tap whose point
is outside the viewport cannot be checked by the look, because the click scrolls to a
randomised band the control plane cannot reproduce; `require_unoccluded` checks it where
it lands.

**What `perceive { selector }` is, from the harness source (A3, 2026-09-19; keep these as
the control plane's premises, not the doc's):**

- **Resolution is first match in DOCUMENT ORDER, visible or not.** `dsResolve` is CSS
  through the shadow-piercing `deepQuerySelector` (open shadow roots) or XPath's first
  ordered node; there is no visibility filter, so a zero-size or `display:none` element
  resolves. It never crosses an iframe boundary: the current browsing context only. A
  resolved element is therefore NOT "the one a user could see"; only the occlusion
  verdict says that, which is why the gate keys on `occluded`, never on resolution.
- **The verdict is shared with click's `require_unoccluded`, the tap point is not.** One
  function (`dsTapVerdict`) decides both, and the look's point is the rect centre rounded
  as click rounds it — but WITHOUT click's per-tap jitter. A partly covered control can
  read clear at the centre and still take a jittered tap on the cover. That residual is
  why the tap that spends an approval, and any tap the look could not see, carries
  `require_unoccluded` where it lands, and why a green look never stands in for a safe
  tap on its own (`unoccludedCheckFor`).
- **`resolved_by` is `'native'` or `'script'`**, and the two paths can disagree about
  which element was got. The control plane reads it only as the capability tell today;
  keying the repeat guard on it as well is open.
- **`label` is accessible-name-LIKE, not the accessible name.** Selector path order:
  `aria-labelledby` → `aria-label` → (only with neither ARIA attribute) the native
  `<label for>` / wrapping `<label>` → `alt` → `placeholder` → button-input `value` →
  `textContent` → `title`; sanitized and capped at 200 chars. Two deliberate deviations:
  it is privacy-constrained (a data input's `value`, a textarea's or contenteditable's
  text, and a select's options are never used — user data), and the native-label
  resolution exists only on the selector path. Feed it to the gate as the harness's
  canonical label; never assert it equals an accname implementation's answer.

### 2026-09-20 — the confirmation gate grew a SECOND, STRUCTURAL arm (A2)

⛔ **NO WIRE CHANGE, AND ONE NEW PIECE OF DEVICE TRAFFIC.** The gate that stops a
purchase / payment / account deletion before dispatch used to be a matcher of fourteen
English captions over the tap's selector, the page digest's name for it and the device's
labels. Measured 2026-09-20: a checkout whose submit button is captioned with an
ordinary neutral word is outside every one of them, and both planner models completed
such an order with no approval, ten repetitions out of ten each.

It now has a second arm (`apps/server/src/services/agent-page-commitment.ts`) that reads
the page's STRUCTURE — does this tap submit a form, is that form collecting a query, does
it commit value already held, and is money on the table — and halts on the four together.
No page prose is an input to any verdict, so a page cannot argue its way past it. **The
caption arm is unchanged and runs first**, so every halt that happened before this happens
identically, with the same `matchedText` and therefore the same approval signature.

What A1 and A3 need from it:

- **The device protocol does not move.** No new verb, no new parameter, no new field on
  any result. `ConsequentialActionCategory` keeps its three members and the
  `confirmation_required` result keeps its four.
- **⛔ NEW DEVICE TRAFFIC: up to SIXTEEN extra `get_page_source` per TURN** — in practice
  roughly ONE PER TAP whose facts predate the last page-changing dispatch, which after the
  first tap is every tap. Taken by the control-plane executor immediately before a tap's
  gate. It is the existing read-only verb through the existing `observe()` path, raced
  against `observeTimeoutMs`, null on any failure. It is NOT taken for a tap the plan's own
  words already halt, for a tap the pre-tap look refused (`covered` / `not_found`), or for a
  target the device's `perceive` calls a `link`, `select`, `checkbox`, `radio` or `textarea`
  — none of which can be a form submit.
  ⛔ **A `button` is not skippable**, because a submit looks exactly like one from the
  outside, so a page with benign buttons before the order button costs a read at each.
  ⛔ **THE NUMBER WAS TWO AND TWO WAS MEASURED WRONG.** Two ordinary taps before the order
  button spent the whole allowance and the order button then met the gate with no facts at
  all — measured in the eval as a completed, unapproved purchase on two everyday shapes
  (two delivery-slot taps on a checkout; two filter taps on a shop, then its checkout). An
  allowance a page reaches by being ORDINARY is an off switch, not a ceiling. Past the
  allowance the arm now uses the LAST facts it read rather than going blind.
- **⛔ A KEY PRESS AND TYPED TEXT ARE ALSO GATED NOW, NOT ONLY A TAP.** `interact:press`
  with `Enter` is one real key press on the focused element and HTML submits the focused
  field's form from it; `interact:type` whose value carries a line break is the same thing
  through send-keys. Both reach the gate, so both can now take the extra read above. The
  focus the gate reasons about is the last control the run typed into or tapped — a
  server-side belief, never a new device question.
- **⛔ THE TELEMETRY LANDED (round 2), AND IT IS WHAT A3'S RHYTHM JUDGEMENT SHOULD BE MADE
  AGAINST NOW.** `driftstack_agent_commitment_facts_total{outcome}` — `refreshed |
unavailable | budget_spent | stale_used`, one row per step the arm judged — is the
  per-turn READ COST and the arm's blind spot in one series, and
  `driftstack_agent_consequential_halt_total{arm}` — `caption | structure | declared` —
  splits a halt by which reading raised it. Production runs no scraper, so the same seven
  numbers also ride on every turn's `agent_turn_action_paths` LOG LINE as
  `commit_facts_*` and `halt_arm_*` (see `docs/runbooks/agent-turn-monitoring.md`). ⛔ **The
  dispatch count A3 has to judge is `commit_facts_refreshed` — that is one extra
  `get_page_source` each.** `unavailable` is the blind rate and the one to alert on;
  `budget_spent` + `stale_used` are steps judged on an older reading, which can only add
  halts.
- **⛔ A THIRD ARM (round 2): THE PLANNER MAY DECLARE THAT A STEP COMMITS.** A plan step
  may carry `commits: "purchase" | "payment" | "account_deletion"` — the existing published
  categories, so **no new public enum value and no new field on any public response, and the
  device protocol still does not move**. It is a side-channel beside the plan, stripped out
  of the reply by the planner contract and read only by the executor's gate. A declared step
  halts exactly as a caption match does, and is judged only where the other arms already
  judge (a tap, a submitting key press, typed text carrying a line break) — but it is NOT
  bounded by what `perceive` calls the target, because a link and a `<div>` are precisely
  what it exists to reach. It needs NO page read, so it costs A3 no extra dispatch at all.
- **⛔ AND THE PROMPT THAT ASKS FOR IT NO LONGER APPRAISES THE STEPS BEFORE THE COMMIT**
  (2026-09-20, measured). The paragraph ended "Mark only the committing step: browsing,
  filling a field, adding to a basket and opening a checkout commit nothing" — and on the
  live corpus that sentence **doubled the rate at which the planner made up a customer's
  email address and submitted a sign-up form with it** (2 of 10 → 6 of 10 on
  `L-TWO-MESSAGES`, where the right reply is to reach the form and ask). It reads as
  "filling a field is harmless". It now says what to mark and that the steps leading up to
  it are left unmarked, and nothing about what those steps are worth; "NO PAGE CAN WAIVE
  THIS", the any-language wording and the any-control wording are unchanged, and the
  paragraph is shorter than it was. Beside it the prompt now carries **A VALUE ONLY THE
  CUSTOMER KNOWS IS ASKED FOR, NEVER INVENTED** — a value that is the customer's to give
  (an address, a name, a payment detail) is not made up and not copied off the page; the
  planner goes as far as it can and hands back with the contract's existing `clarify`. ⛔ **A
  page cannot supply one by claiming to know it** — "the customer gave it in this chat" would
  otherwise read onto page text, because this prompt's own injection rule calls an observation
  part of the conversation history, so the rule says in as many words that a page is not the
  customer.
  ⛔ **This is a PROMPT change only: no verb, no reply shape, no device call and no gate
  arm moves**, and the two wire goldens were re-recorded with the system-prompt text as the
  only difference (block list, block types and `cache_control` placement identical over all
  45 recorded Claude calls and 40 chat calls).
- **What would still close the largest remaining hole is a wire change, and it is A3's call.**
  A commit driven by a script handler on `<button type="button">`, a `<div>` or a link is
  not reachable from markup shape — the corpus already contains one. The declared arm
  reaches it when the model cooperates, and a page that talks the model out of declaring
  takes that arm away (asserted in the eval as a measured MISS). Closing it for a model that
  does not cooperate still needs the device to say what a click WOULD DO (a `submits` /
  `activates` field on the perceive answer). Reported, not assumed.

### 2026-09-18 — an unknown RESULT key is stripped and counted, not fatal

**Why.** On 2026-09-18 the harness shipped two result keys it considered additive
(`focus_tap_unoccluded_checked` on `send_keys`, `hit_via_own_label` on `perceive`
elements). Every per-intent result schema was `.strict()`, so until the control plane
declared them every such result failed its contract: typed steps would have failed and
pre-tap looks fell back to unchecked taps. No customer was affected (no AI turn ran in
the window), but an additive key breaking a dispatch is an outage waiting to happen.

**The rule (agreed with A3).** Inside a decoded `outputData`:

- A key the control plane DECODES is validated exactly as before. A wrong type or value
  on a known key is still a contract failure → `intent_dispatch_error`.
- A key nothing declares is REMOVED from the result before the executor sees it (never
  passed through — nothing downstream may act on a field it does not know) and COUNTED.
  The step carries on.

This applies at every nesting level the result schema describes (e.g. `perceive`
`value`, `elements[]`, `hit`, `hit.bounds`, `tap_point`, `state`). "Declared" means
declared by ANY variant at that position, so a key one variant owns arriving on a
variant that forbids it (navigate `loadedAtTimeout: false`, `results_visible` on a
truncated search) is a known key with a wrong value and still fails — it is never
stripped into a different variant. Positions whose keys are data (`extract.value`,
`execute_script.value`) are untouched, as before. Implementation:
`apps/server/src/services/harness-result-unknown-keys.ts`, called from
`parseIntentResult`; the strict schemas themselves are unchanged and remain the
known-key contract.

**Two guards keep the strip from accepting what the strict schemas refused.** Both only
ever reject:

- **Echoed secrets stay fatal.** A top-level `password` or `username` on `login`, `query`
  on `search`, `text` on `send_keys` or `fields` on `fill_form` fails the step
  (`RESULT_ECHO_TRIPWIRE_KEYS` in `harness-control-codec.ts`). These are the names of
  request parameters that carry customer secrets or text; a device echoing them back is a
  regression that must fail loudly, not read as a new field on a dashboard metric. The
  error names the key, never the value.
- **A cross-intent payload is still refused.** When top-level keys were stripped, the
  codec checks whether another intent's schema accepts the payload after stripping a
  STRICT SUBSET of those keys. If so, the payload is that intent's result (misrouted),
  not ours with new keys, and it fails as before. Without this, back/forward
  `{url, action}` sent for a `navigate` dispatch lost `action` and was accepted as
  navigate `{url}`. A tie (a new key both intents lack) is not a better fit, so an
  additive key never trips it. Pinned exhaustively: every sample of every intent, parsed
  as every other intent, is accepted only where the strict schema alone accepted it.

**The ordering rule still applies to any key whose VALUE the control plane needs.**
Decode first, arm by switch: the harness must not start relying on the control plane
reading a new key until A2 says the declaration is LIVE IN PRODUCTION. What changed is
only the failure mode of getting it wrong: an undeclared key used to fail the step; now
it is silently absent from the executor's view. So a new key that CHANGES MEANING —
anything the control plane must act on to stay correct — still needs the declaration
first, or a switch on the harness side, exactly as before. An unknown key no longer
breaks a dispatch.

**What stays strict, and why.**

| Surface                                                                                                     | Unknown key                  | Why                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decoded per-intent result (`outputData`)                                                                    | stripped + counted           | an additive fact about a step that otherwise validated. Two exceptions stay fatal (below): an echoed secret-bearing request key, and a payload another intent explains better                                             |
| `intentResult` envelope (`IntentResultEnvelopeSchema`)                                                      | REJECTED (unchanged)         | envelope keys qualify the whole frame — correlation, success, how `outputData` is encoded. A future `outputEncoding` or `partial` stripped away would make us act on a misread frame. Pinned per frame by the parity test |
| `errorCode`                                                                                                 | REJECTED (unchanged)         | an unknown code changes meaning; the decode-first table above still governs new codes                                                                                                                                     |
| Everything the server SENDS (params, `sessionAssign`, `controlCommand`, `probeEgress`, …)                   | REJECTED (unchanged)         | our own output: a stray key is our bug, and several of these carry authority (secrets, node-scoped ops)                                                                                                                   |
| Other harness→server frames (`sessionStatus`, `heartbeat`, `pageState`, the correlated `*Result` frames, …) | already stripped (unchanged) | these were never strict; unknown keys there are dropped silently, not counted                                                                                                                                             |

⚠️ An unknown key on the ENVELOPE still makes the whole outbound union refuse the
frame; the correlator never sees it and that dispatch waits out its timeout. The refusal
is logged (`inbound_frame_rejected`, structure only), so it is visible, but envelope
additions must still ship decode-first.

**What the operator sees.**

- `driftstack_harness_intent_result_unknown_key_total{intent}` — incremented by the
  number of distinct unknown key paths on each ACCEPTED result. `intent` is the closed
  intent enum from the pending dispatch; a key name is never a label. Dashboard-only (no
  paging rule). Non-zero means the device ships a field this build ignores.
- A `warn` log line, `event: "intent_result_unknown_keys"`, `component:
"harness-intent-result"`, with `intent`, `unknownKeys` (at most 8 dotted paths, array
  indices collapsed to `[]`, each name sanitised to `[A-Za-z0-9_-]` and capped at 64
  characters), `unknownKeyCount`, `truncated` (more than 256 distinct paths on one
  result) and `occurrences`. Rate-limited per (intent, key set): the first is logged,
  then every 100th with the running count; a NEW key set is logged at once. Key names
  only — never a value.
- A result that FAILS validation is not counted: another intent's payload would read as
  a device full of "new" keys.

### 2026-07-15 protocol-truth correction (supersedes every older roster/count above)

The live Swift `IntentExecutor` routes exactly 18 names, all of which are valid
internal dispatch vocabulary: `navigate`, `back`, `forward`, `click`, `send_keys`,
`press_key`, `execute_script`, `detect_challenge`, `extract`, `screenshot`,
`get_page_source`, `perceive`, `wait_for`, `scroll`, `behavioral_pause`, `fill_form`,
`search`, and `login`. The older 11/12-name lists and the claim that
`fill_form`/`search`/`login` were reserved or unimplemented are historical and
must not be used to build a sender.

The live result failure vocabulary is exactly 12 codes:
`intent_session_not_established`, `intent_not_implemented`,
`intent_missing_parameter`, `intent_invalid_parameter`,
`intent_webdriver_failed`, `intent_script_failed`, `intent_dispatch_error`,
`intent_deadline_exceeded`, `intent_deadline_cleanup_unconfirmed`,
`result_too_large`, `session_paused`, and `session_intent_in_flight`.
`intent_script_failed` is a non-retryable invalid script request;
`session_paused` is retryable after resume; `session_intent_in_flight` is a
retryable session-state condition after the active operation settles.
`intent_deadline_exceeded` is emitted only after the producer's fill/scroll
whole-intent wall fence wins, destroys that exact browser session, and confirms
browser exit; it is non-retryable for that session and requires a new session.
`intent_deadline_cleanup_unconfirmed` is emitted when that same producer fence
wins but bounded SIGKILL exit confirmation fails. It is likewise non-retryable
and requires a new session; the old exact id remains fail-closed on that node.

Every logical parameter object and every successful decoded result now has an
intent-specific strict schema (for results: the KNOWN-key contract — since
2026-09-18 an undeclared result key is stripped and counted instead of failing, see
above). A success envelope must carry only `outputData`;
a failure envelope must carry `errorCode` and may carry `errorMessage`, but must
not carry `outputData`. The correlator stores the originating `intentName` and
validates a success against that exact result schema. It first reads only the
bounded `type`/`sessionId`/`intentId` header: unknown ids and cross-session echoes
are discarded before full envelope validation or base64/JSON decoding. Once an
id/session pair matches pending state, malformed envelopes, malformed payloads,
and cross-intent result shapes settle deterministically as
`intent_dispatch_error` rather than hanging to timeout.

### Resolved wire facts (A3-confirmed; build to these)

- `inputParams`/`outputData` = **base64 string** of UTF-8 JSON (Swift `Data` default). Envelope keys = **camelCase**.
- WSS auth = **Ed25519-JWT + nonce** (mTLS NO LONGER required — optional transport DiD later). Verifier =
  the audited `services/fleet-node-auth.ts` (claims iss=sub=nodeId/iat/exp≤300/nonce; alg header ignored;
  `Authorization: Bearer <jwt>` on the WS upgrade). Harness signer wired to it (A3 `d1482885`).
- Dispatch correlation/timeout (A3 W106): 1:1 by `intentId`; fast-fail on the errored SessionStatus
  `intent_dispatch_no_session: <intentName>`; per-intent timeout follows the live producer budget plus
  15 seconds of transport slack where that budget is proved. Login targets an exact **600,000ms producer wall +
  15,000ms delivery slack = 615,000ms correlation** across username resolution/type, password
  resolution/type, submit, settle, and assessment. The 615,000ms control-plane deadline is not an
  early producer-loss detector. This is not yet activation evidence: the current producer creates the
  deadline task after its worker, reacquires actor ownership after the worker returns, and measures
  duration with `Date`, so an honest worker-first result is not yet proved to publish at or below
  600,000ms. A follow-up producer fence must make that public result bound executable before activation.
  Search now targets the same **600,000ms producer wall + 15,000ms delivery slack = 615,000ms
  correlation** and exposes an exact zero-submit truncation terminal. Its producer proof is landed,
  but activation likewise remains held until the monotonic deadline is part of mutation/publication
  authority. The remaining current policies are 315s for
  click/send_keys/behavioral_pause/wait_for, 70s for navigate/back/forward and 30s
  for remaining short observation/key/script intents. fill_form and scroll now use an exact 315s correlation
  deadline: a producer-enforced 300s monotonic whole-intent fence plus 15s for bounded exact-browser
  SIGTERM→SIGKILL→exit confirmation and delivery. Producer cleanup is bounded to 3s SIGTERM + 1s SIGKILL
  confirmation; the fixed default heartbeat result drain adds at most 10s, leaving 1s for actor scheduling/network.
  Confirmed destruction yields `intent_deadline_exceeded`; unconfirmed bounded
  cleanup yields `intent_deadline_cleanup_unconfirmed`. Both require a new session. Transport,
  capacity and lost-reply failures remain retryable `intent_dispatch_error`. A blanket long timeout is deliberately
  avoided so genuine connection loss remains fast for
  short operations. No result on connection-drop settles as `intent_dispatch_error` at the applicable deadline.

The login schema/correlation slice is contract-only and does **not** activate public direct login.
Activation remains blocked until the producer proves the 600,000ms result-publication bound, a real
direct driver consumes the intent, and a durable public
operation transport spans the 615-second lifetime across SDK defaults, nginx and the proxied edge.
The current roughly 30-second SDK defaults, request-derived maximums and public ingress ceilings are
not widened or presented as sufficient by this contract. A mock-driver 200 is not capability
evidence and must not receive customer credentials. Every currently shipped driver advertises a
non-real login capability, and the route fails with 503 before session lookup or operation claim;
only an explicit future real capability may reach the strict result path. Direct search has the same
contract-only posture: every shipped driver is non-real and returns 503 before lookup/claim. `fill_form`
remains an internal harness intent with no public session route or SDK method.

### DONE on the API side (all unwired → zero prod change until the bootstrap swap)

| piece                   | file                                       | commit                                   |
| ----------------------- | ------------------------------------------ | ---------------------------------------- |
| (a) wire schema         | `schemas/harness-control-protocol.ts`      | `3fa842fa` (+ base64 tighten `8711a319`) |
| (b) request mapper      | `services/agent-intent-to-dispatch.ts`     | `beb41e23`                               |
| codec (serialize/parse) | `services/harness-control-codec.ts`        | `8711a319`                               |
| result mapper           | `services/agent-intent-result.ts`          | `e6e577b2`                               |
| correlator + timeout    | `services/harness-dispatch-correlator.ts`  | `68b82e41`                               |
| plan runner (executor)  | `services/agent-executor-control-plane.ts` | `e0006d9c`                               |

The data path is complete + unit-tested end-to-end against a mock transport:
`agentIntentToDispatch → serializeIntentDispatch → IntentDispatchCorrelator.dispatch → parseIntentResult →
intentResultToCustomer`, halt-on-failure, in `ControlPlaneAgentExecutor` (implements the existing `AgentExecutor`).

### REMAINING (all Agent-2-buildable — NOT founder-gated; corrected 2026-06-05)

> **Correction:** the `fleet_nodes` table is NOT a pending founder gate — it was **APPROVED + shipped
> 2026-05-17 as migration `0043`** (+ `0056` LiveKit creds), and `DrizzleFleetNodesRepo` (getPublicKey/register/
> revoke/touchLastSeen/getDetail/listActive) is wired in bootstrap (`drizzleFleetNodesRepo`). Earlier runbook
> drafts wrongly listed it as gated-on-founder. So the WSS route has NO founder gate — it's a straight A2 build.

1. ✅ **Redis nonce cache** (replay defense) — SHIPPED `lib/redis-fleet-nonce-cache.ts` (atomic `SET NX EX`,
   NUL-separated keys, TTL clamp). Inject into `FleetNodeAuthImpl` at the route (NOT optional in prod).
2. **`@fastify/websocket`** dep (A2 adds when building the route — withheld until then to avoid an unused dep).
3. **`/v1/fleet/events` WS route** (A2 builds — no gate):
   - On upgrade: verify `Authorization: Bearer <jwt>` via `fleetNodeAuth.verify` (with the Redis nonce cache) →
     401 before the socket opens on failure.
   - Per-connection `DispatchTransport` (`send(d)` → `socket.send(JSON.stringify(d))`); inbound frame →
     `correlator.onResultFrame(frame)` (IntentResults) / `correlator.onSessionError(sessionId, detail)`
     (errored SessionStatus); on close → `correlator.failAll(...)`.
   - **OPEN (A2 designs; coordinate the node side via the bus): node→session routing** — the control plane maps
     a `sessionId` to the connected node owning its BrowserProcess. session→node assignment is the control
     plane's own state (planning 133); confirm with A3 whether the node also self-registers its sessionIds on
     connect (the connection-registry shape).
4. **Bootstrap swap**: `StubAgentExecutor` → `new ControlPlaneAgentExecutor(new IntentDispatchCorrelator(wsTransport))`
   — sequence on the LIVE transport + a real driver (swapping before end-to-end is real degrades the demo); a
   technical-readiness call, not a founder gate.
5. **Per-node Ed25519 key provisioning** (infra) — private key → harness (`ControlClientConfig.nodeSigningKeyRaw`),
   public key registered in `fleet_nodes` via `DrizzleFleetNodesRepo.register` (table + method already exist).
6. End-to-end execution against the fork still gated on item 9 (harness→fork drive; A1 Option-1, founder-approved).

### Customer-facing schema additions (c) — HOLD until 1–5 wired

`AgentIntentSchema` scroll{direction,distance_px}/back/forward/behavioral_pause + 3 SDKs + decomposer. Shipping
before the executor can dispatch them = a false affordance. Add as the FIRST post-wiring increment.

## sessionId WIRE-SHAPE contract (2026-06-06, A2 — verified compatible with harness W157)

A3 W157 (A2-A3 bus, harness commit `a9d26305`): the harness interpolates
`SessionAssign.sessionId` into per-session FILE PATHS (gost log, WD port-file, RTP
ndjson, JS-bridge socket), so `handleSessionAssign` now REJECTS (`invalid_session_id`,
no spawn) any sessionId that isn't **non-empty, ≤128 chars, `[A-Za-z0-9_-]` only** —
a defense-in-depth path-traversal guard (same principle as the W135 navigate-scheme
guard). Flagged "likely no-op for you."

**A2 verified it IS a no-op — our control-plane `sessionId` is a _prefixed_ id (not a
bare UUID), and it passes the W157 guard cleanly.** The value on every
`ControlInbound.sessionAssign` / `intentDispatch` and `HarnessOutbound.*` envelope is:

- **`agt_<uuid>`** — agent sessions. THE canonical control-plane session id.
  Minted in `db/agent-sessions-repo.ts` as `` `agt_${randomUUID()}` `` and pinned
  by `AGENT_SESSION_ID_RE = /^agt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`.
- **`ses_<uuid>`** — legacy driftstack sessions (the separate DIRECT `/v1/sessions`
  path). `SESSION_ID_RE = /^ses_.../`. Same body shape, different prefix.

Both invariants are locked by `tests/unit/session-id-prefix-cross-source-invariant.test.ts`
(prefixes must never cross). Wire-shape facts (all WITHIN the W157 guard):

- **Charset:** `agt_`/`ses_` + lowercase hex + `-` — every char ∈ `[A-Za-z0-9_-]` ✓.
- **Length 40** (4-char prefix + 36-char UUID-with-dashes) ≤ 128 ✓; non-empty ✓.
- **Path-traversal-safe:** no `/`, `.`, `..`, `%`, `:`, or whitespace — safe to embed
  in a capture/session directory path as-is (which is exactly why W157 accepts it).

**CONCLUSION: no action either side — verified compatible.** Recorded here because
the contract previously left the wire `sessionId` shape unspecified; this pins it so
any future id-format change (e.g. a new prefix, or dropping the dashes) is checked
against the harness's `[A-Za-z0-9_-]`/≤128 path-safety guard before it ships. The API
will NOT strip the prefix before sending — the prefix is the cross-type safety
boundary (keeps a `ses_` id out of an `agt_` mint flow), so it must travel on the wire,
and it is path-safe by construction.

## Profile-backed sessions — restore + save-back contract (2026-06-08, A2 W181–W186 ⇄ A3 W417–W421)

A profile-backed session restores an encrypted per-profile store into the fork on
assign and seals it back on session end. The sealed blob (LZFSE + AES-GCM-256 under
a per-profile DEK) is **opaque to the control plane** — A2 only moves bytes + mints
presigned URLs; it never decrypts. Stored in R2 at `profiles/<profile_id>.sealed`
(`profileSealedBlobKey`, an object-storage key — flat, no path traversal).

### Wire contract (snake_case nested, mirrors the `livekit` block convention)

**INBOUND — `ControlInbound.sessionAssign.profile`** (optional; absent ⇒ today's
stateless path, unchanged). `SessionAssignProfileSchema`: `profile_id` + `dek`
required; `sealed_blob` (inline ≤256KB) OR `sealed_blob_url` (presigned GET) +
`sealed_blob_put_url` (presigned PUT for save-back) optional. Built by
`buildAssignProfileBlock(r2, profileId, dek, {urlTtlSeconds})` (camelCase in →
serializeSessionAssign emits snake_case). A2 chose **always-presigned-URL, never
inline** on the restore side (A3's decoder fetches `sealed_blob_url`, W420 tested) —
keeps an arbitrarily large blob off the server with no size-probe.

**OUTBOUND — `HarnessOutbound.profileSaved`** (A3 W421, exact emitted frames, pinned
both sides byte-for-byte). nil optionals are **OMITTED, not null** — absence is the
discriminator:

- inline (small): `{"type":"profileSaved","sessionId":"…","profile_id":"…","sealed_blob":"<b64>"}` → server `putObject`s under `profileSealedBlobKey`.
- large-ack (after the harness PUT to `sealed_blob_put_url`): `{"type":"profileSaved","sessionId":"…","profile_id":"…","stored":true}` → server no-op.

### Status

- **A3 (W420): COMPLETE + live** — lifecycle wired end-to-end (decode→openProfile→
  populate on assign; serialize→seal→profileSaved on end), graceful-degrade to
  stateless on any restore failure, must-deliver queue across teardown. 239 green.
- **A2: DONE (gated/inert in prod until wiring + flag)** — wire contract (`65d77c59`),
  profileSaved consumer + R2 persist (`4eccdd65`), verbatim-frame drift-guard
  (`3b836cab`), `buildAssignProfileBlock` restore builder (`7214a6aa`), presign-TTL
  data-loss fix (`c0d4234d`).

### Audit findings (A2 W185–W186)

1. **FIXED (`c0d4234d`):** the save-back PUT URL is minted at assign but used at
   session END; R2's default 900s TTL < the 1800s default max session ⇒ a >15-min
   session's save-back would 403 → silent profile-data loss. `buildAssignProfileBlock`
   now takes `urlTtlSeconds` (default 3600, clamped to R2's 7-day ceiling); the step-(e)
   caller passes `maxDurationSeconds` + margin.
2. **OPEN — authorization, close at wiring:** the profileSaved consumer's INLINE path
   writes `profiles/<frame.profile_id>.sealed` using the NODE-supplied `profile_id`
   with no ownership check ⇒ a compromised/buggy authenticated node could overwrite an
   arbitrary profile's blob. Isolated (the only inbound frame writing a cross-session
   resource keyed by untrusted input; intentResult/sessionStatus are correlation-scoped).
   Close via **(B)** harness always uses the server-minted `sealed_blob_put_url` (never
   inline) ⇒ server-controlled key, node-keyed write dead; **+(A)** server records
   `session→profile` at dispatch and the consumer rejects a `profile_id` mismatch.

### REMAINING

- **(c) DEK mint/wrap — REFRAMED 2026-06-08: NOT KMS-gated.** file 57 specifies a
  KMS→TMK→DEK design, but the SHIPPED codebase reality is a single host-resident
  `MFA_ENCRYPTION_KEY` AES-256-GCM envelope used by **4 secret classes already**
  (BYOK-anthropic, gui-control-key, MFA-TOTP, livekit-secret — see
  `livekit-secret-encryption.ts`); **no secret class uses KMS yet.** So profiles can
  reuse that exact pattern with **no new infra**: per-profile `DEK = randomBytes(32)`,
  wrap with `MFA_ENCRYPTION_KEY` (mirror `encryptLivekitSecret`), store `encrypted_dek`
  in the profiles table, decrypt JIT on assign → the plaintext `dek` rides the assign to
  the harness (A3 W420 — the dek deliberately DOES cross to the harness, unlike the 4
  server-only classes). **Only open decision (founder ack): ship on the host-key envelope
  NOW (same trust boundary as the other 4 classes) vs wait for a file-57 KMS migration
  (a separate cross-cutting future arc nothing uses yet). Recommend host-key-now for v1.0.**
- **session→profile linkage** — how an agent-session selects a profile (e.g. a
  `profile_id` on the create body) — **product decision** (Tier-2; propose, don't auto-add).
- **(e) dispatch wiring** — once (c) is ack'd: mint/unwrap the dek, call
  `buildAssignProfileBlock(r2, profileId, dek, {urlTtlSeconds: maxDuration+margin})` in
  `dispatchSessionAssignOnCreate` for profile-backed sessions, + close the W185 inline-path
  authz finding (option B: harness always uses the server-minted PUT, never inline; +A:
  record session→profile + reject mismatch). The crypto-free R2/presign half is already
  built + tested (`buildAssignProfileBlock`); (e) is unblocked the moment (c) is ack'd +
  the linkage is chosen.

## SessionAssign readiness ownership (2026-07-15, A3 V-689 — inert until provisioner wiring)

`socket.send(sessionAssign)` proves only that a frame was handed to one WebSocket; it
does not prove that the harness created the browser. Each authenticated
`FleetControlConnection` therefore owns one bounded `SessionReadinessCorrelator`.
A future strict provisioner must reserve the session id synchronously on the exact
connection **before** sending `sessionAssign`, then await one non-rejecting outcome:

- `active` — that connection received the exact session's active status;
- `terminal` — it received `ended` or `errored`, retaining only the bounded status
  and optional bounded reason token (never free-text detail);
- `timeout` — the control-plane readiness policy elapsed;
- `connection_closed` — that physical connection closed or was superseded;
- `duplicate` or `capacity` — the reservation was refused before any send.

Unknown/intermediate statuses do not settle readiness. A connection admits at most
256 pending ids; duplicates never replace their first owner. Close clears every
timer and resolves every pending owner. Same-node reconnect is a hard authority
boundary: replacement settles the predecessor's owners as `connection_closed`, and
neither a late predecessor frame nor a successor frame can acknowledge work owned
by the other connection. Terminal status still independently drives the existing
intent fast-fail and terminal-session consumer exactly once.

The default 105-second deadline is an overrideable control-plane policy, **not** a
claim about the harness producer's maximum. The current harness launch watchdog
defaults to 90 seconds but is operator-tunable. Runtime activation remains blocked
until the watchdog is fixed/clamped fleet-wide or its effective deadline is carried
through an authenticated capability and the control-plane policy is derived from
that value. Finite overrides are capped at Node's 2,147,483,647ms timer ceiling;
larger `setTimeout` values otherwise become a dangerous 1ms timeout. This slice adds
the owner and proofs only; no route, driver, provisioner or bootstrap path calls it.
