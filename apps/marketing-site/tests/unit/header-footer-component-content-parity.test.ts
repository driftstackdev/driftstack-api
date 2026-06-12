// W382.C — drift guard for marketing-site Header.astro + Footer.
// astro components. Existing footer-nav-baseline checks href
// integrity; this guard pins the load-bearing structure + copy
// that every marketing-site page renders.
//
// 2026-05-16 F-3 (Issue 7) revisions:
//   • Header: mobileExtraItems now empty (Roadmap link removed per
//     Issue 5 — no aspirational nav at launch).
//   • Footer: 4-column grid collapsed to 2-column (Product/Company);
//     Trust + Legal links moved to a bottom meta-link row; compliance
//     badge strip (Stripe-billed/GDPR-aware/EU-resident/Article 28)
//     replaced with product-focused signals; VAT/BTW notice removed
//     from prominent bar; brand tagline updated to "Pixel-identical
//     iPhone Safari sessions in the cloud. API, SDK, or GUI." per
//     Issue 4 framing (outcome > implementation, GUI added).
//
// Header:
//   • V-133 mobile-responsive framing pinned in comment.
//   • 5 desktop navItems in canonical order: Pricing / Compare /
//     Self-hosted / FAQ / Docs(external).
//   • mobileExtraItems is now an empty array (F-3).
//   • V-219* D-badge + lowercase font-mono "driftstack".
//   • "Sign in" link to https://app.driftstack.dev/login.
//   • "Get started" btn-primary to /pricing#free.
//   • Mobile hamburger uses CSS-only <details>/<summary> (no JS).
//   • aria-label="Open navigation menu" on summary.
//
// Footer:
//   • 2 columns: Product / Company.
//   • Product (6 links, F-3): Pricing / Comparison / Self-hosted /
//     Docs(external) / Sign up / Sign in. /roadmap removed.
//   • Company (5 links): About / FAQ / Changelog / support@ /
//     sales@.
//   • Meta link row: legal/privacy / legal/terms / legal/dpa /
//     legal/aup / trust / security / trust/sub-processors /
//     status(external).
//   • Product signal strip: bit-identical iPhone Safari fingerprint
//     + SOCKS5/WireGuard/OpenVPN proxies + API/SDK/GUI access +
//     EU-hosted.
//   • Tagline: "Pixel-identical iPhone Safari sessions in the cloud.
//     API, SDK, or GUI."
//   • StatusBadge embed (live platform health on every page).
//   • {year} dynamic copyright.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const HEADER = resolve(REPO_ROOT, 'apps/marketing-site/src/components/Header.astro');
const FOOTER = resolve(REPO_ROOT, 'apps/marketing-site/src/components/Footer.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W382.C marketing-site Header.astro content parity', () => {
  const body = read(HEADER);

  it('V-133 mobile-responsive framing pinned in component comment', () => {
    expect(body).toMatch(/V-133: mobile responsiveness pass/);
    expect(body).toMatch(
      /CSS-only <details> hamburger so we don't need\s*\n?\s*\/\/\s*a client-side JS bundle/,
    );
  });

  it('5 desktop navItems pinned in canonical order (Pricing / Compare / Self-hosted / FAQ / Docs[external])', () => {
    const block = body.match(/const navItems = \[([\s\S]+?)\];/);
    expect(block).not.toBeNull();
    expect(body).toMatch(/\{ href: '\/pricing', label: 'Pricing' \}/);
    expect(body).toMatch(/\{ href: '\/comparison', label: 'Compare' \}/);
    expect(body).toMatch(/\{ href: '\/self-hosted', label: 'Self-hosted' \}/);
    expect(body).toMatch(/\{ href: '\/faq', label: 'FAQ' \}/);
    expect(body).toMatch(
      /\{ href: 'https:\/\/docs\.driftstack\.dev', label: 'Docs', external: true \}/,
    );
  });

  it('mobileExtraItems: empty array (F-3 — /roadmap removed per Issue 5)', () => {
    expect(body).toMatch(
      /const mobileExtraItems: Array<\{ href: string; label: string \}> = \[\];/,
    );
    expect(body).not.toMatch(/\{ href: '\/roadmap', label: 'Roadmap' \}/);
  });

  it('R15 brand mark in header: /driftstack-mark.svg <img> (iPhone-D logo) + lowercase "driftstack" wordmark — replaces the prior bg-gradient-accent D-tile chip with the real SVG brand asset', () => {
    expect(body).toMatch(/<img\s*\n?\s*src="\/driftstack-mark\.svg(\?v=\d+)?"/);
    expect(body).toMatch(
      /<span class="font-sans font-black italic tracking-tight">DRIFT<span class="text-tk-accent">STACK<\/span><\/span>/,
    );
  });

  it('Sign in CTA → app.driftstack.dev/login + Get started CTA → /pricing#free', () => {
    expect(body).toMatch(
      /<a href="https:\/\/app\.driftstack\.dev\/login" class="nav-link">Sign in<\/a>/,
    );
    expect(body).toMatch(/<a href="\/pricing#free" class="btn-primary">Get started<\/a>/);
  });

  it('mobile hamburger: CSS-only <details>/<summary> (no client-side JS)', () => {
    expect(body).toMatch(/<details class="relative">/);
    expect(body).toMatch(/<summary[\s\S]*?aria-label="Open navigation menu"/);
    expect(body).toMatch(/\[&::-webkit-details-marker\]:hidden/);
  });

  it('mobile CTA: "Start" (shorter mobile label, same /pricing#free target)', () => {
    expect(body).toMatch(/<a href="\/pricing#free" class="btn-primary text-sm">Start<\/a>/);
  });

  it('external nav-items render target="_blank" + rel="noopener noreferrer"', () => {
    expect(body).toMatch(/target=\{item\.external \? '_blank' : undefined\}/);
    expect(body).toMatch(/rel=\{item\.external \? 'noopener noreferrer' : undefined\}/);
  });

  it('active-route highlighting: pathname === item.href → text-tk-accent (Fleet token; was text-tk-accent). 2026-05-21 — font-medium moved from active-only to the base class (constant width prevents click-induced horizontal nudge as the active text bolds; same fix as the dashboard 50b0dd7a + admin-panel 3331f410 sidebars).', () => {
    expect(body).toMatch(/pathname === item\.href && 'text-tk-accent'/);
    expect(body).toMatch(/'nav-link font-medium'/);
  });
});

