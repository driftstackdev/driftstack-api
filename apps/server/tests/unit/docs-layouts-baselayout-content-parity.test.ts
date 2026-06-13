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
      /interface Props \{\s*\n?\s*title: string;\s*\n?\s*description\?: string;\s*\n?\s*pathname\?: string;\s*\n?\s*\}/,
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
      /<meta property="og:image" content="https:\/\/driftstack\.dev\/og-default\.png" \/>/,
    );
    expect(body).toMatch(/<meta property="og:image:width" content="1200" \/>/);
    expect(body).toMatch(/<meta property="og:image:height" content="630" \/>/);
    expect(body).toMatch(
      /<meta name="twitter:image" content="https:\/\/driftstack\.dev\/og-default\.png" \/>/,
    );
  });

  it('Favicon + base.css imports pinned: drift would break the docs-site visual identity or strip the brand-mark from browser tabs', () => {
    expect(body).toMatch(/import '\.\.\/styles\/base\.css';/);
    expect(body).toMatch(
      /<link rel="icon" type="image\/svg\+xml" href="\/driftstack-mark\.svg\?v=3" \/>/,
    );
  });
});
