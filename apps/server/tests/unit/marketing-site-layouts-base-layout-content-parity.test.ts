// W523.A — drift guard for apps/marketing-site/src/layouts/BaseLayout.astro.
// Site-wide SEO + OG + Twitter card scaffold. Drift here either changes
// social-share preview output (would create marketing↔social-platform
// preview divergence) or breaks the V-255 noindex flag (would
// accidentally let pre-counsel-review draft pages get indexed).
//
//   • V-255 noindex flag doc-comment + default-indexable framing.
//   • Default description: the fleet-register tagline ("Real iPhone
//     Safari in the cloud — ... just people on phones.", S15 2026-07-03).
//   • fullTitle: any already-branded title stays verbatim;
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
      /\* V-255 — set true on draft \/ pre-counsel-review pages so search\s*\* engines don't index them as binding\. Defaults to indexable\./,
    );
    expect(body).toMatch(/noindex\?: boolean;/);
    expect(body).toMatch(/noindex = false,/);
    expect(body).toMatch(
      /<meta name="robots" content=\{noindex \? 'noindex,nofollow' : 'index,follow'\} \/>/,
    );
  });

  it("ogImage per-page-override framing + /og-default.png fallback pinned: 'Optional per-page social-card image (absolute URL or `/`-rooted path). Defaults to the site-wide `/og-default.png` when not supplied. Pages that want a custom card pass it explicitly.' + 'ogImage?: string;' + 'Resolve OG image to an absolute URL so social crawlers can fetch it without the path-resolution headaches some platforms have with relative paths. Defaults to /og-default.png at the site root — Cloudflare Pages serves anything in apps/marketing-site/public/ at the root when build runs.' + 'const ogImageUrl = new URL(ogImage ?? \"/og-default.png\", Astro.site).toString();' — pinned so the per-page-override + /og-default.png-fallback + absolute-resolution + Cloudflare-Pages-public-mount commitment survives", () => {
    expect(body).toMatch(
      /\* Optional per-page social-card image \(absolute URL or `\/`-rooted\s*\* path\)\. Defaults to the site-wide `\/og-default\.png` when not\s*\* supplied\. Pages that want a custom card pass it explicitly\./,
    );
    expect(body).toMatch(/ogImage\?: string;/);
    expect(body).toMatch(
      /\/\/ Resolve OG image to an absolute URL so social crawlers can fetch it\s*\/\/ without the path-resolution headaches some platforms have with\s*\/\/ relative paths\. Defaults to \/og-default\.png at the site root —\s*\/\/ Cloudflare Pages serves anything in apps\/marketing-site\/public\/\s*\/\/ at the root when build runs\./,
    );
    expect(body).toMatch(
      /const ogImageBase = new URL\(ogImage \?\? '\/og-default\.png', Astro\.site\)\.toString\(\);/,
    );
    // ?v=2 cache-bust on the site-wide default card only (immutable-1y edge
    // cache; dark+oxblood v2 art 2026-07-03) — per-page overrides untouched.
    expect(body).toMatch(/const ogImageUrl = ogImage \? ogImageBase : `\$\{ogImageBase\}\?v=2`;/);
    // The PNG (not SVG) rationale is pinned so nobody silently reverts the
    // default to the SVG (which social crawlers don't render).
    expect(body).toMatch(/PNG, NOT SVG: Twitter\/X, Facebook,/);
    expect(body).toMatch(/scripts\/gen-og-image\.mjs/);
  });

  it('default-description tagline + duplicate-brand-safe fullTitle + canonical framing pinned: already-branded titles stay verbatim, unbranded titles gain the middle-dot Driftstack suffix, and canonical URLs resolve against Astro.site', () => {
    // S15 2026-07-03 — the default description moves off the retired
    // "on demand / premium fidelity" tagline onto the fleet register
    // (mirrors the hero paragraph + the OG card subline).
    expect(body).toMatch(
      /description =\s*"Real iPhone Safari in the cloud — to every website, they're just people on phones\. Drive them by hand, by code, or by AI\. Start free\.",/,
    );
    expect(body).toMatch(
      /const fullTitle = title\.includes\('Driftstack'\) \? title : `\$\{title\} · Driftstack`;/,
    );
    expect(body).toMatch(/Preserve any already-branded title verbatim\./);
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
      /\{\/\* OpenGraph \(LinkedIn, Slack, iMessage, generic OG-aware crawlers\) \*\/\}/,
    );
    expect(body).toMatch(/<meta property="og:title" content=\{fullTitle\} \/>/);
    expect(body).toMatch(/<meta property="og:description" content=\{description\} \/>/);
    expect(body).toMatch(/<meta property="og:url" content=\{canonical\} \/>/);
    expect(body).toMatch(/<meta property="og:type" content="website" \/>/);
    expect(body).toMatch(/<meta property="og:site_name" content="Driftstack" \/>/);
    expect(body).toMatch(/<meta property="og:image" content=\{ogImageUrl\} \/>/);
    expect(body).toMatch(/<meta property="og:image:width" content="1200" \/>/);
    expect(body).toMatch(/<meta property="og:image:height" content="630" \/>/);
    expect(body).toMatch(/\{\/\* Twitter \/ X \*\/\}/);
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

  it('iOS apple-touch-icon points at the raster /apple-touch-icon.png — an SVG favicon alone leaves a blank/generic icon when driftstack.io is added to an iPhone home screen (iOS requires a PNG); on-brand for an iPhone-focused product', () => {
    expect(body).toMatch(/<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" \/>/);
  });

  it('visitor mode toggle pinned (S13 2026-07-03): a pre-paint is:inline script in <head> applies the WHITELISTED saved mode (ds_theme_mode, light|dark only — marketing does NOT expose the accent axis, and deliberately ignores prefers-color-scheme) + a body-end delegated listener wires every [data-theme-toggle] button and keeps the theme-color meta in sync. Both scripts are PLAIN CODE — the template-literal-in-expression-container form ships a dead no-op string (2026-07-02 bug class)', () => {
    // pre-paint: whitelisted read + attribute set
    expect(body).toMatch(/var m = localStorage\.getItem\('ds_theme_mode'\);/);
    expect(body).toMatch(/if \(m === 'light' \|\| m === 'dark'\) \{/);
    expect(body).toMatch(/document\.documentElement\.setAttribute\('data-mode', m\);/);
    // wiring: delegated toggle + persistence + theme-color sync
    expect(body).toMatch(/e\.target\.closest\('\[data-theme-toggle\]'\)/);
    expect(body).toMatch(/localStorage\.setItem\('ds_theme_mode', next\);/);
    expect(body).toMatch(/next === 'light' \? '#f2f3f6' : '#060608'/);
    // the dead-script wrapper must never appear before either script body
    expect(body).not.toMatch(/<script is:inline>\s*\{`/);
  });

  it('self-hosted font preloads pinned (Fleet v2 port 2026-07-03): GeistVF + JetBrainsMono-Regular woff2 preloaded as="font" with crossorigin so first paint does not flash the system stack longer than needed (font-display: swap in base.css)', () => {
    expect(body).toMatch(
      /<link rel="preload" href="\/fonts\/geist\/GeistVF\.woff2" as="font" type="font\/woff2" crossorigin \/>/,
    );
    expect(body).toMatch(/href="\/fonts\/jetbrains-mono\/JetBrainsMono-Regular\.woff2"/);
  });

  it('doctype + viewport + canonical-link + Header/Footer-slot framing pinned: \'<!doctype html>\' + \'<html lang="en">\' + \'meta name="viewport" content="width=device-width, initial-scale=1"\' + \'link rel="canonical" href={canonical}\' + Header + main flex-1 + slot + Footer — pinned so the doctype + lang=en + viewport + canonical-link + Header/Footer-shell + main-slot commitment survives', () => {
    expect(body).toMatch(/<!doctype html>/);
    // Fleet token axes: dark+oxblood is the shipped default ("Fleet Mission
    // Control — Dark + Red", founder-locked 2026-06-15, superseding the
    // 2026-06-12 spec's light+violet direction).
    expect(body).toMatch(/<html lang="en" data-mode="dark" data-accent="oxblood">/);
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
