# Driftstack design system — LOCKED spec (2026-06-12)

The founder's picks, codified as the implementation contract for porting the
visual rework into the real apps. Source demos: `docs/internal/visual-demos/`
(direction D `marketing-d-fleet.html` + the re-skinned surface demos).

**Founder decisions this encodes (2026-06-12):**

- Layout/feel: **Direction D "Fleet Mission Control"** — "white and purple,
  very clean and professional" ("This is class").
- Default theme: **light mode + violet accent** (dark + oxblood/teal remain
  selectable; the old oxblood-on-dark becomes a non-default theme).
- Brand: **L2 + W2** — Drift Layers _filled-front_ mark + **DRIFTSTACK**
  black-italic two-tone wordmark ("more bold").
- Full implementation greenlit: "approved to implement and work on everything,
  take best decisions yourself."

---

## 1. Brand

**Lockup** (mark + wordmark; canonical SVG/markup, theme-aware):

```html
<svg width="20" height="20" viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <rect
    x="9"
    y="6"
    width="22"
    height="36"
    rx="6"
    stroke="var(--ink-2)"
    stroke-width="2.6"
    opacity=".55"
    transform="rotate(-7 20 24)"
  />
  <rect x="16" y="6" width="22" height="36" rx="6" fill="var(--accent)" />
  <circle cx="27" cy="36" r="2.2" fill="#fff" />
</svg>
<span style="font-weight:900;font-style:italic;letter-spacing:-.5px">
  DRIFT<span style="color:var(--accent)">STACK</span></span
>
```

Rules: mark scales 16–24px in navs, larger standalone; the filled layer is
always `--accent`; the back layer always `--ink-2` @ 55%; wordmark is ALWAYS
900-weight italic caps with the two-tone split exactly at DRIFT|STACK.
App icon = the mark white-on-accent-gradient squircle (logo page L6 shows it).

## 2. Token layer (two axes)

Axis A `data-mode`: `light` (default) | `dark`. Axis B `data-accent`:
`violet` (default) | `oxblood` | `teal`. Set on `<html>`; persisted in
localStorage (+ later an account column — additive migration, not now).

```css
[data-accent='violet'] {
  --accent: #6d5efc;
  --accent-2: #8b7dff;
  --accent-strong: #5847e0;
  --accent-ink: #fff;
  --accent-soft: rgba(109, 94, 252, 0.13);
  --glow: rgba(109, 94, 252, 0.32);
}
[data-accent='oxblood'] {
  --accent: #9b3b46;
  --accent-2: #c04b58;
  --accent-strong: #722f37;
  --accent-ink: #fff;
  --accent-soft: rgba(155, 59, 70, 0.13);
  --glow: rgba(155, 59, 70, 0.32);
}
[data-accent='teal'] {
  --accent: #109a82;
  --accent-2: #1bc7a8;
  --accent-strong: #0c7d69;
  --accent-ink: #fff;
  --accent-soft: rgba(16, 154, 130, 0.13);
  --glow: rgba(16, 154, 130, 0.28);
}
[data-mode='light'] {
  --bg: #f2f3f6;
  --surface: #fff;
  --raised: #fff;
  --hover: #f1f2f5;
  --ink: #0f1014;
  --ink-2: #474a55;
  --ink-3: #8a8d99;
  --border: #e4e6ec;
  --ready: #0c9a5d;
  --busy: #c98a12;
  --err: #d8453c;
  --sync: #2563eb;
  --code-bg: #16171c;
}
[data-mode='dark'] {
  --bg: #060608;
  --surface: #0e0e12;
  --raised: #15151b;
  --hover: #22232c;
  --ink: #f5f5f7;
  --ink-2: #b0b0bb;
  --ink-3: #73737f;
  --border: #1e1e26;
  --ready: #2fe39a;
  --busy: #ffc24d;
  --err: #ff6b61;
  --sync: #60a5fa;
  --code-bg: #0c0c11;
}
```

Tailwind maps the EXISTING semantic names onto vars so current class usage
keeps working (`surface-base` etc. flip with the axes instead of being baked):

```js
colors: {
  surface: { base:'var(--bg)', raised:'var(--surface)', elevated:'var(--raised)',
             inset:'var(--code-bg)', divider:'var(--border)' },
  ink: { primary:'var(--ink)', secondary:'var(--ink-2)', muted:'var(--ink-3)' },
  accent: { DEFAULT:'var(--accent)', strong:'var(--accent-strong)',
            soft:'var(--accent-soft)', ink:'var(--accent-ink)' },
  // legacy aliases during migration: glow.red -> var(--accent-2), oxblood.700 -> var(--accent-strong)
}
```

Accent discipline (unchanged founder rules): accent = actions/active/focus
only, never large fills; no gradient-on-text.

## 3. Type & texture (the Fleet DNA)

- Sans: system stack (marketing currently ships Geist — keep) — headings
  650–900 weight, tight letter-spacing (−1 to −2.6px at display sizes).
- Mono (Berkeley Mono fallback chain) for: section labels
  (`// LABEL` — 10–11.5px, 1.4–2px tracking, uppercase, accent-colored `//`),
  telemetry strips (`99.98% · 74ms · 0 lies`), pricing tier names, nav links
  on marketing (`/pricing`), code.
- Live-status dots breathe (2.4s `livepulse` box-shadow keyframe;
  `prefers-reduced-motion: reduce` → none).
- Light mode: scanlines OFF or ≤0.015 alpha; hero glow = `--glow` radial.
- Radius: 8px controls / 12–16px cards / 999 pills. Shadows: soft ambient,
  `0 0 0 1px var(--accent) + 0 0 26px var(--glow)` only for "hot" elements.

## 4. Component inventory (all exist in the demos — port as-is)

btn(primary/ghost) · card · status-pill(+dot) · tag-chip · folder-row ·
telemetry-foot · fleet-wall(+mini-phone) · coherence-ring · stat-card ·
ticker · console-row(text+viz) · pricing-tier-row/card · privacy-vault ·
identity-preview-rail · themer(mode/accent switcher).

## 5. Migration plan (per app, smallest-blast-radius first)

1. **marketing-site** — add the token layer (global CSS + tailwind map above);
   rebuild `index.astro` to the Fleet design (demo = blueprint; real copy is
   ALREADY the source of the demo's copy, so this is layout/styling). Other
   pages inherit tokens first (acceptable interim), re-skin after. ⚠️ grep
   `*-doc-parity` + content-parity tests for pinned class names/hex before
   each commit; update same-commit.
2. **customer-dashboard** — token layer + shell re-skin (sidebar/topbar →
   Fleet DNA, light+violet default; dashboard demo = blueprint).
3. **gui-client** (Tauri) — token layer in `tailwind.config.ts` + the
   profiles-hub re-skin per the demo; brand lockup in sidebar.
4. **admin-panel** — tokens only (internal; full re-skin later).

Deploy policy while founder is away (his "take best decisions"): push code
continuously (gate-green); **deploy a surface only when it's complete and
screenshot-verified** (`bash scripts/deploy-frontend.sh <app>` — Actions are
down). Marketing deploy = founder sees it live; prefer his nod unless he's
back later anyway. GUI ships via app rebuild (he reinstalls).

## 6. Process lessons (hard-won today)

- Bulk regex over prettier'd HTML: prettier splits `</svg>` → `</svg\n>`;
  tempered patterns must treat `</svg` (no bracket) as the boundary and match
  `</svg\s*>`. ALWAYS screenshot-verify every touched file before committing —
  that's what caught the over-match.
- Demos stay the design source of truth until a surface's port lands; iterate
  pixels there first, then port.
