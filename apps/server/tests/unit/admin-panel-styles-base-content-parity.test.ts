// Drift guard for apps/admin-panel/src/styles/base.css. Pins the
// light-mode posture (intentional inversion from customer-dashboard
// dark-mode + marketing-site dark-mode) + the F-1 mobile-scroll
// prevention + the 4 components-layer utility classes.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/styles/base.css');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('admin-panel styles/base content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('Tailwind 3-directive header pinned: @tailwind base + components + utilities', () => {
    expect(body).toMatch(/@tailwind base;/);
    expect(body).toMatch(/@tailwind components;/);
    expect(body).toMatch(/@tailwind utilities;/);
  });

  it("Light-mode posture pinned (INTENTIONAL inversion vs customer-dashboard dark-mode): color-scheme: light + bg-slate-50. Drift to dark-mode would make admin staff confuse the admin surface with the customer-dashboard at a glance — defeating the visual distinction that complements the slice 194 'admin' pill + noindex framing", () => {
    expect(body).toMatch(/color-scheme: light;/);
    expect(body).toMatch(/@apply bg-slate-50 text-slate-900;/);
  });

  it('tokens-shared-with-marketing commitment pinned (admin uses light-mode but shares the OXBLOOD brand + Geist font tokens). Drift to dropping the comment would orphan the cross-app token-sync rationale', () => {
    expect(body).toMatch(/Tokens shared with apps\/marketing-\s*site\/src\/styles\/base\.css\./);
  });

  it("F-1 mobile-scroll prevention rationale pinned: 'operators occasionally check pages from phones' — drift to dropping the rationale would let a future refactor strip overflow-x:clip thinking it's not needed on a desktop-only admin surface", () => {
    expect(body).toMatch(
      /F-1 — prevent admin-panel horizontal scroll on narrow viewports\s*\(operators occasionally check pages from phones\)/,
    );
  });

  it('4 components-layer utility classes pinned: .btn-primary + .btn-secondary + .nav-link + .dashboard-card. Drift to dropping any would break every admin page using the class', () => {
    expect(body).toMatch(/\.btn-primary \{/);
    expect(body).toMatch(/\.btn-secondary \{/);
    expect(body).toMatch(/\.nav-link \{/);
    expect(body).toMatch(/\.dashboard-card \{/);
  });

  it('btn-primary brand-accent (oxblood-700) pinned: drift to a different background color would break cross-app brand recognition for the primary CTA color', () => {
    expect(body).toMatch(
      /\.btn-primary \{[\s\S]{0,300}bg-oxblood-700[\s\S]{0,300}hover:bg-oxblood-800/,
    );
  });
});