describe('W382.C marketing-site Footer.astro content parity', () => {
  const body = read(FOOTER);

  it('imports StatusBadge + uses dynamic UTC year', () => {
    expect(body).toMatch(/import StatusBadge from '\.\/StatusBadge\.astro';/);
    expect(body).toMatch(/const year = new Date\(\)\.getUTCFullYear\(\);/);
  });

  it('tagline (F-3): brand framing + proxy egress capability. 2026-05-23 — expanded with SOCKS5/OpenVPN/WireGuard per founder direction.', () => {
    expect(body).toMatch(/Pixel-identical iPhone Safari sessions in the cloud\./);
    expect(body).toMatch(/SOCKS5/);
    expect(body).toMatch(/API, SDK, or GUI\./);
  });

  it('2 column headings in canonical order: Product / Company (F-3 — Trust + Legal moved to meta-link row)', () => {
    const expected = ['Product', 'Company'];
    let lastIdx = -1;
    for (const heading of expected) {
      const idx = body.indexOf(
        `<h3 class="font-medium text-tk-ink text-xs uppercase tracking-widest">${heading}</h3>`,
      );
      expect(idx, `column heading out of order: ${heading}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
    // Trust + Legal sub-headed columns must NOT exist any more.
    expect(body).not.toMatch(
      /<h3 class="font-medium text-tk-ink text-xs uppercase tracking-widest">Trust<\/h3>/,
    );
    expect(body).not.toMatch(
      /<h3 class="font-medium text-tk-ink text-xs uppercase tracking-widest">Legal<\/h3>/,
    );
  });

  it('Product column 6 links pinned (F-3 — /roadmap removed): Pricing / Comparison / Self-hosted / Docs[ext] / Sign up / Sign in', () => {
    expect(body).toMatch(/<a href="\/pricing" class="nav-link">Pricing<\/a>/);
    expect(body).toMatch(/<a href="\/comparison" class="nav-link">Comparison<\/a>/);
    expect(body).not.toMatch(/<a href="\/roadmap"/);
    expect(body).toMatch(/<a href="\/self-hosted" class="nav-link">Self-hosted<\/a>/);
    expect(body).toMatch(/href="https:\/\/docs\.driftstack\.dev"[\s\S]+?Docs/);
    expect(body).toMatch(
      /<a href="https:\/\/app\.driftstack\.dev\/signup" class="nav-link">Sign up<\/a>/,
    );
    expect(body).toMatch(
      /<a href="https:\/\/app\.driftstack\.dev\/login" class="nav-link">Sign in<\/a>/,
    );
  });

  it('Company column: About / FAQ / Changelog + support@ + sales@ mailto', () => {
    expect(body).toMatch(/<a href="\/about" class="nav-link">About<\/a>/);
    expect(body).toMatch(/<a href="\/faq" class="nav-link">FAQ<\/a>/);
    expect(body).toMatch(/<a href="\/changelog" class="nav-link">Changelog<\/a>/);
    expect(body).toMatch(
      /<a href="mailto:support@driftstack\.dev" class="nav-link">support@driftstack\.dev<\/a>/,
    );
    expect(body).toMatch(
      /<a href="mailto:sales@driftstack\.dev" class="nav-link">sales@driftstack\.dev<\/a>/,
    );
  });

  it('Trust meta-row links present (F-3 — moved out of headed column): Trust / Security / Sub-processors / Status[external]', () => {
    expect(body).toMatch(/<a href="\/trust" class="nav-link">Trust<\/a>/);
    expect(body).toMatch(/<a href="\/security" class="nav-link">Security<\/a>/);
    expect(body).toMatch(/<a href="\/trust\/sub-processors" class="nav-link">Sub-processors<\/a>/);
    expect(body).toMatch(/href="https:\/\/status\.driftstack\.dev"[\s\S]+?Status/);
  });

  it('Legal meta-row links present (F-3 — moved out of headed column): Terms / Privacy / DPA / Acceptable Use', () => {
    expect(body).toMatch(/<a href="\/legal\/terms" class="nav-link">Terms<\/a>/);
    expect(body).toMatch(/<a href="\/legal\/privacy" class="nav-link">Privacy<\/a>/);
    expect(body).toMatch(/<a href="\/legal\/dpa" class="nav-link">DPA<\/a>/);
    expect(body).toMatch(/<a href="\/legal\/aup" class="nav-link">Acceptable Use<\/a>/);
  });

  it('VAT/BTW disclosure removed from footer prominent bar per F-3 (Issue 7) — that detail belongs on /pricing context, not on every page', () => {
    expect(body).not.toMatch(
      /All prices in USD\. VAT\/BTW added per region per applicable EU rules\./,
    );
  });

  it('F-3 product-focused signal strip present (replaced compliance badges): bit-identical fingerprint + SOCKS5/WireGuard/OpenVPN + API/SDK/GUI + EU-hosted', () => {
    expect(body).toMatch(/Bit-identical iPhone Safari fingerprint/);
    expect(body).toMatch(/SOCKS5 · WireGuard · OpenVPN proxies/);
    expect(body).toMatch(/API · SDK · GUI access/);
    expect(body).toMatch(/UDP \/ QUIC \/ WebRTC tunnelling/);
  });

  it('<StatusBadge /> embed (live platform health on every page footer)', () => {
    expect(body).toMatch(/<StatusBadge \/>/);
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/components/StatusBadge.astro')),
    ).toBe(true);
  });

  it('dynamic copyright: "© {year} Driftstack. All rights reserved."', () => {
    expect(body).toMatch(/&copy; \{year\} Driftstack\. All rights reserved\./);
  });

  it('R15 brand mark in footer: /driftstack-mark.svg <img> (iPhone-D logo) — replaces the prior bg-gradient-accent text-xs D chip. Footer no longer renders a separate "driftstack" wordmark element (the brand SVG carries the identity on its own at the footer scale)', () => {
    expect(body).toMatch(/<img\s*\n?\s*src="\/driftstack-mark\.svg(\?v=\d+)?"/);
  });

  it('Docs + Status external links carry target="_blank" + rel="noopener noreferrer"', () => {
    expect(body).toMatch(
      /href="https:\/\/docs\.driftstack\.dev"\s*\n?\s*class="nav-link"\s*\n?\s*target="_blank"\s*\n?\s*rel="noopener noreferrer"/,
    );
    expect(body).toMatch(
      /href="https:\/\/status\.driftstack\.dev"\s*\n?\s*class="nav-link"\s*\n?\s*target="_blank"\s*\n?\s*rel="noopener noreferrer"/,
    );
  });
});
