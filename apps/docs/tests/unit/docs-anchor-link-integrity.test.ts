// Anchor-link integrity across ALL docs pages.
//
// Complements W306.C (guides-cross-link-integrity), which validates that
// internal links resolve to a target PAGE but DELIBERATELY skips the
// `#anchor` fragment. That gap let six broken anchors drift silently
// (stale `-v-NNN` heading suffixes + wrong-page targets, fixed
// 4d814270 / a866db35). This guard closes it: every same-page or
// cross-page docs anchor must resolve to a real heading slug on the
// target page, computed with github-slugger — the same slugger Astro's
// rehype-slug uses to render heading ids, so the computed slug matches
// the deployed anchor.
//
// Scope: same-page (`](#x)`) + cross-page relative links to a docs `.md`
// page (`](/api/foo#x)` / `](/api/foo/#x)`). Skips: links with no
// anchor; marketing-domain links (`/legal/*` etc. render off-site);
// `.astro` targets (headings aren't plain markdown); absolute `http(s)`
// links.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import GithubSlugger from 'github-slugger';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');

// Off-site (marketing) prefixes — rendered on driftstack.dev, not the
// docs site, so their headings aren't in this tree.
const MARKETING_PREFIXES = ['/legal/', '/security', '/pricing', '/about', '/trust'];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    throw new Error(
      `walk root is missing: ${dir} — a sweep over a missing tree reports nothing to sweep, which reads as clean; if the tree moved, update the root`,
    );
  for (const e of readdirSync(dir)) {
    const full = resolve(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const read = (p: string): string => readFileSync(p, 'utf8');

// Strip the inline markdown that rehype removes before slugging the
// heading's text content (code spans, emphasis, link syntax).
function headingText(raw: string): string {
  return raw
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

// Compute the set of anchor slugs a docs `.md` page renders, mirroring
// rehype-slug: one stateful slugger per page (so repeated headings get
// the -1/-2 dedup suffixes Astro emits).
function pageAnchors(mdFile: string): Set<string> {
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  for (const line of read(mdFile).split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) anchors.add(slugger.slug(headingText(m[1]!)));
  }
  return anchors;
}

// Map a docs route (/api/foo or /api/foo/) to its source .md file, or
// null if it's not a markdown docs page (e.g. .astro or missing).
function routeToMdFile(route: string): string | null {
  const clean = route.replace(/\/$/, '');
  for (const cand of [`${clean}.md`, `${clean}/index.md`]) {
    const f = resolve(DOCS_PAGES, `.${cand}`);
    if (existsSync(f)) return f;
  }
  return null;
}

describe('docs anchor-link integrity', () => {
  const mdFiles = walk(DOCS_PAGES).filter((f) => f.endsWith('.md'));

  it('finds docs pages', () => {
    expect(mdFiles.length).toBeGreaterThan(0);
  });

  it('every same-page + cross-page docs anchor resolves to a real heading slug', () => {
    const offenders: { file: string; link: string; reason: string }[] = [];
    for (const f of mdFiles) {
      const relFile = f.slice(REPO_ROOT.length + 1);
      const body = read(f);
      const selfAnchors = pageAnchors(f);
      // Match [text](TARGET#ANCHOR) where TARGET is empty (same page),
      // or a relative /path. Capture target + anchor.
      for (const m of body.matchAll(/\]\(((?:\/[A-Za-z0-9/_-]+)?)\/?#([A-Za-z0-9_-]+)\)/g)) {
        const target = m[1] ?? '';
        const anchor = m[2]!;
        if (target === '') {
          // Same-page anchor.
          if (!selfAnchors.has(anchor)) {
            offenders.push({
              file: relFile,
              link: `#${anchor}`,
              reason: 'no matching heading on this page',
            });
          }
          continue;
        }
        if (
          MARKETING_PREFIXES.some((p) => target === p.replace(/\/$/, '') || target.startsWith(p))
        ) {
          continue; // off-site
        }
        const md = routeToMdFile(target);
        if (md === null) continue; // .astro / non-md target — page-existence is W306.C's job
        if (!pageAnchors(md).has(anchor)) {
          offenders.push({
            file: relFile,
            link: `${target}#${anchor}`,
            reason: `no #${anchor} heading on ${target}`,
          });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
