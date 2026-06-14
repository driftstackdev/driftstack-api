# GUI rework — "Console" build plan (autonomous)

**Status:** ACTIVE · founder put the GUI rework on autopilot 2026-06-14 ("you choose, do as
recommended, get it all done, plan properly, auto pilot mode"). Aesthetic **LOCKED = Console**
(founder approved `docs/internal/visual-demos/gui-rework-2026-06-14/console.html`: dense / data-rich /
dark-leaning, strictly in the real `apps/gui-client` design tokens). This file is the source of truth
for the build; each fresh autopilot wave picks the next unchecked slice and ships it.

Continuity memory: `project_gui_major_rework_initiative_2026_06_14` (+ this doc).

## Goal

Turn `apps/gui-client` (the Tauri desktop app) into the Console-look product: a beautiful, dense,
data-rich antidetect-browser hub with (1) the headline **AI chat** that drives sessions, (2) the
proxy/profile/folder UX the founder asked for, and (3) the planned-but-missing feature surfaces.
"Wow" comes from restraint — slate surfaces + one accent used sparingly, refined type/spacing — not
gradients.

## Working rules (per slice)

- **One coherent slice per wave**, full pre-push gate GREEN, V-205 attribution, Rule R (<50
  uncommitted). Parity/behavioral tests in the same commit where there's testable logic.
- **GUI visuals can't be self-verified** (no render; screencapture is GPU-blind to the WebView —
  `feedback_screencapture_gpu_blind_use_executescript`). The gate is the **gui-jsdom unit suite**
  (behavior/structure) + the **founder opening a Tauri rebuild**. So: ship correct, reasoned slices
  gate-green; batch a **Tauri rebuild** at each visible milestone for founder review.
- **Load-aware:** the 16GB box spikes; if `uptime` 1-min/5-min load is high (>~20), do read-only /
  doc / local-commit work and defer the gating push to a low-load window.
