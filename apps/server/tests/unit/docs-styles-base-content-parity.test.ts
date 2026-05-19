// Drift guard for apps/docs/src/styles/base.css. Pins the R11
// dark-mode-synced-with-marketing posture + the F-1 mobile-scroll
// prevention + the 3 components-layer utility classes.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/styles/base.css');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs styles/base content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('Tailwind 3-directive header pinned', () => {
    expect(body).toMatch(/@tailwind base;/);
    expect(body).toMatch(/@tailwind components;/);
    expect(body).toMatch(/@tailwind utilities;/);
  });

  it("R11 dark-mode-synced-with-marketing posture pinned: 'Synced with the marketing-site + customer-dashboard graphite palette so the product reads as one site, not three.' Drift to a different palette would break cross-app brand consistency", () => {
    expect(body).toMatch(/R11 — dark-mode docs surface\. Synced with the marketing-site \+/);
    expect(body).toMatch(/customer-dashboard "graphite" palette so the product reads as one/);
    expect(body).toMatch(/site, not three/);
    expect(body).toMatch(/color-scheme: dark;/);
  });

  it("Code-block surface-inset framing pinned: 'Code blocks land on slate-950 (surface.inset)' replacing the prior 'ugly extra white background' the founder flagged. Drift to a lighter pre background would re-introduce the readability bug", () => {
    expect(body).toMatch(/Code blocks land on slate-950 \(surface\.inset\) for/);
    expect(body).toMatch(/high-contrast monospace readability — replaces the prior light/);
    expect(body).toMatch(/slate-100 prose-code background that the founder flagged as/);
    expect(body).toMatch(/"ugly extra white background, barely readable"/);
  });

  it('F-1 iPhone-Safari horizontal-scroll prevention pinned: overflow-x:clip + max-width:100vw. Drift to overflow:hidden would break sticky positioning on docs pages', () => {
    expect(body).toMatch(/F-1 — prevent iPhone Safari horizontal scroll/);
    expect(body).toMatch(/overflow-x: clip;/);
    expect(body).toMatch(/max-width: 100vw;/);
  });

  it('Body backdrop radial-gradient pinned (the subtle oxblood glow at the top of every docs page that ties the brand together). Drift would either soften (less brand presence) or amplify (visually distracting) the glow', () => {
    expect(body).toMatch(/background-image: radial-gradient\(/);
    expect(body).toMatch(/rgba\(226, 56, 71, 0\.05\)/);
    expect(body).toMatch(/background-attachment: fixed;/);
  });

  it('3 components-layer utility classes pinned: .btn-primary + .btn-secondary + .nav-link. Drift to dropping any would break the docs-site button/nav rendering', () => {
    expect(body).toMatch(/\.btn-primary \{/);
    expect(body).toMatch(/\.btn-secondary \{/);
    expect(body).toMatch(/\.nav-link \{/);
  });

  it('btn-primary hover lift pattern pinned: -translate-y-0.5 + active:translate-y-0 + shadow-glow-red-lg. Drift would lose the load-bearing tactile-feedback on the docs CTAs', () => {
    expect(body).toMatch(/hover:-translate-y-0\.5/);
    expect(body).toMatch(/active:translate-y-0/);
    expect(body).toMatch(/shadow-glow-red-lg/);
  });
});
