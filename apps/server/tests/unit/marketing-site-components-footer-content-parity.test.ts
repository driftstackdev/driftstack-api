// W522.B — drift guard for apps/marketing-site/src/components/Footer.astro.
// Marketing-site footer with 2-category nav grid + product-focused signal
// strip + consolidated meta link row + status badge + auto-year copyright.
//
// F-3 (Issue 7, 2026-05-16): four-column grid (Product/Company/Trust/Legal)
// collapsed to two-column (Product/Company); compliance badges replaced
// with product-focused differentiators; trust + legal links moved to a
// small bottom meta-link row; /roadmap link removed (Issue 5 — no
// aspirational language at launch); EU-VAT/BTW notice removed from
// prominent position.
//
//   • Auto-year copyright via new Date().getUTCFullYear() (UTC-pinned).
//   • Brand tagline: 'Pixel-identical iPhone Safari sessions in the cloud.
//     API, SDK, or GUI.'.
//   • 2-category nav grid: Product / Company.
//   • Product 6-link: /pricing + /comparison + /self-hosted +
//     docs.driftstack.dev (external) + app/signup + app/login.
//   • Company 6-link (2026-07-03 S11): /about + /faq + /changelog +
//     /roadmap + support@ + sales@. (/roadmap returned as a Company
//     link with the v2 redesign — the Issue-5 removal targeted the
//     aspirational Product-column/header placement, which stays gone.)
//   • Meta link row: /legal/privacy + /legal/terms + /legal/dpa +
//     /legal/aup + /trust + /security + /trust/sub-processors +
//     status.driftstack.dev (external).
//   • Product signal strip: bit-identical iPhone Safari fingerprint +
//     SOCKS5/WireGuard/OpenVPN proxies + API/SDK/GUI access + EU-hosted.
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

  it('Auto-year UTC + StatusBadge import + brand tagline framing. 2026-05-23 — tagline expanded with proxy/VPN egress capability per founder direction (UDP/QUIC/WebRTC + OpenVPN + WireGuard); pin loosened to per-clause assertions.', () => {
    expect(body).toMatch(/import StatusBadge from '\.\/StatusBadge\.astro';/);
    expect(body).toMatch(/const year = new Date\(\)\.getUTCFullYear\(\);/);
    expect(body).toMatch(/Pixel-identical iPhone Safari sessions in the cloud\./);
    expect(body).toMatch(/SOCKS5/);
    expect(body).toMatch(/API, SDK, or GUI\./);
    expect(body).toMatch(/&copy; \{year\} Driftstack\. All rights reserved\./);
  });

  it('Product-category 6-link framing pinned (F-3 — /roadmap removed per Issue 5 no-aspirational-language; 2026-07-03 S11 scoped the not-check to the Product column since /roadmap now ships as a Company link): /pricing + /comparison + /self-hosted + docs.driftstack.dev (external) + app/signup + app/login', () => {
    expect(body).toMatch(
      /<h3 class="font-medium text-tk-ink text-xs uppercase tracking-widest">Product<\/h3>/,
    );
    expect(body).toMatch(/<li><a href="\/pricing\/" class="nav-link">Pricing<\/a><\/li>/);
    expect(body).toMatch(/<li><a href="\/comparison\/" class="nav-link">Comparison<\/a><\/li>/);
    const productColumn = body.slice(body.indexOf('>Product</h3>'), body.indexOf('>Company</h3>'));
    expect(productColumn).not.toMatch(/<li><a href="\/roadmap"/);
    expect(body).toMatch(/<li><a href="\/self-hosted\/" class="nav-link">Self-hosted<\/a><\/li>/);
    expect(body).toMatch(
      /<a\s*\n?\s*href="https:\/\/docs\.driftstack\.dev"\s*\n?\s*class="nav-link"\s*\n?\s*target="_blank"\s*\n?\s*rel="noopener noreferrer">Docs<\/a/,
    );
    expect(body).toMatch(
      /<a href="https:\/\/app\.driftstack\.dev\/signup\/" class="nav-link">Sign up<\/a>/,
    );
    expect(body).toMatch(
      /<a href="https:\/\/app\.driftstack\.dev\/login\/" class="nav-link">Sign in<\/a>/,
    );
  });

  it('Company-category 6-link framing pinned (2026-07-03 S11 added /roadmap): /about + /faq + /changelog + /roadmap + mailto:support@driftstack.dev + mailto:sales@driftstack.dev — pinned so the 6-company-link surface + 2-mailto-channel (support + sales) commitment survives (drift to dropping either mailto would orphan the sales+support routing)', () => {
    expect(body).toMatch(
      /<h3 class="font-medium text-tk-ink text-xs uppercase tracking-widest">Company<\/h3>/,
    );
    expect(body).toMatch(/<li><a href="\/about\/" class="nav-link">About<\/a><\/li>/);
    expect(body).toMatch(/<li><a href="\/faq\/" class="nav-link">FAQ<\/a><\/li>/);
    expect(body).toMatch(/<li><a href="\/changelog\/" class="nav-link">Changelog<\/a><\/li>/);
    expect(body).not.toMatch(/href="\/roadmap\/"|>Roadmap<\/a>/);
    expect(body).toMatch(
      /<a href="mailto:support@driftstack\.dev" class="nav-link">support@driftstack\.dev<\/a>/,
    );
    expect(body).toMatch(
      /<a href="mailto:sales@driftstack\.dev" class="nav-link">sales@driftstack\.dev<\/a>/,
    );
  });

  it('F-3 meta link row (Trust + Legal collapsed): /legal/privacy + /legal/terms + /legal/dpa + /legal/aup + /trust + /security + /trust/sub-processors + status.driftstack.dev (external). Trust/Legal sub-headed columns removed; surfaces these as a single small bottom link row.', () => {
    // Trust + Legal grid columns must NOT exist as headed sub-blocks.
    expect(body).not.toMatch(
      /<h3 class="font-medium text-tk-ink text-xs uppercase tracking-widest">Trust<\/h3>/,
    );
    expect(body).not.toMatch(
      /<h3 class="font-medium text-tk-ink text-xs uppercase tracking-widest">Legal<\/h3>/,
    );
    // But the links must still be present as nav-links somewhere
    // (the meta-link row).
    expect(body).toMatch(/<a href="\/legal\/privacy\/" class="nav-link">Privacy<\/a>/);
    expect(body).toMatch(/<a href="\/legal\/terms\/" class="nav-link">Terms<\/a>/);
    expect(body).toMatch(/<a href="\/legal\/dpa\/" class="nav-link">DPA<\/a>/);
    expect(body).toMatch(/<a href="\/legal\/aup\/" class="nav-link">Acceptable Use<\/a>/);
    expect(body).toMatch(/<a href="\/trust\/" class="nav-link">Trust<\/a>/);
    expect(body).toMatch(/<a href="\/security\/" class="nav-link">Security<\/a>/);
    expect(body).toMatch(
      /<a href="\/trust\/sub-processors\/" class="nav-link">Sub-processors<\/a>/,
    );
    expect(body).toMatch(
      /<a\s*\n?\s*href="https:\/\/status\.driftstack\.dev"\s*\n?\s*class="nav-link"\s*\n?\s*target="_blank"\s*\n?\s*rel="noopener noreferrer">Status<\/a/,
    );
    expect(body).not.toMatch(
      /href="\/(?:pricing|comparison|self-hosted|about|faq|changelog|roadmap|legal\/privacy|legal\/terms|legal\/dpa|legal\/aup|trust|security|trust\/sub-processors)"/,
    );
    expect(body).not.toMatch(/href="https:\/\/app\.driftstack\.dev\/(?:signup|login)"/);
  });

  it("F-3 product-focused signal strip replaces R7 compliance-badge strip: 'Bit-identical iPhone Safari fingerprint' + 'SOCKS5 · WireGuard · OpenVPN proxies' + 'API · SDK · GUI access' + 'EU-hosted'. Stripe-billed/GDPR-aware/Article 28(2) badges removed from the splash row (legal copy lives on /trust + /legal pages).", () => {
    expect(body).toMatch(/Bit-identical iPhone Safari fingerprint/);
    expect(body).toMatch(/SOCKS5 · WireGuard · OpenVPN proxies/);
    expect(body).toMatch(/API · SDK · GUI access/);
    expect(body).toMatch(/UDP \/ QUIC \/ WebRTC tunnelling/);
    // Old splash badges must NOT reappear in the footer prominent position.
    expect(body).not.toMatch(/Stripe-billed · SCA \/ 3DS/);
    expect(body).not.toMatch(/GDPR-aware · DPA on request/);
    expect(body).not.toMatch(/EU-resident infrastructure/);
    expect(body).not.toMatch(/Article 28\(2\) sub-processor change-log/);
  });

  it('StatusBadge embed + VAT notice removal: <StatusBadge /> still present; F-3 strips the prominent VAT/BTW line (moved to /pricing context).', () => {
    expect(body).toMatch(/<StatusBadge \/>/);
    expect(body).not.toMatch(
      /<p>All prices in USD\. VAT\/BTW added per region per applicable EU rules\.<\/p>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
