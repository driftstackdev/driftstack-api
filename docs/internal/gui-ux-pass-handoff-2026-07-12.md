# GUI UX Pass — Handoff (2026-07-12)

**For the next agent continuing this work.** Read this top-to-bottom before touching code.

## Founder intent

The founder (running A3 autopilot) redirected mid-session: _"continue finding high-impact
GUI improvements and make the user experience more smooth and user friendly"_ → then
**"Do it all, plan it and do it."** This is a phased, best-way (not fast) polish +
smoothness pass on the real GUI client. Binding founder value: **"We don't move fast, we do
everything in the best way"** — never skip validation/box-smoke to move fast; keep the
founder's live browser STABLE above all.

## Where things live

- **GUI client** (the target): `/Users/john/code/driftstack-api/apps/gui-client/` — a
  **Tauri 2 + Vite + React** desktop app (NOT the empty `driftstack/gui` scaffold — that
  misled an early Explore agent; ignore it).
  - The live-session surface is a **separate floating "Simulator" window**:
    `src/views/SimulatorWindow.tsx` (~7400 lines, the monolith) +
    `src/components/AgentSessionPanel.tsx`. This is the founder's most-used surface — weight
    work here.
- **The plan**: `/Users/john/.claude/plans/jolly-gathering-llama.md` (full 3-wave plan; was
  approved via ExitPlanMode).
- **Cross-agent bus**: `/Users/john/code/driftstack/operations/agent-bus/A2-A3-BUS.md`
  (A2 = control-plane/GUI engineer, ACTIVE in this repo) and `A1-A3-BUS.md` (A1 =
  fingerprint/webkit-fork). Post updates there.

## ⚠️ Repo-ownership reality (critical)

`driftstack-api` is **A2's repo and A2 is actively committing to it concurrently.** During
this session A2 committed `8dea02230` (profiles-layout) while A3 worked — clean, no
collision. To avoid entangling A2's WIP:

- **Commit with an explicit pathspec** (`git commit -- <your files>`), never `git add -A`
  / `git add .`. This commits only your files and leaves A2's staged/unstaged WIP intact.
- Before editing a file, `git status` it — if A2 has WIP there (esp. `ProfilesView.tsx`,
  `ProfilePhoneCard.tsx`, `index.css`), **coordinate on the A2-A3 bus first**.
- Commit identity is auto-configured `Driftstack <dev@driftstack.dev>`; **ZERO** AI-tooling
  strings in messages (a commit-msg hook rejects them). **NEVER `git push`.**
- A lint-staged pre-commit hook runs prettier/eslint --fix on staged files (harmless).

## DONE — committed, green, NOT built/installed

Nothing here is built/installed. It all rides the **next founder-coordinated gui-client
Tauri build**; the founder's live browser is UNCHANGED. Verify before claiming otherwise.

### `8ff9c7f01` — Wave 1 friendliness polish

- **Friendly crash + boot screens.** `src/main.tsx` (renderFatalError) + `index.html` early
  guard: human copy + Reload up front, code/message/stack behind a collapsed
  `<details>` "Show technical details" (no raw stack trace to the user). Boot splash:
  `index.html` paints a branded spinner instantly as a **sibling of `#root`** (NOT a child —
  the 30s mount-poll's `#root has children` test must still detect the real React mount;
  the splash is removed on mount or on the fatal panel). `src/App.tsx` settings-load = a
  spinner (`border-surface-divider border-t-ink-primary`) not a bare "Loading…".
- **Killed raw error-code leakage on the LIVE surface.** `src/lib/page-error-copy.ts`:
  the `default` branch no longer echoes the raw harness message (e.g. `-1004`); `http` leads
  with plain copy but keeps the (user-meaningful) status. `AgentSessionPanel.tsx`
  `friendlyConnectError`: unrecognized transport strings → generic friendly line. Raw text
  still flows to the dev logs. **Deliberately left shared `src/lib/api-errors.ts` AS-IS** —
  it feeds the customer-dashboard + admin-panel too (a first pass friendly-izing it broke
  ~18 non-GUI tests and was cross-app scope creep; reverted).
