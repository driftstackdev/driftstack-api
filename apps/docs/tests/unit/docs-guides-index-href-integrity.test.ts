// W297.B — drift guard for /guides/ index page hrefs. Every link
// on the guides index must resolve to a real page (mostly under
// /guides/<slug>/ but with cross-links to /sdk/, /api/, /quickstart/).
// Catches drift where the index page links a renamed/missing guide.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');
const INDEX = resolve(PAGES, 'guides/index.astro');

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

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const pageUrls = new Set<string>(['/']);
for (const f of walk(PAGES).filter((f) => /\.(astro|md)$/.test(f))) {
  const rel = relative(PAGES, f).replace(/\\/g, '/');
  const url = '/' + rel.replace(/\.(astro|md)$/, '').replace(/(^|\/)index$/, '');
  const norm = url.endsWith('/') ? url.slice(0, -1) || '/' : url;
  pageUrls.add(norm);
  pageUrls.add(norm + '/'); // tolerate trailing-slash form
}

describe('W297.B /guides index href integrity', () => {
  it('every href in guides/index resolves to a real docs page', () => {
    const body = read(INDEX);
    const offenders: string[] = [];
    const matches = [...body.matchAll(/href=["'](\/[^"']+)["']/g)];
    for (const m of matches) {
      const href = m[1]!.replace(/#.*$/, '').replace(/\?.*$/, '');
      const norm = href.replace(/\/$/, '') || '/';
      if (!pageUrls.has(href) && !pageUrls.has(norm)) {
        offenders.push(href);
      }
    }
    expect(offenders).toEqual([]);
  });
});
