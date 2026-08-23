// W522.A — drift guard for apps/marketing-site/src/components/Header.astro.
// V-133 mobile-responsiveness pass. Drift here either changes a nav
// destination (would create marketing↔dashboard-route divergence) or
// breaks the CSS-only-no-JS-bundle commitment (would invite client-side
// JS into a pure-static marketing site).
//
//   • V-133 doc-comment framing: mobile-responsiveness + 4-item nav
//     overflow fix + CSS-only <details> hamburger + no client-side JS bundle.
//   • 6-item navItems array (S14 nav rework 2026-07-03, D8): /how-it-works
//     + /use-cases + /pricing + /comparison + /faq +
//     https://docs.driftstack.dev (external). /self-hosted left the desktop
//     roster (footer Product column carries it).
//   • Mobile-extra items: /self-hosted + /glossary (no top-level desktop
//     slot). Never /roadmap (F-3 / Issue 5 — no aspirational pages in nav).
//   • Active-link styling on normalized exact-or-nested pathname match.
//   • Sign in → https://app.driftstack.dev/login/.
//   • CTA → /pricing/#free.
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

  it("6-item navItems array pinned (S14 nav rework 2026-07-03, D8): /how-it-works How it works + /use-cases Use cases + /pricing Pricing + /comparison Compare + /faq FAQ + https://docs.driftstack.dev Docs (external), in that order (funnel pages lead). /self-hosted left the desktop roster (footer Product column carries it; mobile keeps a slot). mobileExtraItems: /self-hosted + /glossary + the external Download (the desktop Download sits in the CTA row, which is hidden below md, so it must repeat here or be unreachable on a phone). F-3 (Issue 5) stays binding: no /roadmap anywhere in nav — aspirational pages don't belong in nav at launch.", () => {
    const navBlock = body.match(/const navItems = \[([\s\S]+?)\];/)?.[1] ?? '';
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
    // Self-hosted is out of the desktop roster but keeps its mobile path.
    expect(navBlock).not.toContain("{ href: '/self-hosted'");
    expect(body).toMatch(
      /const mobileExtraItems: Array<\{ href: string; label: string; external\?: boolean \}> = \[[\s\S]*?\{ href: '\/self-hosted', label: 'Self-hosted' \},[\s\S]*?\{ href: '\/glossary', label: 'Glossary' \},[\s\S]*?label: 'Download',[\s\S]*?\];/,
    );
    expect(body).not.toMatch(/\{ href: '\/roadmap',/);
  });

  it('Active-link styling pins normalized exact-or-nested local-route authority and external exclusion with the AA-safe accent-text tone.', () => {
    expect(body).toMatch(/const pathname = Astro\.url\.pathname;/);
    expect(body).toContain(
      "const normalizedPathname = pathname === '/' ? '/' : pathname.replace(/\\/+$/, '');",
    );
    expect(body).toMatch(/if \(item\.external === true\) return false;/);
    expect(body).toMatch(
      /return normalizedPathname === item\.href \|\| normalizedPathname\.startsWith\(`\$\{item\.href\}\/`\);/,
    );
    expect(body).toMatch(
      /class:list=\{\[\s*(?:\/\/[^\n]*\n\s*)*'nav-link font-medium',\s*(?:\/\/[^\n]*\n\s*)*isActiveItem\(item\) && 'text-tk-accent-text',?\s*\]\}/,
    );
    expect(body).toMatch(
      /'rounded px-3 py-2 text-sm font-medium text-tk-ink-2 hover:bg-tk-hover hover:text-tk-ink',\s*(?:\/\/[^\n]*\n\s*)*isActiveItem\(item\) && 'text-tk-accent-text',?\s*\]\}/,
    );
    expect(body).toMatch(/href=\{item\.external \? item\.href : `\$\{item\.href\}\/`\}/);
  });

  it("R15 logo + brand framing pinned: a href / wrapping the new /driftstack-mark.svg <img> (iPhone-D brand SVG) + the W2 DRIFT/STACK two-tone wordmark + font-mono font-semibold + h-8-w-8 mark size. Replaces the prior bg-gradient-accent text-white 'D' chip with the real SVG brand asset. Drift to a different brand-mark source or font-family would create cross-page styling divergence.", () => {
    expect(body).toMatch(
      /<a\s+href="\/"\s+class="group flex items-center gap-2\.5 font-mono text-xl font-semibold text-tk-ink"/,
    );
    expect(body).toMatch(/<img\s*\n?\s*src="\/driftstack-mark\.svg(\?v=\d+)?"/);
    expect(body).toMatch(/width="32"\s*\n?\s*height="32"/);
    // S17 2026-07-04 (Lighthouse a11y): the mark img is decorative (alt="" —
    // the wordmark beside it carries the name; alt="Driftstack" was flagged
    // redundant), and STACK renders in the AA accent-text tone (raw accent
    // is 2.99:1 on the dark bg; same oxblood family, brighter).
    expect(body).toMatch(/alt=""/);
    expect(body).toMatch(
      /<span class="font-sans font-black italic tracking-tight">DRIFT<span class="text-tk-accent-text">STACK<\/span><\/span>/,
    );
  });

  it("Desktop nav 2-CTA framing pinned: canonical sign-in + '/pricing/#free' Start free", () => {
    expect(body).toMatch(
      /<a href="https:\/\/app\.driftstack\.dev\/login\/" class="nav-link">Sign in<\/a>/,
    );
    expect(body).toMatch(/<a href="\/pricing\/#free" class="btn-primary">Start free<\/a>/);
    expect(body).not.toMatch(/href="(?:https:\/\/app\.driftstack\.dev\/login|\/pricing#free)"/);
  });

  it('External-docs noopener-noreferrer framing pinned: \'target={item.external ? "_blank" : undefined}\' + \'rel={item.external ? "noopener noreferrer" : undefined}\' — pinned so the external-link safety pattern (noopener + noreferrer + target=_blank) survives', () => {
    expect(body).toMatch(/target=\{item\.external \? '_blank' : undefined\}/);
    expect(body).toMatch(/rel=\{item\.external \? 'noopener noreferrer' : undefined\}/);
  });

  it('Mobile CTA visible-at-all-widths + canonical Start-button framing pinned.', () => {
    expect(body).toMatch(/<a href="\/pricing\/#free" class="btn-primary text-sm">Start free<\/a>/);
  });

  it("Mobile hamburger <details>+<summary> framing pinned: 'flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-md border border-slate-200 text-slate-700 [&::-webkit-details-marker]:hidden' + aria-label 'Open navigation menu' + 3-line SVG icon (3 <line> elements at y=6/12/18) — pinned so the <details> hamburger + 3-line-icon + aria-label commitment survives (drift to a JS-based menu would break the no-JS-bundle pure-static commitment)", () => {
    expect(body).toMatch(/<details class="relative" data-mobile-nav>/);
    expect(body).toMatch(/aria-label="Open navigation menu"/);
    expect(body).toMatch(/\[&::-webkit-details-marker\]:hidden/);
    expect(body).toMatch(/<line x1="3" y1="6" x2="21" y2="6"><\/line>/);
    expect(body).toMatch(/<line x1="3" y1="12" x2="21" y2="12"><\/line>/);
    expect(body).toMatch(/<line x1="3" y1="18" x2="21" y2="18"><\/line>/);
  });

  it("Mobile nav popup positioning + composed-list framing pinned: 'absolute right-0 top-12 z-20 flex w-56 flex-col gap-1 rounded-md border border-tk-border bg-tk-surface p-3 shadow-glow-accent' + [...navItems, ...mobileExtraItems].map composition + 'in item && item.external' type-narrowed external check — pinned so the mobile-popup positioning + composed-list-spread + type-narrowed-external check survives", () => {
    expect(body).toMatch(
      /class="absolute right-0 top-12 z-20 flex w-56 flex-col gap-1 rounded-md border border-tk-border bg-tk-surface p-3 shadow-glow-accent"/,
    );
    expect(body).toMatch(/\[\.\.\.navItems, \.\.\.mobileExtraItems\]\.map\(\(item\) => \(/);
    expect(body).toMatch(/'external' in item && item\.external \? '_blank' : undefined/);
    expect(body).toMatch(
      /'external' in item && item\.external \? 'noopener noreferrer' : undefined/,
    );
  });

  it('S13 mode toggle: desktop button exposes its current action and pressed state with sun/moon icons; BaseLayout owns delegated wiring.', () => {
    expect(body).toMatch(/data-theme-toggle/);
    expect(body).toMatch(/aria-label="Switch to light theme"/);
    expect(body).toMatch(/aria-pressed="false"/);
    expect(body).toMatch(/title="Switch to light theme"/);
    expect(body).toMatch(/class="hidden dark:block"/);
    expect(body).toMatch(/class="block dark:hidden"/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
