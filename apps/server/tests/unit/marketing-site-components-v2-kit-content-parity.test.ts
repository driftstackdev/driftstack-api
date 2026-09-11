// W529 — drift guard for the marketing-site Fleet v2 shared component kit
// (2026-07-03): Section, PageHero, Card, IconTile, Stat, HonestyChip,
// FeatureRow, PriceCard, CtaBand, CodeWindow under
// apps/marketing-site/src/components/. One consolidated parity file (the
// kit evolves together) pinning each component's load-bearing contract:
//
//   • Section/PageHero: .section-label + tokened headline shell.
//   • HonestyChip: EXACTLY three states with verbatim labels
//     ('Live' / 'Rolling out' / 'Roadmap') — the honest-claims guardrail;
//     unshipped features must carry their chip.
//   • Stat: the Band-B "big plain line + small mono technical line" tile.
//   • PriceCard: NO dollar literals and NO pricing imports — the caller
//     formats figures from src/data/pricing.ts (W292.B data-binding), so
//     the card can never become a second pricing source of truth.
//   • CtaBand/PriceCard: external (http) hrefs get rel="noopener noreferrer".
//   • CodeWindow: plain-code is:inline copy script with a double-bind
//     guard — NEVER an expression-container template literal (that Astro
//     pattern ships a dead no-op string).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const COMPONENTS = resolve(REPO_ROOT, 'apps/marketing-site/src/components');

function read(name: string): string {
  return readFileSync(resolve(COMPONENTS, name), 'utf8');
}

const KIT = [
  'Section.astro',
  'PageHero.astro',
  'Card.astro',
  'IconTile.astro',
  'Stat.astro',
  'HonestyChip.astro',
  'FeatureRow.astro',
  'PriceCard.astro',
  'CtaBand.astro',
  'CodeWindow.astro',
  // 2026-09-11 — the real-capture frame (replaces every hand-drawn GUI
  // mockup on the site). Joins the kit so the hygiene sweep covers it.
  'AppScreen.astro',
];

