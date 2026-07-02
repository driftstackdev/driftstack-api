// W530 — every internal href in the customer-dashboard resolves to a real page.
//
// Completes the frontend-wiring guard trifecta: W481 covered fetch()→route,
// W472 covered email→page, this covers in-app <a href> → page (the class the
// other two miss — e.g. login's "Sign in with a magic link instead" link).
// A nav/CTA pointing at a renamed/removed page 404s silently for a customer.
//
// Verified W530: 32 pages, 16 distinct internal hrefs, 0 missing.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES_DIR = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.astro$/.test(name)) out.push(p);
  }
  return out;
}

describe('W530 dashboard internal hrefs resolve to pages', () => {
  const pages = walk(PAGES_DIR);

  // Route paths the page files provide ("/team/accept", "/", ...).
  const provided = new Set<string>();
  for (const p of pages) {
    const r =
      p
        .replace(PAGES_DIR, '')
        .replace(/\.astro$/, '')
        .replace(/\/index$/, '') || '/';
    provided.add(r === '' ? '/' : r);
  }

  // Distinct same-app hrefs referenced from page markup (path-only; /v1 API
  // paths are the fetch guard's concern, not this one's).
  const hrefs = new Set<string>();
  for (const p of pages) {
    const body = readFileSync(p, 'utf8');
    for (const m of body.matchAll(/href="(\/[a-z0-9\-/]*)"/g)) {
      const h = (m[1] ?? '').replace(/\/$/, '') || '/';
      if (!h.startsWith('/v1')) hrefs.add(h);
    }
  }

  it('finds pages and hrefs to check', () => {
    // 2026-07-02 — floor lowered 25→20 with the account-portal IA
    // (redesign slice 2): the 9 operational pages (profiles/snapshots/
    // sessions/agent-sessions[+/[id]]/recipes[+/[id]]/proxies/first-session)
    // moved to the desktop GUI, leaving 23 dashboard pages.
    expect(provided.size).toBeGreaterThanOrEqual(20);
    expect(hrefs.size).toBeGreaterThanOrEqual(10);
  });

  it('every internal href has a page file', () => {
    const missing = [...hrefs]
      .filter((h) => {
        const base = h.split('?')[0] ?? h;
        if (provided.has(base)) return false;
        // Dynamic segments: /foo/[id].astro provides /foo/<anything>.
        return ![...provided].some(
          (e) => e.includes('[') && base.startsWith(e.split('[')[0] ?? ''),
        );
      })
      .sort();
    expect(
      missing,
      `dashboard links to these paths but no page file exists (silent 404):\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});
