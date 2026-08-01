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

/**
 * Absolute in-docs links in `text` — the ones this guard is responsible for
 * resolving. API endpoint refs and cross-site marketing paths are excluded
 * here rather than at the comparison, so the reachability check below and the
 * assertion agree on what counts as a link.
 */
function docsLinks(text: string): string[] {
  // Match [text](/path) — absolute, no scheme, no leading #.
  // The path class deliberately admits `#` and `?`: the previous pattern
  // stopped at the first one, so a link like `/api/api-keys#rotate` never
  // matched at all and the `.replace(/#.*$/)` below was dead code. 30 anchored
  // links in the docs were going unchecked because of it.
  return [...text.matchAll(/\[[^\]]*\]\((\/[a-z][a-z0-9/_-]*(?:[?#][^)\s]*)?)\)/gi)]
    .map((m) => m[1]!.replace(/#.*$/, '').replace(/\?.*$/, ''))
    .filter((href) => !href.startsWith('/v1/') && !isMarketingSitePath(href));
}

describe('W274.B apps/docs internal markdown link integrity', () => {
  it('CRITICAL both sides are populated and the matcher still extracts a link. The link set and the page set come from the same walk, so a moved or renamed pages/ empties both and the assertion below reports every link valid having resolved none. The directions are not symmetric: an empty PAGE set flags every link and fails loudly; an empty FILE set is the silent one.', () => {
    expect(mdFiles.length, '.md pages scanned for links').toBeGreaterThan(40);
    expect(pageUrls.size, 'routable docs pages links are checked against').toBeGreaterThan(40);

    const found = mdFiles.flatMap((f) => docsLinks(read(f)));
    expect(found.length, 'in-docs links found across those pages').toBeGreaterThan(0);

    expect(docsLinks('see [keys](/api/api-keys) for more'), 'a plain docs link').toEqual([
      '/api/api-keys',
    ]);
    expect(
      docsLinks('see [keys](/api/api-keys#rotate) for more'),
      'anchors are stripped, matching how pageUrls is built',
    ).toEqual(['/api/api-keys']);
    expect(
      docsLinks('see [terms](/legal/terms) and [sessions](/v1/sessions)'),
      'while cross-site and API paths are excluded rather than reported broken',
    ).toEqual([]);
  });

  it('every [label](/abs/path) link resolves to a real .md page', () => {
    const offenders: { file: string; href: string }[] = [];
    for (const f of mdFiles) {
      for (const href of docsLinks(read(f))) {
        if (!pageUrls.has(href) && !pageUrls.has(href + '/')) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), href });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