- **Actionable "stuck" badges.** `SimulatorWindow.tsx`: added a shared `manualReconnect`
  `useCallback` (resets the freeze budget + fires a full Room rebuild via `setRecoverAction`
  mode `'rebuild'`). The `control-unreachable-badge` (was an informational dead-end) and the
  `video-frozen-badge` now both carry a working **Reconnect**. The freeze badge shows it as
  soon as `recovering || freezeRecoveryExhausted` (~8s in), not only after the ~48s ladder.
- **Badge-collision fix.** The five top-anchored advisories (notice / navSendFailed /
  controlUnreachable / pageLoadStalled / transport-fallback) now flow through ONE centered
  flex column `data-component="top-advisory-stack"` (`pointer-events-none` container, each
  badge `pointer-events-auto`) — never overlap, handles wrapping. The center freeze/stall
  badges, the full-screen `page-error-overlay`, and the bottom `ai-driving-badge` stay
  separate (different screen regions).
- **Cold tab-switch escape.** `switchTakingLong` state + a 3s timer keyed on
  `switchingTabId`: the black switch-blank cover shows a "Taking longer than usual…" hint +
  a "Show current page" button (`data-component="switch-blank-escape"`) that drops the blank.
  The existing 6s `SWITCH_AFFORDANCE_TIMEOUT_MS` hard-net still backstops. Warm-tabs stays
  A1's structural fix. (Removed `aria-hidden` from the cover since it now has a button.)
- Tests: `tests/unit/page-error-copy.test.ts` (new, raw-leak guard); +2 in
  `simulator-window-frozen.test.tsx` (freeze Reconnect mid-ladder; controlUnreachable
  Reconnect); `agent-session-panel.test.tsx` friendlyConnectError test updated.

### `3bfe04aa9` — Wave 2a

- Documented the **⌘V paste-to-device** shortcut in `src/components/ShortcutsCheatsheet.tsx`
  (it worked but was invisible). +1 assertion in `shortcuts-cheatsheet.test.tsx`.

## VERIFIED — already correct, deliberately NOT changed (don't re-open without a new repro)

- **Return key grey** (`IOSKeyboard.tsx`): grey-on-a-generic-field IS correct iOS. Blue
  needs the box to emit `enterkeyhint` (a cross-lane harness change) — forcing it blue would
  be wrong. Defer until the box sends enterkeyhint.
- **Emoji key** (`IOSKeyboard.tsx:289`): already rendered `disabled`/dimmed with a clear
  rationale (synthetic emoji = fingerprint divergence). Not a dead key. No change.

## HELD — A2 active-lane overlap (coordinate on the bus before doing)

- **Tab-restore count on the profile card** (plan Wave 2 item 7): touches
  `ProfilePhoneCard.tsx` / `ProfilesView.tsx` — A2's active files. A3 posted a heads-up on
  the A2-A3 bus asking if A2 is mid-flight; **wait for A2's reply** or hand these to A2.

## REMAINING — staged, mostly box-smoke- or founder-online-gated

