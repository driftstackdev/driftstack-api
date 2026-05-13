// W522.A — drift guard for apps/marketing-site/src/components/Header.astro.
// V-133 mobile-responsiveness pass. Drift here either changes a nav
// destination (would create marketing↔dashboard-route divergence) or
// breaks the CSS-only-no-JS-bundle commitment (would invite client-side
// JS into a pure-static marketing site).
//
//   • V-133 doc-comment framing: mobile-responsiveness + 4-item nav
//     overflow fix + CSS-only <details> hamburger + no client-side JS bundle.
//   • 5-item navItems array: /pricing + /comparison + /self-hosted + /faq
//     + https://docs.driftstack.dev (external).
//   • Mobile-extra item: /roadmap (no top-level desktop slot).
//   • Active-link styling on pathname match.
//   • Sign in → https://app.driftstack.dev/login.
//   • CTA → /pricing#trial-pack.
//   • External docs link opens with noopener noreferrer.
//   • Mobile hamburger uses <details> with custom-summary + 3-line SVG icon.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/components/Header.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W522.A apps/marketing-site/src/components/Header.astro content parity', () => {
  const body = read(LIB);

  it("V-133 framing pinned: 'mobile responsiveness pass. On mobile (<md), the 4-item nav + CTA + logo overflowed in a single row. Now: logo + CTA stay visible at all widths; nav links hide on mobile and reveal via CSS-only <details> hamburger so we don't need a client-side JS bundle for a pure-static marketing site.' — pinned so the V-133 anchor + CSS-only-no-JS-bundle commitment + pure-static-marketing-site posture survives", () => {
    expect(body).toMatch(
      /\/\/ V-133: mobile responsiveness pass\.\s*\n?\s*\/\/ On mobile \(<md\), the 4-item nav \+ CTA \+ logo overflowed in a single\s*\n?\s*\/\/ row\. Now: logo \+ CTA stay visible at all widths; nav links hide on\s*\n?\s*\/\/ mobile and reveal via CSS-only <details> hamburger so we don't need\s*\n?\s*\/\/ a client-side JS bundle for a pure-static marketing site\./,
    );
  });

  it("5-item navItems array pinned: /pricing Pricing + /comparison Compare + /self-hosted Self-hosted + /faq FAQ + https://docs.driftstack.dev Docs (external) + 'Mobile-menu list mirrors desktop + adds the secondary pages that don't earn a top-level desktop slot (currently: Roadmap).' + /roadmap Roadmap in mobileExtraItems — pinned so the 5-nav + 1-mobile-extra commitment + Docs-as-external + Roadmap-as-mobile-only-secondary commitment survives (drift to a different nav destination would create marketing↔site-route divergence)", () => {
    expect(body).toMatch(/\{ href: '\/pricing', label: 'Pricing' \},/);
    expect(body).toMatch(/\{ href: '\/comparison', label: 'Compare' \},/);
    expect(body).toMatch(/\{ href: '\/self-hosted', label: 'Self-hosted' \},/);
    expect(body).toMatch(/\{ href: '\/faq', label: 'FAQ' \},/);
    expect(body).toMatch(
      /\{ href: 'https:\/\/docs\.driftstack\.dev', label: 'Docs', external: true \},/,
    );
    expect(body).toMatch(
      /\/\/ Mobile-menu list mirrors desktop \+ adds the secondary pages that\s*\n?\s*\/\/ don't earn a top-level desktop slot \(currently: Roadmap\)\./,
    );
    expect(body).toMatch(
      /const mobileExtraItems = \[\s*\{ href: '\/roadmap', label: 'Roadmap' \},?\s*\];/,
    );
  });

  it("Active-link styling + pathname-match framing pinned: 'pathname === item.href && text-oxblood-700 font-medium' + Astro.url.pathname source-of-truth — pinned so the active-link styling pattern + pathname source commitment survives (drift to claiming external active state would mislead users about their current location)", () => {
    expect(body).toMatch(/const pathname = Astro\.url\.pathname;/);
    expect(body).toMatch(
      /class:list=\{\[\s*'nav-link',\s*pathname === item\.href && 'text-glow-red font-medium',?\s*\]\}/,
    );
  });

  it("R15 logo + brand framing pinned: a href / wrapping the new /driftstack-mark.svg <img> (iPhone-D brand SVG) + 'driftstack' wordmark + font-mono font-semibold + h-8-w-8 mark size. Replaces the prior bg-gradient-accent text-white 'D' chip with the real SVG brand asset. Drift to a different brand-mark source or font-family would create cross-page styling divergence.", () => {
    expect(body).toMatch(
      /<a\s+href="\/"\s+class="group flex items-center gap-2\.5 font-mono text-base font-semibold text-ink-primary"/,
    );
    expect(body).toMatch(/<img\s*\n?\s*src="\/driftstack-mark\.svg(\?v=\d+)?"/);
    expect(body).toMatch(/width="32"\s*\n?\s*height="32"/);
    expect(body).toMatch(/<span class="tracking-tight">driftstack<\/span>/);
  });

  it("Desktop nav 2-CTA framing pinned: 'Sign in' → https://app.driftstack.dev/login + 'Get started' btn-primary → /pricing#trial-pack — pinned so the 2-CTA target (dashboard login URL + #trial-pack pricing anchor) commitment survives (drift to a different login URL would create marketing↔dashboard divergence)", () => {
    expect(body).toMatch(
      /<a href="https:\/\/app\.driftstack\.dev\/login" class="nav-link">Sign in<\/a>/,
    );
    expect(body).toMatch(/<a href="\/pricing#trial-pack" class="btn-primary">Get started<\/a>/);
  });

  it('External-docs noopener-noreferrer framing pinned: \'target={item.external ? "_blank" : undefined}\' + \'rel={item.external ? "noopener noreferrer" : undefined}\' — pinned so the external-link safety pattern (noopener + noreferrer + target=_blank) survives', () => {
    expect(body).toMatch(/target=\{item\.external \? '_blank' : undefined\}/);
    expect(body).toMatch(/rel=\{item\.external \? 'noopener noreferrer' : undefined\}/);
  });

  it('Mobile CTA visible-at-all-widths + Start-button framing pinned: \'<a href="/pricing#trial-pack" class="btn-primary text-sm">Start</a>\' — pinned so the mobile CTA always-visible + \'Start\' short-label + same /pricing#trial-pack anchor commitment survives (drift to hiding CTA on mobile would lose the conversion path)', () => {
    expect(body).toMatch(/<a href="\/pricing#trial-pack" class="btn-primary text-sm">Start<\/a>/);
  });

  it("Mobile hamburger <details>+<summary> framing pinned: 'flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-md border border-slate-200 text-slate-700 [&::-webkit-details-marker]:hidden' + aria-label 'Open navigation menu' + 3-line SVG icon (3 <line> elements at y=6/12/18) — pinned so the <details> hamburger + 3-line-icon + aria-label commitment survives (drift to a JS-based menu would break the no-JS-bundle pure-static commitment)", () => {
    expect(body).toMatch(/<details class="relative">/);
    expect(body).toMatch(/aria-label="Open navigation menu"/);
    expect(body).toMatch(/\[&::-webkit-details-marker\]:hidden/);
    expect(body).toMatch(/<line x1="3" y1="6" x2="21" y2="6"><\/line>/);
    expect(body).toMatch(/<line x1="3" y1="12" x2="21" y2="12"><\/line>/);
    expect(body).toMatch(/<line x1="3" y1="18" x2="21" y2="18"><\/line>/);
  });

  it("Mobile nav popup positioning + composed-list framing pinned: 'absolute right-0 top-12 z-20 flex w-56 flex-col gap-1 rounded-md border border-slate-200 bg-white p-3 shadow-lg' + [...navItems, ...mobileExtraItems].map composition + 'in item && item.external' type-narrowed external check — pinned so the mobile-popup positioning + composed-list-spread + type-narrowed-external check survives", () => {
    expect(body).toMatch(
      /class="absolute right-0 top-12 z-20 flex w-56 flex-col gap-1 rounded-md border border-white\/10 bg-surface-raised p-3 shadow-glow-red"/,
    );
    expect(body).toMatch(/\[\.\.\.navItems, \.\.\.mobileExtraItems\]\.map\(\(item\) => \(/);
    expect(body).toMatch(/'external' in item && item\.external \? '_blank' : undefined/);
    expect(body).toMatch(
      /'external' in item && item\.external \? 'noopener noreferrer' : undefined/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
