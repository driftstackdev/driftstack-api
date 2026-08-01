// W295.A — drift guard for customer-dashboard internal links.
// Every <a href="/..."> link to a path-relative URL within the
// dashboard must resolve to a real page. Catches drift where a
// page is renamed but inline cross-references survive.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');
const SRC = resolve(REPO_ROOT, 'apps/customer-dashboard/src');

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
for (const f of walk(PAGES).filter((f) => /\.astro$/.test(f))) {
  const rel = relative(PAGES, f).replace(/\\/g, '/');
  const url = '/' + rel.replace(/\.astro$/, '').replace(/(^|\/)index$/, '');
  pageUrls.add(url.endsWith('/') ? url.slice(0, -1) || '/' : url);
}

const allAstro = walk(SRC).filter((f) => /\.astro$/.test(f));

/**
 * In-app root-relative hrefs in `text`, normalised the way `pageUrls` is.
 *
 * Shared with the reachability check below deliberately: a floor exercising a
 * separate copy of this would prove that copy works, not this one.
 */
function internalHrefs(text: string): string[] {
  return (
    // The path class admits `?` and `#`: the previous pattern required the
    // closing quote right after the path, so any link carrying a query or
    // fragment failed to match and went unchecked, while the strip below
    // looked like it handled them.
    [...text.matchAll(/<a[^>]+href=["'](\/[a-z][a-z0-9/_-]*(?:[?#][^"']*)?)["']/g)]
      .map((m) => m[1]!.replace(/#.*$/, '').replace(/\?.*$/, '').replace(/\/$/, '') || '/')
      // Skip external-looking heuristics (rooted at /v1/) — out-of-app links.
      .filter((href) => !href.startsWith('/v1/'))
  );
}

describe('W295.A customer-dashboard internal href integrity', () => {
  it('CRITICAL both sides of the comparison are populated, and the matcher still extracts a link. The page set AND the scanned files come from the same walk, so a moved or renamed src/ empties both — and comparing no links against no pages reports every href valid having checked none. Note the two failure directions are not symmetric: an empty PAGE set would flag every link and fail loudly, while an empty FILE set is the silent one.', () => {
    expect(allAstro.length, '.astro files scanned for links').toBeGreaterThan(15);
    expect(pageUrls.size, 'routable pages the links are checked against').toBeGreaterThan(10);

    const found = allAstro.flatMap((f) => internalHrefs(read(f)));
    expect(found.length, 'in-app links found across those files').toBeGreaterThan(0);

    expect(internalHrefs('<a href="/api-keys">Keys</a>'), 'a plain in-app link').toEqual([
      '/api-keys',
    ]);
    expect(
      internalHrefs('<a href="/api-keys?tab=live#top">Keys</a>'),
      'query and hash are stripped, matching how pageUrls is built',
    ).toEqual(['/api-keys']);
    expect(
      internalHrefs('<a href="/v1/sessions">API</a>'),
      'and an API path is not treated as a page',
    ).toEqual([]);
  });

  it('every <a href="/<path>"> (with no query/hash stripped) resolves to a real page', () => {
    const offenders: { file: string; href: string }[] = [];
    for (const f of allAstro) {
      for (const href of internalHrefs(read(f))) {
        if (!pageUrls.has(href)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), href });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
