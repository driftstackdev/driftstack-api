// S19 (2026-07-06) — Breadcrumbs component + its adoption on the deep
// hierarchy pages (use-cases personas + trust subpages). One `items`
// array drives BOTH the visible <nav aria-label="Breadcrumb"> trail and
// the BreadcrumbList JSON-LD, so the rendered crumbs and the schema can
// never diverge. Also pins the additive PageHero `crumbs` slot.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/marketing-site/src');

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), 'utf8');
}

describe('S19 Breadcrumbs component + adoption', () => {
  it('Breadcrumbs.astro: single-source visible nav + BreadcrumbList schema from one items array', () => {
    const body = read('components/Breadcrumbs.astro');
    expect(existsSync(resolve(SRC, 'components/Breadcrumbs.astro'))).toBe(true);
    // the schema derives from the SAME items array the trail renders
    expect(body).toMatch(/'@type': 'BreadcrumbList',/);
    expect(body).toMatch(/itemListElement: items\.map\(\(c, i\) => \(\{/);
    expect(body).toMatch(/position: i \+ 1,/);
    // absolute item URLs, and the current (href-less) crumb carries no item
    expect(body).toMatch(
      /c\.href \? \{ item: new URL\(c\.href, Astro\.site\)\.toString\(\) \} : \{\}/,
    );
    // visible, accessible trail — final crumb is aria-current, not a link
    expect(body).toMatch(/<nav aria-label="Breadcrumb"/);
    expect(body).toMatch(/aria-current="page"/);
    expect(body).toMatch(
      /<script is:inline type="application\/ld\+json" set:html=\{JSON\.stringify\(breadcrumbLd\)\} \/>/,
    );
    // dead-inline-script trap guard (this is a set:html script, not a body)
    expect(body).not.toMatch(/<script[^>]*>\s*\{`/);
  });

  it('PageHero exposes an additive `crumbs` slot above the eyebrow', () => {
    expect(read('components/PageHero.astro')).toMatch(/<slot name="crumbs" \/>/);
  });

  it('every deep hierarchy page adopts Breadcrumbs with a Home root + its own final (link-less) crumb', () => {
    const pages: Array<[string, string]> = [
      ['pages/use-cases/index.astro', "{ name: 'Use cases' }"],
      ['pages/use-cases/multi-account.astro', "{ name: 'Multi-account operations' }"],
      ['pages/use-cases/qa-testing.astro', "{ name: 'QA + testing' }"],
      ['pages/use-cases/web-scraping.astro', "{ name: 'Web scraping' }"],
      ['pages/trust/security-overview.astro', "{ name: 'Security overview' }"],
      ['pages/trust/sub-processors.astro', "{ name: 'Sub-processors' }"],
      ['pages/trust/compliance.astro', "{ name: 'Compliance' }"],
      ['pages/trust/incidents.astro', "{ name: 'Incidents' }"],
      ['pages/trust/cumulative-rig.astro', "{ name: 'Cumulative rig' }"],
    ];
    for (const [page, finalCrumb] of pages) {
      const body = read(page);
      expect(body, `${page} imports Breadcrumbs`).toMatch(
        /import Breadcrumbs from '\.\.\/\.\.\/components\/Breadcrumbs\.astro';/,
      );
      expect(body, `${page} renders it in the crumbs slot`).toMatch(/<Breadcrumbs\s*slot="crumbs"/);
      expect(body, `${page} roots the trail at Home`).toMatch(/\{ name: 'Home', href: '\/' \}/);
      expect(body, `${page} ends on its own page (no href = current)`).toContain(finalCrumb);
    }
  });

  it('the use-cases personas nest under the /use-cases hub crumb; trust subpages under /trust', () => {
    for (const p of [
      'pages/use-cases/multi-account.astro',
      'pages/use-cases/qa-testing.astro',
      'pages/use-cases/web-scraping.astro',
    ]) {
      expect(read(p)).toContain("{ name: 'Use cases', href: '/use-cases/' }");
    }
    for (const p of [
      'pages/trust/security-overview.astro',
      'pages/trust/sub-processors.astro',
      'pages/trust/compliance.astro',
      'pages/trust/incidents.astro',
      'pages/trust/cumulative-rig.astro',
    ]) {
      expect(read(p)).toContain("{ name: 'Trust center', href: '/trust/' }");
    }
  });
});
