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
3. **GUI item-b — release .app webview-paint.** Diagnosed: most likely macOS WKWebView blank-until-redraw on the `titleBarStyle:"Overlay"` window. Fix-list ready (`docs/internal/2026-06-10-gui-release-paint-bug-diagnosis.md`); needs eyes-on (observe the release build, apply #1/#2).
4. **agent_sessions strict-FK.** Currently loose text link (decided once). The strict-FK migration is breaking — re-confirm keep-loose or do the deprefix migration.
5. **LOW / optional (founder/infra calls):** navigate URL-scheme SSRF allowlist (gated/planning-133 — VM isolation is the mitigation); unauth-token-route IP gates (values are policy; trustProxy now live so they'd be effective); api-key rotate grace-boundary expiry (semantics); `errors.driftstack.dev` DNS (NXDOMAIN — RFC-7807 type URIs); profile-saved cross-account check (fix at multi-node wiring); avatar R2 lifecycle policy (orphan cleanup — infra, NOT app-side: R2 client is deliberately delete-less).

**Bottom line:** no A2 code blockers anywhere. The codebase is exhaustively audited + the backlog is accurate. The single highest-leverage action is go-live (turnkey-runbooked).
