// W554.A — drift guard for /docs/deployment/cdn-strategy.md.
// V-221 marketing-site CF Pages caching strategy. Drift here
// either weakens the 3-tier cache hierarchy (would invite per-
// page TTL overrides that fragment cache), drops the security-
// headers-Tier-2 trio (would lose clickjacking + MIME-sniff +
// referrer-leak defenses), or weakens the measured merge semantics
// (would let a broad catch-all override specific cache rules).
//
//   • V-221. apps/marketing-site/public/_headers source of truth.
//   • Applies to marketing-site only (NOT customer-dashboard,
//     apps/server, apps/admin-panel).
//   • 3 tiers: Hashed assets immutable-1yr + Marketing pages
//     5min/1d/1d-SWR + Crawler artefacts 1hr.
//   • 3 security headers: X-Frame-Options DENY +
//     X-Content-Type-Options nosniff + Referrer-Policy strict-
//     origin-when-cross-origin.
//   • HSTS + enforced CSP on the security-only catch-all.

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

  it("Header + V-221 + source-of-truth framing pinned: '# CDN strategy — marketing site' + 'V-221 — Cloudflare Pages caching strategy for `apps/marketing-site/`. Cache rules live in `apps/marketing-site/public/_headers`' + '## Where this applies' + '**`apps/marketing-site/`** — static Astro build deployed to Cloudflare Pages at driftstack.io.' + 'Not applicable to `apps/customer-dashboard/` (SSR, behind auth, no public caching) or `apps/server/`' + 'Not applicable to `apps/admin-panel/` (internal-staff surface, never cached publicly).' — pinned so the V-221-marketing-site-CF-Pages + _headers-source-of-truth + driftstack.io-static-Astro + customer-dashboard-SSR-excluded + apps/server-per-route-excluded + admin-panel-never-cached commitment survives", () => {
    expect(body).toMatch(/^# CDN strategy — marketing site$/m);
    expect(body).toMatch(
      /V-221 — Cloudflare Pages caching strategy for `apps\/marketing-site\/`\./,
    );
    expect(body).toMatch(/Cache rules live in `apps\/marketing-site\/public\/_headers`;/);
    expect(body).toMatch(/## Where this applies/);
    expect(body).toMatch(
      /- \*\*`apps\/marketing-site\/`\*\* — static Astro build deployed to Cloudflare/,
    );
    expect(body).toMatch(/Pages at driftstack\.io\./);
    expect(body).toMatch(/- Not applicable to `apps\/customer-dashboard\/` \(SSR, behind auth, no/);
    expect(body).toMatch(/public caching\) or `apps\/server\/`/);
    expect(body).toMatch(
      /- Not applicable to `apps\/admin-panel\/` \(internal-staff surface, never/,
    );
    expect(body).toMatch(/cached publicly\)\./);
  });

  it('pins the three cache tiers and keeps the broad catch-all security-only', () => {
    expect(body).toMatch(/### Tier 1 — Hashed assets \(immutable, 1 year\)/);
    expect(body).toMatch(/\/_astro\/\*\s+→ public, max-age=31536000, immutable/);
    expect(body).toMatch(/### Tier 2 — Homepage \(5min browser, 1d edge, 1d SWR\)/);
    expect(body).toMatch(
      /Cache-Control: public, max-age=300, s-maxage=86400, stale-while-revalidate=86400/,
    );
    expect(body).toMatch(/### Tier 3 — Crawler artefacts \(1 hour\)/);
    expect(body).toMatch(/\/robots\.txt\s+→ public, max-age=3600/);
    expect(body).toMatch(/\/sitemap-index\.xml\s+→ public, max-age=3600/);
    expect(body).toMatch(/\/sitemap-\*\.xml\s+→ public, max-age=3600/);
    expect(body).toMatch(/\/\* {2}→ security headers only \(no Cache-Control\)/);
  });

  it('pins the homepage TTL rationale and deploy invalidation behavior', () => {
    expect(body).toMatch(/- \*\*`max-age=300`\*\* \(5 minutes browser\):/);
    expect(body).toMatch(/- \*\*`s-maxage=86400`\*\* \(1 day edge\):/);
    expect(body).toMatch(
      /- \*\*`stale-while-revalidate=86400`\*\* \(1 day\): when the edge cached/,
    );
    expect(body).toMatch(/hits 24h\+1s, the next request serves the stale copy AND fires an async/);
    expect(body).toMatch(/revalidation\. Customer never waits on a re-fetch;/);
    expect(body).toMatch(/Pages deploy invalidates the project edge/);
    expect(body).toMatch(/use the Cloudflare purge API/);
  });

  it('pins the enforced CSP and measured all-matching-rules merge semantics', () => {
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
    expect(body).toMatch(/origin \(`https:\/\/driftstack\.io`\), not the full path\./);
    expect(body).toMatch(/`Strict-Transport-Security` and an enforced `Content-Security-Policy`/);
    expect(body).toMatch(/CSP audit completed 2026-07-13/);
    expect(body).toMatch(/Cloudflare Pages applies and merges every matching rule/);
    expect(body).toMatch(/not first-match-wins/);
    expect(body).toMatch(/The `\/\*` catch-all MUST stay last and security-only\./);
  });

  it("What-we-don't-do + Verify-with-curl + Source-of-truth framing pinned: '**Per-page TTL overrides** — every HTML page uses the same Tier 2 config. Special-casing creates surprise' + '**Vary headers** — the marketing site doesn't serve content based on cookie, language, or device.' + '**CDN-level transforms** (image resize, HTML minification) — Astro already minifies at build' + '**Worker-based caching logic** — `_headers` is declarative' + 'curl -sI https://driftstack.io/_astro/<hashed-bundle>.js | grep -i cache' + 'curl -sI https://driftstack.io/pricing | grep -iE 'cache|frame|content-type-options|referrer'' + 'curl -sI https://driftstack.io/robots.txt | grep -i cache' + '`apps/marketing-site/public/_headers` is the source of truth.' — pinned so the no-per-page-TTL + no-Vary + no-CDN-transforms + no-Worker-caching + 3-curl-verify-commands + _headers-source-of-truth commitment survives", () => {
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
      /curl -sI https:\/\/driftstack\.io\/_astro\/<hashed-bundle>\.js \| grep -i cache/,
    );
    expect(body).toMatch(
      /curl -sI https:\/\/driftstack\.io\/pricing \| grep -iE 'cache\|frame\|content-type-options\|referrer'/,
    );
    expect(body).toMatch(/curl -sI https:\/\/driftstack\.io\/robots\.txt \| grep -i cache/);
    expect(body).toMatch(/`apps\/marketing-site\/public\/_headers` is the source of truth\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
