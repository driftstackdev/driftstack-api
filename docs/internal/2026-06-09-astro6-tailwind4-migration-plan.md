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

## ⚠️ CRITICAL recipe correction (W365 — learned from the status-site pilot)

**Use `@tailwindcss/postcss` (+ a `postcss.config.mjs`), NOT `@tailwindcss/vite`.** The Vite
plugin breaks while astro 5 + 6 coexist in this monorepo: `q.createIdResolver is not a function`
(the plugin binds to the wrong deduped Vite version). The PostCSS plugin decouples from Astro's
bundled Vite → builds clean. Corrected step 3/4:

- `package.json`: `astro@^6`, drop `@astrojs/tailwind`, add `@tailwindcss/postcss@^4` + `tailwindcss@^4`.
- `astro.config.mjs`: remove the `@astrojs/tailwind` integration AND any `@tailwindcss/vite` plugin (none).
- add `apps/<site>/postcss.config.mjs`: `export default { plugins: { '@tailwindcss/postcss': {} } }`.
- the codemod (`npx @tailwindcss/upgrade`) handles config→`@theme`, `@tailwind`→`@import`, utility renames.

## Audit note (W365)

status-site doesn't carry the original 2 HIGH (`@astrojs/cloudflare` undici/devalue — those are
**marketing-site**'s adapter). The audit count rose to 28 (incl criticals) because adding astro
6.4.5 surfaces the **astro `<=6.1.9` XSS/server-island advisories against the 4 sites STILL on
astro 5.18.1** — migrating all sites to 6.4.5 CLEARS them (6.4.5 is patched). All build-time/
static-site (server runtime undici is 8.x/safe). So: finish all 5 sites to actually reduce the count.

## ⚠️⚠️ CORRECTED vuln-remediation picture (W370) — the migrations done so far DON'T fix the vulns

The 2 HIGH advisories (undici + devalue, via `@astrojs/cloudflare`) live in \*\*customer-dashboard

- admin-panel** (both `output:'static'` + the Cloudflare adapter, currently `@astrojs/cloudflare@^12.6.13`)
  — **NOT\*\* in status-site/docs/marketing (those have no adapter). So:

* **status-site + docs (W365/W367, done):** pure modernization — ZERO vuln impact.
* **marketing-site:** static, no adapter, no vulns → migrating it is **pure modernization, 71 `.astro`
  files + Sentry integration + ~10 parity/doc tests. Low ROI. DEPRIORITIZE** (skip unless the founder
  wants all sites on astro 6 for consistency).
* **customer-dashboard + admin-panel (the actual vuln target):** the fix is `@astrojs/cloudflare@13.7.0`,
  whose peer is **`astro: ^6.3.0`** — so clearing the vulns REQUIRES a full astro-6 migration of BOTH
  auth/SSR-adapter dashboard apps. These are the **highest-risk** migrations (customer login + internal
  admin, the adapter runtime, the biggest visual+functional surface).

**The vulns are build-time/adapter-tooling** (the dashboards serve static output; undici/devalue aren't in
the served runtime) → **low REAL risk** (matches W328). **npm-override path is NOT clean**: patched undici
is 8.x (a major bump from the adapter's 7.x → likely breaks `@astrojs/cloudflare@12`).

**RECOMMENDATION (founder decision):** DEFER the dashboard migrations — migrating the auth-bearing customer
dashboard to astro 6 to clear _build-time, low-real-risk_ vulns is a poor risk trade. Either accept the
advisories (they don't touch served runtime) until a planned dashboard-modernization, or schedule that as a
focused, carefully-verified effort (NOT autopilot fallback). Marketing = optional modernization, skip.

## Status

- 2026-06-09 W364: plan + status-site breaking-utility audit (this doc).
- 2026-06-09 W365: **status-site PILOT MIGRATED + builds clean** (astro 6.4.5 + Tailwind v4 via
  postcss; codemod ran; CSS verified — 21KB, oxblood/surface theme + renamed utilities present).
  **BANKED, NOT pushed** — pushing auto-deploys to live status.driftstack.io (Cloudflare Pages)
  and the founder asked to spot-check renders; I can't verify pixels. Awaiting founder OK to push,
  OR founder eyeballs the built `apps/status-site/dist`. Recipe proven for the remaining 4 sites.
