// W306.C — drift guard for docs guides cross-link integrity.
// Every internal /<section>/<page>/ link in apps/docs/src/pages/guides/
// must resolve to either:
//   • a docs page file under apps/docs/src/pages/ (md or astro), OR
//   • a known marketing-site prefix (/legal/, /security, etc.) that
//     ships on the marketing site rather than the docs site.
// Anchor fragments (#payload-reference) are not checked — the
// presence of the target page is enough; per-anchor coverage is
// already handled by per-page parity tests.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');
const GUIDES = resolve(DOCS_PAGES, 'guides');

// Marketing-site prefixes — these resolve on driftstack.dev, not on
// docs.driftstack.dev. The docs site links to them directly.
const MARKETING_PREFIXES = ['/legal/', '/security', '/pricing', '/about'];

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

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Build the set of routable URLs from the docs pages tree. A file at
// `apps/docs/src/pages/api/team.md` resolves to `/api/team` and
// `/api/team/`.
function buildDocsUrlSet(): Set<string> {
  const urls = new Set<string>();
  for (const f of walk(DOCS_PAGES)) {
    if (!/\.(md|astro)$/.test(f)) continue;
    const rel = f.slice(DOCS_PAGES.length).replace(/\\/g, '/'); // /api/team.md
    let route = rel.replace(/\.(md|astro)$/, '');
    if (route.endsWith('/index')) route = route.slice(0, -'/index'.length);
    urls.add(route);
    urls.add(route + '/');
  }
  return urls;
}

describe('W306.C docs/guides cross-link integrity', () => {
  const docsUrls = buildDocsUrlSet();
  const guideFiles = walk(GUIDES).filter((f) => /\.(md|astro)$/.test(f));

  it('finds at least one guide page', () => {
    expect(guideFiles.length).toBeGreaterThan(0);
  });

  it('every internal /<section>/ link in a guide resolves to a known docs page or marketing prefix', () => {
    const offenders: { file: string; href: string }[] = [];
    for (const f of guideFiles) {
      const body = read(f);
      for (const m of body.matchAll(/\]\((\/[A-Za-z0-9/_-]+\/?)(?:#[^)]*)?\)/g)) {
        const href = m[1]!;
        // Skip marketing-site cross-site links.
        if (MARKETING_PREFIXES.some((p) => href === p || href.startsWith(p))) continue;
        // Skip anchor-only/relative cases already filtered by regex.
        if (docsUrls.has(href) || docsUrls.has(href.replace(/\/$/, ''))) continue;
        offenders.push({ file: f.slice(REPO_ROOT.length + 1), href });
      }
    }
    expect(offenders).toEqual([]);
  });
});
