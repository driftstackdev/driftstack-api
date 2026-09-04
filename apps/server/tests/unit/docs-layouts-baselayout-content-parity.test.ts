// Drift guard for apps/docs/src/layouts/BaseLayout.astro. Pins the
// V-250 mirrors-marketing-site framing + the SEO meta tag shape +
// the canonical URL derivation + the title suffix pattern.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/layouts/BaseLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs layouts/BaseLayout content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('V-250 doc-comment framing pinned: mirrors apps/marketing-site/BaseLayout for brand consistency. Drift would orphan the engineering anchor for the brand-consistency contract between docs + marketing', () => {
    expect(body).toMatch(
      /\/\/ V-250 — docs site BaseLayout\. Mirrors apps\/marketing-site\/BaseLayout/,
    );
    expect(body).toMatch(/for brand consistency/);
  });

  it('Props contract pinned: title (required) + description (optional, default) + pathname (optional, falls back to Astro.url.pathname). Drift to a different shape would break every page that wraps in BaseLayout', () => {
    expect(body).toMatch(
      /interface Props \{\s*title: string;\s*description\?: string;\s*pathname\?: string;\s*\}/,
    );
  });

  it('Default description pinned: customer-facing tagline. Drift to a generic description would weaken every docs-page social card + the description meta tag', () => {
    expect(body).toMatch(
      /description = 'Driftstack documentation: API reference, SDK guides, self-hosted GUI client\.'/,
    );
  });

  it("Title-suffix pattern pinned: '<title> · Driftstack docs' EXCEPT when title IS 'Driftstack docs' (avoids 'Driftstack docs · Driftstack docs' on the homepage). Drift to dropping the special-case would create the visual stutter", () => {
    expect(body).toMatch(
      /const fullTitle = title === 'Driftstack docs' \? title : `\$\{title\} · Driftstack docs`;/,
    );
  });

  it('Canonical URL derivation pinned: new URL(pathname, Astro.site). Drift would either drop the canonical or compute it wrong, harming SEO crawl-equity routing', () => {
    expect(body).toMatch(/const canonical = new URL\(pathname, Astro\.site\)\.toString\(\);/);
    expect(body).toMatch(/<link rel="canonical" href=\{canonical\} \/>/);
  });

  it('SEO meta tag shape pinned: robots index,follow + og:type website + og:site_name "Driftstack docs" + twitter summary_large_image. Drift to robots noindex would silently de-index docs from search; drift to dropping og tags would break LinkedIn / Twitter share previews', () => {
    expect(body).toMatch(/<meta name="robots" content="index,follow" \/>/);
    expect(body).toMatch(/<meta property="og:type" content="website" \/>/);
    expect(body).toMatch(/<meta property="og:site_name" content="Driftstack docs" \/>/);
    expect(body).toMatch(/<meta name="twitter:card" content="summary_large_image" \/>/);
  });

  it('og:image + twitter:image point at the marketing-site PNG card (per the V-250 "OG images point at the marketing site default" comment). A summary_large_image twitter:card with NO image renders no preview, so these must be present + must be the PNG (SVG og:images are not rendered by Twitter/X, Facebook, LinkedIn, Slack)', () => {
    expect(body).toMatch(
      /<meta property="og:image" content="https:\/\/driftstack\.io\/og-default\.png" \/>/,
    );
    expect(body).toMatch(/<meta property="og:image:width" content="1200" \/>/);
    expect(body).toMatch(/<meta property="og:image:height" content="630" \/>/);
    expect(body).toMatch(
      /<meta name="twitter:image" content="https:\/\/driftstack\.io\/og-default\.png" \/>/,
    );
  });

  it('Favicon + base.css imports pinned: drift would break the docs-site visual identity or strip the brand-mark from browser tabs', () => {
    expect(body).toMatch(/import '\.\.\/styles\/base\.css';/);
    expect(body).toMatch(
      /<link rel="icon" type="image\/svg\+xml" href="\/driftstack-mark\.svg\?v=4" \/>/,
    );
  });

  it('S22.1 (2026-07-06) — Fleet mode/accent axes LIVE on <html>: dark+oxblood founder-locked default + dark theme-color meta (#060608; iOS Safari status-bar tint). Drift to dropping either attribute would strand every tk-* token on its fallback', () => {
    expect(body).toMatch(/<html lang="en" data-mode="dark" data-accent="oxblood">/);
    expect(body).toMatch(/<meta name="theme-color" content="#060608" \/>/);
  });

  it('S22.1 — pre-paint theme script pinned: is:inline, reads ds_theme_mode, WHITELISTED value check (never raw localStorage into a DOM attribute), swaps theme-color to #f2f3f6 on light, no prefers-color-scheme (dark first impression is the brand). Body must be RAW code — a template-literal-wrapped body ships as a dead no-op string (2026-07-02 bug class)', () => {
    expect(body).toMatch(/<script is:inline>/);
    expect(body).toMatch(/var m = localStorage\.getItem\('ds_theme_mode'\);/);
    expect(body).toMatch(/if \(m === 'light' \|\| m === 'dark'\) \{/);
    expect(body).toMatch(/document\.documentElement\.setAttribute\('data-mode', m\);/);
    expect(body).toMatch(/mt\.setAttribute\('content', '#f2f3f6'\);/);
    // The dead-inline-script trap: no template-literal expression wrapper.
    expect(body).not.toMatch(/<script is:inline>\s*\{`/);
    expect(body).not.toMatch(/is:inline>\s*\{\s*`/);
  });

  it('S22.1 — mode-toggle wiring pinned: one delegated [data-theme-toggle] listener at body end flips data-mode, syncs the theme-color meta, persists to ds_theme_mode (try/catch — persistence-unavailable still toggles this visit)', () => {
    expect(body).toMatch(/e\.target\.closest\('\[data-theme-toggle\]'\)/);
    expect(body).toMatch(
      /document\.documentElement\.getAttribute\('data-mode'\) === 'dark' \? 'light' : 'dark';/,
    );
    expect(body).toMatch(/document\.documentElement\.setAttribute\('data-mode', next\);/);
    expect(body).toMatch(
      /mt\.setAttribute\('content', next === 'light' \? '#f2f3f6' : '#060608'\);/,
    );
    expect(body).toMatch(/localStorage\.setItem\('ds_theme_mode', next\);/);
  });

  it('S22.1 — self-hosted font preloads pinned (Geist VF + JetBrains Mono Regular, crossorigin — fonts always need it even same-origin) + tk token body classes. Drift to dropping a preload re-introduces the system-font flash on first paint', () => {
    expect(body).toMatch(
      /<link rel="preload" href="\/fonts\/geist\/GeistVF\.woff2" as="font" type="font\/woff2" crossorigin \/>/,
    );
    expect(body).toMatch(/href="\/fonts\/jetbrains-mono\/JetBrainsMono-Regular\.woff2"/);
    expect(body).toMatch(/<body class="flex min-h-screen flex-col bg-tk-bg text-tk-ink">/);
  });

  it('S22.3 (2026-07-06) — Pagefind search modal markup pinned: hidden-by-default [data-search-modal] overlay with a [data-search-backdrop] scrim, role=dialog aria-modal=true dialog, and the combobox/listbox pattern (role=combobox input with aria-controls + aria-activedescendant + aria-autocomplete=list; role=listbox results ul restyling Pagefind <mark> highlights to the accent wash + AA accent-text via [&_mark] variants; role=status live line). Drift on the ARIA shape would break screen-reader operability of search', () => {
    expect(body).toMatch(/<div data-search-modal hidden class="fixed inset-0 z-50">/);
    expect(body).toMatch(/data-search-backdrop/);
    expect(body).toMatch(/role="dialog"\s*aria-modal="true"\s*aria-label="Search documentation"/);
    expect(body).toMatch(/data-search-input\s*type="text"\s*role="combobox"/);
    expect(body).toMatch(/aria-controls="docs-search-results"/);
    expect(body).toMatch(/aria-activedescendant=""/);
    expect(body).toMatch(/aria-autocomplete="list"/);
    expect(body).toMatch(/id="docs-search-results"\s*data-search-results\s*role="listbox"/);
    expect(body).toMatch(/\[&_mark\]:bg-tk-accent-soft/);
    expect(body).toMatch(/\[&_mark\]:text-tk-accent-text/);
    expect(body).toMatch(/data-search-status\s*role="status"/);
    expect(body).toMatch(/Type to search the docs\./);
  });

  it('S22.3 (2026-07-06) — search script behavior pinned: LAZY native dynamic import of /pagefind/pagefind.js on first open (fully local — the index is emitted by the postbuild `pagefind --site dist` step; no external hosts, no tracker), astro-dev grace (failed import → "index is generated when the site builds" empty state, never a throw), ⌘K/Ctrl-K toggle + "/" shortcut outside editable fields, focus trap (Tab refocuses the input) + focus restore to the opener, ArrowUp/ArrowDown + Enter keyboard result navigation, Esc + backdrop-click close, and section context derived from the result URL. Body must be RAW code — a template-literal-wrapped body ships as a dead no-op string (2026-07-02 bug class; the not-match guards in the S22.1 pre-paint pin above cover every is:inline script in this file)', () => {
    expect(body).toMatch(/import\('\/pagefind\/pagefind\.js'\)/);
    expect(body).toMatch(/loadFailed = true;/);
    expect(body).toMatch(
      /The search index is generated when the site builds — run a full build to search here\./,
    );
    expect(body).toMatch(
      /\(e\.metaKey \|\| e\.ctrlKey\) && !e\.altKey && !e\.shiftKey && \(e\.key === 'k' \|\| e\.key === 'K'\)/,
    );
    expect(body).toMatch(/e\.key === '\/' && !e\.metaKey && !e\.ctrlKey && !e\.altKey/);
    expect(body).toMatch(
      /tag === 'INPUT' \|\| tag === 'TEXTAREA' \|\| tag === 'SELECT' \|\| \(t && t\.isContentEditable\)/,
    );
    expect(body).toMatch(/lastFocus = document\.activeElement;/);
    expect(body).toMatch(/if \(lastFocus && lastFocus\.focus\) lastFocus\.focus\(\);/);
    expect(body).toMatch(/if \(e\.key === 'Tab'\) \{/);
    expect(body).toMatch(/if \(e\.key === 'ArrowDown'\) \{/);
    expect(body).toMatch(/if \(e\.key === 'ArrowUp'\) \{/);
    expect(body).toMatch(/setActive\(\(activeIndex \+ 1\) % items\.length\)/);
    expect(body).toMatch(/setActive\(\(activeIndex - 1 \+ items\.length\) % items\.length\)/);
    expect(body).toMatch(/input\.setAttribute\('aria-activedescendant', el\.id\);/);
    expect(body).toMatch(/backdrop\.addEventListener\('click', close\);/);
    expect(body).toMatch(/pf\.search\(query\)/);
    expect(body).toMatch(/\.slice\(0, 10\)/);
    expect(body).toMatch(/excerpt\.innerHTML = data\.excerpt \|\| '';/);
    expect(body).toMatch(/function sectionOf\(url\)/);
    // The [data-search-kbd] hint swaps to Ctrl K off-Apple platforms.
    expect(body).toMatch(/k\.textContent = 'Ctrl K';/);
  });

  it("S35 2026-07-07 (fable-frontend-audit) — search rejection handling pinned: the runSearch chain (pf.search + fragment r.data() Promise.all) carries a .catch that surfaces 'Search hit a snag — press Enter to try again.' instead of leaving the status stuck on 'Searching…' when a redeploy rotates the hashed /pagefind/ chunk URLs or the connection blips; Enter with no active result re-runs the query (keyboard retry path); the astro-dev missing-index DEV_MSG state stays distinct (loadFailed short-circuits the retry)", () => {
    expect(body).toMatch(/pf\.search\(query\)\s*\.then\(/);
    expect(body).toMatch(/\.catch\(function \(\) \{/);
    expect(body).toMatch(/clearResults\('Search hit a snag — press Enter to try again\.'\);/);
    // Enter retry path: no active result + non-empty query + index loaded.
    expect(body).toMatch(/var retryQ = input\.value\.trim\(\);/);
    expect(body).toMatch(
      /if \(retryQ && !loadFailed\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*status\.textContent = 'Searching…';\s*\n\s*runSearch\(retryQ\);/,
    );
  });
});
