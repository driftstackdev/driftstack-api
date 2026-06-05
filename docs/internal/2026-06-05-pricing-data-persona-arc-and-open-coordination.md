# 2026-06-05 — pricing-as-data + persona arc; open coordination items

Continuity report for the 2026-06-04/05 Agent-2 autopilot arc (docs/internal was
last updated 06-03). Covers what shipped, and — more importantly — the items now
**blocked on a founder decision or Agent-3 confirmation**, surfaced here so they're
visible in the repo (not only in auto-memory).

## Shipped (all landed on main, full pre-push gate green, deployed)

### Pricing-as-data Phase A — COMPLETE (founder locked-decision #1: live-editable, DB-source-of-truth, audited)

The arc, in validated increments:

1. `e9ff1c1e` migration `0067` — `pricing` table + seed (= the existing constants).
2. `1101be04` data layer — `PricingService.listEffective()` = DB row ?? `TIER_MONTHLY_PRICE_CENTS` (safe constant fallback; pricing reads never throw).
3. `34fc16af` (2b) — owner `GET /v1/admin/owner/pricing` view reads `listEffective()`.
4. `bf40c3c1` (2c) — the **crypto-checkout charge** reads `listEffective()` (the customer money-path; `TIER_PRICE_CENTS` kept as seed+fallback).
5. `aff27d85` (2d-i) — `PricingService.setPrice` write path (validated; not shielded by the read fallback).
6. `c8381038` (2d-ii-a) — `pricing.updated` admin-audit enum + migration `0068` (all 4 sources in lockstep).
7. `4eba7b99` (2d-ii-b) — audited owner `PATCH /v1/admin/owner/pricing/:tier` route (requireOwner + D-025 audit-before-response).
8. `aecdf722` — admin-panel owner-only pricing-**edit** UI (the cockpit consumes the PATCH).

Net: an owner price edit now moves **both** the owner view and the customer crypto charge (both read `listEffective`) — no editable-price-that-doesn't-charge footgun. Stripe-SYNC (Phase B) is **design-gated** (immutable Stripe prices → grandfathering).

### Per-session behavioural persona — COMPLETE + DISCOVERABLE (Agent-3 coordination, part 2b)

`behavioral_profile` (`casual`|`regular`|`power_user`, default `regular`) on `POST /v1/sessions`:

- `c0a46694` — api-types field + cross-source guard (lockstep with the `behavioural-simulation` lib `PersonaId`) + service threads it (defaulted, like `purpose`) → driver `CreateSessionInput.behavioralProfile` → mock captures it. Not persisted (create-time harness config; no DB migration). openapi auto-derives; sdk-python regenerated.
- `2990fb86` — Go SDK `CreateSessionRequest` gains `behavioral_profile` (typed `BehavioralProfile` + consts) **and** `profile_id` (closing a pre-existing Go lag since May).
- `7309117c` — API-reference doc (`apps/docs/api/sessions.md`) documents it + doc-parity pin.
  Complete across api-types + server + all 3 SDKs + marketing & API-reference docs.

### Other fixes this arc

- `a50151db` — **api-types `AdminAuditActionSchema` drift fix** (16→20): migrations 0057/0061/0062/0063 had added 4 admin-audit actions to the pgEnum + service union but not the api-types canonical, so the admin audit-log filter 400'd those 4 actions + the SDK response type omitted them. Root cause: the cross-source guard exact-pinned api-types but only subset-checked the pgEnum.
- `846dbe02` — **anti-recurrence hardening**: W862 (admin_audit_action) + W857 (usage_record_type) now exact-pin the pgEnum (accounting for documented internal-only values), closing the asymmetry that allowed the drift.

## OPEN — blocked on a decision (NOT auto-doable; surfaced for the founder / Agent-3)

1. **Behavioural scroll/behavioral_pause intents + executor wiring (Agent-3).** Agent-3 asked to expose the `scroll` + `behavioral_pause` intents (the harness executor is wired for them). PROPOSED shapes (in `project_behavioral_touch_model_ownership_contract` memory): `{kind:'scroll', direction, amount?, selector?}`, `{kind:'behavioral_pause', reason?, hintMs?}`. **Awaiting Agent-3's confirmation of the param shapes** before wiring — these are gate-coupled to the server `AgentIntent` union + the (currently stubbed) executor, so a wrong shape forces rework. This increment must ALSO reconcile a **latent drift surfaced this arc**: the `AgentIntent` interact vocabulary (`tap/type/scroll/swipe`, flat enum) does NOT match the driver/route `InteractActionSchema` (`tap/type/scroll/press`, discriminated union) — agent `swipe` has no driver target, driver `press` is unreachable. Latent today (executor is `StubAgentExecutor`, no driver dispatch); becomes a live bug when the executor wires to `driver.interact`. Ownership decision (relayed, agreed): the TS `behavioural-simulation` lib is the single source of truth for the model (emits the `TouchSample[]`/`ScrollPattern` plan); the harness executes; the plan crosses via the control plane (server runs the lib).

