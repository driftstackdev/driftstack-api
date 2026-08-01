// W279.C — every root-relative asset the marketing site references must exist.
//
// Originally this matched `<img src="/…">` under src/pages. It checked NOTHING:
// there are zero <img> tags in that directory, and only two in the entire
// marketing-site source — both in components/, outside the scanned root, and
// neither root-relative. The guard had been green over an empty set, which is
// the same scan-root defect it exists to catch, one level up.
//
// The assets the site actually references this way are the two preloaded
// fonts and the apple-touch icon, all declared in a layout. Those are worth
// guarding on their own terms: a preloaded font that 404s degrades typography
// on every page, and it fails silently because a missing preload is not an
// error the browser surfaces.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
// The whole source tree, not just pages/: layouts and components are where
// these references actually live, and scanning only pages/ is what made this
// guard inert.
const SRC = resolve(REPO_ROOT, 'apps/marketing-site/src');
const PUBLIC = resolve(REPO_ROOT, 'apps/marketing-site/public');

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

const allFiles = walk(SRC).filter((f) => /\.astro$/.test(f));

/**
 * Root-relative asset paths referenced by `text`, query stripped.
 *
 * `src`, `href` and `content` all carry them — an `<img>`, a font `<link
 * rel="preload">`, an icon `<link>`, an `og:image` `<meta>`. Restricting to
 * `<img src>` is what left this guard with nothing to check.
 *
 * Shared with the reachability check below deliberately: a floor exercising a
 * separate copy of this would prove that copy works, not this one.
 */
const ASSET_REF =
  /(?:src|href|content)=["'](\/[A-Za-z0-9._/-]+\.(?:png|jpe?g|svg|webp|avif|ico|gif|woff2?))(\?[^"']*)?["']/g;

const assetRefs = (text: string): string[] => [...text.matchAll(ASSET_REF)].map((m) => m[1]!);

describe('W279.C marketing-site root-relative asset integrity', () => {
  it('CRITICAL the sweep read real files, found real asset references, and the matcher still works. The assertion below reports an ABSENCE of broken assets, so it is satisfied just as well by finding none — which is precisely what it did while it scanned only src/pages for `<img>` tags that do not exist there.', () => {
    expect(allFiles.length, '.astro files scanned across marketing-site/src').toBeGreaterThan(20);

    const found = allFiles.flatMap((f) => assetRefs(read(f)));
    expect(found.length, 'root-relative asset references found').toBeGreaterThan(2);

    expect(assetRefs('<img src="/img/logo.svg" alt="x">'), 'an image src').toEqual([
      '/img/logo.svg',
    ]);
    expect(
      assetRefs('<link rel="preload" href="/fonts/geist/GeistVF.woff2" as="font">'),
      'a preloaded font, which is the reference class this guard actually protects',
    ).toEqual(['/fonts/geist/GeistVF.woff2']);
    expect(
      assetRefs('<img src="/img/logo.svg?v=2" alt="x">'),
      'a cache-busting query is stripped, since the path is what resolves on disk',
    ).toEqual(['/img/logo.svg']);
    expect(
      assetRefs('<img src="https://cdn.example.com/x.png" alt="x">'),
      'while an absolute external URL is not claimed as a local asset',
    ).toEqual([]);
  });

  it('every root-relative asset reference resolves to a real public/ file', () => {
    const offenders: { file: string; src: string }[] = [];
    for (const f of allFiles) {
      for (const src of assetRefs(read(f))) {
        if (!existsSync(resolve(PUBLIC, '.' + src))) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), src });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
