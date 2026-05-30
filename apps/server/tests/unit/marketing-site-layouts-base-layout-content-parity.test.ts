// W523.A — drift guard for apps/marketing-site/src/layouts/BaseLayout.astro.
// Site-wide SEO + OG + Twitter card scaffold. Drift here either changes
// social-share preview output (would create marketing↔social-platform
// preview divergence) or breaks the V-255 noindex flag (would
// accidentally let pre-counsel-review draft pages get indexed).
//
//   • V-255 noindex flag doc-comment + default-indexable framing.
//   • Default description: 'iPhone Safari sessions, on demand. Premium
//     fidelity for the device that matters.' canonical tagline.
//   • fullTitle: 'Driftstack' → 'Driftstack' (no suffix);
//     otherwise '<title> · Driftstack' (middle-dot separator).
//   • canonical = new URL(pathname, Astro.site).toString().
//   • ogImageUrl absolute-resolution via new URL(...) + /og-default.png
//     site-root fallback.
//   • OG/Twitter meta: og:type=website + og:image 1200x630 +
//     twitter:card=summary_large_image.
//   • Favicon as data:image/svg+xml URL with oxblood %23722F37 fill +
//     white 'D' Georgia-serif glyph (no external favicon.ico request).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/layouts/BaseLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W523.A apps/marketing-site/src/layouts/BaseLayout.astro content parity', () => {
  const body = read(LIB);

  it("V-255 noindex framing + default-indexable pinned: 'V-255 — set true on draft / pre-counsel-review pages so search engines don't index them as binding. Defaults to indexable.' + 'noindex?: boolean;' + default destructure 'noindex = false' + 'noindex ? \"noindex,nofollow\" : \"index,follow\"' robots meta — pinned so the V-255 anchor + draft-page noindex commitment + default-indexable + 4-value robots-meta survives", () => {
    expect(body).toMatch(
      /\* V-255 — set true on draft \/ pre-counsel-review pages so search\s*\n?\s*\* engines don't index them as binding\. Defaults to indexable\./,
    );
    expect(body).toMatch(/noindex\?: boolean;/);
    expect(body).toMatch(/noindex = false,/);
    expect(body).toMatch(
      /<meta name="robots" content=\{noindex \? 'noindex,nofollow' : 'index,follow'\} \/>/,
    );
  });

  it("ogImage per-page-override framing + /og-default.png fallback pinned: 'Optional per-page social-card image (absolute URL or `/`-rooted path). Defaults to the site-wide `/og-default.png` when not supplied. Pages that want a custom card pass it explicitly.' + 'ogImage?: string;' + 'Resolve OG image to an absolute URL so social crawlers can fetch it without the path-resolution headaches some platforms have with relative paths. Defaults to /og-default.png at the site root — Cloudflare Pages serves anything in apps/marketing-site/public/ at the root when build runs.' + 'const ogImageUrl = new URL(ogImage ?? \"/og-default.png\", Astro.site).toString();' — pinned so the per-page-override + /og-default.png-fallback + absolute-resolution + Cloudflare-Pages-public-mount commitment survives", () => {
    expect(body).toMatch(
      /\* Optional per-page social-card image \(absolute URL or `\/`-rooted\s*\n?\s*\* path\)\. Defaults to the site-wide `\/og-default\.png` when not\s*\n?\s*\* supplied\. Pages that want a custom card pass it explicitly\./,
    );
    expect(body).toMatch(/ogImage\?: string;/);
    expect(body).toMatch(
      /\/\/ Resolve OG image to an absolute URL so social crawlers can fetch it\s*\n?\s*\/\/ without the path-resolution headaches some platforms have with\s*\n?\s*\/\/ relative paths\. Defaults to \/og-default\.png at the site root —\s*\n?\s*\/\/ Cloudflare Pages serves anything in apps\/marketing-site\/public\/\s*\n?\s*\/\/ at the root when build runs\./,
    );
    expect(body).toMatch(
      /const ogImageUrl = new URL\(ogImage \?\? '\/og-default\.png', Astro\.site\)\.toString\(\);/,
    );
    // The PNG (not SVG) rationale is pinned so nobody silently reverts the
    // default to the SVG (which social crawlers don't render).
    expect(body).toMatch(/PNG, NOT SVG: Twitter\/X, Facebook,/);
    expect(body).toMatch(/scripts\/gen-og-image\.mjs/);
  });

  it("default-description tagline + fullTitle separator + canonical framing pinned: 'iPhone Safari sessions, on demand. Premium fidelity for the device that matters.' default description + 'const fullTitle = title === \"Driftstack\" ? title : `${title} · Driftstack`;' middle-dot separator + 'const canonical = new URL(pathname, Astro.site).toString();' — pinned so the canonical-tagline + Driftstack-no-suffix + middle-dot-title-separator + Astro.site-canonical commitment survives", () => {
    expect(body).toMatch(
      /description = 'iPhone Safari sessions, on demand\. Premium fidelity for the device that matters\.',/,
    );
    expect(body).toMatch(
      /const fullTitle = title === 'Driftstack' \? title : `\$\{title\} · Driftstack`;/,
    );
    expect(body).toMatch(/const canonical = new URL\(pathname, Astro\.site\)\.toString\(\);/);
  });

  it("4-prop interface + Astro.url.pathname-default framing pinned: 'title: string;' + 'description?: string;' + 'pathname?: string;' + 'pathname = Astro.url.pathname' destructure default — pinned so the 4-prop interface + Astro.url.pathname-fallback (current-page-by-default) commitment survives", () => {
    expect(body).toMatch(/title: string;/);
    expect(body).toMatch(/description\?: string;/);
    expect(body).toMatch(/pathname\?: string;/);
    expect(body).toMatch(/pathname = Astro\.url\.pathname,/);
  });

  it("OG + Twitter meta 11-tag framing pinned: 'OpenGraph (LinkedIn, Slack, iMessage, generic OG-aware crawlers)' comment + og:title + og:description + og:url + og:type=website + og:site_name=Driftstack + og:image + og:image:width=1200 + og:image:height=630 + 'Twitter / X' comment + twitter:card=summary_large_image + twitter:title + twitter:description + twitter:image — pinned so the full OG-tag-set + 1200x630-card-size + twitter:card=summary_large_image commitment survives (drift here would break social-share preview rendering)", () => {
    expect(body).toMatch(
      /<!-- OpenGraph \(LinkedIn, Slack, iMessage, generic OG-aware crawlers\) -->/,
    );
    expect(body).toMatch(/<meta property="og:title" content=\{fullTitle\} \/>/);
    expect(body).toMatch(/<meta property="og:description" content=\{description\} \/>/);
    expect(body).toMatch(/<meta property="og:url" content=\{canonical\} \/>/);
    expect(body).toMatch(/<meta property="og:type" content="website" \/>/);
    expect(body).toMatch(/<meta property="og:site_name" content="Driftstack" \/>/);
    expect(body).toMatch(/<meta property="og:image" content=\{ogImageUrl\} \/>/);
    expect(body).toMatch(/<meta property="og:image:width" content="1200" \/>/);
    expect(body).toMatch(/<meta property="og:image:height" content="630" \/>/);
    expect(body).toMatch(/<!-- Twitter \/ X -->/);
    expect(body).toMatch(/<meta name="twitter:card" content="summary_large_image" \/>/);
    expect(body).toMatch(/<meta name="twitter:title" content=\{fullTitle\} \/>/);
    expect(body).toMatch(/<meta name="twitter:description" content=\{description\} \/>/);
    expect(body).toMatch(/<meta name="twitter:image" content=\{ogImageUrl\} \/>/);
  });

  it('R15 favicon points at /driftstack-mark.svg (the real brand SVG shipped in apps/marketing-site/public/) — replaces the prior inline data-URL placeholder favicon (Georgia-serif white D on oxblood-722F37 tile). Drift to a different brand-mark source would create cross-page brand divergence', () => {
    expect(body).toMatch(/rel="icon"/);
    expect(body).toMatch(/type="image\/svg\+xml"/);
    expect(body).toMatch(/href="\/driftstack-mark\.svg(\?v=\d+)?"/);
  });

  it('doctype + viewport + canonical-link + Header/Footer-slot framing pinned: \'<!doctype html>\' + \'<html lang="en">\' + \'meta name="viewport" content="width=device-width, initial-scale=1"\' + \'link rel="canonical" href={canonical}\' + Header + main flex-1 + slot + Footer — pinned so the doctype + lang=en + viewport + canonical-link + Header/Footer-shell + main-slot commitment survives', () => {
    expect(body).toMatch(/<!doctype html>/);
    expect(body).toMatch(/<html lang="en" class="dark">/);
    expect(body).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
    expect(body).toMatch(/<link rel="canonical" href=\{canonical\} \/>/);
    expect(body).toMatch(/import Header from '\.\.\/components\/Header\.astro';/);
    expect(body).toMatch(/import Footer from '\.\.\/components\/Footer\.astro';/);
    expect(body).toMatch(/<Header \/>/);
    expect(body).toMatch(/<main\b[^>]*\bclass="flex-1">/);
    expect(body).toMatch(/<slot \/>/);
    expect(body).toMatch(/<Footer \/>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
