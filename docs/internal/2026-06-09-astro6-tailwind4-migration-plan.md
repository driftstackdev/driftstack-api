# astro-6 + Tailwind-v4 migration plan (founder-greenlit W363, fallback-priority)

Founder greenlit astro-6 as fallback work ("if nothing more important, go for it").
It's the only fix for the 2 HIGH `npm audit` advisories (devalue DoS + undici via
`@astrojs/cloudflare`) — both build-time/static-site (server runtime undici is 8.x/safe),
so NOT urgent. NOT a clean bump: `@astrojs/tailwind` has no astro-6 peer → astro 6
forces a Tailwind v3→v4 migration per site.

## Why this is now de-risked (the codemod)

Tailwind v4 ships an **official upgrade codemod**: `npx @tailwindcss/upgrade`. Run inside
a site, it automatically: (1) migrates `tailwind.config.{js,mjs}` → CSS-first `@theme` (or
keeps it via `@config`), (2) rewrites `@tailwind base/components/utilities` → `@import "tailwindcss"`,
(3) **renames the breaking utilities in templates** (`rounded`→`rounded-sm`, `shadow-sm`→`shadow-xs`,
`shadow`→`shadow-sm`, `ring`→`ring-3` for the old 3px default, `outline-none`→`outline-hidden`, `blur-sm`→`blur-xs`, …).
That handles the visual-regression risk mechanically — the remaining founder spot-check is a
sanity pass, not a hand-audit.

## Per-site order (lowest-risk → highest)

1. **status-site** (PILOT — do first). 8 `.astro` files, simple uptime/incident page,
   least customer-critical, bounded blast radius (a broken Cloudflare build keeps the
   last-good version). Breaking-utility audit (2026-06-09): 41 `rounded`, 11 `shadow-sm`,
   2 `ring`, 1 `outline-none`, 0 `blur` → all handled by the codemod.
2. **docs** · 3. **marketing-site** · 4/5. **customer-dashboard / admin-panel** (if astro).
   Each pins astro independently → migrate + verify + commit ONE site at a time.

## Execution steps (per site — LOW-LOAD ONLY; npm install + build is heavy on the 16GB box)

Gate: run ONLY when 1-min AND 5-min load both < 14 (A1 fork rebuilds spike load; the build
thrashes otherwise). Check `uptime` first.

1. `cd apps/<site>`
2. `npx @tailwindcss/upgrade` (the codemod — review its diff).
3. `package.json`: `astro` → `^6`, bump `@astrojs/check`, drop `@astrojs/tailwind`, add
   `@tailwindcss/vite` + `tailwindcss@^4` (codemod usually does the tailwind ones).
4. `astro.config.mjs`: remove `integrations: [tailwind(...)]`; add `vite: { plugins: [tailwindcss()] }`
   (import `tailwindcss from '@tailwindcss/vite'`). NOTE status-site used `tailwind({ applyBaseStyles: false })`
   — v4 doesn't inject base styles via the integration, so `@import "tailwindcss"` in global.css is the equivalent;
   keep the existing `@layer base` block.
5. `npm install` (regenerates the root lockfile — astro 6 + tailwind 4 coexist with the other
   sites' astro 5 until they're migrated too).
6. `npm run build --workspace=apps/<site>` → fix residual errors empirically.
7. **The pre-push gate does NOT build astro sites** (server-only) — so a broken site build
   would pass the gate but fail the Cloudflare deploy. MUST `astro build` locally to verify.
8. Commit that ONE site + its lockfile delta. Founder spot-checks the rendered site
   (Cloudflare preview) before the next site.

## Verification

- `npm audit --omit=dev` after all sites migrated → confirm the 2 HIGH advisories cleared.
- Each site: local `astro build` clean + founder visual spot-check (the codemod preserves
  the look; this is a sanity pass).

## Status

- 2026-06-09 W364: plan + status-site breaking-utility audit done (this doc). Execution
  deferred to a confirmed-sustained-low-load wave (A1's webdriver/fork build was winding
  down — 5/15-min load ~22). Pilot = status-site.
