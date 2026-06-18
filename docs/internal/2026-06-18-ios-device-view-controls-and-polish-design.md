# iOS device view — control toggles + visual polish + touch cursor (design)

**2026-06-18. Founder ask:** the windowless iOS-Simulator session view (`SimulatorWindow.tsx`) should gain
(1) **expandable toggles for control**, (2) be **"all better looking"** (the toolbar reads "kinda dark"), and
(3) a **touch-point cursor** — when the pointer is over the device screen, show a fingertip, not the PC arrow.

Produced from two multi-perspective design workflows (3 independent designs each, scored + synthesized) plus a
focused touch-cursor design. This is a PLAN — build on founder greenlight. No sizing-math (`TOOLBAR_H`/`BEZEL_PAD`/
`STATUS_STRIP_H`) changes; the expandable panel stays an absolute dropdown.

---

## Part 1 — Expandable control toggles

**Recommended (base = "Minimal Purist", grafting the contextual state-model + a panel-only composer):**
the static `◉ Full control · tap to interact` line is replaced by a real, iOS-style **segmented Mode control** as
the hero of the existing expandable panel. Everything else stays restrained so the default is still "just an iPhone".

```
COLLAPSED (default — phone only):
  ● ●            ◌ Drift · iPhone 17        ● ⌄      ← 34px toolbar (unchanged)
  [ iPhone bezel · status strip · live screen ]

EXPANDED (chevron) — absolute dropdown, w-56, over the screen:
  ┌──────────────────────────────────────┐
  │  Mode                                 │
  │  [ Agent ][ Pair ][ Manual ]          │  ← hero: 3-way iOS segmented, accent on active
  │  ● Agent is driving — watching live   │  ← mode-aware caption (pulse dot when agent acting)
  │  ⤿ Take control                       │  ← contextual: ONLY in Pair (flips ⤺ Hand back)
  │  ┌────────────────────────────────┐   │
  │  │ Tell the agent…            ➤   │   │  ← composer: ONLY in Agent/Pair, panel-only
  │  └────────────────────────────────┘   │
  │  ──────────────────────────────────   │
  │  ⤓ Save snapshot                      │  ← existing window chrome (unchanged)
  │  ↻ Rotate to landscape                │
  │  📌 Pin on top                         │
  │  ⓘ Session info                       │
  └──────────────────────────────────────┘
```

- **Mode** → `POST /v1/agent-sessions/:id/mode {mode}` where mode ∈ `ai|manual|pair`. Optimistic local set,
  revert + status-pill toast on 409 (session not active) / 403 (scope).
- **Take control / Hand back** → `POST .../takeover {client_id}` / `POST .../handback`. Shown **only in Pair**;
  label derived from one source of truth: `driver = derive(mode, pair_mode_state.kind)` (human-driving → "Hand back",
  else → "Take control"). `client_id` is a stable per-window `useRef(crypto.randomUUID())`.
- **Tell the agent** (composer) → `POST .../message`. Shown **only in Agent/Pair**, lives **strictly inside the panel**
  (never on the device screen — a text field over the screen would collide with the input-capture keyboard and break
  the illusion). Send-and-go on Enter/➤ only (no send-on-blur).
