# Design system v2 — customer-dashboard reference (2026-07-03)

The customer-dashboard redesign (2026-07-02/03) is the **reference
implementation** of Driftstack design-system v2. This doc is the contract
the other apps (gui-client, marketing-site, admin-panel) port to when they
adopt v2. It supersedes the direction set in
`2026-06-12-design-system-spec.md` for the dashboard surface, keeping that
doc's two-axis architecture but recording the decisions that actually
shipped.

Live source of truth: `apps/customer-dashboard/src/styles/base.css`
(token layer + `@layer components` recipes) and
`apps/customer-dashboard/tailwind.config.mjs` (the `tk-*` Tailwind map +
radii/shadows/keyframes).

## 1. Axes + default (founder-locked 2026-07-02)

Two attributes on `<html>`, persisted pre-paint in localStorage
(`ds_theme_mode` / `ds_theme_accent`); a later account column is additive,
out of scope.

- **Axis A `data-mode`**: `dark` (default) | `light`.
- **Axis B `data-accent`**: `oxblood` (default) | `violet` | `teal`.

**The dashboard default is dark + oxblood** — the founder kept the red
brand identity ("keep our main color/logo (red), and standard is dark
red"), with a prominent light toggle in the themer pill (sidebar foot +
auth header). This intentionally diverges from the 2026-06-12 spec's
light+violet default, matching the shipped GUI default instead.

## 2. Token values

CSS custom properties are set per axis at the bottom of `base.css` and
mapped to Tailwind `tk-*` utilities as `rgb(var(--x-rgb) / <alpha-value>)`
so alpha modifiers (`bg-tk-err/10`) keep working. Values are **synchronized
with marketing-site** — do not drift one without the other (the
`app-styles-*` cross-app parity tests enforce this).

### Accent axis

| accent            | `--accent` | `--accent-2` | `--accent-strong` | `--accent-soft`      | `--glow`             |
| ----------------- | ---------- | ------------ | ----------------- | -------------------- | -------------------- |
| oxblood (default) | `#9b3b46`  | `#c04b58`    | `#722f37`         | rgba(155,59,70,.13)  | rgba(155,59,70,.32)  |
| violet            | `#6d5efc`  | `#8b7dff`    | `#5847e0`         | rgba(109,94,252,.13) | rgba(109,94,252,.32) |
| teal              | `#109a82`  | `#1bc7a8`    | `#0c7d69`         | rgba(16,154,130,.13) | rgba(16,154,130,.28) |

Accent discipline (unchanged founder rule): accent = actions / active /
focus only, never large fills, no gradient-on-text.

### Mode axis

| token       | light     | dark      |
| ----------- | --------- | --------- |
| `--bg`      | `#f2f3f6` | `#060608` |
| `--surface` | `#fff`    | `#0e0e12` |
| `--raised`  | `#fff`    | `#15151b` |
| `--hover`   | `#f1f2f5` | `#22232c` |
| `--ink`     | `#0f1014` | `#f5f5f7` |
| `--ink-2`   | `#474a55` | `#b0b0bb` |
| `--ink-3`   | `#8a8d99` | `#73737f` |
| `--border`  | `#e4e6ec` | `#1e1e26` |
| `--ready`   | `#0c9a5d` | `#2fe39a` |
| `--busy`    | `#c98a12` | `#ffc24d` |
| `--err`     | `#d8453c` | `#ff6b61` |
| `--sync`    | `#2563eb` | `#60a5fa` |
| `--code-bg` | `#16171c` | `#0c0c11` |

**Status tokens are load-bearing.** The redesign's biggest correctness win
was moving every hard-coded status color (emerald / red-50 / blue-50 /
amber / slate literals) onto `tk-ready` / `tk-err` / `tk-busy` / `tk-accent`
/ `tk-hover` so badges and states flip with `data-mode` instead of breaking
in light mode. Any new status UI must use these tokens, never a raw
Tailwind palette shade.

## 3. Fonts

Self-hosted, licensing-clean (both OFL), vendored under
`public/fonts/` with their `OFL.txt`:

- **Geist** (variable, `font-sans`) — `public/fonts/geist/GeistVF.woff2`.
- **JetBrains Mono** (`font-mono` fallback) — Regular + Bold.

Mono stack: `'Berkeley Mono', 'JetBrains Mono', ui-monospace, …` —
Berkeley Mono stays first for locally-licensed users but is **never
vendored** (commercial license); JetBrains Mono is what actually ships.
`font-display: swap`, both preloaded in `<head>`, `/fonts/*` immutable
cache in `public/_headers`.

