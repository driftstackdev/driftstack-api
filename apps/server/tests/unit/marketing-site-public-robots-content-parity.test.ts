// W524.B — drift guard for apps/marketing-site/public/robots.txt.
// Marketing-site crawl directives. Drift here either changes crawl
// permission (would either over-expose or hide pages from search
// engines unintentionally) or breaks the subdomain-isolation comment
// (would mislead reviewers about where each subdomain's robots lives).
//
//   • driftstack.dev/robots.txt canonical URL doc-comment.
//   • Subdomain-isolation framing: app.driftstack.dev + admin.driftstack.dev
//     have their own robots — both noindex.
//   • User-agent: * + Allow: / (everything public on marketing site
//     is crawlable).
//   • Crawl-delay: 5 (avoid wasting crawl budget on stable
//     trust/sub-processors).
//   • Sitemap: https://driftstack.dev/sitemap-index.xml reference.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/public/robots.txt');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W524.B apps/marketing-site/public/robots.txt content parity', () => {
  const body = read(LIB);

  it("Canonical robots.txt URL + subdomain-isolation framing pinned: '# https://driftstack.dev/robots.txt' + 'All public pages crawlable. Subdomains (app.driftstack.dev for the customer dashboard, admin.driftstack.dev for the customer dashboard, admin.driftstack.dev for the admin panel) carry their own robots — both noindex.' — pinned so the canonical-marketing-site-robots + 2-subdomain-isolation (app + admin) + both-noindex commitment survives (drift to indexing app/admin subdomains would expose customer-only routes to search engines)", () => {
    expect(body).toMatch(/# https:\/\/driftstack\.dev\/robots\.txt/);
    expect(body).toMatch(
      /# All public pages crawlable\. Subdomains \(app\.driftstack\.dev for the\s*# customer dashboard, admin\.driftstack\.dev for the admin panel\) carry\s*# their own robots — both noindex\./,
    );
  });

  it("User-agent + Allow framing pinned: 'User-agent: *' + 'Allow: /' (everything public is crawlable) — pinned so the wildcard-user-agent + allow-everything commitment survives (drift to a Disallow rule would silently hide marketing pages from search engines)", () => {
    expect(body).toMatch(/^User-agent: \*$/m);
    expect(body).toMatch(/^Allow: \/$/m);
  });

  it("Crawl-delay + sub-processors comment framing pinned: 'Avoid wasting crawl budget on the trust sub-processor page when crawlers re-fetch it on every visit; it's stable content.' + 'Crawl-delay: 5' — pinned so the 5s-crawl-delay + sub-processors-stable-content commitment survives", () => {
    expect(body).toMatch(
      /# Avoid wasting crawl budget on the trust sub-processor page when\s*# crawlers re-fetch it on every visit; it's stable content\./,
    );
    expect(body).toMatch(/^Crawl-delay: 5$/m);
  });

  it("Sitemap reference framing pinned: 'Sitemap: https://driftstack.dev/sitemap-index.xml' — pinned so the sitemap-index pointer at the canonical marketing-domain commitment survives (drift to dropping the sitemap reference would break crawler discovery of indexed pages)", () => {
    expect(body).toMatch(/^Sitemap: https:\/\/driftstack\.dev\/sitemap-index\.xml$/m);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
