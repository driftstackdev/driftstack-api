// W530 — every internal href in the customer-dashboard resolves to a real page.
//
// Completes the frontend-wiring guard trifecta: W481 covered fetch()→route,
// W472 covered email→page, this covers in-app <a href> → page (the class the
// other two miss — e.g. login's "Sign in with a magic link instead" link).
// A nav/CTA pointing at a renamed/removed page 404s silently for a customer.
//
// Verified W530: 32 pages, 16 distinct internal hrefs, 0 missing.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
/**
 * The Astro apps whose internal links this guard resolves.
 *
 * customer-dashboard was the only one until 2026-08-16. admin-panel and
 * status-site route the same way and had no link guard at all — marketing-site
 * and apps/docs have their own, which handle documentation-specific link shapes
 * this one does not. A broken href in the status page is a 404 on the most
 * public surface we run.
 *
 * Each app is resolved SEPARATELY. Merging the page sets would let a dashboard
 * page satisfy an admin-panel link: every href would still "have a page file",
 * in a different application.
 */
const APPS = ['customer-dashboard', 'admin-panel', 'status-site'] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.astro$/.test(name)) out.push(p);
  }
  return out;
}

interface AppLinks {
  readonly app: string;
  readonly provided: ReadonlySet<string>;
  readonly hrefs: ReadonlySet<string>;
}

function linksFor(app: string): AppLinks {
  const dir = resolve(REPO_ROOT, `apps/${app}/src/pages`);
  const pages = walk(dir);

  // Route paths the page files provide ("/team/accept", "/", ...).
  const provided = new Set<string>();
  for (const p of pages) {
    const r =
      p
        .replace(dir, '')
        .replace(/\.astro$/, '')
        .replace(/\/index$/, '') || '/';
    provided.add(r === '' ? '/' : r);
  }

  // Distinct same-app hrefs referenced from page markup (path-only; /v1 API
  // paths are the fetch guard's concern, not this one's).
  const hrefs = new Set<string>();
  for (const p of pages) {
    const body = readFileSync(p, 'utf8');
    for (const m of body.matchAll(/href="(\/[a-z0-9\-/]*)"/g)) {
      const h = (m[1] ?? '').replace(/\/$/, '') || '/';
      if (!h.startsWith('/v1')) hrefs.add(h);
    }
  }
  return { app, provided, hrefs };
}

const APP_LINKS = APPS.map(linksFor);

describe('W530 internal hrefs resolve to pages, per app', () => {
  const dashboard = APP_LINKS.find((a) => a.app === 'customer-dashboard');
  const provided = dashboard?.provided ?? new Set<string>();
  const hrefs = dashboard?.hrefs ?? new Set<string>();

  it('every app was scanned and produced pages and hrefs. A root that resolved to nothing would report every href resolving, having found no hrefs at all.', () => {
    expect(APP_LINKS.length, 'apps scanned').toBe(APPS.length);
    for (const { app, provided: p, hrefs: h } of APP_LINKS) {
      // MEASURED: dashboard 23 pages / 13 hrefs, admin-panel 15 / 4,
      // status-site 6 / 3.
      expect(p.size, `${app}: page files found`).toBeGreaterThanOrEqual(5);
      expect(h.size, `${app}: internal hrefs found`).toBeGreaterThanOrEqual(3);
    }
  });

  it('every internal href resolves WITHIN ITS OWN APP. These are separate deployments — customer-dashboard, admin-panel and the public status page each ship alone — so a page in one cannot answer a link in another.', () => {
    const missing: string[] = [];
    for (const { app, provided: p, hrefs: h } of APP_LINKS) {
      for (const href of h) {
        const base = href.split('?')[0] ?? href;
        if (p.has(base)) continue;
        const dynamic = [...p].some(
          (e) => e.includes('[') && base.startsWith(e.split('[')[0] ?? ''),
        );
        if (!dynamic) missing.push(`${app}: ${base}`);
      }
    }
    expect(missing.sort(), 'app link(s) with no page file (silent 404):').toEqual([]);
  });

  it('finds pages and hrefs to check', () => {
    // 2026-07-02 — floor lowered 25→20 with the account-portal IA
    // (redesign slice 2): the 9 operational pages (profiles/snapshots/
    // sessions/agent-sessions[+/[id]]/recipes[+/[id]]/proxies/first-session)
    // moved to the desktop GUI, leaving 23 dashboard pages.
    expect(provided.size).toBeGreaterThanOrEqual(20);
    expect(hrefs.size).toBeGreaterThanOrEqual(10);
  });

  it('every internal href has a page file', () => {
    const missing = [...hrefs]
      .filter((h) => {
        const base = h.split('?')[0] ?? h;
        if (provided.has(base)) return false;
        // Dynamic segments: /foo/[id].astro provides /foo/<anything>.
        return ![...provided].some(
          (e) => e.includes('[') && base.startsWith(e.split('[')[0] ?? ''),
        );
      })
      .sort();
    expect(
      missing,
      `dashboard links to these paths but no page file exists (silent 404):\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});