- **Tokens are real:** two `<html>` axes — `data-mode` (light|dark) × `data-accent`
  (violet #6d5efc default · oxblood #722f37 · teal #109a82). Semantic Tailwind colors resolve to
  CSS vars (`apps/gui-client/src/styles/index.css`). Reserve the accent for primary action / active
  nav / live dot / focus ring. Fonts: Geist Sans (UI) + Berkeley Mono (ids/IPs/metrics).
- **Don't auto-do gated items:** real browser **execution** of agent intents needs Agent-1's
  `RealAgentExecutor` / webkit driver (prod is `driver:mock` + `StubAgentExecutor`) — the AI chat
  ships with REAL Claude planning but SIMULATED actions until that lands; license-activation /
  menu-bar Rust-shell work may be backend/Tauri-gated — surface, don't force.

## Slice plan (ordered)

### P0 — hub quick-wins ✅ DONE

- [x] **S1** proxy latency + "checked <relative>" on profile cards; folders get glyph + per-name
      color dot. `ProfilesView.tsx` + `folder-identity.test.tsx`. Shipped `8e180c24` (gui suite green).

### P1 — Profiles hub → Console

- [ ] **S2** Fix the "Refreshed HH:MM:SS · auto-refresh 5s" overlap (`ProfilesView.tsx:1532`) —
      relocate it to the header, right-aligned (as the demo does), out of the bottom-of-column position.
      Verify via Tauri rebuild.
- [ ] **S3** Proxy health from the hub: a per-card / per-proxy **Test** affordance + auto-probe of
      stale proxies on load + a staleness badge ("checked 2d ago — re-test"). Reuse `lib/proxies.ts`
      (testProxy/probeProxyExit) + `proxy-probe-cache.ts` (already has latency/at/exitIp/exitCountry).
      Add health pill states (healthy / slow / no-proxy / re-test).
- [ ] **S4** Console-density restyle of the hub: stat tiles (count-up + sparkline/health-ring, mono
      numerals), denser card grid, tighter spacing rhythm, hairline dividers — match `console.html`.
- [ ] **MILESTONE → Tauri rebuild #1** (founder sees the new hub).

### P2 — AI chat (headline)

- [x] **S5** SDK types catch-up (`packages/sdk-typescript/src/resources/agent-sessions.ts`) — DONE.
      Added `ConsequentialActionCategory` + `AgentUsage` types, the `confirmation_required`
      `AgentIntentResult` variant (`{kind, intent, category, matchedText}` echoed for approval),
      `usage?` on plan-executed/clarify/refuse, and `message()`'s `approveConsequentialActions` opt →
      mapped to the wire snake_case `approve_consequential_actions`. Re-exported the new types from
      `index.ts`. Mirrors the route shape (`routes/agent-sessions.ts` ~1717-1750, `publicUsage` +
      `results` passthrough). TS-only (no cross-SDK test forces Go/Python equality for this shape —
      Go/Python catch-up is a non-blocking follow-up). Parity test updated + 2 SDK unit tests added.
- [x] **S6** `useAgentChat` hook — DONE (`apps/gui-client/src/lib/use-agent-chat.ts`). Lazy
      session-create on first send (`agentSessions.create({mode:'ai',model?,token_budget?})`),
      `message()` per turn, append-only turn list, derived `pendingConfirmation` (from the last
      plan-executed turn's `confirmation_required` result), `approve()` = re-send the same user message
      with `approveConsequentialActions`, `deny()` = dismiss the gate (no dispatch), `reset()`. Pure
      `extractPendingConfirmation` exported + unit-tested (4 tests: detect / success-only / non-plan /
      first-of-many). Focused gate green (tsc + eslint + prettier + gui-jsdom).
- [ ] **S7** `AgentChatView` (Console look) + `'ai'` Sidebar nav + `App.tsx` route: transcript
      (user/agent bubbles), **plan cards** (intents as a checklist), **confirmation card with working
      Approve/Deny**, per-turn cost/usage badge, token-budget meter, model-picker chip, composer with
      slash-command hints. Honest "actions simulated until live driver" affordance.
- [ ] **S8** (polish) live transcript streaming via the SSE event bus
      (`/v1/agent-sessions/:id/events`) instead of request/response only.
- [ ] **MILESTONE → Tauri rebuild #2** (founder sees the AI chat).

### P3 — planned-but-missing feature surfaces (file 128)

- [ ] **S9** Recipes browser (browse/search/view vendor recipes; file 56/128 §3.2).
- [ ] **S10** Validate view — "Run validation suite" surface (file 78/126/128).
- [ ] **S11** Logs viewer — ring buffer + level filter + sanitized export (file 128 §3.2).
- [ ] **S12** Settings sub-tabs build-out — License / Updates / Telemetry / Archetypes (file 128 §4).
- [ ] **S13** Menu-bar app + "pause new sessions" kill-switch (file 128 §5) — Tauri/Rust shell;
      assess gating before building.

### P4 — cross-cutting polish ("wow")

- [ ] **S14** Roll Console aesthetic across remaining views (Sessions, Recordings, Fleet, Proxies,
      Settings) for visual consistency.
- [ ] **S15** Empty-states with personality, onboarding tour, micro-interactions, transitions,
      keyboard-first affordances.
- [ ] **MILESTONE → Tauri rebuild #3** (full pass) + morning summary.

## Verification ledger

Each slice records here when shipped: slice id · commit · gate result · "needs Tauri rebuild to see".

- S1 · `8e180c24` · gui-jsdom 521 green + full suite green · visible after rebuild #1.
- S5 · `4453de41` · SDK agent-sessions.ts confirmation_required + usage + approveConsequentialActions
  · sdk unit (17) + content-parity (16) + v2-37 green · non-visual (SDK types; unblocks S6/S7).
- S6 · (this commit) · useAgentChat hook + extractPendingConfirmation · gui-jsdom +4 tests · non-visual
  (logic; the chat view S7 consumes it). NOTE: S5+S6 committed local, PUSH PENDING a low-load window —
  the S5 pre-push gate flaked on 1/22781 (toasts concurrency flake under load ~78; local full-suite of
  the same code passed clean). Retry `git push` when load <~15.

## Out of scope / gated (surface, don't flip)

- Real agent **execution** (RealAgentExecutor / webkit driver) — Agent-1.
- License activation server endpoints (file 128 §2/§6) — backend track.
- Deep Tauri/Rust shell changes (menu-bar, hardware fingerprint) — assess per slice.
- The backend audit clean-fixes (#4 whitespace BYOK / #5 429-transient / #6 eventBus index) +
  decisions (#10/#11) remain parked behind the GUI initiative (`project_agent_runloop_adversarial_audit_findings`).
