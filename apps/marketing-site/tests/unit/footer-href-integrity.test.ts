// W281.B — drift guard for marketing-site Footer hrefs. Every
// internal href in Footer.astro must resolve to a real page file
// under apps/marketing-site/src/pages. Catches renames where the
// footer still points at the old slug.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const FOOTER = resolve(REPO_ROOT, 'apps/marketing-site/src/components/Footer.astro');
const PAGES = resolve(REPO_ROOT, 'apps/marketing-site/src/pages');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) throw new Error(`missing ${dir}`);
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
  pageUrls.add(url.endsWith('/') ? url.slice(0, -1) || '/' : url);
}

describe('W281.B Footer.astro internal href integrity', () => {
  const body = read(FOOTER);
  const hrefs = [...body.matchAll(/href=["'](\/[^"']+)["']/g)].map((m) =>
    m[1]!.replace(/#.*$/, '').replace(/\?.*$/, '').replace(/\/$/, ''),
  );

  it('Footer has more than 10 internal links', () => {
    expect(hrefs.length).toBeGreaterThan(10);
  });

  it('every internal href resolves to a real page', () => {
    const offenders = hrefs.filter((h) => h !== '' && !pageUrls.has(h));
    expect(offenders).toEqual([]);
  });
});
