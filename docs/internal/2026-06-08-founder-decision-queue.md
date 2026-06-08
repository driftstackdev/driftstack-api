# Founder decision queue — 2026-06-08 (Agent 2 / driftstack-api)

Consolidated "start here" for the founder returning from away-time. These are
the items autopilot **cannot** action itself (founder decision / eyes-on /
cross-agent) — surfaced across recent waves, gathered here so they can be worked
in one pass. Everything else (audits/hardening) is shipping autonomously.

## ✅ 1. Agent-layer architecture overlap — RESOLVED (you picked option 1)

You decided **option 1** (W545→A3 W549). A2's `agent-runtime`/decomposer/executor/
agent-sessions stays the canonical NL agent layer; A3 **retired the duplicated
agent-service units**. The agent-service is now just net-new pieces A2 can adopt
as a lib if/when useful (`stop-conditions.ts` file-06 precedence,
`page-representation.ts`); nothing of A2's changes. No further action needed.

## ⭐ 1b. NEW — iPhone-touch input (your "real tap not macbook mouse" directive)

You asked for real iPhone tap (e.g. iOS-Simulator touch) in the live/stream
input instead of the macbook mouse cursor. **It's planned (04 §226-228 + 05) and
partly built:** the streamed mac cursor is already removed (`showsCursor=false`),
and AI-intent input already uses behavioural touch. The **gap is the manual /
live-drive path** (still mouse-vocab + harness-forward 503'd) and the
**fork-vs-iOS-Simulator runtime** call. A2 is **driving its part + coordinating**
(bus W550): A1 = runtime feasibility (fork vs iOS-Sim), A3 = harness iOS-touch
injection, A2 = the touch wire-contract + dashboard/gui-client emit. Full design +
contract proposal: `docs/internal/2026-06-08-iphone-touch-input-pipeline.md`.
**Your call if/when it surfaces:** v1.0 scope of iOS-Sim-for-live-browsing (A1).

## 2. GitHub account flag — blocks CI/Deploy (you've contacted support)

The account flag ("ineligible for transactions") is what stalled GitHub Actions
(CI + auto-deploy). git **push** still works; the **GUI is a local build**
(unaffected); prod can be **manually SSH-deployed** (`scripts/deploy-bridge.sh`)
if it must be current before the flag clears. ~10 undeployed server commits are
migration/env-clean — they auto-deploy when the flag lifts, or on a manual run.

## 3. GUI (b) release `.app` paint bug — needs your build + launch

Narrowed to a WKWebView **compositing** issue (not boot/assets — JS runs). Full
diagnosis procedure + the dev-log file path + candidate toggles are in
`docs/internal/2026-06-08-gui-live-flow-hardening-and-b-diagnosis.md`. Autopilot
can't do it (eyes-on + changes window UX). GUI (a)/(c)/(d) are **done**.

## 4. Breaking / gated changes (your design call — autopilot will NOT flip)

- **agent_sessions strict FK** (task #5) — a breaking migration; needs your
  design decision (cascade vs restrict vs nullable).
- **iphone16pro → iphone17 launch-archetype cutover** — canvas-gated (Agent 1);
  surfaced, not flipped.

## 5. Surfaced edges (lower priority — fix-when-wired / your call)

- **Dashboard manual-control coordinate projection** — `viewportCoords` sends raw
  overlay px; must project to device px when Slice-4 wires the `<video>` + harness
  forwarding (TODO marked at the call site; latent today — forwarding 503s).
- **Recordings flush-on-close** — fire-and-forget on unmount; an abrupt app-close
  can lose an in-progress recording. Proper fix = Tauri `onCloseRequested` + await
  (Rust + launch-verify).
- **Staging→prod deploy** of the undeployed commits (V-507 staging-first;
  low-urgency — mock/pre-launch surfaces).

---

_Autopilot status: GUI live-flow (4 bugs fixed), Go SDK core, webhook-signature
verification, and the server/SDK/crypto surfaces are audited-clean. Fresh-audit
waves continue; real findings get surfaced here, churn is not manufactured._
