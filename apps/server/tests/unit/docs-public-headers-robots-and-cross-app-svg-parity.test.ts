// W792 — apps/docs/public/_headers + robots.txt + cross-app brand-
// SVG consistency parity. One-hundred-eighteenth in the cross-SDK
// drift-guard series.
//
// docs/public/_headers + robots.txt had no parity guards (only
// marketing-site/public did). The brand-SVG cross-app consistency
// check is preventive — drift between apps would erode brand
// uniformity across customer surfaces.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const DOCS_HEADERS = resolve(REPO_ROOT, 'apps/docs/public/_headers');
const DOCS_ROBOTS = resolve(REPO_ROOT, 'apps/docs/public/robots.txt');

// Apps whose public/ ships the brand SVG pair.
const APPS_WITH_SVG = [
  'apps/marketing-site',
  'apps/docs',
  'apps/customer-dashboard',
  'apps/admin-panel',
  'apps/status-site',
] as const;

describe('W792 docs/public configs + cross-app brand-SVG parity', () => {
  it('apps/docs/public/_headers + robots.txt exist', () => {
    expect(existsSync(DOCS_HEADERS)).toBe(true);
    expect(existsSync(DOCS_ROBOTS)).toBe(true);
  });

  // ─── docs/public/_headers ─────────────────────────────────────

  it("CRITICAL V-221 + 3-tier cache strategy framing pinned. The 'V-221 — Cloudflare Pages cache headers for the marketing site' + 3-tier (hashed assets / marketing pages / crawler artefacts) wording is the load-bearing CDN strategy anchor matching docs/deployment/cdn-strategy.md.", () => {
    const p = read(DOCS_HEADERS);

    expect(p).toMatch(/V-221 — Cloudflare Pages cache headers for the marketing site\./);
    expect(p).toMatch(/Strategy in detail at docs\/deployment\/cdn-strategy\.md\./);
    expect(p).toMatch(/1\. Hashed assets \(immutable, 1y\)/);
    expect(p).toMatch(/2\. Marketing pages \(medium, 5m \/ 1d edge\)/);
    expect(p).toMatch(/3\. Crawler artefacts \(1h\)/);
  });

  it("CRITICAL Cloudflare Pages first-match-wins + ordering-matters framing pinned. The 'Cloudflare Pages copies public/_headers verbatim into the deploy and applies these per-path. First match wins; ordering matters. More-specific patterns above broader ones' wording is the canonical config-rule explanation.", () => {
    const p = read(DOCS_HEADERS);

    expect(p).toMatch(
      /Cloudflare Pages copies public\/_headers verbatim into the deploy and\s*\n#\s+applies these per-path\. First match wins; ordering matters\. More-\s*\n#\s+specific patterns above broader ones\./,
    );
  });

  it("CRITICAL /_astro/* immutable-1y framing pinned. The 'Astro emits hashed filenames under /_astro/* — the hash flips on every content change so customers always re-fetch on real updates; in between, the browser + edge cache the file forever' wording is the load-bearing hashed-asset strategy.", () => {
    const p = read(DOCS_HEADERS);

    expect(p).toMatch(/\/_astro\/\*\s*\n\s+Cache-Control: public, max-age=31536000, immutable/);
    expect(p).toMatch(
      /Astro emits hashed filenames under \/_astro\/\* — the hash flips on\s*\n#\s+every content change so customers always re-fetch on real updates;\s*\n#\s+in between, the browser \+ edge cache the file forever\./,
    );
  });

  it('CRITICAL 8-extension static-media immutable pinned — svg/png/jpg/jpeg/webp/avif/ico/woff/woff2. Drift to dropping any would break long-term caching for that asset family.', () => {
    const p = read(DOCS_HEADERS);

    for (const ext of ['svg', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'ico', 'woff', 'woff2']) {
      expect(p, `*.${ext} immutable`).toMatch(
        new RegExp(`\\/\\*\\.${ext}\\s*\\n\\s+Cache-Control: public, max-age=31536000, immutable`),
      );
    }
  });

  it("CRITICAL crawler-artefact 1-hour cache framing pinned. The 'Crawlers re-check robots + sitemaps periodically; 1h is the sweet spot — fast enough that a fresh sitemap propagates the same day, slow enough that we don\\'t burn origin requests on every Googlebot visit' wording is the load-bearing rationale.", () => {
    const p = read(DOCS_HEADERS);

    expect(p).toMatch(/\/robots\.txt\s*\n\s+Cache-Control: public, max-age=3600/);
    expect(p).toMatch(/\/sitemap-index\.xml\s*\n\s+Cache-Control: public, max-age=3600/);
    expect(p).toMatch(/\/sitemap-\*\.xml\s*\n\s+Cache-Control: public, max-age=3600/);
    expect(p).toMatch(/1h is the sweet\s*\n#\s+spot/);
  });

  it('CRITICAL marketing HTML 5m+1d+SWR cache pinned. max-age=300 + s-maxage=86400 + stale-while-revalidate=86400 is the load-bearing 3-tier customer-fresh + edge-fast + stale-resilient strategy.', () => {
    const p = read(DOCS_HEADERS);

    expect(p).toMatch(
      /Cache-Control: public, max-age=300, s-maxage=86400, stale-while-revalidate=86400/,
    );
  });

  it('CRITICAL 3-security-header set pinned — X-Frame-Options: DENY + X-Content-Type-Options: nosniff + Referrer-Policy: strict-origin-when-cross-origin. Drift to dropping any would weaken framing/MIME-sniff/referrer-leak defenses.', () => {
    const p = read(DOCS_HEADERS);

    expect(p).toMatch(/X-Frame-Options: DENY/);
    expect(p).toMatch(/X-Content-Type-Options: nosniff/);
    expect(p).toMatch(/Referrer-Policy: strict-origin-when-cross-origin/);
  });

  it("CRITICAL catch-all /* HTML pattern pinned. The '/* pattern (last-resort) covers any HTML response not already matched' wording explains why /* sits at the bottom — first-match-wins means more-specific patterns must come above.", () => {
    const p = read(DOCS_HEADERS);

    expect(p).toMatch(
      /Catch-all for HTML pages — Cloudflare Pages serves \/pricing\/index\.html\s*\n#\s+at \/pricing, \/faq\/index\.html at \/faq, etc\./,
    );
    expect(p).toMatch(
      /The `\/\*` pattern\s*\n#\s+\(last-resort\) covers any HTML response not already matched\./,
    );
  });

  // ─── docs/public/robots.txt ───────────────────────────────────

  it('CRITICAL robots.txt allow-all + sitemap pointer pinned. User-agent: * + Allow: / + Sitemap: https://docs.driftstack.dev/sitemap-index.xml. Drift to disallow would hide docs from search engines.', () => {
    const p = read(DOCS_ROBOTS);

    expect(p).toMatch(/User-agent: \*\nAllow: \//);
    expect(p).toMatch(/Sitemap: https:\/\/docs\.driftstack\.dev\/sitemap-index\.xml/);
  });

  // ─── Cross-app brand-SVG byte-identity ────────────────────────

  it('CRITICAL all 5 apps ship identical driftstack-mark.svg + driftstack-horizontal.svg. Drift to a per-app fork would erode brand consistency across marketing-site/docs/customer-dashboard/admin-panel/status-site.', () => {
    const markBytes = APPS_WITH_SVG.map((app) =>
      readFileSync(resolve(REPO_ROOT, `${app}/public/driftstack-mark.svg`)),
    );
    const horizontalBytes = APPS_WITH_SVG.map((app) =>
      readFileSync(resolve(REPO_ROOT, `${app}/public/driftstack-horizontal.svg`)),
    );

    // All 5 mark.svg bytes equal the first one.
    for (let i = 1; i < markBytes.length; i++) {
      const a = markBytes[0];
      const b = markBytes[i];
      expect(a, `mark.svg ${APPS_WITH_SVG[i]} matches ${APPS_WITH_SVG[0]}`).toBeDefined();
      expect(b, `mark.svg ${APPS_WITH_SVG[i]} exists`).toBeDefined();
      expect(a!.equals(b!), `mark.svg ${APPS_WITH_SVG[i]} byte-equals ${APPS_WITH_SVG[0]}`).toBe(
        true,
      );
    }
    for (let i = 1; i < horizontalBytes.length; i++) {
      const a = horizontalBytes[0];
      const b = horizontalBytes[i];
      expect(
        a!.equals(b!),
        `horizontal.svg ${APPS_WITH_SVG[i]} byte-equals ${APPS_WITH_SVG[0]}`,
      ).toBe(true);
    }
  });

  it("CRITICAL driftstack-mark.svg shape pinned — 256×256 viewBox + aria-label 'Driftstack logo' + oxblood→glow-red brand-gradient framing. Drift to a different viewBox/aria would break responsive sizing + a11y.", () => {
    const mark = readFileSync(resolve(REPO_ROOT, 'apps/docs/public/driftstack-mark.svg'), 'utf8');

    expect(mark).toMatch(
      /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 256 256" width="256" height="256" aria-label="Driftstack logo">/,
    );
    expect(mark).toMatch(/uppercase D with an iPhone silhouette as the/);
    expect(mark).toMatch(/inner counter \(notch \+ speaker detail at top\)\./);
    expect(mark).toMatch(
      /Vertical brand\s*\n\s+gradient from oxblood #722F37 \(top\) to bright glow-red #e23847/,
    );
  });

  it('CRITICAL customer-dashboard + admin-panel + status-site each ship their own public/_headers with the security-header set (X-Frame-Options + X-Content-Type-Options + Referrer-Policy + Permissions-Policy). status-site was added 2026-06-01 (the 2026-05-20 audit covered the other four but omitted it; separate Cloudflare Pages projects do NOT cross-inherit _headers, so it shipped with none). None of the three ship a robots.txt override.', () => {
    expect(existsSync(resolve(REPO_ROOT, 'apps/customer-dashboard/public/_headers'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/admin-panel/public/_headers'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/status-site/public/_headers'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/customer-dashboard/public/robots.txt'))).toBe(false);
    expect(existsSync(resolve(REPO_ROOT, 'apps/admin-panel/public/robots.txt'))).toBe(false);
    expect(existsSync(resolve(REPO_ROOT, 'apps/status-site/public/robots.txt'))).toBe(false);
  });

  it('CRITICAL status-site/public/_headers ships the 4-header security set on /* (X-Frame-Options: DENY + X-Content-Type-Options: nosniff + Referrer-Policy: strict-origin-when-cross-origin + Permissions-Policy) plus immutable /_astro/* caching — matches the other Pages apps so the public status surface is no longer header-less. Drift to dropping any weakens the framing/MIME/referrer defenses on status.driftstack.dev.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/status-site/public/_headers'));
    expect(p).toMatch(/X-Frame-Options: DENY/);
    expect(p).toMatch(/X-Content-Type-Options: nosniff/);
    expect(p).toMatch(/Referrer-Policy: strict-origin-when-cross-origin/);
    expect(p).toMatch(/Permissions-Policy: accelerometer=\(\), camera=\(\), geolocation=\(\),/);
    expect(p).toMatch(/\/_astro\/\*\s*\n\s+Cache-Control: public, max-age=31536000, immutable/);
  });

  it('CRITICAL marketing-site /_headers + /robots.txt sibling pinned. The marketing-site has matching files (covered by W-NNN marketing-site-public-headers/robots parity tests); both apps share the V-221 Cloudflare-Pages config pattern.', () => {
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/public/_headers'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/public/robots.txt'))).toBe(true);
  });

  it('HSTS (2026-06-03) — docs + status _headers force HTTPS on /* (completes the family-wide Strict-Transport-Security posture; dashboard/admin/apex shipped earlier). Added to /* only so CF Pages merges it onto every path with a single header. Dropping it reopens a TLS-strip window on these public surfaces.', () => {
    const docs = read(DOCS_HEADERS);
    const status = read(resolve(REPO_ROOT, 'apps/status-site/public/_headers'));
    expect(docs).toMatch(
      /^ {2}Strict-Transport-Security: max-age=63072000; includeSubDomains; preload$/m,
    );
    expect(status).toMatch(
      /^ {2}Strict-Transport-Security: max-age=63072000; includeSubDomains; preload$/m,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-public-headers-robots-and-cross-app-svg-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
