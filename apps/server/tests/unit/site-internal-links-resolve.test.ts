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
// FIRST-PARTY CROSS-SITE links are checked too, and that is the customer
// journey: marketing sends people to docs, docs sends them to the dashboard.
// The sites deploy to separate hosts, but all five apps live in this repo, so
// `https://docs.driftstack.dev/api/sessions` resolves against `apps/docs`.
// A dead link there is a dead end at the exact moment someone is trying to
// adopt the product. Third-party hosts (github, sentry, the payment providers)
// are not this check's subject and are skipped.
//
// `public/` is resolved as well as `src/pages`. Static files are real routes —
// `/.well-known/security.txt` is served from `public/` and is what a security
// researcher fetches to report a vulnerability. Without this the first cross-
// site pass reported it as broken, which was the resolver's blind spot rather
// than a defect.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const SITES = ['marketing-site', 'docs', 'customer-dashboard', 'admin-panel', 'status-site'];
const PAGE_EXTENSIONS = new Set(['.astro', '.md', '.mdx']);

/**
 * BOTH link syntaxes, because the sites use both and the split is not even.
 *
 * Measured: docs carries 219 markdown links against 48 HTML hrefs, so an
 * href-only matcher checked 18% of that site and 58% of the corpus overall.
 * That is the same failure the docs-example guard had — matching the minority
 * spelling of a convention and reporting the result as coverage — so the
 * pattern is written once here and reused by both extractors.
 */
const SAME_SITE_LINK = /href="(\/[^"]*)"|\]\((\/[^)\s]*)\)/g;
const CROSS_SITE_LINK = /href="https?:\/\/([^/"]+)([^"]*)"|\]\(https?:\/\/([^)/\s]+)([^)\s]*)\)/g;

/**
 * First-party hosts, mapped to the app in this repo that serves them.
 *
 * `api.driftstack.dev` is deliberately absent: it is the Fastify server, not a
 * page app, and its surface is covered by the OpenAPI route-coverage
 * invariants. Staging is absent for the same reason plus impermanence.
 */
const FIRST_PARTY_HOSTS: Record<string, string> = {
  'driftstack.dev': 'marketing-site',
  'docs.driftstack.dev': 'docs',
  'app.driftstack.dev': 'customer-dashboard',
  'status.driftstack.dev': 'status-site',
};

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
  // Static assets are routes too: anything under `public/` is served verbatim.
  const publicRoot = resolve(REPO_ROOT, 'apps', site, 'public');
  for (const file of walkAll(publicRoot)) {
    staticRoutes.add(`/${relative(publicRoot, file)}`.replace(/\/$/, ''));
  }
  return { staticRoutes, dynamic };
}

/** Every file under a directory, whatever its extension. */
function walkAll(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkAll(full));
    else out.push(full);
  }
  return out;
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
    for (const m of text.matchAll(SAME_SITE_LINK)) {
      const raw = m[1] ?? m[2] ?? '';
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

interface CrossLink {
  from: string;
  host: string;
  path: string;
}

/** Literal absolute links from one site into another first-party app. */
function crossSiteLinksOf(site: string): CrossLink[] {
  const root = resolve(REPO_ROOT, 'apps', site, 'src', 'pages');
  const out: CrossLink[] = [];
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(CROSS_SITE_LINK)) {
      const host = m[1] ?? m[3] ?? '';
      const raw = m[2] ?? m[4] ?? '';
      if (FIRST_PARTY_HOSTS[host] === undefined) continue;
      if (raw.includes("'") || raw.includes('+') || raw.includes('${') || raw.includes('`')) {
        continue;
      }
      const path = ((raw.split('#')[0] ?? '').split('?')[0] ?? '').replace(/\/$/, '') || '/';
      out.push({ from: relative(root, file), host, path });
    }
  }
  return out;
}

function unresolvedCrossSite(site: string): string[] {
  return crossSiteLinksOf(site)
    .filter(({ host, path }) => {
      const target = FIRST_PARTY_HOSTS[host] ?? '';
      const { staticRoutes, dynamic } = routesOf(target);
      return !staticRoutes.has(path) && !dynamic.some((re) => re.test(path));
    })
    .map(({ from, host, path }) => `${site}: ${host}${path} <- ${from}`);
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
    // docs 267, marketing 264, dashboard 49, status 8, admin-panel 4. The admin
    // panel is low because most of its links ARE script-built, which is the
    // case this guard deliberately skips.
    //
    // Docs moved from 48 to 267 when the markdown syntax was added — it is a
    // markdown site, so an href-only matcher was reading 18% of it. Floors are
    // set against the post-fix numbers so that regression is visible if the
    // matcher ever narrows again.
    const MIN_LINKS: Record<string, number> = {
      'marketing-site': 200,
      docs: 200,
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
    expect(total, 'literal internal links across all sites').toBeGreaterThan(500);

    // The resolver, on cases whose verdict is not in doubt. `docs` has both a
    // nested route and an index, which is where an off-by-one in the index
    // handling would show up.
    const docs = routesOf('docs');
    expect(docs.staticRoutes.has('/'), 'the docs index resolves to /').toBe(true);
    expect(docs.staticRoutes.has('/does-not-exist'), 'a made-up route does not resolve').toBe(
      false,
    );
  });

  it('CRITICAL every FIRST-PARTY cross-site link resolves against the app that serves it. This is the adoption path — marketing sends people to docs, docs sends them to the dashboard — so a dead link here is a dead end at the moment someone is trying to use the product.', () => {
    const total = SITES.reduce((n, s) => n + crossSiteLinksOf(s).length, 0);
    // MEASURED: 120 first-party cross-site links, up from 83 when the markdown
    // syntax was added.
    expect(total, 'first-party cross-site links found').toBeGreaterThan(100);
    expect(
      SITES.flatMap((site) => unresolvedCrossSite(site)),
      'cross-site link(s) pointing at a page the target app does not serve:',
    ).toEqual([]);
  });

  it('CRITICAL no internal link points at a route no site file produces. A renamed page leaves the old link behind, and the only symptom is a 404 on a customer-facing page — nothing errors and nothing is logged.', () => {
    const broken = SITES.flatMap((site) => unresolved(site));
    expect(broken, 'internal link(s) pointing at a non-existent route:').toEqual([]);
  });
});
