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
