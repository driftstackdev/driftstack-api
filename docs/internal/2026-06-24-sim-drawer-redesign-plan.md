# Simulator Control-Drawer Redesign — Plan (2026-06-24)

Founder ask: the sim control drawer is "kinda messy" + more is coming (permission knobs, tabs, profile mgmt) → icons + expandable/accordion, clean + scalable. Produced by a 3-approach design judge-panel (wqcnooeza). Task #50.

## ✅ APPROVED — build this (founder, 2026-06-24, after 2 interactive HTML demos)

The judge-panel recommended Approach A, but **the founder picked Approach B (icon rail + single content pane)** + a fancy treatment, then approved the full mock ("it all looks great, approve it all"). **Final design to build:**

- **Shell = Approach B:** a slim left **icon rail** (one glyph per section) + a single **content pane** showing the active section; **status strip pinned on top** (Manual · link · transport · fps · latency · egress · ✕) + **End-session pinned footer**. `activePane` persisted in `localStorage['ds-sim-drawer-pane']`. Drawer ~300px (was 264 — confirm `fitWindow` math; the iPhone view stays pristine/untouched).
- **Every pane is "fancy"** (cards, stat tiles, nice toggles, sparkline on latency) — not just Cookies.
- **🍪 Cookies pane (hero):** per-domain expandable groups (favicon chip + domain + count + chevron), per-cookie flags (🔒 Secure / HttpOnly / SameSite=… / ⏱ expiry / 3rd-party), search, this-page/all-domains scope, a pulsing **● live** indicator, and **realtime ⬇ Export / ⬆ Import** of the jar.
  - **Export = pure A2** (I have the jar via getAgentSessionCookies → `downloadBlob` as cookies.json). Ship now.
  - **Import (set cookies on the live session) = NEW A3 wire** (`setCookies` → box WKHTTPCookieStore.setCookie) — scope + flag A3 (mirrors the upload/download wires). The button ships disabled-with-tooltip until the wire lands.
