// Every internal link on the shipped sites points at a page that exists.
//
// 176 pages across five Astro apps — marketing, docs, the customer dashboard,
// the admin panel and the status site — and nothing checked that their links go
// anywhere. The parity suites pin page CONTENT, `url-canonicalization` covers
// API URL shapes, and neither notices a nav entry pointing at a route that was
// renamed. The failure is a plain 404 on a customer-facing page: no error, no
// log, nobody told.
//
// Only LITERAL hrefs are checked. Several admin pages build a link in script —
// `'/accounts/' + encodeURIComponent(id)` — and a naive regex reports the
// fragment before the concatenation as a broken path. That is exactly the false
// positive that would get this guard deleted, so an href containing a quote, a
// `+` or a `${` is skipped rather than guessed at. What remains is the set that
// can be resolved without evaluating anything.
//
// Cross-site links are also skipped: the sites deploy to separate hosts, so
// `https://docs.driftstack.dev/...` cannot be resolved against a sibling's
// pages directory and is not this check's subject.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const SITES = ['marketing-site', 'docs', 'customer-dashboard', 'admin-panel', 'status-site'];
const PAGE_EXTENSIONS = new Set(['.astro', '.md', '.mdx']);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (PAGE_EXTENSIONS.has(extname(full))) out.push(full);
  }
  return out;
}

/** The routes a site serves, split into literal paths and dynamic patterns. */
function routesOf(site: string): { staticRoutes: Set<string>; dynamic: RegExp[] } {
  const root = resolve(REPO_ROOT, 'apps', site, 'src', 'pages');
  const staticRoutes = new Set<string>();
  const dynamic: RegExp[] = [];
  for (const file of walk(root)) {
    const rel = relative(root, file).replace(/\.(astro|mdx?|md)$/, '');
    const parts = rel.split('/').filter((p) => p !== '');
    if (parts[parts.length - 1] === 'index') parts.pop();
    const route = `/${parts.join('/')}`.replace(/\/$/, '') || '/';
    if (route.includes('[')) {
      // `[slug]` matches one segment, `[...rest]` matches the remainder.
      const pattern = route.replace(/\[\.\.\.[^\]]+\]/g, '.*').replace(/\[[^\]]+\]/g, '[^/]+');
      dynamic.push(new RegExp(`^${pattern}$`));
    } else {
      staticRoutes.add(route);
    }
  }
  return { staticRoutes, dynamic };
}

interface Link {
  from: string;
  href: string;
}

/** Literal same-site hrefs. Anything script-built is deliberately skipped. */
function linksOf(site: string): Link[] {
  const root = resolve(REPO_ROOT, 'apps', site, 'src', 'pages');
  const out: Link[] = [];
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/href="(\/[^"]*)"/g)) {
      const raw = m[1] ?? '';
      // Script-built or templated: not resolvable without evaluating it.
      if (raw.includes("'") || raw.includes('+') || raw.includes('${') || raw.includes('`')) {
        continue;
      }
      // Protocol-relative is external.
      if (raw.startsWith('//')) continue;
      const href = (raw.split('#')[0] ?? '').split('?')[0] ?? '';
      if (href === '') continue;
      out.push({ from: relative(root, file), href: href.replace(/\/$/, '') || '/' });
    }
  }
  return out;
}

function unresolved(site: string): string[] {
  const { staticRoutes, dynamic } = routesOf(site);
  return linksOf(site)
    .filter(({ href }) => !staticRoutes.has(href) && !dynamic.some((re) => re.test(href)))
    .map(({ from, href }) => `${site}: ${href} <- ${from}`);
}

describe('every internal site link resolves to a page that exists', () => {
  it('CRITICAL the scan found real routes and real links on every site. Each assertion below reports an ABSENCE, so a matcher that stopped finding links would satisfy them having checked nothing.', () => {
    // MEASURED per site rather than assumed, because the counts differ by an
    // order of magnitude and a single floor is either useless or wrong:
    // marketing 230, dashboard 49, docs 48, status 8, admin-panel 4. The
    // admin panel is low because most of its links ARE script-built, which is
    // the case this guard deliberately skips.
    const MIN_LINKS: Record<string, number> = {
      'marketing-site': 150,
      docs: 30,
      'customer-dashboard': 30,
      'admin-panel': 3,
      'status-site': 5,
    };
    for (const site of SITES) {
      const { staticRoutes, dynamic } = routesOf(site);
      expect(staticRoutes.size + dynamic.length, `${site} routes discovered`).toBeGreaterThan(4);
      expect(linksOf(site).length, `${site} literal internal links found`).toBeGreaterThanOrEqual(
        MIN_LINKS[site] ?? 3,
      );
    }
    const total = SITES.reduce((n, s) => n + linksOf(s).length, 0);
    expect(total, 'literal internal links across all sites').toBeGreaterThan(250);

    // The resolver, on cases whose verdict is not in doubt. `docs` has both a
    // nested route and an index, which is where an off-by-one in the index
    // handling would show up.
    const docs = routesOf('docs');
    expect(docs.staticRoutes.has('/'), 'the docs index resolves to /').toBe(true);
    expect(docs.staticRoutes.has('/does-not-exist'), 'a made-up route does not resolve').toBe(
      false,
    );
  });

  it('CRITICAL no internal link points at a route no site file produces. A renamed page leaves the old link behind, and the only symptom is a 404 on a customer-facing page — nothing errors and nothing is logged.', () => {
    const broken = SITES.flatMap((site) => unresolved(site));
    expect(broken, 'internal link(s) pointing at a non-existent route:').toEqual([]);
  });
});