- **Pause / Record** stay (Record already a toolbar button; Pause stops the capture/latency interval).
- The mode-aware **caption** always states what a tap means _right now_ (honest about who's driving).

**Wiring (important):** `SimulatorWindow` is mounted under `RecordingsProvider` only — it has **no SDK client and no
`SettingsProvider`**. So control calls go through a new thin raw-fetch `lib/agent-session-control.ts` (modeled on
`lib/gui-input.ts`), reading `{apiKey, baseUrl}` via the already-exported standalone `loadSettings()` once on mount
(same Tauri store + Keychain the main window uses). **Do NOT** thread the apiKey through the window URL (leak risk) or
wrap in `SettingsProvider` (extra `client.account.me()` on open). Re-fetch mode/pair_mode_state cheaply on each
panel-expand (no idle polling).

**Files:** new `lib/agent-session-control.ts` (+ `AgentSessionControlError` mapping 403→scope / 409→state / 404→no-pair-lock);
`SimulatorWindow.tsx` (mount-load settings; `mode`/`pairKind`/`pendingControl`/`composerText` state + handlers;
new local `<SessionControlSection>` replacing the static block; extend `DeviceToolbar` props). No server changes
(endpoints exist). No sizing-math change.

---

## Part 2 — "All better looking" (visual polish)

**Recommended: Direction B — Refined Driftstack Premium (rich dark), grafting two moves from the Apple-authentic
direction.** Root cause of the founder's "kinda dark" = **flatness** (single near-black fills, flat slabs), not that
it should go light. Fix = layered translucent material + light/highlights + a faint accent, staying dark.

Key concrete changes (Tailwind/CSS; all specular alphas ≤0.10, accent halo ≤22% — tasteful, not gaudy):

- **Toolbar** (the "too dark" slab): `bg-[#161618] ring-white/10` → `backdrop-blur-xl [background-color:rgba(22,24,30,0.72)]`
  - a top sheen (`inset 0 1px 0 rgba(255,255,255,0.10)`) + grounded bottom (`inset 0 -1px 0 rgba(0,0,0,0.4)`). Frosted, lit, premium.
- **Identity text**: washed `text-ink-secondary` → `text-white/85` (profile) / `text-white/45` (·device), 12px semibold tracking-tight.
- **DriftMark**: faint accent halo `drop-shadow-[0_0_4px_color-mix(in_srgb,var(--accent)_55%,transparent)]`.
- **Traffic lights**: glossy bead `shadow-[inset_0_0.5px_0_rgba(255,255,255,0.4)]`; reveal close/min glyphs on group-hover (Apple behavior).
- **Bezel** (flat → machined metal): `bg-[#0b0b0d]` → `bg-gradient-to-b from-[#1b1c20] via-[#0d0e11] to-[#08090b]` + `ring-white/12`.
- **Screen**: `ring-1 ring-black/80` so the OLED sits in a true-black moat inside the metal (real-iPhone detail).
- **Dynamic Island** (graft from A — seamless true-black): `bg-[#060607] ring-white/10` → `bg-black`, drop the ring,
  add faint inner gloss `inset 0 1px 1px rgba(255,255,255,0.04)`.
- **Expandable panel**: unify as the same frosted glass (`backdrop-blur-2xl` translucent dark + two-stop shadow);
  rows get macOS inset hover `mx-1 rounded-md hover:bg-white/[0.07]` (graft from A).
- **Optional**: expose chrome colors as `--sim-*` CSS vars (set to B's dark values now) so a future light-desktop
  variant is cheap. **Do NOT** take A's BEZEL_PAD/window-padding changes — they touch sizing math for marginal gain.
- **Shared:** apply the bezel-gradient + island + screen-moat to the in-dashboard embed (AgentSessionPanel) for consistency.

---

## Part 3 — Touch-point cursor (fingertip over the screen)

When the pointer is over the device **screen** (the `data-tauri-drag-region="false"` area), hide the PC arrow and show
a fingertip touch-point that confirms taps — reinforcing "this is a touchscreen".

- **Screen only**: `cursor: none` on the screen element. Toolbar + bezel keep the normal arrow (you need it for the
  window buttons + dragging).
- **Follower dot**: an absolutely-positioned `pointer-events-none` element — a ~40px translucent circle + thin ring —
  that tracks the pointer (translate to x/y); show on pointer-enter, hide on pointer-leave / window blur.
- **Press feedback**: on press, a quick **tap ripple** (dot shrinks, a ring pulses outward) so a tap _visibly lands_ —
  mirrors the `touchStart` the input-capture already injects; trails on drag; eases back on release.
- **Rides the existing pointer events** in `useInputCapture` (no new input path).
- **Mode-aware**: show the fingertip in **Manual/Pair** (you're driving); in **Agent** mode hide it or show a subtle
  "watching" state (a stray tap there likely means "take over").
- Works in both the floating window and the in-app embed.

---

## Build phasing (each its own gated slice)

1. **Visual polish** (Part 2) — lowest risk, pure CSS, immediate "better looking" win; verify via the Playwright visual harness.
2. **Touch cursor** (Part 3) — small, self-contained, high-delight.
3. **Control toggles** (Part 1) — the transport + mode segmented control first, then takeover/handback, then composer.

## Test plan (Part 1, vitest jsdom + content-parity)

segmented renders active mode / tap calls setSessionMode + optimistic flip / 409 reverts + status pill / takeover-handback
row absent in ai|manual present in pair / takeover uses stable clientId / composer hidden in manual present in ai|pair, Enter+➤
send / empty apiKey → disabled + auth hint / Pause clears interval / **regression: TOOLBAR_H stays 34 + panel stays
absolute** / drag coherence (composer under drag-region=false) / transport maps 403→scope 409→state 404→no-pair / content-parity
pin of the panel's visible strings.

## Founder decisions (taste calls)

- **Mode labels/order**: `Agent | Pair | Manual` (Pair as the midpoint)? Or `AI | …`? Confirm wording.
- **In Agent mode**, hide the takeover button (switch via segmented — recommended) or offer a one-tap "take over"?
- **Composer**: send-and-go on Enter only (recommended), no confirm dialog? (message can burn BYOK/LLM cost.)
- **Collapsed state**: strictly phone-only (recommended, per the 2026-06-17 note) or a tiny mode badge on the toolbar?
- **Visual**: confirm Direction B (rich dark) is the right read of "kinda dark" (vs going light). Live clock vs static 9:41.
- **Touch cursor**: fingertip-dot style — plain translucent dot, or a faint ring + dot? Mode-aware hide in Agent mode?