## 4. Component kit (`base.css` `@layer components`)

Restyled-in-place recipes (same class names, so pages adopt v2 without
markup churn): `.btn-primary` (flat accent, ambient shadow, **no** glow
ring / hover lift — accent discipline), `.btn-secondary` (solid surface +
border, no glass), `.dashboard-card` / `.auth-card` (solid, ambient
shadow, no glass), `.form-input`, `.banner-info` / `.banner-warn`
(tk-busy) / `.banner-err`, `.section-label` (`// LABEL` mono), `.nav-link`,
`.hero-glow` (accent-token radials, reduced-motion clamp).

New additive recipes: `.btn-ghost`, `.btn-danger`, `.panel` /
`.panel-title`, `.stat-card` / `.stat-label` / `.stat-value` / `.stat-sub`,
`.meter` / `.meter-fill`, `.status-dot(--ready|busy|err|idle|live)`,
`.pill`, `.badge-count`, `.table-shell` / `.col-l` / `.col-m` (container
queries), `.data-table`, `.modal-overlay` / `.modal-card`, `.skeleton`,
`.empty-state`, `.mono`, `.themer` / `.themer-btn` / `.themer-swatch`,
plus a global `:focus-visible` accent ring.

Tailwind additions: `borderRadius.card` (14px), `boxShadow.ambient` /
`ambient-lg` (the calm card shadows that replaced glow-on-everything),
keyframes `view-in` (150ms) + `livepulse` (2.4s, killed by the global
`prefers-reduced-motion` clamp).

Radii: 8px controls (`rounded-lg`) / 14px cards (`rounded-card`) / 999
pills. Charts are **dependency-free** — percentage-height `<div>` bars
(Overview 14-day, Usage daily), honest empty states, never a fabricated
line.

## 5. GUI porting map

The GUI (`apps/gui-client`) already has the two-axis architecture but a
**different namespace** and different values. To adopt dashboard v2, port
its CSS-var layer (`src/styles/index.css`) + `tailwind.config.ts` map. The
correspondence:

| concept    | dashboard (`tk-*`)                    | gui (`surface/ink/accent/status`)                         |
| ---------- | ------------------------------------- | --------------------------------------------------------- |
| page bg    | `tk-bg` / `--bg`                      | `surface-base` / `--surface-base-rgb`                     |
| card       | `tk-surface` / `--surface`            | `surface-raised`                                          |
| elevated   | `tk-raised` / `--raised`              | `surface-elevated`                                        |
| inset/code | `tk-code-bg` / `--code-bg`            | `surface-inset`                                           |
| divider    | `tk-border` / `--border`              | `surface-divider`                                         |
| text       | `tk-ink` / `tk-ink-2` / `tk-ink-3`    | `ink-primary` / `ink-secondary` / `ink-muted`             |
| accent     | `tk-accent` (+`-2`/`-strong`/`-soft`) | `accent` (+`-hover`/`-active`/`-subtle`/`-ring`)          |
| status     | `tk-ready` / `tk-busy` / `tk-err`     | `status-ready` / `status-busy` / `status-error` (+`idle`) |

**Two divergences to reconcile at port time (founder call):**

1. **Dark surfaces.** Dashboard/marketing dark = near-black
   (`#060608`/`#0e0e12`); GUI dark = the status-site **slate** scale
   (`#0f172a`/…). Pick one for cross-app parity — the dashboard token
   layer is currently pinned to marketing's near-black.
2. **Oxblood shade.** Dashboard/spec oxblood `#9b3b46`; GUI brightened it
   to `#a83b4d` ("more red, like the status page") on 2026-06-17. Align to
   one hex.

Both are one-commit token edits; neither blocks a GUI port of the recipe
layer. Recipes port cleanly (the GUI's `.btn-*` / `.mono` / `.section-label`
/ container-query table helpers were the source of several dashboard v2
recipes).

## 6. Guardrails when extending

- Content-parity + `dashboard-*` drift guards regex-pin dashboard source;
  any pinned-line change needs the pin updated same-commit, and the full
  `npx vitest run` (root) must pass — the gui-client jsdom project + the
  dashboard page tests (which execute built `dist/`) only run there.
- No hard-coded color literals — use `tk-*` tokens so light mode works.
- Inline `<script>` in `.astro`: plain code only, never the `{`…`}`
  template-literal wrapper (it ships as a dead no-op string; see
  `2026-07-02` five-dead-scripts fix).
- Charts + new features degrade to honest empty states; never fabricate
  data (usage writers are unwired until V-014/V-015).
