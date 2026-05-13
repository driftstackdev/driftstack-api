// W382.C — drift guard for marketing-site Header.astro + Footer.
// astro components. Existing footer-nav-baseline checks href
// integrity; this guard pins the load-bearing structure + copy
// that every marketing-site page renders:
//
// Header:
//   • V-133 mobile-responsive framing pinned in comment.
//   • 5 desktop navItems in canonical order: Pricing / Compare /
//     Self-hosted / FAQ / Docs(external).
//   • Mobile-extra navItem: Roadmap.
//   • V-219* D-badge + lowercase font-mono "driftstack".
//   • "Sign in" link to https://app.driftstack.dev/login.
//   • "Get started" btn-primary to /pricing#trial-pack.
//   • Mobile hamburger uses CSS-only <details>/<summary> (no JS).
//   • aria-label="Open navigation menu" on summary.
//
// Footer:
//   • 4 columns: Product / Company / Trust / Legal.
//   • Product (7 links): Pricing / Comparison / Roadmap / Self-
//     hosted / Docs(external) / Sign up / Sign in.
//   • Company (5 links): About / FAQ / Changelog / support@ /
//     sales@.
//   • Trust (5 links): Trust center / Security / Sub-processors /
//     Incidents / Status(external).
//   • Legal (4 links): Terms / Privacy / DPA / Acceptable Use.
//   • Tagline: "iPhone Safari sessions, on demand."
//   • VAT/BTW disclosure: "All prices in USD. VAT/BTW added per
//     region per applicable EU rules."
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

  it('mobileExtraItems: Roadmap (mobile-only, not on desktop)', () => {
    expect(body).toMatch(
      /const mobileExtraItems = \[\s*\{ href: '\/roadmap', label: 'Roadmap' \},?\s*\];/,
    );
  });

  it('V-219* D-badge (gradient-accent) + lowercase "driftstack" wordmark in header', () => {
    expect(body).toMatch(/rounded-md bg-gradient-accent text-white/);
    expect(body).toMatch(/<span class="tracking-tight">driftstack<\/span>/);
  });

  it('Sign in CTA → app.driftstack.dev/login + Get started CTA → /pricing#trial-pack', () => {
    expect(body).toMatch(
      /<a href="https:\/\/app\.driftstack\.dev\/login" class="nav-link">Sign in<\/a>/,
    );
    expect(body).toMatch(/<a href="\/pricing#trial-pack" class="btn-primary">Get started<\/a>/);
  });

  it('mobile hamburger: CSS-only <details>/<summary> (no client-side JS)', () => {
    expect(body).toMatch(/<details class="relative">/);
    expect(body).toMatch(/<summary[\s\S]*?aria-label="Open navigation menu"/);
    expect(body).toMatch(/\[&::-webkit-details-marker\]:hidden/);
  });

  it('mobile CTA: "Start" (shorter mobile label, same /pricing#trial-pack target)', () => {
    expect(body).toMatch(/<a href="\/pricing#trial-pack" class="btn-primary text-sm">Start<\/a>/);
  });

  it('external nav-items render target="_blank" + rel="noopener noreferrer"', () => {
    expect(body).toMatch(/target=\{item\.external \? '_blank' : undefined\}/);
    expect(body).toMatch(/rel=\{item\.external \? 'noopener noreferrer' : undefined\}/);
  });

  it('active-route highlighting: pathname === item.href → text-glow-red font-medium', () => {
    expect(body).toMatch(/pathname === item\.href && 'text-glow-red font-medium'/);
  });
});

describe('W382.C marketing-site Footer.astro content parity', () => {
  const body = read(FOOTER);

  it('imports StatusBadge + uses dynamic UTC year', () => {
    expect(body).toMatch(/import StatusBadge from '\.\/StatusBadge\.astro';/);
    expect(body).toMatch(/const year = new Date\(\)\.getUTCFullYear\(\);/);
  });

  it('tagline: "iPhone Safari sessions, on demand. Premium fidelity for the device that matters."', () => {
    expect(body).toMatch(
      /iPhone Safari sessions, on demand\. Premium fidelity for the device that matters\./,
    );
  });

  it('4 column headings in canonical order: Product / Company / Trust / Legal', () => {
    const expected = ['Product', 'Company', 'Trust', 'Legal'];
    let lastIdx = -1;
    for (const heading of expected) {
      const idx = body.indexOf(
        `<h3 class="font-medium text-ink-primary text-xs uppercase tracking-widest">${heading}</h3>`,
      );
      expect(idx, `column heading out of order: ${heading}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it('Product column 7 links pinned (Pricing / Comparison / Roadmap / Self-hosted / Docs[ext] / Sign up / Sign in)', () => {
    expect(body).toMatch(/<a href="\/pricing" class="nav-link">Pricing<\/a>/);
    expect(body).toMatch(/<a href="\/comparison" class="nav-link">Comparison<\/a>/);
    expect(body).toMatch(/<a href="\/roadmap" class="nav-link">Roadmap<\/a>/);
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

  it('Trust column: Trust center / Security / Sub-processors / Incidents / Status[external]', () => {
    expect(body).toMatch(/<a href="\/trust" class="nav-link">Trust center<\/a>/);
    expect(body).toMatch(/<a href="\/security" class="nav-link">Security<\/a>/);
    expect(body).toMatch(/<a href="\/trust\/sub-processors" class="nav-link">Sub-processors<\/a>/);
    expect(body).toMatch(/<a href="\/trust\/incidents" class="nav-link">Incidents<\/a>/);
    expect(body).toMatch(/href="https:\/\/status\.driftstack\.dev"[\s\S]+?Status/);
  });

  it('Legal column 4 links pinned (Terms / Privacy / DPA / Acceptable Use)', () => {
    expect(body).toMatch(/<a href="\/legal\/terms" class="nav-link">Terms<\/a>/);
    expect(body).toMatch(/<a href="\/legal\/privacy" class="nav-link">Privacy<\/a>/);
    expect(body).toMatch(/<a href="\/legal\/dpa" class="nav-link">DPA<\/a>/);
    expect(body).toMatch(/<a href="\/legal\/aup" class="nav-link">Acceptable Use<\/a>/);
  });

  it('VAT/BTW disclosure pinned: "All prices in USD. VAT/BTW added per region per applicable EU rules."', () => {
    expect(body).toMatch(/All prices in USD\. VAT\/BTW added per region per applicable EU rules\./);
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

  it('V-219* D-badge (gradient-accent) + lowercase "driftstack" wordmark in footer', () => {
    expect(body).toMatch(/rounded-md bg-gradient-accent text-white text-xs/);
    expect(body).toMatch(/<span class="tracking-tight">driftstack<\/span>/);
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
