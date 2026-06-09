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

## ⭐ 1b. iPhone-touch input ("real tap not macbook mouse") — LIVE end-to-end, one gated piece left

Your "real iPhone tap not the macbook mouse cursor" directive is **delivered on
the contract + harness + docs side**, cross-agent in lockstep:

- **A2 shipped:** the touch vocab in the `InputEvent` contract (api-types SSoT +
  gui-client + sdk-typescript copies + openapi), the input-event route is
  touch-ready, and the live-video guide documents it (W3C input model).
- **A3 shipped:** the harness decodes the touch vocab → **genuine WebKit
  `pointerType:touch`** (no CGEvent-mouse fallback → no fingerprint tell), and
  the manual **keyboard** now routes through W3C key actions too (the parallel
  W198 hazard, also closed). CGEvent is only a legacy fallback.
- **No iOS-Simulator needed for v1.0** — the fork already does genuine WebKit
  touch (A3's runtime read; A1 confirms if/when relevant).

**The one remaining piece (A2, gated):** wire the **customer-dashboard**
LiveKit-video subscription (currently a placeholder) + switch its manual overlay
to emit touch + project stream-px→device-CSS. It's **gated on end-to-end
verifiability** — needs a live publishing session + A3's drive-bridge
`ManualTouchInjecting` up (touch events are safely dropped harness-side until
then). Not shipped blind (the dashboard is is:inline → hard to unit-test). The
gui-client capture path already emits `tap_at` (touch), so that path is done.
Design/status: `docs/internal/2026-06-08-iphone-touch-input-pipeline.md`.
**Nothing needs you here** unless you want the dashboard live-stream view
prioritized — say so + I'll build it for you to verify on a live session.

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

_Autopilot status: iPhone-touch contract shipped end-to-end (A2+A3 lockstep);
cross-SDK retry-safety docs done; a recurring gui-jsdom push-gate flake fixed.
Audited-clean (sound, don't re-audit): GUI live-flow (4 bugs fixed earlier), Go
SDK core, webhook-signature verification, the agent ACT layer (executor +
intent-dispatch), the webhook-delivery worker, account-lifecycle, and the
server/SDK/crypto surfaces. Safe non-gated ship-work is largely exhausted — the
high-value remainder is the gated/eyes-on items above; fresh-audit waves continue
(clean results = soundness confidence), and the dashboard LiveKit slice ships the
moment a live session is reachable. Churn is not manufactured._