- **⏺ Recording pane (founder add):** a DEDICATED pane (not a stray indicator dot) with full controls — Start/Stop record (elapsed + frames + size while recording), auto-record + retention toggles, and the saved-recordings list (Export ⬇ / Play ▶ / Delete ×, reusing the #36 recordings store/export). The rail's Recording icon shows a **red pulse when recording** (the glanceable indicator, replacing the old dot).
- **Rail sections:** Session · Controls · Diagnostics · Cookies · Files · Downloads · Recording (+ future: Permissions/Tabs/Profile/Logs slot in as one more rail icon + pane).
- **Perf:** poll cookies/downloads **only when their pane is active** (`activePane==='cookies'` etc.), not whenever the drawer is open.
- Demos: `scratchpad/cookies-demo.html` (approved) + `scratchpad/drawer-full-demo.html` (full, approved).

## Ranking

- **A — Icon Accordion ("expandable after expandable") = 55** ← winner
- C — Hybrid Pinned-Summary + Icon Accordion = 53
- B — Icon Rail + Content Pane (single active section) = 52

## Recommendation

Ship **A (multi-open icon accordion)** as the structure + graft **C's pinned status strip** (cross-cutting vitals always visible) + **End-session pinned footer**. Reject B (departs from the literal "accordion" ask, forces single-visible-section, steals 44px of the 264px width). Net: collapsed = tidy icon list; one glyph per header; multi-open expandable; scales by `append-one-<DrawerSection>` at a fixed 264px width forever.

## Drawer (collapsed default)

```
┌─ control drawer (264px) ─────────────┐
│ ╭ status (pinned, never scrolls) ╮   │
│ │ Manual · eu-1 ✓ · UDP◆  ✕     │   │
│ │ 48fps · 92ms · 🌍 DE→NL        │   │
│ ╰────────────────────────────────╯   │
│ (◉) Session       Manual     ⌄        │
│ (≡) Controls      Browser·Pin ⌄       │
│ (∿) Diagnostics   48fps·92ms ⌄        │
│ (◍) Cookies       · 7        ⌄        │
│ (📎) Files         · 2        ⌄        │
│ (⤓) Downloads     · 1        ⌄        │
│ ───────────────────────────────────  │
│ [  ◼  End session            ]        │ ← pinned, always reachable
└───────────────────────────────────────┘
```

Header row: `[icon w-4][title flex-1][hint text-white/40][chevron 0→180°]`. Expanding a section reveals its existing body verbatim below the header.

## Icons

Stroke-only inline SVG (`viewBox 0 0 24 24`, currentColor, ~13px) — reuses the existing `LabeledControl` glyph idiom, **no lucide/icon-font dependency**. Session=dial, Controls=sliders, Diagnostics=pulse, Cookies=cookie, Files=upload-tray, Downloads=download-tray. Future: Permissions=shield-check, Tabs=stacked-rects, Profile=id-card, Logs=waveform.

## Section model

- **Multi-open** (inspect Cookies + Downloads together) — not single-open.
- **Defaults:** Session OPEN (hero: mode switch + composer); all data/utility sections CLOSED (clean + perf — polls off until opened).
- **Persistence:** `localStorage['ds-sim-drawer-sections']` = `Record<sectionId,boolean>` merged over DEFAULTS (mirrors `ds-sim-browser-mode`); NOT cleared by the in-place relaunch reset (it's a preference).
- **End-session:** pinned footer (not a section), `shrink-0` outside the scroll, red styling + `sessionId`/`controlBusy` gates unchanged — destructive action always one click away.
- **Glanceable:** the pinned strip (mode·link·transport·fps·latency·egress) + per-header hints (counts/health), both from live render state.

## Reusable primitive

`<DrawerSection id icon title hint open onToggle>{body}</DrawerSection>` — a button header (aria-expanded/aria-controls, focus ring) + a conditional `role=region` body. A `DATA_COMPONENT: Record<SectionId,string>` map preserves today's EXACT `data-component` names (`simulator-cookies/files/downloads`, `drawer-session/controls/diagnostics`) so test selectors stay green. Each existing `<section>` keeps its body verbatim — only its title header is replaced by the DrawerSection header. A future section = +1 SectionId, +1 DEFAULTS, +1 icon, wrap the body; it auto-inherits chevron/aria/persistence/expanded-only-poll.

## Perf — expanded-only polling

Today the cookies (line ~1647) + downloads (line ~1744) polls fire every 3s whenever the drawer is open (wasted — both return "pending" until the box serves them). Tighten the gate from `toolbarExpanded` → the section's own `cookiesOpen`/`downloadsOpen` derived boolean (in the guard AND the dep array — depend on the boolean, not the whole openSections object). React's existing effect-cleanup tears down the interval on collapse; re-expand re-fires `tick()` + re-arms. Net: idle drawer = ZERO cookie/download requests until that section is opened.

## Implementation slices (each compiles + ships independently, gate-safe; only SimulatorWindow.tsx)

1. Primitive + `openSections` hook + localStorage (dead code, no render change).
2. Wrap ONE low-stakes section (Diagnostics) — validate pattern e2e.
3. Wrap Cookies + Downloads AND flip their poll guards to `cookiesOpen`/`downloadsOpen` (isolate the perf change for bisect; verify polls fire only when expanded).
4. Wrap Controls + Files.
5. Wrap Session last (the hero — once the primitive is proven).
6. Pinned status strip + relocate ✕ + pin End-session footer (restructure `<aside>` to `overflow-hidden flex flex-col`: strip `shrink-0` / accordion `flex-1 overflow-y-auto` / footer `shrink-0`). `DRAWER_W` stays 264 → `fitWindow` math untouched.
7. Test migration (grep ALL gui test dirs; preserve `data-component`; a focused test per slice).

Each slice independently revertable; push during a founder-idle window; rebuild+install the .app (built ≠ delivered).

## Risks + mitigations

Test/selector breakage (preserve data-component + grep tests), ✕-relocation (keep a ✕ in the strip + the toolbar chevron), collapsed-by-default hides first-run data (intended; flip cookies:true if preferred), effect-dep correctness (depend on derived booleans), stale strip counts (label "as of last view" OR add a slow 15s counts-poll), window reflow (DRAWER_W unchanged; only the accordion scrolls), do NOT touch the streamed AgentSessionPanel (GUI chrome only), motion-safe gating.

## ⛔ Open questions for the founder (decide before implementing)

1. **Single-open vs multi-open?** (rec: multi-open)
2. **Default-open set?** (rec: Session only; optionally also Diagnostics or Cookies)
3. **Hand-rolled stroke-SVG icons, no icon-font dep?** (rec: yes)
4. **Status-strip counts:** "last-viewed" (zero extra polling) or always-live via a slow 15s counts-poll + a "new download" dot? (rec: last-viewed; upgrade later if wanted)
5. **Keep a drawer-close ✕ in the new status strip** (alongside the toolbar chevron)? (rec: yes)
