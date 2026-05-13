// W522.B — drift guard for apps/marketing-site/src/components/Footer.astro.
// Marketing-site footer with 4-category nav grid + status badge + EU-VAT
// notice + auto-year copyright. Drift here either changes a footer-link
// destination (would create marketing↔site-route divergence) or breaks
// the 4-category-grid + EU-VAT commitment (would mislead pricing reviewers).
//
//   • Auto-year copyright via new Date().getUTCFullYear() (UTC-pinned).
//   • Brand tagline: 'iPhone Safari sessions, on demand. Premium fidelity
//     for the device that matters.'.
//   • 4-category nav grid: Product / Company / Trust / Legal.
//   • Product 7-link: /pricing + /comparison + /roadmap + /self-hosted +
//     docs.driftstack.dev (external) + app/signup + app/login.
//   • Company 5-link: /about + /faq + /changelog + support@ + sales@.
//   • Trust 5-link: /trust + /security + /trust/sub-processors +
//     /trust/incidents + status.driftstack.dev (external).
//   • Legal 4-link: /legal/terms + /legal/privacy + /legal/dpa + /legal/aup.
//   • EU-VAT notice: 'All prices in USD. VAT/BTW added per region per
//     applicable EU rules.'.
//   • StatusBadge component embedded.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/components/Footer.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W522.B apps/marketing-site/src/components/Footer.astro content parity', () => {
  const body = read(LIB);

  it("Auto-year UTC + StatusBadge import + brand tagline framing pinned: 'const year = new Date().getUTCFullYear();' + StatusBadge import + 'iPhone Safari sessions, on demand. Premium fidelity for the device that matters.' tagline + '&copy; {year} Driftstack. All rights reserved.' — pinned so the UTC-year-pin + StatusBadge embed + canonical-tagline + copyright commitment survives (drift to non-UTC year would create date-boundary divergence in non-UTC zones; drift to a different tagline would erode the marketing-positioning consistency)", () => {
    expect(body).toMatch(/import StatusBadge from '\.\/StatusBadge\.astro';/);
    expect(body).toMatch(/const year = new Date\(\)\.getUTCFullYear\(\);/);
    expect(body).toMatch(
      /iPhone Safari sessions, on demand\. Premium fidelity for the device that matters\./,
    );
    expect(body).toMatch(/&copy; \{year\} Driftstack\. All rights reserved\./);
  });

  it("Product-category 7-link framing pinned: /pricing Pricing + /comparison Comparison + /roadmap Roadmap + /self-hosted Self-hosted + https://docs.driftstack.dev Docs (external, noopener noreferrer, target=_blank) + https://app.driftstack.dev/signup 'Sign up' + https://app.driftstack.dev/login 'Sign in' — pinned so the 7-product-link surface + Docs-external-safety + auth-URL-dashboard-routes commitment survives", () => {
    expect(body).toMatch(/<h3 class="font-medium text-slate-900">Product<\/h3>/);
    expect(body).toMatch(/<li><a href="\/pricing" class="nav-link">Pricing<\/a><\/li>/);
    expect(body).toMatch(/<li><a href="\/comparison" class="nav-link">Comparison<\/a><\/li>/);
    expect(body).toMatch(/<li><a href="\/roadmap" class="nav-link">Roadmap<\/a><\/li>/);
    expect(body).toMatch(/<li><a href="\/self-hosted" class="nav-link">Self-hosted<\/a><\/li>/);
    expect(body).toMatch(
      /<a\s*\n?\s*href="https:\/\/docs\.driftstack\.dev"\s*\n?\s*class="nav-link"\s*\n?\s*target="_blank"\s*\n?\s*rel="noopener noreferrer">Docs<\/a/,
    );
    expect(body).toMatch(
      /<a href="https:\/\/app\.driftstack\.dev\/signup" class="nav-link">Sign up<\/a>/,
    );
    expect(body).toMatch(
      /<a href="https:\/\/app\.driftstack\.dev\/login" class="nav-link">Sign in<\/a>/,
    );
  });

  it('Company-category 5-link framing pinned: /about + /faq + /changelog + mailto:support@driftstack.dev + mailto:sales@driftstack.dev — pinned so the 5-company-link surface + 2-mailto-channel (support + sales) commitment survives (drift to dropping either mailto would orphan the sales+support routing)', () => {
    expect(body).toMatch(/<h3 class="font-medium text-slate-900">Company<\/h3>/);
    expect(body).toMatch(/<li><a href="\/about" class="nav-link">About<\/a><\/li>/);
    expect(body).toMatch(/<li><a href="\/faq" class="nav-link">FAQ<\/a><\/li>/);
    expect(body).toMatch(/<li><a href="\/changelog" class="nav-link">Changelog<\/a><\/li>/);
    expect(body).toMatch(
      /<a href="mailto:support@driftstack\.dev" class="nav-link">support@driftstack\.dev<\/a>/,
    );
    expect(body).toMatch(
      /<a href="mailto:sales@driftstack\.dev" class="nav-link">sales@driftstack\.dev<\/a>/,
    );
  });

  it("Trust-category 5-link framing pinned: /trust 'Trust center' + /security Security + /trust/sub-processors Sub-processors + /trust/incidents Incidents + https://status.driftstack.dev Status (external, noopener noreferrer, target=_blank) — pinned so the 5-trust-link surface + status.driftstack.dev-external safety commitment survives", () => {
    expect(body).toMatch(/<h3 class="font-medium text-slate-900">Trust<\/h3>/);
    expect(body).toMatch(/<li><a href="\/trust" class="nav-link">Trust center<\/a><\/li>/);
    expect(body).toMatch(/<li><a href="\/security" class="nav-link">Security<\/a><\/li>/);
    expect(body).toMatch(
      /<li><a href="\/trust\/sub-processors" class="nav-link">Sub-processors<\/a><\/li>/,
    );
    expect(body).toMatch(/<li><a href="\/trust\/incidents" class="nav-link">Incidents<\/a><\/li>/);
    expect(body).toMatch(
      /<a\s*\n?\s*href="https:\/\/status\.driftstack\.dev"\s*\n?\s*class="nav-link"\s*\n?\s*target="_blank"\s*\n?\s*rel="noopener noreferrer">Status<\/a/,
    );
  });

  it("Legal-category 4-link framing pinned: /legal/terms Terms + /legal/privacy Privacy + /legal/dpa DPA + /legal/aup 'Acceptable Use' — pinned so the 4-legal-link surface stays consistent with the W506-pinned legal/ docs (drift to dropping any legal page from the footer would orphan it from compliance review-discovery)", () => {
    expect(body).toMatch(/<h3 class="font-medium text-slate-900">Legal<\/h3>/);
    expect(body).toMatch(/<li><a href="\/legal\/terms" class="nav-link">Terms<\/a><\/li>/);
    expect(body).toMatch(/<li><a href="\/legal\/privacy" class="nav-link">Privacy<\/a><\/li>/);
    expect(body).toMatch(/<li><a href="\/legal\/dpa" class="nav-link">DPA<\/a><\/li>/);
    expect(body).toMatch(/<li><a href="\/legal\/aup" class="nav-link">Acceptable Use<\/a><\/li>/);
  });

  it("StatusBadge embed + EU-VAT notice framing pinned: <StatusBadge /> embedded in bottom bar + 'All prices in USD. VAT/BTW added per region per applicable EU rules.' — pinned so the StatusBadge embed + USD-with-EU-VAT/BTW notice survives (drift to dropping the VAT/BTW notice would mislead EU customers on tax handling)", () => {
    expect(body).toMatch(/<StatusBadge \/>/);
    expect(body).toMatch(
      /<p>All prices in USD\. VAT\/BTW added per region per applicable EU rules\.<\/p>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
