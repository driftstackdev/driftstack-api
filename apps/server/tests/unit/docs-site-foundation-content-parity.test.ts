// W599 — drift guard for apps/docs/src foundation modules.
// Footer + Header + BaseLayout + DocLayout + 404 in one suite — these
// 5 files compose the docs-site chrome that every page wraps with.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const FOOTER = resolve(REPO_ROOT, 'apps/docs/src/components/Footer.astro');
const HEADER = resolve(REPO_ROOT, 'apps/docs/src/components/Header.astro');
const BASE = resolve(REPO_ROOT, 'apps/docs/src/layouts/BaseLayout.astro');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/layouts/DocLayout.astro');
const NOT_FOUND = resolve(REPO_ROOT, 'apps/docs/src/pages/404.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W599 apps/docs foundation modules content parity', () => {
  it('Footer.astro: V-250 framing + brand badge + cross-link to marketing/pricing/security + support@driftstack.dev mailto + year auto-update pinned', () => {
    const body = read(FOOTER);
    expect(body).toMatch(
      /\/\/ V-250 — docs site footer\. Lighter-weight than marketing-site Footer/,
    );
    expect(body).toMatch(
      /\/\/ \(no "Product\/Company\/Trust\/Legal" full grid\) since docs\.driftstack\.io/,
    );
    expect(body).toMatch(
      /\/\/ is a focused reference surface; primary navigation is the docs tree\./,
    );
    expect(body).toMatch(/\/\/ Cross-links back to marketing for the full company navigation\./);
    expect(body).toMatch(/^const year = new Date\(\)\.getUTCFullYear\(\);$/m);
    // S22.1 (2026-07-06) — tk-* tokens: STACK = AA-safe accent-text tone.
    expect(body).toMatch(/DRIFT<span class="text-tk-accent-text">STACK<\/span>/);
    expect(body).toMatch(/<span class="ml-1 text-xs text-tk-ink-3">docs<\/span>/);
    expect(body).toMatch(
      /Reference \+ guides for the Driftstack API, SDKs, and self-hosted client\./,
    );
    expect(body).toMatch(/href="https:\/\/driftstack\.io"/);
    expect(body).toMatch(/href="https:\/\/driftstack\.io\/pricing\/"/);
    expect(body).toMatch(/href="https:\/\/driftstack\.io\/security\/"/);
    expect(body).not.toMatch(/href="https:\/\/driftstack\.io\/(?:pricing|security)"/);
    expect(body).toMatch(/href="mailto:support@driftstack\.dev"/);
    expect(body).toMatch(/&copy; \{year\} Driftstack\./);
    expect(existsSync(FOOTER)).toBe(true);
  });

  it('Header.astro: V-250 framing + 5-item navItems (Overview/API/SDKs/Guides/Marketing-external) + isActive function + brand badge + mobile details/summary nav pinned', () => {
    const body = read(HEADER);
    expect(body).toMatch(/\/\/ V-250 — docs site header\. Mirrors marketing-site Header pattern/);
    expect(body).toMatch(/\/\/ for brand consistency: oxblood D-badge \+ lowercase font-mono/);
    expect(body).toMatch(/\/\/ "driftstack" wordmark, "docs" subtitle to disambiguate cross-app\./);
    expect(body).toMatch(
      /^const navItems = \[\s*\n\s*\{ href: '\/', label: 'Overview' \},\s*\n\s*\{ href: '\/api\/', label: 'API' \},\s*\n\s*\{ href: '\/sdk\/', label: 'SDKs' \},\s*\n\s*\{ href: '\/guides\/', label: 'Guides' \},\s*\n\s*\{ href: 'https:\/\/driftstack\.io', label: 'Marketing site', external: true \},\s*\n\];/m,
    );
    expect(body).toMatch(/function isActive\(href: string\): boolean \{/);
    expect(body).toMatch(/if \(href === '\/'\) return pathname === '\/';/);
    expect(body).toMatch(/return pathname\.startsWith\(href\);/);
    expect(body).toMatch(/aria-label="Open navigation menu"/);
    expect(existsSync(HEADER)).toBe(true);
  });

  it('BaseLayout.astro: V-250 + Props (title required + description + pathname) + fullTitle suffix + canonical URL + OG/Twitter meta + inline SVG favicon (oxblood D) pinned', () => {
    const body = read(BASE);
    expect(body).toMatch(
      /\/\/ V-250 — docs site BaseLayout\. Mirrors apps\/marketing-site\/BaseLayout/,
    );
    expect(body).toMatch(
      /\/\/ for brand consistency; OG images point at the marketing site default/,
    );
    expect(body).toMatch(/\/\/ since docs pages don't have their own social cards yet\./);
    expect(body).toMatch(
      /^interface Props \{\s*\n\s*title: string;\s*\n\s*description\?: string;\s*\n\s*pathname\?: string;\s*\n\}/m,
    );
    expect(body).toMatch(
      /description = 'Driftstack documentation: API reference, SDK guides, self-hosted GUI client\.',/,
    );
    expect(body).toMatch(
      /const fullTitle = title === 'Driftstack docs' \? title : `\$\{title\} · Driftstack docs`;/,
    );
    expect(body).toMatch(/const canonical = new URL\(pathname, Astro\.site\)\.toString\(\);/);
    expect(body).toMatch(/<meta name="robots" content="index,follow" \/>/);
    expect(body).toMatch(/<meta property="og:site_name" content="Driftstack docs" \/>/);
    expect(body).toMatch(/<meta name="twitter:card" content="summary_large_image" \/>/);
    // R15 — docs favicon swapped from the inline Georgia-serif D
    // data-URL placeholder to the real /driftstack-mark.svg brand
    // asset.
    expect(body).toMatch(
      /<link rel="icon" type="image\/svg\+xml" href="\/driftstack-mark\.svg(\?v=\d+)?" \/>/,
    );
    expect(existsSync(BASE)).toBe(true);
  });

  it('DocLayout.astro: V-254 wraps BaseLayout + sidebar nav (DOC_NAV) + content column with prose styling (violet/accent links + dark fenced code) + frontmatter contract (title required + optional description) pinned', () => {
    const body = read(DOC);
    expect(body).toMatch(
      /\/\/ V-254 — doc-page layout\. Wraps BaseLayout with a sidebar nav \(from/,
    );
    expect(body).toMatch(
      /\/\/ `data\/nav\.ts`\) and a content column\. Used as `layout:` frontmatter/,
    );
    expect(body).toMatch(/\/\/ in `\.md` doc pages so markdown content renders into the slot with/);
    expect(body).toMatch(/\/\/ the doc-site brand chrome around it\./);
    expect(body).toMatch(/\/\/ Frontmatter contract: pages set `title` \(required\), optionally/);
    expect(body).toMatch(/\/\/ `description` \(overrides BaseLayout default\)\./);
    expect(body).toMatch(/^import \{ DOC_NAV \} from '\.\.\/data\/nav';$/m);
    expect(body).toMatch(/frontmatter\?: \{ title: string; description\?: string \};/);
    expect(body).toMatch(
      /const title = props\.frontmatter\?\.title \?\? props\.title \?\? 'Driftstack docs';/,
    );
    expect(body).toMatch(
      /return pathname === href \|\| pathname === href\.replace\(\/\\\/\$\/, ''\);/,
    );
    expect(body).toMatch(/DOC_NAV\.map\(\(section\) => \(/);
    // S22.1 (2026-07-06, brand-parity port) — tk-token-driven prose
    // (supersedes the R11 prose-slate stack): color hooks live in
    // base.css as un-layered .prose --tw-prose-* overrides reading the
    // mode-scoped tk tokens; still NOT prose-invert, and fenced code
    // stays a DARK terminal in BOTH modes (--code-bg; founder-pinned).
    // S22.2 (2026-07-06, Stoplight three-pane relayout) — flex-1
    // dropped from the article class (the grid column sizes the pane);
    // max-w-3xl keeps the reading measure. Shell/tree/rail pins live in
    // docs-layouts-doclayout-content-parity.
    expect(body).toMatch(/prose max-w-3xl/);
    expect(body).toMatch(/max-w-\[90rem\]/);
    expect(body).toMatch(/<details open class="group" data-nav-section>/);
    expect(body).not.toMatch(/prose-invert/);
    expect(body).not.toMatch(/prose-slate/);
    expect(body).toMatch(/prose-code:bg-tk-accent-soft/);
    expect(body).toMatch(/--tw-prose-pre-bg: var\(--code-bg\)/);
    expect(body).toMatch(/'bg-tk-accent-soft text-tk-accent-text'/);
    expect(existsSync(DOC)).toBe(true);
  });

  it('404.astro: wraps BaseLayout with "Page not found" title + CTA to overview + GitHub docs/ tree link + concise message pinned', () => {
    const body = read(NOT_FOUND);
    expect(body).toMatch(/^import BaseLayout from '\.\.\/layouts\/BaseLayout\.astro';$/m);
    expect(body).toMatch(/<BaseLayout title="Page not found">/);
    expect(body).toMatch(/<h1 class="text-4xl font-semibold text-tk-ink">Page not found<\/h1>/);
    expect(body).toMatch(
      /The page you're looking for might have moved as the docs site is built out\./,
    );
    // S22.1 (2026-07-06) — links use tk-accent-text (the AA-safe accent
    // text tone per mode; was the legacy glow-red alias).
    expect(body).toMatch(/<a href="\/" class="text-tk-accent-text hover:underline">overview<\/a>/);
    expect(body).toMatch(
      /href="https:\/\/github\.com\/driftstackdev\/driftstack-api\/tree\/main\/docs"/,
    );
    expect(body).toMatch(/repository docs\/ tree<\/a/);
    expect(existsSync(NOT_FOUND)).toBe(true);
  });
});
