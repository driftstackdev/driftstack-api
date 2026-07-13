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
//   • 6 desktop navItems in canonical order (S14 nav rework
//     2026-07-03, D8): How it works / Use cases / Pricing / Compare /
//     FAQ / Docs(external). Self-hosted left the desktop roster —
//     footer Product column carries it on desktop.
//   • mobileExtraItems: Self-hosted + Glossary (S14 — mobile users
//     keep those paths). Never /roadmap (F-3 / Issue 5).
//   • V-219* D-badge + lowercase font-mono "driftstack".
//   • "Sign in" link to https://app.driftstack.dev/login.
//   • "Start free" btn-primary to /pricing#free.
//   • Mobile hamburger uses CSS-only <details>/<summary> (no JS).
//   • aria-label="Open navigation menu" on summary.
//
// Footer:
//   • 2 columns: Product / Company.
//   • Product (6 links, F-3): Pricing / Comparison / Self-hosted /
//     Docs(external) / Sign up / Sign in. /roadmap removed.
//   • Company (6 links, 2026-07-03 S11): About / FAQ / Changelog /
//     Roadmap / support@ / sales@. (/roadmap returned as a Company
//     link with the v2 redesign; it stays out of the header nav and
//     the Product column on purpose.)
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

  it('6 desktop navItems pinned in canonical order (S14 nav rework 2026-07-03: How it works / Use cases / Pricing / Compare / FAQ / Docs[external]; Self-hosted → footer Product column)', () => {
    const block = body.match(/const navItems = \[([\s\S]+?)\];/);
    expect(block).not.toBeNull();
    const navBlock = block![1]!;
    const order = [
      "{ href: '/how-it-works', label: 'How it works' },",
      "{ href: '/use-cases', label: 'Use cases' },",
      "{ href: '/pricing', label: 'Pricing' },",
      "{ href: '/comparison', label: 'Compare' },",
      "{ href: '/faq', label: 'FAQ' },",
      "{ href: 'https://docs.driftstack.dev', label: 'Docs', external: true },",
    ];
    let lastIdx = -1;
    for (const item of order) {
      const idx = navBlock.indexOf(item);
      expect(idx, `nav item missing or out of order: ${item}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
    expect(navBlock).not.toContain("{ href: '/self-hosted'");
  });

  it('mobileExtraItems: Self-hosted + Glossary (S14 — mobile keeps the paths that left/never had a desktop slot; /roadmap stays banned per F-3 Issue 5)', () => {
    expect(body).toMatch(
      /const mobileExtraItems: Array<\{ href: string; label: string \}> = \[\s*\n?\s*\{ href: '\/self-hosted', label: 'Self-hosted' \},\s*\n?\s*\{ href: '\/glossary', label: 'Glossary' \},\s*\n?\s*\];/,
    );
    expect(body).not.toMatch(/\{ href: '\/roadmap', label: 'Roadmap' \}/);
  });

  it('R15 brand mark in header: /driftstack-mark.svg <img> (iPhone-D logo) + lowercase "driftstack" wordmark — replaces the prior bg-gradient-accent D-tile chip with the real SVG brand asset', () => {
    expect(body).toMatch(/<img\s*\n?\s*src="\/driftstack-mark\.svg(\?v=\d+)?"/);
    // S17 2026-07-04: STACK on the AA accent-text tone (Lighthouse flagged
    // raw accent at 2.99:1 on the dark bg).
    expect(body).toMatch(
      /<span class="font-sans font-black italic tracking-tight">DRIFT<span class="text-tk-accent-text">STACK<\/span><\/span>/,
    );
  });

  it('Sign in CTA → app.driftstack.dev/login + Start free CTA → /pricing#free', () => {
    expect(body).toMatch(
      /<a href="https:\/\/app\.driftstack\.dev\/login" class="nav-link">Sign in<\/a>/,
    );
    expect(body).toMatch(/<a href="\/pricing#free" class="btn-primary">Start free<\/a>/);
  });

  it('mobile hamburger: native <details>/<summary> with an explicit initial accessibility state', () => {
    expect(body).toMatch(/<details class="relative" data-mobile-nav>/);
    expect(body).toMatch(/<summary[\s\S]*?aria-label="Open navigation menu"/);
    expect(body).toMatch(/<summary[\s\S]*?aria-expanded="false"/);
    expect(body).toMatch(/\[&::-webkit-details-marker\]:hidden/);
  });

  it('theme toggle exposes the initial dark-mode state as an unpressed Light theme toggle', () => {
    expect(body).toMatch(/data-theme-toggle[\s\S]*?aria-label="Light theme"/);
    expect(body).toMatch(/data-theme-toggle[\s\S]*?aria-pressed="false"/);
    expect(body).toMatch(/data-theme-toggle[\s\S]*?title="Switch to light theme"/);
  });

  it('mobile CTA: "Start free" (shorter mobile label, same /pricing#free target)', () => {
    expect(body).toMatch(/<a href="\/pricing#free" class="btn-primary text-sm">Start free<\/a>/);
  });

  it('external nav-items render target="_blank" + rel="noopener noreferrer"', () => {
    expect(body).toMatch(/target=\{item\.external \? '_blank' : undefined\}/);
    expect(body).toMatch(/rel=\{item\.external \? 'noopener noreferrer' : undefined\}/);
  });

  it('active-route highlighting: pathname === item.href → text-tk-accent-text (S24 2026-07-06: the active tone is TEXT, so it reads the AA-safe accent-text pair — the raw accent is ~3.0:1 on the dark bg, a fill tone). 2026-05-21 — font-medium moved from active-only to the base class (constant width prevents click-induced horizontal nudge as the active text bolds; same fix as the dashboard 50b0dd7a + admin-panel 3331f410 sidebars).', () => {
    expect(body).toMatch(/pathname === item\.href && 'text-tk-accent-text'/);
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

  it('Product column 6 links pinned (F-3 — /roadmap removed from Product; 2026-07-03 S11 scoped the check to the Product column since /roadmap now lives in Company): Pricing / Comparison / Self-hosted / Docs[ext] / Sign up / Sign in', () => {
    expect(body).toMatch(/<a href="\/pricing" class="nav-link">Pricing<\/a>/);
    expect(body).toMatch(/<a href="\/comparison" class="nav-link">Comparison<\/a>/);
    const productColumn = body.slice(body.indexOf('>Product</h3>'), body.indexOf('>Company</h3>'));
    expect(productColumn).not.toMatch(/<a href="\/roadmap"/);
    expect(body).toMatch(/<a href="\/self-hosted" class="nav-link">Self-hosted<\/a>/);
    expect(body).toMatch(/href="https:\/\/docs\.driftstack\.dev"[\s\S]+?Docs/);
    expect(body).toMatch(
      /<a href="https:\/\/app\.driftstack\.dev\/signup" class="nav-link">Sign up<\/a>/,
    );
    expect(body).toMatch(
      /<a href="https:\/\/app\.driftstack\.dev\/login" class="nav-link">Sign in<\/a>/,
    );
  });

  it('Company column: About / FAQ / Changelog / Roadmap (2026-07-03 S11) + support@ + sales@ mailto', () => {
    expect(body).toMatch(/<a href="\/about" class="nav-link">About<\/a>/);
    expect(body).toMatch(/<a href="\/faq" class="nav-link">FAQ<\/a>/);
    expect(body).toMatch(/<a href="\/changelog" class="nav-link">Changelog<\/a>/);
    expect(body).toMatch(/<a href="\/roadmap" class="nav-link">Roadmap<\/a>/);
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

  it('S13 (2026-07-03): footer bottom row carries the "No trackers on this site." statement + a [data-theme-toggle] mode button (header has the primary one; wiring is BaseLayout-delegated)', () => {
    expect(body).toMatch(/No trackers on this site\./);
    expect(body).toMatch(/data-theme-toggle/);
    expect(body).toMatch(/aria-label="Light theme"/);
    expect(body).toMatch(/aria-pressed="false"/);
    expect(body).toMatch(/title="Switch to light theme"/);
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
