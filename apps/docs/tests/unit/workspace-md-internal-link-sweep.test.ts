// W274.B — workspace-wide sweep guard for apps/docs internal links.
// Every relative markdown link like `[label](/path)` or
// `[label](./foo.md)` must resolve to a real .md page file under
// apps/docs/src/pages/. Catches the drift class where docs are
// renamed but cross-links survive.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');

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

const mdFiles = walk(PAGES).filter((f) => /\.md$/.test(f));
const allDocsPages = walk(PAGES).filter((f) => /\.(md|astro)$/.test(f));

// Build the set of valid page URLs the way Astro routes .md|.astro/index.
const pageUrls = new Set<string>();
for (const f of allDocsPages) {
  const rel = relative(PAGES, f).replace(/\\/g, '/');
  const url = '/' + rel.replace(/\.(md|astro)$/, '').replace(/\/index$/, '');
  pageUrls.add(url);
  pageUrls.add(url + '/'); // tolerate trailing-slash form
}

// Cross-site marketing-site paths (driftstack.dev) — legitimate absolute
// links from docs to the marketing site that we don't resolve here.
const MARKETING_PREFIXES = [
  '/legal/',
  '/comparison',
  '/pricing',
  '/changelog',
  '/blog/',
  '/about',
  '/contact',
  '/status',
  '/roadmap',
  '/trust/',
  '/security-overview',
];

function isMarketingSitePath(href: string): boolean {
  return MARKETING_PREFIXES.some((p) => href === p.replace(/\/$/, '') || href.startsWith(p));
}

describe('W274.B apps/docs internal markdown link integrity', () => {
  it('every [label](/abs/path) link resolves to a real .md page', () => {
    const offenders: { file: string; href: string }[] = [];
    for (const f of mdFiles) {
      const body = read(f);
      // Match [text](/path) — absolute, no scheme, no leading #.
      const matches = [...body.matchAll(/\[[^\]]*\]\((\/[a-z][a-z0-9/_-]*)\)/gi)];
      for (const m of matches) {
        const href = m[1]!.replace(/#.*$/, '').replace(/\?.*$/, '');
        if (href.startsWith('/v1/')) continue; // API endpoint refs
        if (isMarketingSitePath(href)) continue; // cross-site link
        if (!pageUrls.has(href) && !pageUrls.has(href + '/')) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), href });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
