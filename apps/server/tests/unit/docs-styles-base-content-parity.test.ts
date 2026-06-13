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

  it('Tailwind v4 @import + typography @plugin header pinned (W368 — replaces the v3 3-directive header)', () => {
    expect(body).toMatch(/@import 'tailwindcss';/);
    expect(body).toMatch(/@plugin '@tailwindcss\/typography';/);
  });

  it("R11/Fleet light+violet-synced posture pinned: 'light+violet docs surface synced with marketing/dashboard/admin Fleet tokens so the product reads as one site.' Drift to a different palette would break cross-app brand consistency", () => {
    expect(body).toMatch(/R11 \/ Fleet rebrand — light\+violet docs surface\. Synced with the/);
    expect(body).toMatch(/marketing-site \+ customer-dashboard \+ admin Fleet tokens/);
    expect(body).toMatch(/the product reads as one site/);
    expect(body).toMatch(/color-scheme: light;/);
  });

  it('F-1 code-overflow containment pinned: base.css keeps code/pre from pushing the page width (overflow-wrap:anywhere + pre overflow-x:auto) — the iPhone-Safari horizontal-scroll guard', () => {
    expect(body).toMatch(/code blocks scroll internally rather than pushing page/);
    expect(body).toMatch(/long unbreakable strings wrap or scroll internally/);
    expect(body).toMatch(/overflow-wrap: anywhere;/);
    expect(body).toMatch(/word-break: break-word;/);
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

  it('3 component utility classes pinned: btn-primary + btn-secondary + nav-link (W368 — v4 @utility, was @layer components). Drift to dropping any would break the docs-site button/nav rendering', () => {
    expect(body).toMatch(/@utility btn-primary \{/);
    expect(body).toMatch(/@utility btn-secondary \{/);
    expect(body).toMatch(/@utility nav-link \{/);
  });

  it('btn-primary hover lift pattern pinned: -translate-y-0.5 + active:translate-y-0 + shadow-glow-red-lg. Drift would lose the load-bearing tactile-feedback on the docs CTAs', () => {
    expect(body).toMatch(/hover:-translate-y-0\.5/);
    expect(body).toMatch(/active:translate-y-0/);
    expect(body).toMatch(/shadow-glow-red-lg/);
  });
});
