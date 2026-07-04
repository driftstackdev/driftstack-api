// W523.C — drift guard for apps/marketing-site/public/_headers.
// V-221 Cloudflare Pages cache headers + security headers. Drift here
// either changes the 3-tier cache strategy (would create cache-fill
// misses or stale content) or breaks the security-header commitments
// (would weaken X-Frame-Options/X-Content-Type-Options/Referrer-Policy
// posture on the marketing site).
//
//   • V-221 anchor doc-comment + 3-tier (hashed-1y / pages-5m+1d /
//     crawler-1h) cache strategy commitment.
//   • Hashed-asset tier: /_astro/* + 7-media-extension (svg/png/jpg/
//     jpeg/webp/avif/ico) + 2-font-extension (woff/woff2) — all 1y
//     immutable.
//   • Crawler-artefact tier: /robots.txt + /sitemap-index.xml +
//     /sitemap-*.xml — 1h max-age.
//   • Marketing-pages tier: / + /index.html + /* — 5m max-age + 1d
//     s-maxage + 1d stale-while-revalidate.
//   • Security headers on HTML responses: X-Frame-Options: DENY +
//     X-Content-Type-Options: nosniff + Referrer-Policy:
//     strict-origin-when-cross-origin.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/public/_headers');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W523.C apps/marketing-site/public/_headers content parity', () => {
  const body = read(LIB);

  it("V-221 framing + 3-tier-strategy framing pinned: 'V-221 — Cloudflare Pages cache headers for the marketing site.' + 'Strategy in detail at docs/deployment/cdn-strategy.md.' + 'Three tiers:' + '1. Hashed assets (immutable, 1y)        — /_astro/*, fonts, images' + '2. Marketing pages (medium, 5m / 1d edge) — html' + '3. Crawler artefacts (1h)                — robots.txt, sitemaps' + 'Cloudflare Pages copies public/_headers verbatim into the deploy and applies these per-path. First match wins; ordering matters. More-specific patterns above broader ones.' + 'Format reference: https://developers.cloudflare.com/pages/configuration/headers/' — pinned so the V-221 anchor + 3-tier-cache-strategy + first-match-wins + Cloudflare-Pages-format-reference commitment survives", () => {
    expect(body).toMatch(/# V-221 — Cloudflare Pages cache headers for the marketing site\./);
    expect(body).toMatch(/# Strategy in detail at docs\/deployment\/cdn-strategy\.md\./);
    expect(body).toMatch(/# Three tiers:/);
    expect(body).toMatch(
      /# {3}1\. Hashed assets \(immutable, 1y\) {8}— \/_astro\/\*, fonts, images/,
    );
    expect(body).toMatch(/# {3}2\. Marketing pages \(medium, 5m \/ 1d edge\) — html/);
    expect(body).toMatch(/# {3}3\. Crawler artefacts \(1h\) {16}— robots\.txt, sitemaps/);
    expect(body).toMatch(
      /# Cloudflare Pages copies public\/_headers verbatim into the deploy and\s*\n?\s*# applies these per-path\. First match wins; ordering matters\. More-\s*\n?\s*# specific patterns above broader ones\./,
    );
    expect(body).toMatch(
      /#\s+https:\/\/developers\.cloudflare\.com\/pages\/configuration\/headers\//,
    );
  });

  it("Hashed-Astro-bundle tier framing pinned: '── Hashed Astro bundles + CSS ──' section + 'Astro emits hashed filenames under /_astro/* — the hash flips on every content change so customers always re-fetch on real updates; in between, the browser + edge cache the file forever.' + '/_astro/*' + 'Cache-Control: public, max-age=31536000, immutable' — pinned so the /_astro/* immutable-1y + hash-flips-on-content-change commitment survives", () => {
    expect(body).toMatch(/# ── Hashed Astro bundles \+ CSS ──/);
    expect(body).toMatch(
      /# Astro emits hashed filenames under \/_astro\/\* — the hash flips on\s*\n?\s*# every content change so customers always re-fetch on real updates;\s*\n?\s*# in between, the browser \+ edge cache the file forever\./,
    );
    expect(body).toMatch(/^\/_astro\/\*$/m);
    expect(body).toMatch(/^ {2}Cache-Control: public, max-age=31536000, immutable$/m);
  });

  it("Static-media 7-extension immutable tier framing pinned: '── Static media (images, fonts) ──' section + 'Hash-versioned via Astro pipeline OR uploaded with stable names; in either case treat as immutable. If a stable-name image needs to change, deploy with a new filename (or add a query string).' + /*.svg + /*.png + /*.jpg + /*.jpeg + /*.webp + /*.avif + /*.ico + /*.woff + /*.woff2 — all 1y immutable — pinned so the 7-image-extension + 2-font-extension immutable-1y commitment survives", () => {
    expect(body).toMatch(/# ── Static media \(images, fonts\) ──/);
    expect(body).toMatch(
      /# Hash-versioned via Astro pipeline OR uploaded with stable names; in\s*\n?\s*# either case treat as immutable\. If a stable-name image needs to\s*\n?\s*# change, deploy with a new filename \(or add a query string\)\./,
    );
    expect(body).toMatch(/^\/\*\.svg$/m);
    expect(body).toMatch(/^\/\*\.png$/m);
    expect(body).toMatch(/^\/\*\.jpg$/m);
    expect(body).toMatch(/^\/\*\.jpeg$/m);
    expect(body).toMatch(/^\/\*\.webp$/m);
    expect(body).toMatch(/^\/\*\.avif$/m);
    expect(body).toMatch(/^\/\*\.ico$/m);
    expect(body).toMatch(/^\/\*\.woff$/m);
    expect(body).toMatch(/^\/\*\.woff2$/m);
  });

  it("Self-hosted fonts explicit-dir tier pinned (S17 2026-07-04): '── Self-hosted fonts ──' section + '/fonts/*' immutable-1y — needed EXPLICITLY because CF Pages /*.woff2 extension globs do NOT match nested paths in production (measured max-age=14400 on /fonts/** ; Lighthouse flagged the ~180 KiB font re-download). Mirrors the customer-dashboard _headers section", () => {
    expect(body).toMatch(/# ── Self-hosted fonts ──/);
    expect(body).toMatch(/do\s*\n?#?\s*NOT match nested paths in production/);
    expect(body).toMatch(/^\/fonts\/\*$/m);
    const fontsSection = body.match(/^\/fonts\/\*\n([^\n]+)/m);
    expect(fontsSection?.[1]).toContain('Cache-Control: public, max-age=31536000, immutable');
  });

  it("Crawler-artefact tier framing pinned: '── Crawler artefacts ──' section + 'Crawlers re-check robots + sitemaps periodically; 1h is the sweet spot — fast enough that a fresh sitemap propagates the same day, slow enough that we don't burn origin requests on every Googlebot visit.' + /robots.txt + /sitemap-index.xml + /sitemap-*.xml — all 'Cache-Control: public, max-age=3600' (1h) — pinned so the crawler-artefact-1h-cache + 3-path (robots + sitemap-index + sitemap-*) commitment survives", () => {
    expect(body).toMatch(/# ── Crawler artefacts ──/);
    expect(body).toMatch(
      /# Crawlers re-check robots \+ sitemaps periodically; 1h is the sweet\s*\n?\s*# spot — fast enough that a fresh sitemap propagates the same day,\s*\n?\s*# slow enough that we don't burn origin requests on every Googlebot\s*\n?\s*# visit\./,
    );
    expect(body).toMatch(/^\/robots\.txt$/m);
    expect(body).toMatch(/^\/sitemap-index\.xml$/m);
    expect(body).toMatch(/^\/sitemap-\*\.xml$/m);
    expect(body).toMatch(/^ {2}Cache-Control: public, max-age=3600$/m);
  });

  it("Marketing-pages tier + 5m/1d/1d-SWR framing pinned: '── Marketing pages (HTML) ──' section + '5min in the customer's browser, 1d at the edge, 1d stale-while-revalidate. Means: customers see fresh-ish content (max 5min stale on a return visit), edge keeps a hot copy for 24h, and during a re-fetch the edge can serve stale-but-fresh while revalidating in the background. Optimised for \"we deploy a few times a week and want fast page loads in between.\"' + 3-path (/ + /index.html + /*) + 'Cache-Control: public, max-age=300, s-maxage=86400, stale-while-revalidate=86400' — pinned so the 5m-max-age + 1d-s-maxage + 1d-SWR + 3-html-path commitment survives", () => {
    expect(body).toMatch(/# ── Marketing pages \(HTML\) ──/);
    expect(body).toMatch(
      /# 5min in the customer's browser, 1d at the edge, 1d\s*\n?\s*# stale-while-revalidate\. Means: customers see fresh-ish content \(max\s*\n?\s*# 5min stale on a return visit\), edge keeps a hot copy for 24h, and\s*\n?\s*# during a re-fetch the edge can serve stale-but-fresh while\s*\n?\s*# revalidating in the background\. Optimised for "we deploy a few\s*\n?\s*# times a week and want fast page loads in between\."/,
    );
    expect(body).toMatch(/^\/$/m);
    expect(body).toMatch(/^\/index\.html$/m);
    expect(body).toMatch(/^\/\*$/m);
    expect(body).toMatch(
      /^ {2}Cache-Control: public, max-age=300, s-maxage=86400, stale-while-revalidate=86400$/m,
    );
  });

  it("Catch-all /* + security-header framing pinned: 'Catch-all for HTML pages — Cloudflare Pages serves /pricing/index.html at /pricing, /faq/index.html at /faq, etc. The `/*` pattern (last-resort) covers any HTML response not already matched.' + X-Frame-Options: DENY + X-Content-Type-Options: nosniff + Referrer-Policy: strict-origin-when-cross-origin + Permissions-Policy (sensor/payment deny) — pinned so the catch-all-HTML-coverage + 4-security-header commitment survives (drift to dropping any security header would weaken the marketing-site security posture)", () => {
    expect(body).toMatch(
      /# Catch-all for HTML pages — Cloudflare Pages serves \/pricing\/index\.html\s*\n?\s*# at \/pricing, \/faq\/index\.html at \/faq, etc\. The `\/\*` pattern\s*\n?\s*# \(last-resort\) covers any HTML response not already matched\./,
    );
    expect(body).toMatch(/^ {2}X-Frame-Options: DENY$/m);
    expect(body).toMatch(/^ {2}X-Content-Type-Options: nosniff$/m);
    expect(body).toMatch(/^ {2}Referrer-Policy: strict-origin-when-cross-origin$/m);
    // 2026-06-05 — closed the 2026-05-20-csp-header-audit Permissions-Policy
    // gap (it shipped on dashboard/admin/status but not marketing/docs). The
    // marketing site uses none of these features (no getUserMedia / geolocation
    // / inline PaymentRequest — Stripe checkout is a hosted redirect on the
    // dashboard), so a deny-all is safe + matches the other 4 Pages apps.
    expect(body).toMatch(
      /^ {2}Permissions-Policy: accelerometer=\(\), camera=\(\), geolocation=\(\), gyroscope=\(\), magnetometer=\(\), microphone=\(\), payment=\(\), usb=\(\)$/m,
    );
  });

  it('HSTS on the /* catch-all block ONLY — single header (2026-06-03 de-dup: CF Pages MERGES /* onto every path incl. /, proven live by the previously-doubled header, so one STS on /* covers the apex; a single clean header is preload-submission-ready, unlike the prior comma-joined double)', () => {
    // Apex = highest-traffic public entry (login click-through) + the
    // includeSubDomains preload anchor for the driftstack.dev tree. STS
    // lives on /* only (same pattern as docs/status); the / homepage rule
    // intentionally has NO STS — it inherits it via the /* merge, exactly
    // as /index.html inherits its security headers from /*.
    const stsLines = body.match(
      /^ {2}Strict-Transport-Security: max-age=63072000; includeSubDomains; preload$/gm,
    );
    // Exactly ONE STS line (on /*). length===1 is itself the negative
    // guard against regressing to STS-on-both (the doubled comma-joined
    // header that fails strict hstspreload.org validation).
    expect(stsLines, 'STS must be present on the /* catch-all').not.toBeNull();
    expect(stsLines!.length).toBe(1);
    // Confirm the surviving STS sits in the /* catch-all block (the line
    // immediately after that block's Referrer-Policy at EOF).
    expect(body).toMatch(
      /\/\*\n(?: {2}.+\n)* {2}Strict-Transport-Security: max-age=63072000; includeSubDomains; preload/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
