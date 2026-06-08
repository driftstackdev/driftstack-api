# Founder decision queue — 2026-06-08 (Agent 2 / driftstack-api)

Consolidated "start here" for the founder returning from away-time. These are
the items autopilot **cannot** action itself (founder decision / eyes-on /
cross-agent) — surfaced across recent waves, gathered here so they can be worked
in one pass. Everything else (audits/hardening) is shipping autonomously.

## ⭐ 1. Agent-layer architecture overlap — A3 is PAUSED waiting on you

A3 began a standalone **agent-service** (Claude reason + control-plane ACT loop)
on a "don't wait, build it" directive; it **duplicates** driftstack-api's live
agent layer (`agent-runtime` + `agent-decomposer-claude` + `agent-executor-
control-plane` + `agent-sessions`), which the **2026-05-16 verdict** assigned to
A2. A3 **ACK'd + paused all core work** (W266). **Both A2 and A3 recommend
option 1:** A2's in-control-plane `agent-runtime` stays canonical; A3's 3 genuinely
net-new pieces (harness `perceive`, `stop-conditions.ts` file-06 precedence,
`page-representation.ts`) become a lib A2 consumes. Option 2 = move the loop out
to A3's service (bigger reshuffle, retires A2's runtime). **A3 is idle on this
until you pick.** (Full detail: A2↔A3 bus W265/W266.)

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
