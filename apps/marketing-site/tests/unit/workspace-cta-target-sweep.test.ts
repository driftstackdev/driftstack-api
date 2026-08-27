// W275.B — workspace-wide sweep guard for marketing-site CTA hrefs.
// Every internal href on a marketing page must resolve to one of:
//   - a real .astro page under src/pages
//   - a docs subpath (/docs/<slug>)
//   - the pricing trial-pack anchor (/pricing#trial-pack)
//   - a /legal/* path that exists
// Catches the drift class where a CTA points to a renamed page.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
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

const allPages = walk(PAGES).filter((f) => /\.astro$/.test(f));

// Build the set of valid marketing-site URLs.
const pageUrls = new Set<string>();
for (const f of allPages) {
  const rel = relative(PAGES, f).replace(/\\/g, '/');
  const url = '/' + rel.replace(/\.astro$/, '').replace(/\/index$/, '');
  pageUrls.add(url);
}
pageUrls.add('/'); // home

describe('W275.B marketing-site CTA href integrity', () => {
  // ⛔ walk() returns [] for a MISSING root, and [] is also the pass condition for the
  // emptiness assertions below — so a renamed or moved root turns this sweep silent
  // and green in the same instant, reporting the corpus clean because it read none.
  //
  // ⚠️ Its own arm rather than at the walk: the collection runs at MODULE scope, where
  // a throw removes the file from collection instead of failing a test, and walk()'s
  // own guard covers every recursive descent — making THAT throw would kill the walk
  // on a vanishing subdirectory or a broken symlink, a different failure entirely.
  it('non-vacuous: the sweep read a real corpus, so an empty result is a finding and not a clean bill', () => {
    expect(existsSync(PAGES), `walk root missing — this sweep read nothing: ${PAGES}`).toBe(true);
    expect(
      allPages.length,
      'the walk found no files; an empty sweep is not a clean one',
    ).toBeGreaterThan(5);
  });

  it('every internal href in a button or btn-* class link resolves to a real page', () => {
    const offenders: { file: string; href: string }[] = [];
    for (const f of allPages) {
      const body = read(f);
      // Capture <a href="/..." class="...btn..."> patterns (best-effort).
      const matches = [
        ...body.matchAll(
          /<a[^>]+href=["'](\/[a-z][a-z0-9/_-]*)["'][^>]*class=["'][^"']*\bbtn-[a-z]+\b[^"']*["']/g,
        ),
      ];
      for (const m of matches) {
        const href = m[1]!.replace(/#.*$/, '').replace(/\?.*$/, '').replace(/\/$/, '');
        if (href === '') continue; // root href "/"
        if (!pageUrls.has(href)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), href });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