2. **Secrets management Phase A (founder locked-decision #3).** DB-backed encrypted secrets store, owner-gated, audited, never-plaintext-readback. **Design-gated** — the recon (`project_secrets_management_design_recon`) flagged 4 decisions for founder sign-off (Phase-A-runtime-secrets-first vs the boot-time Stripe key; restart-on-change vs runtime re-init; confirm never-readback; confirm env master key stays mandatory). Recommended: Phase-A-first + restart-on-change for B + never-readback + env master key. Not auto-built (security-critical + architectural).

3. **Pre-existing founder/maintainer-gated items (unchanged):** agent*sessions strict-FK (breaking migration); iphone16pro→iphone17 archetype cutover (canvas-gated, Agent-1); webhook-delivery worker unwired in prod; PERMISSIVE_CORS in prod; trustProxy/XFF; errors.driftstack.dev NXDOMAIN; metrics layer inert in prod. (All in `project*\*` memories + the 06-02 decision-queue report.)

## State of the audit surface

Comprehensively swept (see `project_cross_cutting_invariant_audits_roster` — 9 dimensions; Zod-validator vein; driver+mock layer; enum-drift class). Fresh probes now reliably land on already-clean ground, so per the saturation guidance, default waves to **minimal-cost safety checks** (git divergence + prod /health+/version, to catch a new regression/CVE/divergence the moment it appears) + instant ship-readiness; mount a deep probe only on a NEW signal (prod anomaly, fresh CVE, founder §-decision, or a genuinely-untouched track). The two real levers are items (1) and (2) above.

---

## 2026-06-05 (later waves) — Increment-2 control-path shipped + audit/hardening

**Architecture correction (supersedes the driver-path framing above).** Agent-3 confirmed
(W91 + the canonical `driftstack/docs/internal/harness-intent-contract.md`, drift-guarded +
behavior-tested per W95/W96) that agent-session intents dispatch as ONE
`ControlInbound.intentDispatch` per intent over the control-plane WSS, routed by `intentName` —
NOT the server-local driver. So the unwired `RealAgentExecutor` (AI-B2.b, driver-path) is the
wrong layer; its translation logic is reusable, the dispatch target changes. Re-scoped + shipped:

### Increment-2 SHIPPED (control-path, unwired — zero prod change)

- **(a) wire schema** `3fa842fa` — `apps/server/src/schemas/harness-control-protocol.ts` (server-internal,
  gui-input/L-001 precedent): 11 dispatchable intentNames + 3 reserved JSBridge, per-intent param
  schemas + `HARNESS_INTENT_PARAM_SCHEMAS` map, `IntentDispatch`/`IntentResultEnvelope` envelopes,
  5 error codes, caps (behavioral_pause 300_000ms / wait_for 300s). 32 tests.
- **(b) mapping core** `beb41e23` — `apps/server/src/services/agent-intent-to-dispatch.ts`:
  `agentIntentToDispatch(AgentIntent) → {ok,intentName,params} | {ok:false,reason}`. Clean 1:1
  (navigate / tap→click / type→send_keys / scroll / wait:selector_visible→wait_for [JSON-escaped
  querySelector predicate] / screenshot / dom_snapshot→get_page_source); typed-unsupported for
  swipe / wait:idle / pdf / missing-field. Codec-independent (produces params object, not the wire
  bytes) → stable regardless of the open codec question. 23 tests.

### 🔴 OPEN — the 3 A3 wire questions are the actual blocker on (a)'s WSS handler (relayed to founder)

Not in the contract doc (they're transport/serialization, modeled `z.unknown()` until confirmed):

1. `inputParams`/`outputData` codec — Swift `Data`: nested JSON object, JSON string, or base64?
2. Envelope JSON key casing — `.convertToSnakeCase` (session_id…) or literal camelCase (sessionId…)?
3. `/v1/fleet/events` WSS auth + first-message handshake — Ed25519 fleet-node JWT+nonce / mTLS / both?
   and the node-register message (which sessionIds it owns) → for the connection registry.

### Remaining (a)/(b)/(c) gates (all founder/cross-agent)

- (a) WSS handler: `fleet_nodes` Tier-2 migration approval + mTLS (Cloudflare AOP) + `@fastify/websocket`
  (A2 adds when building). `/v1/fleet/events` is a 503 stub today; the `fleet-node-auth.ts` Ed25519
  verifier is audited SOUND (alg-confusion regression suite added `ca2fd8ad`) + ready for the handshake.
- (c) customer `AgentIntentSchema` additions (scroll dir/distance, back/forward, behavioral_pause) —
  HOLD until (a)/(b) wired (else false affordance).
- End-to-end still gated on item 9 (harness→fork drive; founder Option-1; A1).

### Other ships this session

- `ca2fd8ad` fleet-auth JWT alg-confusion + integrity regression suite (no source change — verifier sound).
- `51bba3ab` egress: trim `socks5.host` before probe + env var (v1.0 launch path; backend wired-but-uncalled
  — routes 503-stub, so the probe SSRF stays latent/founder-§4.17 until EG-API-1.6 wires `applyToSession`).
- `8df88dda` Permissions-Policy added to marketing + docs `_headers` → CF-Pages family 5/5 consistent + per-app
  drift-guarded (CSP still deferred family-wide).

### Surfaced this session (founder-supervised, NOT autopilot)

- **MFA TOTP replay within the validity window** (RFC-6238 §5.2 — no last-step tracking; rate-limit-mitigated;
  proper fix needs a column = migration). + `regenerateRecoveryCodes` non-atomic (low). Verify/recovery core
  otherwise SOUND. (`project_mfa_service_verify_audit`)
- Master-owner cockpit gate (`requireOwner` + price-edit) adversarially audited **SOUND + fully tested**
  (`project_admin_owner_gate_audit_clean`) — highest-stakes new code (price-manipulation authority) is secure.

### Audit-surface status

Definitive saturation re-confirmed this session across MFA, legal, rate-limiter (core+store), auth-coalescer,
client-ip (= the surfaced trustProxy/XFF item), socks5, owner-cockpit, behavioral_profile, webhook, SDK, routes,
cost. Default waves = safety heartbeat + fresh-audit scope-confirmations; the two real levers remain
Increment-2 (the 3 wire answers + migration/mTLS/item9) and secrets Phase A. No churn manufactured.
