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

- [x] **S2** Fixed the "Refreshed … · auto-refresh 5s" overlap — relocated the timestamp from a
      floating bottom `<p>` (was after the content column, overlap-prone) into the hub `<header>` title
      column as a subtle `text-2xs` line, and removed the floating element. Structurally can't overlap
      now. tsc/eslint/prettier + gui-jsdom 525 + ProfilesView parity (18) green. Verify visual at rebuild.
- [x] **S3** Proxy "Test" from the hub — DONE (the founder's "not a proxy check" core ask). Each
      profile card's proxy strip gets a **Test** button (`handleTestProxy`) that runs the native SOCKS5
      capability probe (`testProxy`) + the exit-geo probe (`probeProxyExit`) and persists both to the
      shared probe cache (`saveProbeResult`/`saveExitResult`) → the card immediately shows exit IP /
      country / latency / last-checked / UDP. Mirrors the canonical `ProxiesView.handleTest`; best-effort
      (keeps prior state on failure); `testingProxyId` drives the "Testing…" disabled state. Optional
      follow-ups deferred: auto-probe-stale-on-load + explicit health pills (healthy/slow/re-test) —
      fold into S4. tsc/eslint/prettier + gui-jsdom 525 + ProfilesView parity 18 green.
- [x] **S4** Console-density restyle of the hub — **DONE** (the real visual overhaul, after founder
      "the demo looked far better"). Ported console.html into ProfilesView (+719/-318): **HERO** (greeting
  - health line + New-profile/Quick-session + Refreshed live pill), **STAT TILES** (count-up numerals +
    sub-line + a Sparkline on Live-now + an SVG HealthRing on Proxy-health), **FOLDER SHELF** (horizontal
    emoji-icon pills, replacing the text nav), and the centerpiece **PROFILE CARDS** (device-frame
    thumbnail with a per-card stylized `MiniPage` mini-page + LIVE glow/chip + hover quick-actions + the
    polished meta: name/device chip/proxy row w/ flag+IP+latency-meter+health-pill — all from the real
    probeCache, S1/S3 Test preserved). Logic 100% preserved. All semantic tokens (light+dark). tsc/eslint/
    prettier + gui-jsdom 525 + ProfilesView parity 18 green (folder-identity glyph test updated to the
    demo emoji). Built by restyle workflow wbhydq6uk + verified.
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
- [x] **S7** `AgentChatView` (Console look) + `'ai'` Sidebar nav ("Automate" section) + `App.tsx`
      route + ⌘K palette entry — DONE (`apps/gui-client/src/views/AgentChatView.tsx`). Transcript
      (user bubbles / agent plan-cards rendering results as ✓/✗/⏸ steps; clarify/refuse/logged-manual),
      inline **Approve/Deny** confirmation gate (status-busy banner), per-turn **usage badge**
      ($/tok/model), **token-budget meter**, model picker (locked once a chat starts), composer
      (Enter-to-send), example-prompt empty state, and an honest "actions simulated until the live
      driver is enabled" banner. tsc + eslint + prettier clean; gui-jsdom 525 green.
- [ ] **S8** (polish) live transcript streaming via the SSE event bus
      (`/v1/agent-sessions/:id/events`) instead of request/response only.
- [x] **S16** ⭐ AI-chat **profile selection** — DONE (founder ask: "where the AI must work on").
      AgentChatView header now has a Profile picker ("No profile (stateless)" + each owned profile,
      loaded via `client.profiles.iterate({limit:100})`), threaded through `useAgentChat({profileId})` →
      `agentSessions.create({ mode:'ai', model, profile_id })`; locked once a chat starts (like the
      model picker). tsc/eslint/prettier + gui-jsdom 525 green. DEFERRED (own slice, S17): the AI/Pair/
      Manual **mode** chip — Pair needs the takeover state-machine + a live driver, so Manual/Pair aren't
      fully meaningful in the GUI until Agent-1's driver lands; surface, don't force.
- [ ] **MILESTONE → Tauri rebuild #2** (founder sees the AI chat).

### P3 — planned-but-missing feature surfaces (file 128)

- [x] **S9** Recipes browser — DONE (`RecipesView.tsx`, built by the P3 workflow). Master-detail over
      `client.recipes.list()`/`get(id)`: searchable list + detail panel with the replayable intent_log
      (type-safe AgentIntent summaries). Read-only. Wired (nav/route/⌘K). gate-green.
- [~] **S10** Validate view — **GATED** (correctly not built). No cloud data source: no SDK validation
  resource, no `/validate` route, no Tauri local-harness command (the file-128 validation suite is a
  self-hosted-daemon feature; the file-07 harness↔Tauri IPC channel isn't built). Un-gate needs
  EITHER a server `POST /v1/sessions/:id/validate` + SDK wrapper returning a structured pass/fail
  report, OR the file-07 IPC + a Tauri `run_validation` command. SURFACED, not faked.
- [x] **S11** Logs viewer — DONE (`LogsView.tsx`, built by the P3 workflow). Over `lib/log-buffer`
      (getLogEntries/subscribeLogs/clearLogEntries/formatLogEntries): scrollable entries (ts + level
      pill + msg), level filter (All/Info/Warn/Error — log+debug grouped under Info so nothing is
      hidden), search, Clear, Copy-export. Wired (nav/route/⌘K). gate-green.
- [ ] **S12** Settings sub-tabs build-out — License / Updates / Telemetry / Archetypes (file 128 §4).
- [ ] **S13** Menu-bar app + "pause new sessions" kill-switch (file 128 §5) — Tauri/Rust shell;
      assess gating before building.

### P4 — cross-cutting polish ("wow")

- [x] **S14** Roll Console aesthetic across remaining views (Sessions, Recordings, Fleet, Proxies,
      Settings) for visual consistency. ✅ DONE (workflow wksmejxyz).
- [ ] **S15** Empty-states with personality, onboarding tour, micro-interactions, transitions,
      keyboard-first affordances.
- [ ] **MILESTONE → Tauri rebuild #3** (full pass) + morning summary.

## Verification ledger

Each slice records here when shipped: slice id · commit · gate result · "needs Tauri rebuild to see".

- S1 · `8e180c24` · gui-jsdom 521 green + full suite green · visible after rebuild #1.
- S5 · `4453de41` · SDK agent-sessions.ts confirmation_required + usage + approveConsequentialActions
  · sdk unit (17) + content-parity (16) + v2-37 green · non-visual (SDK types; unblocks S6/S7).
- S6 · `c24b72ba` · useAgentChat hook + extractPendingConfirmation · gui-jsdom +4 tests · non-visual.
- S7 · `d6c30ab3` · AgentChatView + 'ai' nav/route/palette · gui-jsdom 525 green · VISIBLE after Tauri
  rebuild #2.
- (parity) · `c0a55b5f` · fixed 3 content-parity pins my S5/S7 changes broke (byok message-sig +
  App/Sidebar union variants) — these had failed the pre-push gate (NOT a flake; I'd mis-diagnosed it).
- ✅ S5+S6+S7+parity ALL PUSHED + full-suite-verified (origin `c0a55b5f`, 22727 passed/0 failed). The
  whole AI chat is on origin; needs Tauri rebuild #2 to be visible.
- S2 · `af21978c` · refresh-text overlap fix (relocate to header) · gui-jsdom 525 + ProfilesView
  parity (18) green · shipped in rebuild #2.
- ✅ Tauri rebuild #2 INSTALLED 2026-06-14 (origin af21978c): vite+Rust build → /Applications/Driftstack.app
  - codesign --force --deep -s - + verified valid; backup at .prev. AI chat + S1+S2 now LIVE in the app.
- S3 · `07513339` · per-card proxy "Test" affordance (testProxy+probeProxyExit→cache) · VISIBLE after #3.
- S4 · `2ba3f668` · console-density stat tiles (HubStat mono tabular-nums + section-label) · S4 partial.
- S9+S11+wiring · (this commit) · RecipesView + LogsView (P3 workflow wli6j2jl0) wired into
  App/Sidebar/⌘K + App parity (13-variant) + Sidebar parity (11-variant) updated in-commit + S3
  concurrent-test race fix (disable all Test buttons while one runs) · tsc/eslint/prettier + gui-jsdom
  525 + App/Sidebar parity 19 green · S10 Validate GATED (no cloud source) · VISIBLE after rebuild #3.
- S4(full)+S16 · `feb57188` · full Console restyle of the ProfilesView hub (HERO/stat-tiles/sparkline/
  HealthRing/folder-pills/device-frame MiniPage cards/proxy-row/per-card Test) + AI-chat profile picker
  · gui-jsdom + folder-identity green · VISIBLE after rebuild #4 (INSTALLED 2026-06-14).
- S14 · `97972adf` · Console restyle of Proxies/Sessions/Recordings/Settings (workflow wksmejxyz,
  +1082/-590, logic preserved) + 5 test files re-pinned to new copy/source (proxies-view-test-button
  behavioral + 4 view content-parity) · tsc OK + gui-jsdom 526 (67 files) + 4 view content-parity 43
  green · VISIBLE after rebuild #5. + greatness backlog saved (2026-06-14-gui-greatness-backlog.md).

### P5 — greatness backlog (Tier-1 quick-wins; see 2026-06-14-gui-greatness-backlog.md)

- QW1 Save-as-recipe · `7cccb488` · AgentChatView "Save as recipe" button + dialog →
  `client.recipes.create({agent_session_id,label,description?})` (the SDK call had ZERO GUI callers);
  success toast; enabled only once a turn actually plan-executed · new agent-chat-save-recipe.test.tsx
  (3 tests) · tsc/eslint/prettier OK + gui-jsdom 529 (68 files) green · VISIBLE after rebuild #5.
- QW2 Richer toasts · `172e67eb` · add `success`/`error` tones to lib/toasts (per-tone border +
  leading status dot + assertive `alert` role for warn/error); Save-as-recipe toast now `success` ·
  +2 toasts.test.tsx tone tests · tsc/eslint/prettier OK + gui-jsdom 531 green · VISIBLE after #5.
- QW3 Theme/accent switcher · (this commit) · new ThemeSwitcher in the TitleBar — 3 accent swatches
  (violet/oxblood/teal) + a light/dark toggle over settings.themeMode/themeAccent (was buried in
  Settings) + global ⌘⇧D mode toggle · new theme-switcher.test.tsx (5 tests) · tsc/eslint/prettier OK
  - App content-parity 12 + gui-jsdom 536 green · VISIBLE after rebuild #5.

- FIX2 AI-chat approve double-bubble · (this commit) · **real UX bug found via fresh-eyes audit** —
  `useAgentChat.approve()` re-sent `lastUserMessage` through `post()`, which unconditionally appended a
  user bubble → clicking Approve echoed the user's original message as a fresh request (misleading; the
  user clicked a button). Fix: `post` takes `{appendUserTurn?}`; approve passes `false` so the approval
  re-send continues the SAME logical turn (halt turn + approved-execution turn, no duplicate). approval
  echo + gate-clear unchanged. new use-agent-chat-approve.test.tsx (2 tests, proven to fail without the
  fix) · gui-jsdom 541 green.
- FIX1 LogsView live-update · `89e1d421` · **real bug found via fresh-eyes audit** — `getLogEntries()`
  returns the LIVE buffer array (stable ref, mutated in place), so LogsView's `filtered`/`errorCount`
  `useMemo`s (keyed only on `entries`) never recomputed on new log lines despite the `subscribeLogs`
  forceRender → list went stale while the header count ticked up. Fix: feed the `forceRender` version
  counter into both memo deps. (DevLogPanel was unaffected — it filters inline.) new
  logs-view-live-update.test.tsx (3 tests, proven to fail without the fix) · gui-jsdom 539 green.

NOTE (ops): the husky **pre-push** hook runs the FULL gate (typecheck+lint+format:check+npm test)
against the **WORKING TREE**, not just the pushed commits. Editing files while a background `git push`
is in flight races the hook (QW1's background push failed on a half-edited toasts.tsx). Push in the
FOREGROUND with a clean tree, or don't edit until the background push reports done.

## Out of scope / gated (surface, don't flip)

- Real agent **execution** (RealAgentExecutor / webkit driver) — Agent-1.
- License activation server endpoints (file 128 §2/§6) — backend track.
- Deep Tauri/Rust shell changes (menu-bar, hardware fingerprint) — assess per slice.
- The backend audit clean-fixes (#4 whitespace BYOK / #5 429-transient / #6 eventBus index) +
  decisions (#10/#11) remain parked behind the GUI initiative (`project_agent_runloop_adversarial_audit_findings`).
