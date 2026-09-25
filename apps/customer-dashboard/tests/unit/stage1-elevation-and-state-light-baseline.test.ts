// W-2026-09-21 — drift guard for the stage-1 visual upgrade (design brief:
// docs.internal a2-ai-view/stage-everywhere/DESIGN-BRIEF.md §4). Pins the
// four derived tokens (--shadow-lift, --shadow-float, --tk-ease,
// --tk-state-rgb) and — separately, because this is the part most likely to
// silently regress — that every new animation this stage adds (.tk-room's
// breathing backdrop, the [data-tk-state] pip's breathing halo) carries its
// OWN explicit prefers-reduced-motion still. The sitewide global clamp
// (reduced-motion-baseline.test.ts) forces near-zero animation duration for
// everyone; it does NOT guarantee a specific, correct resting frame for a
// bespoke animation whose base (un-animated) style differs from its
// keyframe's resting value — this exact class of bug was found live in this
// app during the stage-1 survey (DashboardLayout's page-hydrate <main
// style="opacity:0">, revealed only by JS, not by a keyframe) and is why
// every new loop here gets its own authored still rather than relying on
// the global clamp alone.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const BASE_CSS = resolve(REPO_ROOT, 'apps/customer-dashboard/src/styles/base.css');
const TAILWIND = resolve(REPO_ROOT, 'apps/customer-dashboard/tailwind.config.mjs');
const INDEX_PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('customer dashboard stage-1 elevation + state-light baseline', () => {
  const css = read(BASE_CSS);
  const tailwind = read(TAILWIND);
  const indexPage = read(INDEX_PAGE);

  // 2026-09-25 — the easing and the lift/float shadows now come from the shared
  // design tokens (packages/design-tokens, the desktop app's own --ai-ease,
  // --ai-lift and --ai-float), which base.css imports; base.css declares no token
  // value of its own. The arms below follow the values to where they live.
  const tokensCss = read(resolve(REPO_ROOT, 'packages/design-tokens/dist/tokens.css'));
  const aliasesCss = read(resolve(REPO_ROOT, 'packages/design-tokens/dist/web-aliases.css'));

  it('--tk-ease is defined once, mode/accent-independent: the shared --ease on :root, aliased as --tk-ease', () => {
    expect(css).toMatch(/@import '@driftstack\/design-tokens\/tokens\.css';/);
    expect(css).toMatch(/@import '@driftstack\/design-tokens\/web-aliases\.css';/);
    expect(tokensCss).toMatch(
      /:root,\s*\[data-accent='oxblood'\]\s*\{[^}]*--ease:\s*cubic-bezier\([^)]+\);/,
    );
    expect(aliasesCss).toMatch(/--tk-ease:\s*var\(--ease\);/);
    expect(css).not.toMatch(/--tk-ease:/);
  });

  it('--shadow-lift and --shadow-float are defined in BOTH mode blocks (light + dark), with --shadow-ambient aliased onto the lift', () => {
    const lightBlock = tokensCss.match(/\[data-mode='light'\]\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    const darkBlock = tokensCss.match(/\[data-mode='dark'\]\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    for (const block of [lightBlock, darkBlock]) {
      expect(block).toMatch(/--shadow-lift:/);
      expect(block).toMatch(/--shadow-float:/);
    }
    expect(aliasesCss).toMatch(/--shadow-ambient:\s*var\(--shadow-lift\);/);
  });

  it('tailwind.config.mjs exposes shadow-lift / shadow-float utilities wired to the CSS variables (through the shared preset)', () => {
    const preset = read(resolve(REPO_ROOT, 'packages/design-tokens/dist/tailwind-preset.mjs'));
    expect(tailwind).toMatch(/presets: \[preset\],/);
    expect(preset).toMatch(/lift:\s*'var\(--shadow-lift\)'/);
    expect(preset).toMatch(/float:\s*'var\(--shadow-float\)'/);
  });

  it('.tk-room (the home-page header room backdrop) breathes, and has an explicit reduced-motion still — not just the global clamp', () => {
    expect(css).toMatch(/@keyframes tk-room-breathe\s*\{/);
    expect(css).toMatch(/\.tk-room\s*\{\s*animation:\s*tk-room-breathe/);
    const reduceBlock =
      css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}\n\n/)?.[0] ?? '';
    // there are two reduced-motion blocks in the stage-1 section (room +
    // pip); search the whole tail of the file for both explicitly.
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.tk-room\s*\{\s*animation:\s*none;\s*opacity:\s*0\.85;/,
    );
    void reduceBlock;
  });

  it('[data-tk-state] pip: busy/creating breathe, ready is steady (no animation authored for it), and busy/creating get an explicit reduced-motion still', () => {
    expect(css).toMatch(/\[data-tk-state='busy'\]\s*\{\s*--tk-state-rgb:\s*var\(--busy-rgb\);/);
    expect(css).toMatch(
      /\[data-tk-state='creating'\]\s*\{\s*--tk-state-rgb:\s*var\(--accent-rgb\);/,
    );
    expect(css).toMatch(/\[data-tk-state='ready'\]\s*\{\s*--tk-state-rgb:\s*var\(--ready-rgb\);/);
    expect(css).toMatch(/@keyframes tk-breathe\s*\{/);
    expect(css).toMatch(
      /\[data-tk-state='busy'\]::before,\s*\[data-tk-state='creating'\]::before\s*\{\s*animation:\s*tk-breathe/,
    );
    // the reduced-motion still for the pip must explicitly neutralise the
    // animation AND supply a static box-shadow — not rely on the global
    // 0.01ms clamp alone (an animation without fill-mode:forwards reverts
    // to its un-animated base style when the clamp cuts its duration to
    // near-zero; that base style must therefore already be the intended
    // resting look, authored here, not left to fall out of the keyframe).
    const pipReduceMatch = css.match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\[data-tk-state='busy'\]::before,\s*\[data-tk-state='creating'\]::before\s*\{\s*animation:\s*none;\s*box-shadow:[^;]+;/,
    );
    expect(pipReduceMatch).not.toBeNull();
  });

  it("index.astro's Active sessions row template stamps data-tk-state, and ONLY for the three statuses this stage defines a light for (creating/busy/ready — destroyed/errored are filtered out upstream in the same function)", () => {
    expect(indexPage).toMatch(/data-tk-state="'\s*\+\s*escapeHtml\(s\.status \|\| 'ready'\)/);
    // the upstream filter this depends on: sessions in 'destroyed'/'errored'
    // never reach the row template at all, so no dead/error light is needed.
    expect(indexPage).toMatch(/s\.status !== 'destroyed' && s\.status !== 'errored'/);
  });

  it('home (index.astro) and security.astro both elevate their "Your data is protected" trust sub-cards with the new token — not the pre-existing plain border they shipped with', () => {
    const securityPage = read(
      resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/security.astro'),
    );
    for (const page of [indexPage, securityPage]) {
      const matches =
        page.match(
          /class="tk-liftable rounded-lg border border-tk-border bg-tk-surface p-4 shadow-lift"/g,
        ) ?? [];
      expect(matches.length).toBe(3);
    }
  });
});
