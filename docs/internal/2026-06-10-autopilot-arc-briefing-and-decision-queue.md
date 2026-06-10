# 2026-06-10 — Autopilot arc briefing + founder decision-queue (Agent-2)

Concise orientation for the founder's return after a long Agent-2 autopilot run
(driftstack-api scope). Supersedes the decision-queue half of
`2026-06-02-resilience-arc-and-founder-decision-queue.md` (that arc's shipped
items still stand). Per-item depth is in auto-memory; this is the index + the
decisions that need you.

## Shipped this arc (all on origin, gate-green, V-205-clean; prod still `c984f207` — dormant commits ride the next deploy)

- **Challenge-handling feature — COMPLETE end-to-end** (A3 W736 asks → decided + built): `harness-control-protocol` contract (pauseSession/resumeSession/challengeDetected), registry relay-hook, `makeChallengeRelay` → `session.challenge_detected` webhook (+ migration 0070 enum), customer `POST /v1/agent-sessions/:id/resume` endpoint (+ 409 active-guard), docs. A3 harness side confirmed wired. All `FLEET_CONTROL_PLANE_ENABLED`-gated/dormant.
- **Fixes:** scheduled_jobs claim partial index (0071); incident notification fan-out → fire-and-forget (don't block admin create/resolve on a slow Slack channel); go-live config boot-log; `DB_STATEMENT_TIMEOUT_MS` added to the go-live runbook. (Earlier in the arc: rate-limiter Redis-SPOF fail-open, egress SSRF DNS-rebind, cost-chain death, SSE backpressure, LiveKit over-grant route deletion, astro-6 status/docs.)
- **~28 fresh audits** across security/crypto/authz/ops/perf/retention/Tauri-IPC/CLI-auth — all clean (no real bugs); details in auto-memory mined-veins roster.
- **Reconciliation pass — cleared 8 stale "open" findings** that were already fixed in earlier sessions: Stripe webhook double-dispatch, validation-harness re-entrancy, oauth-provider ratelimit, **the HIGH trustProxy IP-resolution gap** (TRUST_PROXY=1 verified live in prod), auth-flow-token double-submit, health-probe ×2. The open-findings list is now accurate.

## Decision queue (all founder-gated; nothing here is autopilot-fixable)

1. **GO-LIVE (highest leverage).** A2 is 100% ready — dispatch/token/profile-DEK/egress/challenge-handling all on origin + dormant. Needs: the env secrets (`FLEET_CONTROL_PLANE_ENABLED=1`, all-3 `LIVEKIT_*`, `PROFILE_MASTER_KEY`; `TRUST_PROXY=1` already set; `DB_STATEMENT_TIMEOUT_MS` recommended) + a registered Mac fleet node, then `deploy-bridge.sh` (runs migration 0070). Turnkey runbook: `docs/internal/2026-06-09-go-live-runbook.md`.
2. **Retention policy (W418).** `session_events` + `scheduled_jobs` (finished rows) grow unbounded — no prune/archive. Decide delete-vs-archive + period. Pre-scale (tiny pre-launch), but decide before meaningful traffic. Both fixable via existing patterns (audit-archive→R2 or a prune tick).
3. **GUI item-b — release .app webview-paint.** Candidate fix SHIPPED (W434, `2a5557ad`): a macOS-only Tauri `.setup()` resize-nudge forcing a startup compositing pass past the Overlay-titlebar WKWebView blank-until-redraw quirk — `cargo check` clean, benign-if-wrong. **Needs you to observe the next release `.app` build:** composites → item (b) RESOLVED; still-blank → fallbacks (#1 `titleBarStyle:"Visible"`, then #3/#4) in `docs/internal/2026-06-10-gui-release-paint-bug-diagnosis.md`. (GUI items a/c/d verified done: a = AgentSessionPanel aspect-lock; c = keychain only-for-cloud, self-hosted key in settings.json; d = dev logs/stability.)
4. **agent_sessions strict-FK.** Currently loose text link (decided once). The strict-FK migration is breaking — re-confirm keep-loose or do the deprefix migration.
5. **LOW / optional (founder/infra calls):** navigate URL-scheme SSRF allowlist (gated/planning-133 — VM isolation is the mitigation); unauth-token-route IP gates (values are policy; trustProxy now live so they'd be effective); api-key rotate grace-boundary expiry (semantics); `errors.driftstack.dev` DNS (NXDOMAIN — RFC-7807 type URIs); profile-saved cross-account check (fix at multi-node wiring); avatar R2 lifecycle policy (orphan cleanup — infra, NOT app-side: R2 client is deliberately delete-less).

## Product-scope calls (v1.0 vs v1.1) — surfaced from A2↔A3 collaboration

These are forward features, fully scoped + cross-agent-ready; each needs only your
v1.0-vs-v1.1 call. Both agents agree; neither is being pre-built (founder-gated).

6. **Behavioral speed-modifier axis** (fast/balanced/careful, layered on the
   persona). Persona selection (casual/regular/power_user) is the working v1.0 cut;
   the speed axis is a power-user refinement. **A2 + A3 both recommend v1.1.** If
   v1.0: A2 adds a `speed_profile` field (CreateSessionRequest + SessionAssign), A3
   extends `resolvePersona` to 2-arg (apply-fn already exists). Doc:
   `2026-06-10-behavioral-model-ownership-decision.md`.
7. **`threshold_action_detected` — human-confirm before consequential actions**
   (purchase over threshold / account deletion / payment-method change). The one
   unbuilt file-06 stop. **A2 + A3 both lean v1.0-minimal (safety/liability):** a
   goal-driven autonomous agent can over-step into an unrequested purchase/payment/
   deletion → real financial/destructive liability + trust hit (stronger than the
   speed-axis, which is cosmetic). Minimal v1.0 = confirm before a detectable
   payment-form-submit / destructive-button-class action; full configurable semantic
   threshold = v1.1. If greenlit: A2 wires semantic target-classification (page-rep
   labels) + the confirm flow (reusing the challenge pause/resume machinery); A3's
   stop-conditions hook is ~10-line-ready (bus W788).

**Bottom line:** no A2 code blockers anywhere. The codebase is exhaustively audited

- the backlog is accurate. Highest-leverage action is go-live (turnkey-runbooked);
  the two product-scope calls (#6, #7) are the only forward A2 builds, each waiting on
  your v1.0/v1.1 decision.
