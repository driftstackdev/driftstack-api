// W281.C — drift guard for apps/docs DOC_NAV. Every href in the
// docs sidebar nav must resolve to a real .md/.astro page under
// apps/docs/src/pages. Catches drift where a doc is renamed but
// the sidebar still points to the old slug.

import { readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOC_NAV } from '../../src/data/nav';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    throw new Error(
      `walk root is missing: ${dir} — a sweep over a missing tree reports nothing to sweep, which reads as clean; if the tree moved, update the root`,
    );
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const pageUrls = new Set<string>(['/']);
for (const f of walk(PAGES).filter((f) => /\.(astro|md)$/.test(f))) {
  const rel = relative(PAGES, f).replace(/\\/g, '/');
  const url = '/' + rel.replace(/\.(astro|md)$/, '').replace(/(^|\/)index$/, '');
  const norm = url.endsWith('/') ? url.slice(0, -1) || '/' : url;
  pageUrls.add(norm);
  pageUrls.add(norm + '/'); // trailing-slash form
}

describe('W281.C apps/docs DOC_NAV href integrity', () => {
  const navHrefs: string[] = [];
  for (const section of DOC_NAV) {
    for (const item of section.items) {
      navHrefs.push(item.href);
    }
  }

  it('DOC_NAV has at least 10 items', () => {
    expect(navHrefs.length).toBeGreaterThan(10);
  });

  it('every DOC_NAV href resolves to a real .md/.astro page', () => {
    const offenders = navHrefs.filter(
      (h) => !pageUrls.has(h) && !pageUrls.has(h.replace(/\/$/, '')),
    );
    expect(offenders).toEqual([]);
  });
});
