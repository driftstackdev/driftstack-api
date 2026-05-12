// W266.D — drift-guard for /docs/api-changelog. Pins:
// 1. Recent monthly section headers are present in correct chronological order.
// 2. Each cross-linked /docs/* page exists.
// 3. DASHBOARD_ORIGIN-derived auth URLs are framed correctly.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/api-changelog.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W266.D /docs/api-changelog ↔ cross-link + framing parity', () => {
  const page = read(PAGE);

  it('cites at least the current 2026-05 section header', () => {
    expect(page).toMatch(/<h2>2026-05<\/h2>/);
  });

  it('chronological order: 2026-05 section appears before any older 2026-0x', () => {
    const idx05 = page.indexOf('<h2>2026-05</h2>');
    expect(idx05).toBeGreaterThan(-1);
    for (const older of ['2026-04', '2026-03', '2026-02', '2026-01']) {
      const idx = page.indexOf(`<h2>${older}</h2>`);
      if (idx > -1) expect(idx).toBeGreaterThan(idx05);
    }
  });

  it('every cross-linked /docs/* page exists', () => {
    const links = [...page.matchAll(/href="(\/docs\/[a-z0-9-]+)"/g)].map((m) => m[1]!);
    const missing: string[] = [];
    for (const href of links) {
      const stem = href.replace(/^\//, '');
      const exists = [
        `${stem}.md`,
        `${stem}.astro`,
        `${stem}/index.md`,
        `${stem}/index.astro`,
      ].some((c) => existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages', c)));
      if (!exists) missing.push(href);
    }
    expect(missing).toEqual([]);
  });

  it('DASHBOARD_ORIGIN-derived auth URLs are framed correctly', () => {
    // V-079.C: real dashboard routes are /verify-email, /reset-password
    // (NOT the legacy /auth/<flow> paths).
    expect(page).toMatch(/<code>\/verify-email<\/code>/);
    expect(page).toMatch(/<code>\/reset-password<\/code>/);
    // Negative check: must not advertise the legacy /auth/<flow> form.
    expect(page).not.toMatch(/<code>\/auth\/verify-email<\/code>/);
  });

  it('DASHBOARD_ORIGIN env var is named consistently', () => {
    expect(page).toMatch(/DASHBOARD_ORIGIN/);
    // Legacy PUBLIC_DASHBOARD_URL removal is documented.
    expect(page).toMatch(/PUBLIC_DASHBOARD_URL/);
  });
});
