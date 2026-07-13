// W282.A — drift guard for marketing-site Header nav. Every
// internal href in the top-of-page nav must resolve to a real
// page file under apps/marketing-site/src/pages. Mirrors the
// Footer integrity guard.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const HEADER = resolve(REPO_ROOT, 'apps/marketing-site/src/components/Header.astro');
const PAGES = resolve(REPO_ROOT, 'apps/marketing-site/src/pages');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
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

describe('W282.A Header.astro internal href integrity', () => {
  const body = read(HEADER);
  // Inline array-of-objects pattern.
  const navHrefs = [...body.matchAll(/\{\s*href:\s*['"]([^'"]+)['"]\s*,\s*label:/g)].map(
    (m) => m[1]!,
  );

  it('header declares at least 4 nav items', () => {
    expect(navHrefs.length).toBeGreaterThanOrEqual(4);
  });

  it('every internal nav href resolves to a real page', () => {
    const offenders = navHrefs
      .filter((h) => h.startsWith('/'))
      .filter((h) => !pageUrls.has(h.replace(/#.*$/, '').replace(/\/$/, '')));
    expect(offenders).toEqual([]);
  });

  it('top-bar dashboard link points at the canonical app.driftstack.dev/login URL', () => {
    expect(body).toMatch(/href=["']https:\/\/app\.driftstack\.dev\/login\/["']/);
  });
});