describe('W529 marketing-site Fleet v2 component kit content parity', () => {
  it('all 11 kit components exist at the canonical path', () => {
    for (const name of KIT) {
      expect(existsSync(resolve(COMPONENTS, name)), name).toBe(true);
    }
  });

  it('Section: label/title/lead/id/wide props + .section-label + tokened h2 + border-t hairline shell', () => {
    const body = read('Section.astro');
    expect(body).toMatch(/label: string;/);
    expect(body).toMatch(/title: string;/);
    expect(body).toMatch(/lead\?: string;/);
    expect(body).toMatch(/wide\?: boolean;/);
    expect(body).toMatch(/'relative border-t border-tk-border'/);
    expect(body).toMatch(/class="section-label">\{label\}/);
    expect(body).toMatch(/text-tk-ink sm:text-3xl md:text-4xl/);
    expect(body).toMatch(/wide \? 'max-w-7xl' : 'max-w-6xl'/);
  });

  it('PageHero: h1 hero for interior pages over hero-glow + grid-bg (homepage keeps its bespoke hero)', () => {
    const body = read('PageHero.astro');
    expect(body).toMatch(/class="hero-glow" aria-hidden="true"/);
    expect(body).toMatch(/grid-bg opacity-60/);
    expect(body).toMatch(/<h1/);
    expect(body).toMatch(/class="section-label">\{label\}/);
  });

  it('Card + IconTile: solid .card recipe wrapper with icon slot; IconTile is the AA-safe accent chip and is decorative (aria-hidden)', () => {
    const card = read('Card.astro');
    expect(card).toMatch(/'card p-6'/);
    expect(card).toMatch(/<slot name="icon" \/>/);
    const tile = read('IconTile.astro');
    expect(tile).toMatch(/bg-tk-accent\/10 text-tk-accent-text/);
    expect(tile).toMatch(/aria-hidden="true"/);
  });

  it('Stat: the Band-B copy pattern — plain (required) + technical (optional, small mono in tk-ink-3) inside .stat-card', () => {
    const body = read('Stat.astro');
    expect(body).toMatch(/plain: string;/);
    expect(body).toMatch(/technical\?: string;/);
    expect(body).toMatch(/'stat-card'/);
    expect(body).toMatch(/font-mono text-xs leading-5 text-tk-ink-3/);
  });

  it("HonestyChip: EXACTLY three states with verbatim labels — live→'Live' (tk-ready family), rolling-out→'Rolling out' (tk-busy family), roadmap→'Roadmap' (muted). These are contract strings; rewording requires a deliberate re-pin. S24 2026-07-06: the LABEL text reads the AA-safe status-text tones (raw ready/busy are fill tones, 2.7–3.3:1 as small light-mode text); the /30 borders keep the raw status tint", () => {
    const body = read('HonestyChip.astro');
    expect(body).toMatch(/type ChipState = 'live' \| 'rolling-out' \| 'roadmap';/);
    expect(body).toMatch(/live: 'Live',/);
    expect(body).toMatch(/'rolling-out': 'Rolling out',/);
    expect(body).toMatch(/roadmap: 'Roadmap',/);
    expect(body).toMatch(/live: 'text-tk-ready-text border-tk-ready\/30',/);
    expect(body).toMatch(/'rolling-out': 'text-tk-busy-text border-tk-busy\/30',/);
  });

  it('FeatureRow: copy + media two-column grid with optional HonestyChip and reverse ordering', () => {
    const body = read('FeatureRow.astro');
    expect(body).toMatch(/import HonestyChip from '\.\/HonestyChip\.astro';/);
    expect(body).toMatch(/chip\?: 'live' \| 'rolling-out' \| 'roadmap';/);
    expect(body).toMatch(/<slot name="media" \/>/);
    expect(body).toMatch(/reverse \? 'md:order-2' : ''/);
  });

  it('PriceCard: caller-formatted price string, NO dollar literals, NO pricing.ts import (W292.B — pages own the data-binding); highlight variant + external-href rel', () => {
    const body = read('PriceCard.astro');
    expect(body).toMatch(/price: string;/);
    expect(body).toMatch(/highlight\?: boolean;/);
    // the component itself must never carry a figure or import the data —
    // that would create a second pricing source of truth
    expect(body).not.toMatch(/\$\d/);
    expect(body).not.toMatch(/from '\.\.\/data\/pricing/);
    expect(body).toMatch(/const external = href\.startsWith\('http'\);/);
    expect(body).toMatch(/rel=\{external \? 'noopener noreferrer' : undefined\}/);
    expect(body).toMatch(/highlight \? 'btn-primary w-full' : 'btn-secondary w-full'/);
  });

  it('CtaBand: accent radial wash + primary/secondary CTA pair; external (http) hrefs get rel="noopener noreferrer"', () => {
    const body = read('CtaBand.astro');
    expect(body).toMatch(/bg-glow-radial-accent opacity-50/);
    expect(body).toMatch(
      /const relFor = \(href: string\) => \(href\.startsWith\('http'\) \? 'noopener noreferrer' : undefined\);/,
    );
    expect(body).toMatch(/class="btn-primary" rel=\{relFor\(primaryHref\)\}/);
  });

  it('CodeWindow: chrome + copy button; plain guarded inline script has a single-flight, generation-safe, accessible clipboard lifecycle', () => {
    const body = read('CodeWindow.astro');
    expect(body).toMatch(/class="code-preview overflow-hidden"/);
    expect(body).toMatch(/class="code-window-chrome"/);
    expect(body).toMatch(/data-copy-target=\{copyTargetId\}/);
    expect(body).toMatch(/window\.__dsCopyWired = true;/);
    // Clipboard capability failures and synchronous browser throws are
    // normalized onto the same promise path as async write rejections.
    expect(body).toMatch(
      /if \(!navigator\.clipboard \|\| typeof navigator\.clipboard\.writeText !== 'function'\)/,
    );
    expect(body).toMatch(/return Promise\.resolve\(navigator\.clipboard\.writeText\(value\)\);/);
    expect(body).toMatch(/catch \(error\) \{\s*return Promise\.reject\(error\);\s*\}/);
    // Rapid taps must not overlap writes or let an older reset overwrite a
    // newer result. The active write also exposes visible and AT feedback.
    expect(body).toMatch(/var copyStates = new WeakMap\(\);/);
    expect(body).toMatch(/if \(state\.inFlight\) return;/);
    expect(body).toMatch(/var generation = \+\+state\.generation;/);
    expect(body).toMatch(/btn\.textContent = 'Copying…';/);
    expect(body).toMatch(/btn\.disabled = true;/);
    expect(body).toMatch(/btn\.setAttribute\('aria-busy', 'true'\);/);
    expect(body).toMatch(/if \(generation !== state\.generation\) return;/);
    expect(body).toMatch(
      /showCopyResult\(\s*btn,\s*state,\s*generation,\s*'Copy failed',\s*'Could not copy code; select it manually',\s*1800,?\s*\);/,
    );
    expect(body).toMatch(/btn\.disabled = false;/);
    expect(body).toMatch(/btn\.setAttribute\('aria-busy', 'false'\);/);
    // the dead-inline-script trap: an expression container opening right
    // after the script tag ships a literal string instead of running
    expect(body).not.toMatch(/<script is:inline>\s*\{/);
  });

  // 2026-09-11 — AppScreen is HOW the site shows the desktop app: a real
  // capture (src/assets/screens/<scene>.png, Playwright shots of the visual
  // harness rendering the app's own React components with fixture data)
  // inside an app-window frame. Each arm below pins one line of the
  // rendering contract, and each has a reason:
  //   • astro:assets <Picture> with formats=['webp'] + fallbackFormat="png":
  //     a plain <img src={png}> would ship the 2× PNG (≈1 MB) to every
  //     visitor; the webp <source> + resized candidates are the whole point.
  //   • explicit width/height DERIVED from the capture (src.width / scale):
  //     the slot must reserve its box (no layout shift) and must track the
  //     capture's real aspect — a hand-typed 1280×800 goes stale the day a
  //     scene is re-shot at a different size.
  //   • loading follows `priority`: lazy below the fold, eager + high fetch
  //     priority for the hero (the LCP element) — a flat loading="lazy" makes
  //     the hero paint late; a flat "eager" downloads every screen up front.
  //   • a real alt is REQUIRED (Astro throws without it — the arm pins that
  //     we pass the caller's, never a hard-coded "" that would silence it).
  //   • the frame carries data-contrast-decorative (WCAG 1.4.3 incidental
  //     text-in-a-picture — the capture's own text is part of the picture;
  //     the real copy sits OUTSIDE the component) and is NOT aria-hidden:
  //     the app's real chrome is inside the capture, the frame holds nothing
  //     but the <picture>, and an aria-hidden wrapper would hide the alt.
  it('AppScreen: astro:assets <Picture> (webp + png fallback) sized from the capture, lazy below the fold / eager+high for the hero, real alt, decorative frame carrying data-contrast-decorative and never aria-hidden', () => {
    const body = read('AppScreen.astro');
    expect(body).toMatch(/import \{ Picture \} from 'astro:assets'/);
    expect(body).toMatch(/import type \{ ImageMetadata \} from 'astro'/);
    expect(body).toMatch(/formats=\{\['webp'\]\}/);
    expect(body).toMatch(/fallbackFormat="png"/);
    // dimensions derive from the capture, never hand-typed
    expect(body).toMatch(/const width = Math\.round\(src\.width \/ scale\)/);
    expect(body).toMatch(/const height = Math\.round\(src\.height \/ scale\)/);
    expect(body).toMatch(/width=\{width\}/);
    expect(body).toMatch(/height=\{height\}/);
    expect(body).toMatch(/scale = 2,/);
    // srcset candidates never exceed the source (sharp would upscale)
    expect(body).toMatch(/\.filter\(\(w\) => w <= src\.width\)/);
    expect(body).toMatch(/widths=\{widths\}/);
    expect(body).toMatch(/sizes=\{sizes\}/);
    // loading policy follows `priority`
    expect(body).toMatch(/loading=\{priority \? 'eager' : 'lazy'\}/);
    expect(body).toMatch(/fetchpriority=\{priority \? 'high' : 'auto'\}/);
    expect(body).toMatch(/decoding="async"/);
    expect(body).toMatch(/priority = false,/);
    // the caller's alt is passed through; never a hard-coded empty alt
    expect(body).toMatch(/alt=\{alt\}/);
    expect(body).not.toMatch(/alt=""/);
    // decorative frame semantics — and no aria-hidden ATTRIBUTE anywhere in
    // the component (it would take the alt with it). Matched as `aria-hidden=`
    // so the component's own comment explaining the rule cannot trip it.
    expect(body).toMatch(/data-contrast-decorative/);
    expect(body).not.toMatch(/aria-hidden=/);
    expect(body).toMatch(
      /'app-screen overflow-hidden rounded-2xl border border-tk-border bg-tk-surface shadow-ambient-lg'/,
    );
  });

  it('kit hygiene: no inline event handlers (onclick=), no hard-coded hex colors, no driftstack.com/.io TLD drift', () => {
    for (const name of KIT) {
      const body = read(name);
      expect(body, name).not.toMatch(/\son[a-z]+="/);
      expect(body, name).not.toMatch(/#[0-9a-fA-F]{6}\b/);
      expect(body, name).not.toMatch(/driftstack\.(com|io|app|co)\b/);
    }
  });
});
