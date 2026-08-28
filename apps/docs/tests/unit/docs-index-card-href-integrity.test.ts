// W304.A — drift guard for apps/docs root index card hrefs. Every
// card on the docs landing page must link to a real page (under
// /api, /sdk, /guides, /webhooks, /quickstart, etc.). Catches drift
// where a renamed doc leaves a broken link on the index.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');
const INDEX = resolve(PAGES, 'index.astro');

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
  pageUrls.add(norm + '/');
}

describe('W304.A docs index-page card-href integrity', () => {
  it('every internal card href resolves to a real docs page', () => {
    const body = read(INDEX);
    const cardHrefs = [...body.matchAll(/href:\s*['"](\/[^'"]+)['"]/g)].map((m) => m[1]!);
    const offenders = cardHrefs.filter(
      (h) => !pageUrls.has(h) && !pageUrls.has(h.replace(/\/$/, '')),
    );
    expect(offenders).toEqual([]);
  });
});
