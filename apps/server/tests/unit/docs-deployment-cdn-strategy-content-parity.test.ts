// W554.A — drift guard for /docs/deployment/cdn-strategy.md.
// V-221 marketing-site CF Pages caching strategy. Drift here
// either weakens the 3-tier cache hierarchy (would invite per-
// page TTL overrides that fragment cache), drops the security-
// headers-Tier-2 trio (would lose clickjacking + MIME-sniff +
// referrer-leak defenses), or weakens the match-order semantics
// (would shadow specific rules with broader catch-all).
//
//   • V-221. apps/marketing-site/public/_headers source of truth.
//   • Applies to marketing-site only (NOT customer-dashboard,
//     apps/server, apps/admin-panel).
//   • 3 tiers: Hashed assets immutable-1yr + Marketing pages
//     5min/1d/1d-SWR + Crawler artefacts 1hr.
//   • 3 security headers: X-Frame-Options DENY +
//     X-Content-Type-Options nosniff + Referrer-Policy strict-
//     origin-when-cross-origin.
//   • HSTS at zone level (NOT per-path). CSP V-TBD separate work.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/deployment/cdn-strategy.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W554.A /docs/deployment/cdn-strategy.md content parity', () => {
  const body = read(LIB);

  it("Header + V-221 + source-of-truth framing pinned: '# CDN strategy — marketing site' + 'V-221 — Cloudflare Pages caching strategy for `apps/marketing-site/`. Cache rules live in `apps/marketing-site/public/_headers`' + '## Where this applies' + '**`apps/marketing-site/`** — static Astro build deployed to Cloudflare Pages at driftstack.dev.' + 'Not applicable to `apps/customer-dashboard/` (SSR, behind auth, no public caching) or `apps/server/`' + 'Not applicable to `apps/admin-panel/` (internal-staff surface, never cached publicly).' — pinned so the V-221-marketing-site-CF-Pages + _headers-source-of-truth + driftstack.dev-static-Astro + customer-dashboard-SSR-excluded + apps/server-per-route-excluded + admin-panel-never-cached commitment survives", () => {
    expect(body).toMatch(/^# CDN strategy — marketing site$/m);
    expect(body).toMatch(
      /V-221 — Cloudflare Pages caching strategy for `apps\/marketing-site\/`\./,
    );
    expect(body).toMatch(/Cache rules live in `apps\/marketing-site\/public\/_headers`;/);
    expect(body).toMatch(/## Where this applies/);
    expect(body).toMatch(
      /- \*\*`apps\/marketing-site\/`\*\* — static Astro build deployed to Cloudflare/,
    );
    expect(body).toMatch(/Pages at driftstack\.dev\./);
    expect(body).toMatch(/- Not applicable to `apps\/customer-dashboard\/` \(SSR, behind auth, no/);
    expect(body).toMatch(/public caching\) or `apps\/server\/`/);
    expect(body).toMatch(
      /- Not applicable to `apps\/admin-panel\/` \(internal-staff surface, never/,
    );
    expect(body).toMatch(/cached publicly\)\./);
  });

  it("3-tier cache hierarchy framing pinned: '### Tier 1 — Hashed assets (immutable, 1 year)' + '`/_astro/*       → public, max-age=31536000, immutable`' + '### Tier 2 — Marketing pages (5min browser, 1d edge, 1d SWR)' + 'Cache-Control: public, max-age=300, s-maxage=86400, stale-while-revalidate=86400' + '### Tier 3 — Crawler artefacts (1 hour)' + '/robots.txt          → public, max-age=3600' + '/sitemap-index.xml   → public, max-age=3600' + '/sitemap-*.xml       → public, max-age=3600' — pinned so the Tier-1-hashed-1yr-immutable + Tier-2-marketing-300-86400-86400 + Tier-3-crawler-3600 commitment survives", () => {
    expect(body).toMatch(/### Tier 1 — Hashed assets \(immutable, 1 year\)/);
    expect(body).toMatch(/\/_astro\/\*\s+→ public, max-age=31536000, immutable/);
    expect(body).toMatch(/### Tier 2 — Marketing pages \(5min browser, 1d edge, 1d SWR\)/);
    expect(body).toMatch(
      /Cache-Control: public, max-age=300, s-maxage=86400, stale-while-revalidate=86400/,
    );
    expect(body).toMatch(/### Tier 3 — Crawler artefacts \(1 hour\)/);
    expect(body).toMatch(/\/robots\.txt\s+→ public, max-age=3600/);
    expect(body).toMatch(/\/sitemap-index\.xml\s+→ public, max-age=3600/);
    expect(body).toMatch(/\/sitemap-\*\.xml\s+→ public, max-age=3600/);
  });

  it("Tier-2 number rationale framing pinned: '**`max-age=300`** (5 minutes browser)' + '**`s-maxage=86400`** (1 day edge)' + '**`stale-while-revalidate=86400`** (1 day): when the edge cached copy hits 24h+1s, the next request serves the stale copy AND fires an async revalidation. Customer never waits on a re-fetch' + 'a deploy at T+0 takes up to 24h to fully propagate to all edge POPs' + 'If we ever need a hard purge (e.g. legal copy correction) we hit the Cloudflare Pages purge API rather than waiting on TTL expiry.' — pinned so the 300-5min-browser + 86400-1d-edge + SWR-async-revalidation + 24h-propagation-trade-off + Cloudflare-purge-API commitment survives", () => {
    expect(body).toMatch(/- \*\*`max-age=300`\*\* \(5 minutes browser\):/);
    expect(body).toMatch(/- \*\*`s-maxage=86400`\*\* \(1 day edge\):/);
    expect(body).toMatch(
      /- \*\*`stale-while-revalidate=86400`\*\* \(1 day\): when the edge cached/,
    );
    expect(body).toMatch(/hits 24h\+1s, the next request serves the stale copy AND fires an async/);
    expect(body).toMatch(/revalidation\. Customer never waits on a re-fetch;/);
    expect(body).toMatch(/a deploy at T\+0 takes up to 24h to fully propagate to all edge/);
    expect(body).toMatch(
      /If we ever need a hard purge \(e\.g\. legal copy correction\) we hit the/,
    );
    expect(body).toMatch(/Cloudflare Pages purge API rather than waiting on TTL expiry\./);
  });

  it("3 security headers + match-order semantics framing pinned: '`X-Frame-Options: DENY`** — prevents the site from being embedded in an iframe' + '`X-Content-Type-Options: nosniff`** — disables MIME-type sniffing' + '`Referrer-Policy: strict-origin-when-cross-origin`** — when the browser follows an outbound link, the destination sees only our origin (`https://driftstack.dev`), not the full path.' + 'We do NOT set `Strict-Transport-Security` here because it's owned at the Cloudflare zone level (HSTS preload list policy), not per-path.' + 'Same for `Content-Security-Policy` — CSP for the marketing site is a separate piece of work (V-TBD)' + 'Cloudflare Pages applies the first matching rule per path. Ordering in `_headers` matters; more-specific patterns must come above broader ones.' + 'The `/*` catch-all MUST stay last.' — pinned so the X-Frame-Options-DENY-clickjacking + X-Content-Type-Options-nosniff + Referrer-Policy-strict-origin-when-cross-origin + HSTS-zone-level + CSP-V-TBD + match-order-first-matching + /*-catch-all-MUST-stay-last commitment survives", () => {
    expect(body).toMatch(
      /- \*\*`X-Frame-Options: DENY`\*\* — prevents the site from being embedded in/,
    );
    expect(body).toMatch(/an iframe on another origin\./);
    expect(body).toMatch(
      /- \*\*`X-Content-Type-Options: nosniff`\*\* — disables MIME-type sniffing/,
    );
    expect(body).toMatch(/in older browsers\./);
    expect(body).toMatch(/- \*\*`Referrer-Policy: strict-origin-when-cross-origin`\*\* — when the/);
    expect(body).toMatch(/browser follows an outbound link, the destination sees only our/);
    expect(body).toMatch(/origin \(`https:\/\/driftstack\.dev`\), not the full path\./);
    expect(body).toMatch(
      /We do NOT set `Strict-Transport-Security` here because it's owned at the/,
    );
    expect(body).toMatch(/Cloudflare zone level \(HSTS preload list policy\), not per-path\./);
    expect(body).toMatch(/Same for/);
    expect(body).toMatch(/`Content-Security-Policy` — CSP for the marketing site is a separate/);
    expect(body).toMatch(/piece of work \(V-TBD\)/);
    expect(body).toMatch(/Cloudflare Pages applies the first matching rule per path\. Ordering in/);
    expect(body).toMatch(
      /`_headers` matters; more-specific patterns must come above broader ones\./,
    );
    expect(body).toMatch(/The `\/\*` catch-all MUST stay last\./);
  });

  it("What-we-don't-do + Verify-with-curl + Source-of-truth framing pinned: '**Per-page TTL overrides** — every HTML page uses the same Tier 2 config. Special-casing creates surprise' + '**Vary headers** — the marketing site doesn't serve content based on cookie, language, or device.' + '**CDN-level transforms** (image resize, HTML minification) — Astro already minifies at build' + '**Worker-based caching logic** — `_headers` is declarative' + 'curl -sI https://driftstack.dev/_astro/<hashed-bundle>.js | grep -i cache' + 'curl -sI https://driftstack.dev/pricing | grep -iE 'cache|frame|content-type-options|referrer'' + 'curl -sI https://driftstack.dev/robots.txt | grep -i cache' + '`apps/marketing-site/public/_headers` is the source of truth.' — pinned so the no-per-page-TTL + no-Vary + no-CDN-transforms + no-Worker-caching + 3-curl-verify-commands + _headers-source-of-truth commitment survives", () => {
    expect(body).toMatch(/- \*\*Per-page TTL overrides\*\* — every HTML page uses the same Tier 2/);
    expect(body).toMatch(/config\. Special-casing creates surprise;/);
    expect(body).toMatch(
      /- \*\*Vary headers\*\* — the marketing site doesn't serve content based on/,
    );
    expect(body).toMatch(/cookie, language, or device\./);
    expect(body).toMatch(
      /- \*\*CDN-level transforms\*\* \(image resize, HTML minification\) — Astro/,
    );
    expect(body).toMatch(/already minifies at build;/);
    expect(body).toMatch(/- \*\*Worker-based caching logic\*\* — `_headers` is declarative/);
    expect(body).toMatch(
      /curl -sI https:\/\/driftstack\.dev\/_astro\/<hashed-bundle>\.js \| grep -i cache/,
    );
    expect(body).toMatch(
      /curl -sI https:\/\/driftstack\.dev\/pricing \| grep -iE 'cache\|frame\|content-type-options\|referrer'/,
    );
    expect(body).toMatch(/curl -sI https:\/\/driftstack\.dev\/robots\.txt \| grep -i cache/);
    expect(body).toMatch(/`apps\/marketing-site\/public\/_headers` is the source of truth\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