Ordered safest → riskiest. The risky ones need a **box-smoke on a real session in a
founder-online window** before going live (founder's "best way not fast").

1. **Session-end recap** (Wave 2 item 8, SAFE next): replace the bare "Session ended"
   overlay + lone Close (`AgentSessionPanel.tsx:822-867`, `SimulatorWindow.tsx` `w.close()`)
   with a short recap (duration / page-or-tab count / cost-to-date if available). Investigate
   what session metadata is on hand at terminal-end first; it's a delicate path.
2. **Drawer-rail labels** (Wave 2 item 7): the icon-only rail relies on a custom hover
   flyout (Tauri `title=` is unreliable) — `SimulatorWindow.tsx:865-918`. Add clearer/
   persistent affordance.
3. **Inertial scroll momentum** (Wave 2 item 9, RISKY): `FLING_ENABLED=false` today
   (`src/lib/livekit-input-capture.ts:252`, `:608-617`) — drag-scroll stops dead. Re-enable
   with a velocity/duration cap fed through the existing monotonic-ratchet + per-frame-delta
   path so it can't over-run (it was disabled for exactly that). BOX-SMOKE before enabling.
4. **Simulator monolith re-render decomposition** (Wave 3 item 10, MED): the 7400-line
   component holds 40+ `useState` incl. a 1s rec clock (`:2614`), fps (`:2654`), and 1–5s
   poll loops (`:4503`, `:4808`) — every tick re-renders the video host + tab strip. Extract
   the high-frequency state into isolated memoized children. No behavior change; verify with
   the existing tab/frozen/cookies unit tests + a real-session smoke.
5. **Reliable-channel head-of-line blocking** (Wave 3 item 11, RISKY, cross-lane): under
   high RTT/loss the ordered reliable DataChannel blocks past ~64KB buffered → input freezes
   then replays in a flurry; a stranded `touchEnd` freezes the page. Today only reactive
   shedding exists (`livekit-input-capture.ts:380-401, 887-897, 948-959`). Harden: bound/
   timestamp queued reliable input, drop stale `touchStart/Move` on recovery, always
   synthesize a finger-lift. Touches the harness receiver too
   (`driftstack/harness/.../DataChannelInputReceiver.swift`). Founder-online + box-smoke.

## How to verify (run from `apps/gui-client/`)

- Typecheck: `npx tsc --noEmit` (clean as of handoff).
- Unit (jsdom `.test.tsx`): `npx vitest run` — 137 files green as of handoff.
- Pure-function `.test.ts` files (e.g. `page-error-copy.test.ts`) run in the **root node
  project**, NOT the gui-jsdom scope: run from repo root:
  `cd /Users/john/code/driftstack-api && npx vitest run apps/gui-client/tests/unit/<file>.test.ts`.
- The `vitest.config.ts` `include` is `tests/**/*.test.tsx` (the `.tsx` extension is the
  gui-jsdom discriminator). Don't be surprised a `.test.ts` "isn't found" when filtered
  inside the gui-client project — that's expected.

## Autopilot / stability context (A3's standing duties — keep these alive)

- The founder's browser must stay STABLE. Minimal box heartbeat (mb + crashes must stay 0):
  ```
  ssh -i $HOME/.ssh/driftstack_fleet_ed25519 -o ConnectTimeout=15 -o BatchMode=yes administrator@199.7.163.49 \
   'mb=$(pgrep -f MiniBrowser|wc -l|tr -d " "); crashes=$(find "$HOME/Library/Logs/DiagnosticReports" -name "MiniBrowser*.ips" -newermt "2026-07-11 17:05:00" 2>/dev/null|wc -l|tr -d " "); daemon=$(pgrep -f DriftstackHarnessd|wc -l|tr -d " "); echo "mb=$mb crashes=$crashes daemon=$daemon"'
  ```
- **Warm-tabs `-1004`** (founder's #1 tab-switch pain) is **A1's** fork-side fix. A1's
  coordinated full `build-webkit --release` now COMPILES (A1 caught a W3141 error). A full
  fork build is **founder-coordinated only**: mb=0, back up `MiniBrowser.app.pre-w3140-bak`,
  full rebuild (NEVER incremental — a partial relink → DYLD symbol-not-found crash), resign,
  and **VALIDATE a real session spawns clean BEFORE leaving it live**. WARM_TABS stays 0.
- A1-bus monitor (id in the running session) fires on warm-tabs/-1004/repro/coordinated-build
  triggers.

## Recommended next actions for the incoming agent

1. Read the A2-A3 bus for A2's reply on the ProfilesView/ProfilePhoneCard overlap.
2. If the founder is online: offer to **box-smoke** the risky smoothness items (scroll
   momentum, then HOL) together, or proceed with the SAFE **session-end recap** solo.
3. Keep the stability heartbeat + A1 warm-tabs coordination running in parallel.
4. Commit each increment as its own pathspec commit (reviewable waves), post to the A2-A3
   bus, keep `gui-jsdom` green + `tsc` clean.
